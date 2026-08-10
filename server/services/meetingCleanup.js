import { supabase } from '../config/supabase.js'
import { clearMeetingCounters } from './aiChat.service.js'

// In-memory map of active cleanup timeouts keyed by meeting_id
const activeCleanupTimers = new Map()

// Grace period in milliseconds (configurable, default: 45 seconds)
const GRACE_PERIOD_MS = parseInt(process.env.CLEANUP_GRACE_PERIOD_MS || '45000', 10)

/**
 * Schedules a meeting cleanup check if one is not already pending.
 */
export const scheduleCleanup = (meetingId, meetingCode, roomName) => {
  if (!meetingId) return
  console.log(`[Cleanup Function Call] scheduleCleanup called for meetingId: ${meetingId}, meetingCode: ${meetingCode}`)
  if (activeCleanupTimers.has(meetingId)) {
    console.log(`[Cleanup] Cleanup timer already active for meeting ${meetingId}.`)
    return
  }

  console.log(`[Cleanup] Scheduling meeting cleanup for ${meetingId} in ${GRACE_PERIOD_MS / 1000}s (0 active participants).`)

  const timer = setTimeout(async () => {
    try {
      activeCleanupTimers.delete(meetingId)

      // Double-check if there are still 0 active participants in the database
      const { data: activeParts, error: partErr } = await supabase
        .from('participants')
        .select('participant_id, role, participant_status')
        .eq('meeting_id', meetingId)
        .eq('participant_status', 'joined')

      if (partErr) throw partErr

      const activeCount = activeParts ? activeParts.length : 0

      if (activeCount === 0) {
        const now = new Date().toISOString()
        
        // Fetch meeting details for debug info
        const { data: mtgData } = await supabase.from('meetings').select('*').eq('meeting_id', meetingId).maybeSingle()

        console.log(`
[Meeting End Debug]
MeetingId: ${meetingId}
MeetingCode: ${meetingCode}
AuthenticatedUserId: SYSTEM_CLEANUP
HostId: ${mtgData?.host_id}
Trigger: scheduleCleanup Timer Expiry
ActiveSocketCount: N/A
HostSocketPresent: N/A
ActiveParticipantCount: 0
HostParticipantStatus: N/A
MeetingStatus: ${mtgData?.meeting_status}
Stack/Caller: setTimeout inside meetingCleanup.js
`)

        console.log(`[Cleanup] Grace period expired. Ending meeting ${meetingId} permanently.`)

        // 1. Update meeting status to Ended
        const { error: updateErr } = await supabase
          .from('meetings')
          .update({ meeting_status: 'Ended', ended_at: now, updated_at: now })
          .eq('meeting_id', meetingId)

        if (updateErr) throw updateErr

        // 1.5. Update remaining participant records status to left
        await supabase
          .from('participants')
          .update({ participant_status: 'left', left_at: now })
          .eq('meeting_id', meetingId)
          .in('participant_status', ['joined', 'active', 'disconnected'])

        // 2. Clean up waiting room requests and temporary bans
        if (meetingCode) {
          await supabase.from('meeting_device_bans').delete().eq('meeting_code', meetingCode)
          await supabase.from('meeting_join_requests').delete().eq('meeting_code', meetingCode)
          console.log(`[Cleanup] waiting room and device bans cleared for meeting ${meetingCode}`)
        }

        // 3. Clear meeting counters
        clearMeetingCounters(meetingId)
      } else {
        console.log(`[Cleanup] Grace period expired for meeting ${meetingId}, but active participants exist (count: ${activeCount}). Skipping cleanup.`)
      }
    } catch (err) {
      console.error(`[Cleanup Error] Failed to execute cleanup for meeting ${meetingId}:`, err)
    }
  }, GRACE_PERIOD_MS)

  activeCleanupTimers.set(meetingId, timer)
}

/**
 * Cancels a pending meeting cleanup check if a participant rejoins.
 */
export const cancelCleanup = (meetingId) => {
  if (!meetingId) return
  console.log(`[Cleanup Function Call] cancelCleanup called for meetingId: ${meetingId}`)
  if (activeCleanupTimers.has(meetingId)) {
    console.log(`[Cleanup] Participant rejoined meeting ${meetingId}. Cancelling pending cleanup timer.`)
    clearTimeout(activeCleanupTimers.get(meetingId))
    activeCleanupTimers.delete(meetingId)
  }
}
