import { supabase } from '../config/supabase.js'
import { cancelCleanup } from '../services/meetingCleanup.js'
import { authorizeHost } from '../utils/authHelper.js'
import { executeParticipantRemoval } from '../services/participantRemovalService.js'
import {
  isCloudflareConfigured,
  createCloudflareMeeting,
  addCloudflareParticipant,
  removeCloudflareParticipant,
  endCloudflareMeeting,
  refreshCloudflareParticipantToken
} from '../config/cloudflareRealtime.js'

// RealtimeKit participant preset
export const getCloudflareParticipantPreset = () =>
  process.env.CLOUDFLARE_REALTIME_PARTICIPANT_PRESET || 'meetly-participant'

// Helper for structured audit logging
const logAudit = ({ action, meetingCode, hostId, participantId, value }) => {
  const timestamp = new Date().toISOString()
  console.log(
    `[Audit Log] Action: ${action} | Timestamp: ${timestamp} | MeetingCode: ${meetingCode || 'N/A'} | HostId: ${hostId || 'N/A'} | ParticipantId: ${participantId || 'N/A'} | Value: ${value !== undefined ? value : 'N/A'}`
  )
}

// In-memory store for meeting-wide Mute All / Microphone Lock state keyed by meeting_id / room_name
export const meetingMuteAllStore = new Map()

export const isMuteAllEnabled = (meetingId) => {
  if (!meetingId) return false
  return !!meetingMuteAllStore.get(String(meetingId))
}

// UUID validation helper
const isUuid = (val) => {
  if (!val) return false
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val)
}

// Pluggable Cloudflare service reference allowing test dependency injection
let cloudflareService = {
  isConfigured: isCloudflareConfigured,
  createMeeting: createCloudflareMeeting,
  addParticipant: addCloudflareParticipant,
  removeParticipant: removeCloudflareParticipant,
  endMeeting: endCloudflareMeeting,
  refreshParticipantToken: refreshCloudflareParticipantToken
}

export const setCloudflareService = (service) => {
  cloudflareService = { ...cloudflareService, ...service }
}

export const resetCloudflareService = () => {
  cloudflareService = {
    isConfigured: isCloudflareConfigured,
    createMeeting: createCloudflareMeeting,
    addParticipant: addCloudflareParticipant,
    removeParticipant: removeCloudflareParticipant,
    endMeeting: endCloudflareMeeting,
    refreshParticipantToken: refreshCloudflareParticipantToken
  }
}

/**
 * Safely roll back participant admission when provider enrollment or DB persistence fails.
 * Restores the pending join request and removes any falsely admitted participant record.
 */
const rollbackParticipantAdmission = async (meetingId, uppercaseCode, userId, fingerprint) => {
  try {
    // Check existing participant status: do not delete or restore if participant was banned/removed!
    const { data: existingPart } = await supabase
      .from('participants')
      .select('participant_status')
      .eq('meeting_id', meetingId)
      .eq('user_id', userId)
      .maybeSingle()

    if (existingPart?.participant_status === 'removed') {
      console.log(`[Security] Rollback skipping participant deletion because user ${userId} has status 'removed'.`)
      return
    }

    await supabase
      .from('participants')
      .delete()
      .eq('meeting_id', meetingId)
      .eq('user_id', userId)
      .eq('participant_status', 'enrolling')

    // Atomically restore join request under advisory lock; rejects if device was banned
    const { error: restoreErr } = await supabase
      .rpc('create_join_request_tx', {
        p_meeting_code: uppercaseCode,
        p_user_id: userId,
        p_device_fingerprint: fingerprint || 'unknown-fingerprint'
      })

    if (restoreErr) {
      console.warn(`[Security] Rollback join request restoration rejected: ${restoreErr.message}`)
    }
  } catch (err) {
    console.error('[Security] Failed to rollback participant admission:', err.message)
  }
}


/**
 * GET /api/meetings/security/pending/:meetingCode
 * Fetch list of pending join requests (host only)
 */
export const getPendingRequests = async (req, res) => {
  try {
    const { meetingCode } = req.params
    if (!meetingCode || !meetingCode.trim()) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter meetingCode is missing.'
      })
    }

    const uppercaseCode = meetingCode.trim().toUpperCase()

    const auth = await authorizeHost(uppercaseCode, req.user.id)
    if (!auth.passed) {
      if (auth.status === 403) {
        logAudit({
          action: 'GET_PENDING_UNAUTHORIZED',
          meetingCode: uppercaseCode,
          hostId: auth.meeting?.host_id,
          participantId: req.user.id
        })
      }
      return res.status(auth.status).json({
        success: false,
        code: auth.status === 403 ? 'FORBIDDEN' : (auth.status === 404 ? 'NOT_FOUND' : 'ERROR'),
        message: auth.message
      })
    }
    const meeting = auth.meeting

    // 3. Auto-expire requests older than 30 minutes
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    try {
      const { data: expiredReqs } = await supabase
        .from('meeting_join_requests')
        .select('id, user_id')
        .eq('meeting_code', uppercaseCode)
        .lt('created_at', thirtyMinsAgo)

      if (expiredReqs && expiredReqs.length > 0) {
        for (const req of expiredReqs) {
          logAudit({
            action: 'Waiting Request Expired',
            meetingCode: uppercaseCode,
            participantId: req.user_id
          })
        }
        await supabase
          .from('meeting_join_requests')
          .delete()
          .in('id', expiredReqs.map(r => r.id))
      }
    } catch (expireErr) {
      console.error('[Security] Failed to auto-expire old requests:', expireErr)
    }

    // 4. Fetch active pending requests
    const { data: requests, error: fetchErr } = await supabase
      .from('meeting_join_requests')
      .select('id, user_id, device_fingerprint, created_at')
      .eq('meeting_code', uppercaseCode)
      .order('created_at', { ascending: true })

    if (fetchErr) throw fetchErr

    // Fetch user details for each request
    const requestsWithUser = await Promise.all(
      (requests || []).map(async (r) => {
        const { data: usr } = await supabase
          .from('users')
          .select('full_name, email')
          .eq('id', r.user_id)
          .maybeSingle()
        return {
          id: r.id,
          userId: r.user_id,
          deviceFingerprint: r.device_fingerprint,
          createdAt: r.created_at,
          fullName: usr?.full_name || 'Anonymous',
          email: usr?.email || ''
        }
      })
    )

    return res.status(200).json({ success: true, requests: requestsWithUser })
  } catch (err) {
    console.error('[Security] getPendingRequests error:', err)
    return res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: 'Server error retrieving pending requests.'
    })
  }
}

/**
 * POST /api/meetings/security/accept
 * Host accepts a pending participant using atomic db transaction and dual-provider enrollment
 */
export const acceptJoinRequest = async (req, res) => {
  let meeting = null
  let cfParticipant = null
  try {
    const { meetingCode, userId } = req.body
    if (!meetingCode || !meetingCode.trim()) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter meetingCode is missing.'
      })
    }
    if (!userId || !isUuid(userId)) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter userId is missing or is not a valid UUID.'
      })
    }

    const uppercaseCode = meetingCode.trim().toUpperCase()

    // 1. Authorize caller is meeting Host (Original Host or Active Host)
    const auth = await authorizeHost(uppercaseCode, req.user.id)
    if (!auth.passed) {
      if (auth.status === 403) {
        logAudit({
          action: 'ACCEPT_UNAUTHORIZED',
          meetingCode: uppercaseCode,
          hostId: auth.meeting?.host_id,
          participantId: userId
        })
      }
      return res.status(auth.status).json({
        success: false,
        code: auth.status === 403 ? 'FORBIDDEN' : (auth.status === 404 ? 'NOT_FOUND' : 'ERROR'),
        message: auth.message
      })
    }
    meeting = auth.meeting

    // 2. Step 1: Atomic Admission Reservation (moves participant to 'enrolling' state under advisory lock)
    const { data: fingerprint, error: txErr } = await supabase
      .rpc('accept_join_request_tx', {
        p_meeting_code: uppercaseCode,
        p_user_id: userId
      })

    if (txErr) {
      console.error('[Security Transaction Error] accept_join_request_tx failed:', txErr)
      if (txErr.message?.includes('device is banned') || txErr.message?.includes('user has been removed')) {
        // Clean up the waiting request under transactional user-lock protocol (bounded retry)
        let rejectSucceeded = false
        for (let attempt = 1; attempt <= 2; attempt++) {
          const { error: rejectErr } = await supabase
            .rpc('reject_join_request_tx', {
              p_meeting_code: uppercaseCode,
              p_user_id: userId
            })

          if (!rejectErr) {
            rejectSucceeded = true
            break
          }

          console.error(
            `[Security] reject_join_request_tx cleanup attempt ${attempt} failed for meeting: ${uppercaseCode}, user: ${userId}:`,
            rejectErr.message
          )
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
        }

        if (!rejectSucceeded) {
          console.error(
            `[Security] reject_join_request_tx cleanup exhausted retries for meeting: ${uppercaseCode}, user: ${userId}`
          )
        }

        return res.status(403).json({
          success: false,
          code: 'FORBIDDEN',
          message: txErr.message?.includes('user has been removed')
            ? 'Cannot admit participant: user has been removed from this meeting.'
            : 'Cannot admit participant: this device is banned from the meeting.'
        })
      }

      if (txErr.message?.includes('fingerprint changed concurrently')) {
        return res.status(409).json({
          success: false,
          code: 'CONCURRENCY_CONFLICT',
          message: 'Device fingerprint changed during admission. Please retry.'
        })
      }

      return res.status(400).json({
        success: false,
        code: 'TRANSACTION_FAILED',
        message: txErr.message || 'Database transaction failed.'
      })
    }

    // 3. Fetch user record for identity and display name
    const { data: userRecord } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .maybeSingle()

    if (!userRecord) {
      await rollbackParticipantAdmission(meeting.meeting_id, uppercaseCode, userId, fingerprint)
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: 'User record not found.'
      })
    }

    const isCloudflareMeeting = Boolean(meeting.cloudflare_meeting_id)
    cfParticipant = null

    // 4. Step 2: Cloudflare RealtimeKit Credential Issuance (Asynchronous)
    if (!cloudflareService.isConfigured()) {
      console.error('[Security] Cloudflare is not configured for meeting admission.')
      await rollbackParticipantAdmission(meeting.meeting_id, uppercaseCode, userId, fingerprint)
      return res.status(502).json({
        success: false,
        code: 'CLOUDFLARE_NOT_CONFIGURED',
        message: 'Cloudflare RealtimeKit is not configured on this server.'
      })
    }

    const presetName = getCloudflareParticipantPreset()
    const displayName = userRecord.full_name?.trim() || 'Anonymous'

    try {
      cfParticipant = await cloudflareService.addParticipant(meeting.cloudflare_meeting_id, {
        name: displayName,
        presetName,
        customParticipantId: userId
      })
      console.log(`[Security] Cloudflare participant enrolled for user ${userId} in meeting ${meeting.cloudflare_meeting_id}`)
    } catch (enrollErr) {
      console.error(`[Security] Cloudflare participant enrollment failed for user ${userId}:`, enrollErr.message)
      await rollbackParticipantAdmission(meeting.meeting_id, uppercaseCode, userId, fingerprint)
      return res.status(502).json({
        success: false,
        code: 'CLOUDFLARE_ENROLLMENT_FAILED',
        message: 'Failed to enroll participant in Cloudflare RealtimeKit session.'
      })
    }

    // 5. Step 3: Atomic Finalization Guard (enrolling -> joined under advisory lock)
    // If a ban occurred while provider was enrolling, status was changed to 'removed',
    // so finalize_participant_admission_tx updates 0 rows and returns FALSE.
    const { data: isFinalized, error: finalizeErr } = await supabase.rpc(
      'finalize_participant_admission_tx',
      {
        p_meeting_id: meeting.meeting_id,
        p_user_id: userId,
        p_cloudflare_participant_id: cfParticipant?.participantId || null
      }
    )

    if (finalizeErr || !isFinalized) {
      console.warn(`[Security] Admission finalization rejected for user ${userId}: participant was banned or removed during provider enrollment.`)

      // If Cloudflare participant was created, evict immediately so no orphaned peer lingers
      if (cfParticipant?.participantId && meeting.cloudflare_meeting_id) {
        try {
          await cloudflareService.removeParticipant(meeting.cloudflare_meeting_id, cfParticipant.participantId)
          console.log(`[Security] Evicted mid-flight banned Cloudflare participant ${cfParticipant.participantId}`)
        } catch (evictErr) {
          console.warn('[Security] Concurrent ban Cloudflare eviction warning:', evictErr.message)
        }
      }

      // Withhold credentials and return 403
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: 'Cannot admit participant: this device is banned from the meeting.'
      })
    }

    // 6. Step 4: Pre-Emission Delivery Verification
    // Ensure that even in the sub-millisecond gap between finalization and socket delivery,
    // if a ban committed, credentials are not delivered.
    const { data: verifiedPart } = await supabase
      .from('participants')
      .select('participant_status')
      .eq('meeting_id', meeting.meeting_id)
      .eq('user_id', userId)
      .maybeSingle()

    if (verifiedPart?.participant_status !== 'joined') {
      console.warn(`[Security] Pre-emission check detected status ${verifiedPart?.participant_status} for user ${userId}. Withholding tokens.`)
      if (cfParticipant?.participantId && meeting.cloudflare_meeting_id) {
        await cloudflareService.removeParticipant(meeting.cloudflare_meeting_id, cfParticipant.participantId).catch(() => {})
      }
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: 'Cannot admit participant: this device is banned from the meeting.'
      })
    }

    cancelCleanup(meeting.meeting_id)

    // 7. Targeted Socket.IO emission to the intended participant's socket(s) only
    const io = req.app.get('io')
    const roomUserSockets = req.app.get('roomUserSockets')

    if (io) {
      const acceptancePayload = {
        userId,
        roomName: meeting.room_name,
        cloudflareToken: cfParticipant?.token || null,
        cloudflareMeetingId: meeting.cloudflare_meeting_id || null,
        cloudflareParticipantId: cfParticipant?.participantId || null,
        activeProvider: 'cloudflare'
      }

      const targetUserId = String(userId).trim().toLowerCase()
      const userMap = roomUserSockets?.get(meeting.room_name)
      const userSockets = userMap?.get(targetUserId)

      if (userSockets && userSockets.size > 0) {
        userSockets.forEach((sId) => {
          io.to(sId).emit('participant_accepted', acceptancePayload)
        })
      } else {
        console.warn(`[Security Socket] No active authenticated sockets found in roomUserSockets for user ${userId}.`)
      }

      // Preserve waiting_list_updated broadcast for host
      io.to(meeting.room_name).emit('waiting_list_updated')
    }

    // 7. Structured audit log
    logAudit({
      action: 'Participant Accepted',
      meetingCode: uppercaseCode,
      hostId: req.user.id,
      participantId: userId,
      value: 'cloudflare'
    })

    return res.status(200).json({
      success: true,
      message: 'Participant accepted.',
      cloudflareToken: cfParticipant?.token || null,
      cloudflareMeetingId: meeting.cloudflare_meeting_id || null,
      cloudflareParticipantId: cfParticipant?.participantId || null,
      activeProvider: 'cloudflare'
    })
  } catch (err) {
    console.error('[Security] acceptJoinRequest error:', err)
    if (meeting?.cloudflare_meeting_id && cfParticipant?.participantId) {
      try {
        await cloudflareService.removeParticipant(meeting.cloudflare_meeting_id, cfParticipant.participantId)
        console.log(`[Security] Evicted orphan Cloudflare participant ${cfParticipant.participantId} on error`)
      } catch (evictErr) {
        console.warn('[Security] Error cleanup Cloudflare eviction warning:', evictErr.message)
      }
    }
    return res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: 'Server error admitting participant.'
    })
  }
}

/**
 * POST /api/meetings/security/reject
 * Host rejects a pending participant using atomic db transaction
 */
export const rejectJoinRequest = async (req, res) => {
  try {
    const { meetingCode, userId } = req.body
    if (!meetingCode || !meetingCode.trim()) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter meetingCode is missing.'
      })
    }
    if (!userId || !isUuid(userId)) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter userId is missing or is not a valid UUID.'
      })
    }

    const uppercaseCode = meetingCode.trim().toUpperCase()

    const auth = await authorizeHost(uppercaseCode, req.user.id)
    if (!auth.passed) {
      if (auth.status === 403) {
        logAudit({
          action: 'REJECT_UNAUTHORIZED',
          meetingCode: uppercaseCode,
          hostId: auth.meeting?.host_id,
          participantId: userId
        })
      }
      return res.status(auth.status).json({
        success: false,
        code: auth.status === 403 ? 'FORBIDDEN' : (auth.status === 404 ? 'NOT_FOUND' : 'ERROR'),
        message: auth.message
      })
    }
    const meeting = auth.meeting

    // 2. Execute transaction inside PostgreSQL RPC function
    const { data: success, error: txErr } = await supabase
      .rpc('reject_join_request_tx', {
        p_meeting_code: uppercaseCode,
        p_user_id: userId
      })

    if (txErr) {
      console.error('[Security Transaction Error] reject_join_request_tx failed:', txErr)
      if (txErr.message?.includes('fingerprint changed concurrently')) {
        return res.status(409).json({
          success: false,
          code: 'CONCURRENCY_CONFLICT',
          message: 'Device fingerprint changed concurrently; please retry.'
        })
      }
      return res.status(400).json({
        success: false,
        code: 'TRANSACTION_FAILED',
        message: txErr.message || 'Database transaction failed.'
      })
    }

    if (success === false) {
      return res.status(200).json({
        success: true,
        message: 'Join request already handled or not found.'
      })
    }

    // 3. Emit Socket.IO reject events (Post-Commit)
    const io = req.app.get('io')
    if (io) {
      io.to(meeting.room_name).emit('participant_rejected', { userId })
      io.to(meeting.room_name).emit('waiting_list_updated')
    }

    // 4. Structured audit log
    logAudit({
      action: 'Participant Rejected',
      meetingCode: uppercaseCode,
      hostId: req.user.id,
      participantId: userId
    })

    return res.status(200).json({ success: true, message: 'Participant rejected.' })
  } catch (err) {
    console.error('[Security] rejectJoinRequest error:', err)
    return res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: 'Server error rejecting participant.'
    })
  }
}

/**
 * POST /api/meetings/security/ban-device
 * Host moderator blocks a participant and bans their device fingerprint using atomic db transaction
 */
export const banDevice = async (req, res) => {
  try {
    const { meetingCode, userId } = req.body
    if (!meetingCode || !meetingCode.trim()) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter meetingCode is missing.'
      })
    }
    if (!userId || !isUuid(userId)) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter userId is missing or is not a valid UUID.'
      })
    }

    const uppercaseCode = meetingCode.trim().toUpperCase()

    const auth = await authorizeHost(uppercaseCode, req.user.id)
    if (!auth.passed) {
      if (auth.status === 403) {
        logAudit({
          action: 'BAN_UNAUTHORIZED',
          meetingCode: uppercaseCode,
          hostId: auth.meeting?.host_id,
          participantId: userId
        })
      }
      return res.status(auth.status).json({
        success: false,
        code: auth.status === 403 ? 'FORBIDDEN' : (auth.status === 404 ? 'NOT_FOUND' : 'ERROR'),
        message: auth.message
      })
    }
    const meeting = auth.meeting

    // 2. Execute transaction inside PostgreSQL RPC function
    const { data: fingerprint, error: txErr } = await supabase
      .rpc('ban_device_tx', {
        p_meeting_code: uppercaseCode,
        p_user_id: userId
      })

    if (txErr) {
      console.error('[Security Transaction Error] ban_device_tx failed:', txErr)
      if (txErr.message?.includes('fingerprint changed concurrently')) {
        return res.status(409).json({
          success: false,
          code: 'CONCURRENCY_CONFLICT',
          message: 'Device fingerprint changed during ban operation. Please retry.'
        })
      }
      return res.status(400).json({
        success: false,
        code: 'TRANSACTION_FAILED',
        message: txErr.message || 'Database transaction failed.'
      })
    }

    // 2.5. Update participant record status to 'removed'
    const { data: participant } = await supabase
      .from('participants')
      .select('participant_id, cloudflare_participant_id')
      .eq('meeting_id', meeting.meeting_id)
      .eq('user_id', userId)
      .maybeSingle()

    if (participant) {
      await supabase
        .from('participants')
        .update({ participant_status: 'removed', left_at: new Date().toISOString() })
        .eq('participant_id', participant.participant_id)
    }

    // 2.5.5. Evict participant server-side from Cloudflare RealtimeKit room (including cross-account sessions)
    if (meeting.cloudflare_meeting_id && cloudflareService.isConfigured()) {
      const { data: targetParts } = await supabase
        .from('participants')
        .select('cloudflare_participant_id')
        .eq('meeting_id', meeting.meeting_id)
        .or(`user_id.eq.${userId},device_fingerprint.eq.${fingerprint}`)

      for (const p of targetParts || []) {
        if (p.cloudflare_participant_id) {
          try {
            await cloudflareService.removeParticipant(meeting.cloudflare_meeting_id, p.cloudflare_participant_id)
            console.log(`[Security] Successfully evicted banned participant ${p.cloudflare_participant_id} from Cloudflare meeting ${meeting.cloudflare_meeting_id}`)
          } catch (cfErr) {
            console.warn(`[Security] Cloudflare ban eviction warning for ${p.cloudflare_participant_id}:`, cfErr.message)
          }
        }
      }
    }

    // 3. Emit Socket.IO events (Post-Commit)
    const io = req.app.get('io')
    if (io) {
      io.to(meeting.room_name).emit('participant_banned', { userId })
      io.to(meeting.room_name).emit('participant_removed', { userId })
    }

    // 4. Structured audit log
    logAudit({
      action: 'Participant Banned',
      meetingCode: uppercaseCode,
      hostId: req.user.id,
      participantId: userId,
      value: fingerprint || 'unknown-fingerprint'
    })

    return res.status(200).json({ success: true, message: 'Participant blocked and device banned successfully.' })
  } catch (err) {
    console.error('[Security] banDevice error:', err)
    return res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: 'Server error during banning device.'
    })
  }
}

/**
 * POST /api/meetings/security/toggle-auto-admit
 * Host toggles the auto admit settings for a meeting
 */
export const toggleAutoAdmit = async (req, res) => {
  try {
    const { meetingId, autoAdmit } = req.body
    if (!meetingId) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter meetingId is missing.'
      })
    }
    if (autoAdmit === undefined) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter autoAdmit is missing.'
      })
    }

    const auth = await authorizeHost(meetingId, req.user.id)
    if (!auth.passed) {
      if (auth.status === 403) {
        logAudit({
          action: 'TOGGLE_AUTO_ADMIT_UNAUTHORIZED',
          meetingCode: auth.meeting?.meeting_code,
          hostId: auth.meeting?.host_id,
          participantId: req.user.id
        })
      }
      return res.status(auth.status).json({
        success: false,
        code: auth.status === 403 ? 'FORBIDDEN' : (auth.status === 404 ? 'NOT_FOUND' : 'ERROR'),
        message: auth.message
      })
    }
    const meeting = auth.meeting

    // 3. Update setting
    const { error: updateErr } = await supabase
      .from('meetings')
      .update({
        auto_admit: autoAdmit,
        updated_at: new Date().toISOString()
      })
      .eq('meeting_id', meetingId)

    if (updateErr) throw updateErr

    // 4. Emit socket event
    const io = req.app.get('io')
    if (io) {
      io.to(meeting.room_name).emit('waiting_list_updated')
    }

    // 5. Structured audit log
    logAudit({
      action: 'Auto Admit Changed',
      meetingCode: meeting.meeting_code,
      hostId: req.user.id,
      value: autoAdmit
    })

    return res.status(200).json({ success: true, message: `Auto Admit toggled to ${autoAdmit}.` })
  } catch (err) {
    console.error('[Security] toggleAutoAdmit error:', err)
    return res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: 'Server error toggling auto admit status.'
    })
  }
}

/**
 * POST /api/meetings/security/remove
 * Host moderator removes a participant from the meeting
 */
export const removeParticipant = async (req, res) => {
  try {
    const { meetingCode, userId } = req.body
    if (!meetingCode || !meetingCode.trim()) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter meetingCode is missing.'
      })
    }
    if (!userId || !isUuid(userId)) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter userId is missing or is not a valid UUID.'
      })
    }

    const uppercaseCode = meetingCode.trim().toUpperCase()

    const auth = await authorizeHost(uppercaseCode, req.user.id)
    if (!auth.passed) {
      if (auth.status === 403) {
        logAudit({
          action: 'REMOVE_UNAUTHORIZED',
          meetingCode: uppercaseCode,
          hostId: auth.meeting?.host_id,
          participantId: userId
        })
      }
      return res.status(auth.status).json({
        success: false,
        code: auth.status === 403 ? 'FORBIDDEN' : (auth.status === 404 ? 'NOT_FOUND' : 'ERROR'),
        message: auth.message
      })
    }
    const meeting = auth.meeting

    // 2. Consolidated participant removal & reliable Cloudflare eviction with retries
    const removalResult = await executeParticipantRemoval({
      meeting,
      userId,
      initiatorUserId: req.user.id,
      dbClient: supabase,
      cfService: cloudflareService,
      ioInstance: req.app.get('io')
    })

    // 3. Emit Socket.IO event (Post-Commit)
    const io = req.app.get('io')
    if (io) {
      io.to(meeting.room_name).emit('participant_removed', { userId })
    }

    // 4. Structured audit log
    logAudit({
      action: 'Participant Removed',
      meetingCode: uppercaseCode,
      hostId: req.user.id,
      participantId: userId
    })

    return res.status(200).json({
      success: true,
      status: removalResult.status,
      message: 'Participant removed successfully.'
    })
  } catch (err) {
    console.error('[Security] removeParticipant error:', err)
    if (err.code === 'CANNOT_REMOVE_ORIGINAL_HOST') {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: err.message
      })
    }
    if (err.code === 'CANNOT_REMOVE_SELF') {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: err.message
      })
    }
    if (err.code === 'CLOUDFLARE_REVOCATION_PENDING') {
      return res.status(202).json({
        success: false,
        code: 'REVOCATION_PENDING',
        status: 'pending_revocation',
        message: err.message
      })
    }
    return res.status(500).json({
      success: false,
      code: err.code || 'SERVER_ERROR',
      message: err.message || 'Server error removing participant.'
    })
  }
}

/**
 * POST /api/meetings/security/mute-participant
 * Host moderator mutes or unmutes a participant's microphone.
 * Emits real-time Socket.IO event and authorizes host action.
 */
export const muteParticipant = async (req, res) => {
  try {
    const { meetingCode, participantIdentity, trackSid, mute } = req.body

    if (!meetingCode || !meetingCode.trim()) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter meetingCode is missing.'
      })
    }
    if (!participantIdentity || !participantIdentity.trim()) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter participantIdentity is missing.'
      })
    }
    if (!trackSid || !trackSid.trim()) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Participant microphone track SID is missing or participant has no active microphone track.'
      })
    }
    if (mute === undefined || mute === null) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter mute (boolean) is missing.'
      })
    }

    const uppercaseCode = meetingCode.trim().toUpperCase()

    // 1. Check host authorization (must be meeting host)
    const auth = await authorizeHost(uppercaseCode, req.user.id)
    if (!auth.passed) {
      if (auth.status === 403) {
        logAudit({
          action: 'MUTE_UNAUTHORIZED',
          meetingCode: uppercaseCode,
          hostId: auth.meeting?.host_id,
          participantId: participantIdentity
        })
      }
      return res.status(auth.status).json({
        success: false,
        code: auth.status === 403 ? 'FORBIDDEN' : (auth.status === 404 ? 'NOT_FOUND' : 'ERROR'),
        message: auth.message
      })
    }
    const meeting = auth.meeting
    const roomName = meeting.room_name

    // 2. Emit Socket.IO event to room so participant client executes local microphone disable
    const io = req.app.get('io')
    if (io) {
      io.to(roomName).emit('host_mute_toggle', {
        participantIdentity,
        trackSid,
        mute: !!mute
      })
      console.log(`[Security Socket] Emitted 'host_mute_toggle' (mute=${!!mute}) to room ${roomName} for ${participantIdentity}`)
    }

    // 3. Structured audit log
    logAudit({
      action: mute ? 'Host Muted Participant' : 'Host Unmuted Participant',
      meetingCode: uppercaseCode,
      hostId: req.user.id,
      participantId: participantIdentity
    })

    return res.status(200).json({
      success: true,
      muted: !!mute,
      message: mute ? 'Participant microphone muted.' : 'Participant microphone unmuted.'
    })
  } catch (err) {
    console.error('[Security Error] muteParticipant unexpected error:', err)
    return res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: err.message || 'Server error toggling participant microphone.'
    })
  }
}

/**
 * POST /api/meetings/security/toggle-mute-all
 * Meeting-wide Microphone Lock toggle (Host only).
 * When muteAllEnabled=true, locks microphones across all participants.
 * When muteAllEnabled=false, unlocks microphone controls without blindly unmuting everyone.
 */
export const toggleMuteAll = async (req, res) => {
  try {
    const { meetingCode, muteAllEnabled } = req.body
    if (!meetingCode || !meetingCode.trim()) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter meetingCode is missing.'
      })
    }
    if (muteAllEnabled === undefined || muteAllEnabled === null) {
      return res.status(400).json({
        success: false,
        code: 'BAD_REQUEST',
        message: 'Required parameter muteAllEnabled (boolean) is missing.'
      })
    }

    const uppercaseCode = meetingCode.trim().toUpperCase()

    // 1. Authorize host
    const auth = await authorizeHost(uppercaseCode, req.user.id)
    if (!auth.passed) {
      if (auth.status === 403) {
        logAudit({
          action: 'TOGGLE_MUTE_ALL_UNAUTHORIZED',
          meetingCode: uppercaseCode,
          hostId: auth.meeting?.host_id,
          participantId: req.user.id
        })
      }
      return res.status(auth.status).json({
        success: false,
        code: auth.status === 403 ? 'FORBIDDEN' : (auth.status === 404 ? 'NOT_FOUND' : 'ERROR'),
        message: auth.message
      })
    }
    const meeting = auth.meeting
    const roomName = meeting.room_name
    const isMuteAll = !!muteAllEnabled

    // 2. Update meeting mute_all_enabled state in memory store
    meetingMuteAllStore.set(String(meeting.meeting_id), isMuteAll)
    meetingMuteAllStore.set(String(uppercaseCode), isMuteAll)

    console.log(`[Security Mute All] Meeting ${meeting.meeting_id} (${uppercaseCode}) Mute All toggled to ${isMuteAll}`)

    // 3. Emit Socket.IO event to room so all clients update local muteAllEnabled state
    const io = req.app.get('io')
    if (io) {
      io.to(roomName).emit('meeting_mute_all_changed', {
        muteAllEnabled: isMuteAll
      })
      console.log(`[Security Socket] Emitted 'meeting_mute_all_changed' (${isMuteAll}) to room ${roomName}`)
    }

    // 4. Audit log
    logAudit({
      action: isMuteAll ? 'Mute All / Lock Microphones Enabled' : 'Mute All / Lock Microphones Disabled',
      meetingCode: uppercaseCode,
      hostId: req.user.id,
      value: isMuteAll
    })

    return res.status(200).json({
      success: true,
      muteAllEnabled: isMuteAll,
      message: isMuteAll ? 'Mute All / Microphone Lock enabled.' : 'Mute All / Microphone Lock disabled.'
    })
  } catch (err) {
    console.error('[Security Error] toggleMuteAll unexpected error:', err)
    return res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: err.message || 'Server error toggling Mute All status.'
    })
  }
}
