import crypto from 'crypto'
import { supabase } from '../config/supabase.js'
import * as b2Service from './b2Service.js'

let isRunning = false

/**
 * Runs a single cycle of the 30-day recording retention and pending B2 storage purge.
 */
export const runRecordingRetentionCycle = async () => {
  if (isRunning) {
    console.log('[Recording Retention] Previous cycle still in flight. Skipping.')
    return { processed: 0 }
  }

  isRunning = true
  const claimToken = crypto.randomUUID()
  let processedCount = 0

  try {
    const now = new Date()

    // 1. Mark expired ready recordings as pending_deletion ONLY if no unresolved B2 operation blocks cleanup
    const { data: expiredReady } = await supabase
      .from('recordings')
      .select('recording_id')
      .eq('status', 'ready')
      .lt('expires_at', now.toISOString())
      .eq('b2_operation_state', 'settled')
      .neq('cleanup_status', 'unresolved_error')
      .limit(50)

    if (expiredReady && expiredReady.length > 0) {
      const expiredIds = expiredReady.map(r => r.recording_id)
      console.log(`[Recording Retention] Found ${expiredIds.length} expired settled recording(s). Queuing for purge:`, expiredIds)
      await supabase
        .from('recordings')
        .update({
          status: 'pending_deletion',
          cleanup_status: 'pending_cleanup',
          last_b2_operation: 'delete_versions'
        })
        .in('recording_id', expiredIds)
    }

    // 2. Fetch up to 20 recordings pending storage cleanup strictly where B2 state is settled
    const leaseThreshold = new Date(now.getTime() - 5 * 60 * 1000).toISOString() // 5-minute worker lease
    let candidates = []
    let isRpcClaimed = false

    // Attempt atomic batch claim via RPC first
    try {
      const { data: rpcCandidates, error: rpcErr } = await supabase.rpc('rpc_claim_cleanup_batch', {
        p_claim_token: claimToken,
        p_batch_size: 20,
        p_lease_seconds: 300
      })

      if (!rpcErr && rpcCandidates && rpcCandidates.length > 0) {
        candidates = rpcCandidates
        isRpcClaimed = true
      }
    } catch (rpcEx) {
      console.warn('[Recording Retention] rpc_claim_cleanup_batch fallback to query:', rpcEx.message)
    }

    // Direct query fallback: strictly settled, pending cleanup or cleaning, including pending_deletion and failed
    if (!isRpcClaimed) {
      const { data: queryCandidates, error: fetchErr } = await supabase
        .from('recordings')
        .select('recording_id, meeting_id, b2_key, b2_upload_id, fencing_token, b2_operation_state, cleanup_status, status')
        .in('cleanup_status', ['pending_cleanup', 'cleaning'])
        .in('status', ['pending_deletion', 'failed'])
        .eq('b2_operation_state', 'settled')
        .neq('cleanup_status', 'unresolved_error')
        .or(`operation_claimed_at.is.null,operation_claimed_at.lt.${leaseThreshold}`)
        .limit(20)

      if (fetchErr) {
        console.error('[Recording Retention Error] Error fetching cleanup candidates:', fetchErr)
        return { processed: 0 }
      }
      candidates = queryCandidates || []
    }

    if (!candidates || candidates.length === 0) {
      return { processed: 0 }
    }

    // 3. Process each candidate
    for (const rec of candidates) {
      try {
        // Claim lease if not already claimed by RPC
        if (!isRpcClaimed) {
          await supabase
            .from('recordings')
            .update({
              cleanup_status: 'cleaning',
              operation_claim_token: claimToken,
              operation_claimed_at: now.toISOString(),
              fencing_token: (rec.fencing_token || 1) + 1
            })
            .eq('recording_id', rec.recording_id)
        }

        console.log(`[Recording Retention] Starting permanent B2 version purge for key: ${rec.b2_key}`)

        // Execute permanent version/marker deletion
        const purgeResult = await b2Service.deleteExactKeyVersions(rec.b2_key, rec.b2_upload_id)

        if (purgeResult.success) {
          // Update recording to purged and cleaned
          await supabase
            .from('recordings')
            .update({
              status: 'purged',
              cleanup_status: 'cleaned',
              b2_operation_state: 'settled'
            })
            .eq('recording_id', rec.recording_id)

          processedCount++
          console.log(`[Recording Retention] Successfully settled storage purge for recording ${rec.recording_id}`)

          // Check if parent meeting is marked for deletion
          const { data: meeting } = await supabase
            .from('meetings')
            .select('meeting_id, meeting_code, is_deleted, deletion_requested_at')
            .eq('meeting_id', rec.meeting_id)
            .maybeSingle()

          if (meeting && (meeting.is_deleted || meeting.deletion_requested_at)) {
            // Check if any other recordings exist for this meeting
            const { data: otherRecs } = await supabase
              .from('recordings')
              .select('recording_id')
              .eq('meeting_id', rec.meeting_id)
              .neq('status', 'purged')

            if (!otherRecs || otherRecs.length === 0) {
              console.log(`[Recording Retention] All recordings purged. Executing final deletion of parent meeting ${meeting.meeting_code}`)
              await supabase
                .from('recordings')
                .delete()
                .eq('meeting_id', rec.meeting_id)
                .eq('cleanup_status', 'cleaned')
                .eq('b2_operation_state', 'settled')
              await supabase.from('meeting_device_bans').delete().eq('meeting_code', meeting.meeting_code)
              await supabase.from('meeting_join_requests').delete().eq('meeting_code', meeting.meeting_code)
              await supabase.from('participants').delete().eq('meeting_id', rec.meeting_id)
              await supabase.from('meeting_attendance').delete().eq('meeting_id', rec.meeting_id)
              await supabase.from('meetings').delete().eq('meeting_id', rec.meeting_id)
            }
          }
        }
      } catch (itemErr) {
        console.error(`[Recording Retention Error] Purge failed for ${rec.recording_id}:`, itemErr)
        await supabase
          .from('recordings')
          .update({
            cleanup_status: 'unresolved_error',
            b2_operation_state: 'unresolved',
            failure_reason: itemErr.message
          })
          .eq('recording_id', rec.recording_id)
      }
    }
  } catch (err) {
    console.error('[Recording Retention Error] Unexpected error in retention cycle:', err)
  } finally {
    isRunning = false
  }

  return { processed: processedCount }
}

/**
 * Initializes the background retention cleanup interval (runs every 15 minutes).
 */
export const startRecordingRetentionCleanup = () => {
  console.log('[Recording Retention Job] Initializing 30-day recording retention worker (every 15 minutes)...')
  // Run once shortly after startup
  setTimeout(() => {
    runRecordingRetentionCycle().catch(e => console.error('[Recording Retention Error]:', e))
  }, 15000)

  // Recurring interval every 15 minutes
  setInterval(() => {
    runRecordingRetentionCycle().catch(e => console.error('[Recording Retention Error]:', e))
  }, 15 * 60 * 1000)
}
