import { supabase as defaultSupabase } from '../config/supabase.js'
import { clearMeetingCounters } from './aiChat.service.js'
import { clearMeetingChat } from './meetingChatService.js'

let activeDbClient = defaultSupabase
let expirationSweepInterval = null
let globalIo = null

// In-memory timers: Map<meetingId, NodeJS.Timeout>
const meetingExpirationTimers = new Map()

// Dependency injection for unit tests
export const setDatabaseClient = (client) => {
  activeDbClient = client
}

export const resetDatabaseClient = () => {
  activeDbClient = defaultSupabase
}

export const setGlobalIo = (io) => {
  globalIo = io
}

export const getActiveTimersCount = () => {
  return meetingExpirationTimers.size
}

/**
 * Cancels any pending in-memory expiration timer for a meeting.
 */
export const cancelMeetingExpiration = (meetingId) => {
  if (!meetingId) return
  const idStr = String(meetingId).trim()
  if (meetingExpirationTimers.has(idStr)) {
    clearTimeout(meetingExpirationTimers.get(idStr))
    meetingExpirationTimers.delete(idStr)
    console.log(`[MeetingExpiration] Cancelled expiration timer for meeting: ${idStr}`)
  }
}

/**
 * Atomically terminates an expired meeting and runs full lifecycle cleanup.
 * Concurrency guard: Only executes if meeting_status is currently 'Active'.
 */
export const expireMeetingNow = async (meetingId, ioInstance = null) => {
  if (!meetingId) return { success: false, reason: 'missing_id' }
  const idStr = String(meetingId).trim()

  // Cancel any scheduled in-memory timer
  cancelMeetingExpiration(idStr)

  const db = activeDbClient
  let updatedMeeting = null

  try {
    // Authoritative DB transition: Active -> Ended
    // The production migration is a strict prerequisite. We rely exclusively on the database RPC
    // expire_meeting_if_eligible to evaluate clock_timestamp() directly on the database engine.
    // On RPC failure, log the error and return a retryable failure without ending the meeting using application-server time.
    if (typeof db.rpc !== 'function') {
      const err = new Error('Database client does not support RPC')
      console.error(`[MeetingExpiration] RPC not available on database client for meeting ${idStr}:`, err)
      return { success: false, error: err, retryable: true, reason: 'rpc_unavailable' }
    }

    const { data: rpcData, error: rpcErr } = await db.rpc('expire_meeting_if_eligible', {
      p_meeting_id: idStr
    })

    if (rpcErr) {
      console.error(`[MeetingExpiration] Database RPC expire_meeting_if_eligible failed for meeting ${idStr}:`, rpcErr)
      return { success: false, error: rpcErr, retryable: true, reason: 'rpc_error' }
    }

    if (!rpcData || rpcData.length === 0 || !rpcData[0].success) {
      console.log(`[MeetingExpiration] Meeting ${idStr} is not eligible for expiration (RPC confirmed not active or scheduled deadline is in the future). Skipping duplicate or stale expiration.`)
      return { success: false, reason: 'ineligible_or_already_ended' }
    }

    const row = rpcData[0]
    updatedMeeting = {
      meeting_id: idStr,
      room_name: row.room_name,
      meeting_code: row.meeting_code,
      host_id: row.host_id,
      scheduled_end_time: row.scheduled_end_time,
      ended_at: row.ended_at
    }

    console.log(`[MeetingExpiration] Meeting ${updatedMeeting.meeting_id} reached its scheduled deadline and has been automatically ended.`)

    const transitionTime = updatedMeeting.ended_at || new Date().toISOString()

    // 2. Mark active participants as 'left'
    const { error: partErr } = await db
      .from('participants')
      .update({
        participant_status: 'left',
        left_at: transitionTime
      })
      .eq('meeting_id', idStr)
      .in('participant_status', ['joined', 'active', 'disconnected'])

    if (partErr) {
      console.warn(`[MeetingExpiration] Error marking participants left for ${idStr}:`, partErr)
    }

    // 3. Clear meeting-scoped security records (device bans and join requests)
    if (updatedMeeting.meeting_code) {
      await db.from('meeting_device_bans').delete().eq('meeting_code', updatedMeeting.meeting_code)
      await db.from('meeting_join_requests').delete().eq('meeting_code', updatedMeeting.meeting_code)
    }

    // 4. Clear meeting quota counters & ephemeral chat
    await clearMeetingCounters(idStr)
    if (updatedMeeting.room_name) {
      clearMeetingChat(updatedMeeting.room_name)
    }

    // 5. Broadcast real-time termination to all connected participants
    const io = ioInstance || globalIo
    if (io && updatedMeeting.room_name) {
      io.to(updatedMeeting.room_name).emit('chat:cleared')
      io.to(updatedMeeting.room_name).emit('meeting_ended', {
        reason: 'duration_expired',
        message: 'The meeting duration has ended.'
      })
      console.log(`[MeetingExpiration] Emitted 'meeting_ended' (duration_expired) to room: ${updatedMeeting.room_name}`)
    }

    return { success: true, meeting: updatedMeeting }
  } catch (err) {
    console.error(`[MeetingExpiration] Unexpected error expiring meeting ${idStr}:`, err)
    return { success: false, error: err }
  }
}

/**
 * Schedules an in-memory precision timer to automatically expire an active meeting at scheduledEndTime.
 */
export const scheduleMeetingExpiration = (meetingId, scheduledEndTime, ioInstance = null) => {
  if (!meetingId || !scheduledEndTime) return null
  const idStr = String(meetingId).trim()

  // Clear existing timer if any
  cancelMeetingExpiration(idStr)

  const endMs = new Date(scheduledEndTime).getTime()
  const nowMs = Date.now()
  const delayMs = endMs - nowMs

  if (delayMs <= 0) {
    console.log(`[MeetingExpiration] Scheduled end time for ${idStr} has already passed. Expiring immediately.`)
    // Execute asynchronously to avoid blocking the caller
    setImmediate(async () => {
      const res = await expireMeetingNow(idStr, ioInstance)
      if (!res?.success && res?.retryable) {
        const retryTimer = setTimeout(() => {
          meetingExpirationTimers.delete(idStr)
          expireMeetingNow(idStr, ioInstance)
        }, 2000)
        if (retryTimer.unref) retryTimer.unref()
        meetingExpirationTimers.set(idStr, retryTimer)
      }
    })
    return null
  }

  console.log(`[MeetingExpiration] Scheduled expiration for meeting ${idStr} in ${Math.round(delayMs / 1000)}s (at ${scheduledEndTime})`)

  const timer = setTimeout(async () => {
    meetingExpirationTimers.delete(idStr)
    const res = await expireMeetingNow(idStr, ioInstance)
    if (!res?.success) {
      if (res?.retryable) {
        console.warn(`[MeetingExpiration] Expiration for meeting ${idStr} failed with retryable error. Scheduling retry in 2000ms.`)
        const retryTimer = setTimeout(() => {
          meetingExpirationTimers.delete(idStr)
          expireMeetingNow(idStr, ioInstance)
        }, 2000)
        if (retryTimer.unref) retryTimer.unref()
        meetingExpirationTimers.set(idStr, retryTimer)
      } else if (res?.reason === 'ineligible_or_already_ended') {
        // Double-check if meeting is still Active in the database:
        // Could be due to minor clock skew between app server and database clock_timestamp(),
        // OR the host extended the meeting deadline.
        try {
          const { data: mtg } = await activeDbClient
            .from('meetings')
            .select('meeting_id, meeting_status, scheduled_end_time')
            .eq('meeting_id', idStr)
            .maybeSingle()

          if (mtg && mtg.meeting_status === 'Active' && mtg.scheduled_end_time) {
            const targetMs = new Date(mtg.scheduled_end_time).getTime()
            const currentMs = Date.now()
            if (targetMs > currentMs + 3000) {
              console.log(`[MeetingExpiration] Meeting ${idStr} was extended. Rescheduling expiration timer for ${mtg.scheduled_end_time}.`)
              scheduleMeetingExpiration(idStr, mtg.scheduled_end_time, ioInstance)
            } else {
              console.log(`[MeetingExpiration] Meeting ${idStr} still Active within clock skew window. Retrying expiration in 2000ms.`)
              const retryTimer = setTimeout(() => {
                meetingExpirationTimers.delete(idStr)
                expireMeetingNow(idStr, ioInstance)
              }, 2000)
              if (retryTimer.unref) retryTimer.unref()
              meetingExpirationTimers.set(idStr, retryTimer)
            }
          }
        } catch (skewErr) {
          console.warn(`[MeetingExpiration] Error inspecting meeting state after ineligible expiration:`, skewErr)
        }
      }
    }
  }, delayMs)

  // Prevent node process from hanging if this timer is active during tests
  if (timer.unref) {
    timer.unref()
  }

  meetingExpirationTimers.set(idStr, timer)
  return timer
}

/**
 * Sweep worker: checks the database for any active meetings that have passed their scheduled_end_time.
 * Guarantees recovery after server restarts and catches missed timers.
 */
export const runExpirationSweep = async (ioInstance = null) => {
  const db = activeDbClient
  try {
    const nowIso = new Date().toISOString()
    const { data: overdueMeetings, error } = await db
      .from('meetings')
      .select('meeting_id, scheduled_end_time, room_name, meeting_status')
      .eq('meeting_status', 'Active')
      .eq('is_deleted', false)
      .not('scheduled_end_time', 'is', null)
      .lte('scheduled_end_time', nowIso)

    if (error) {
      console.error('[MeetingExpiration] Error querying overdue meetings during sweep:', error)
      return { expiredCount: 0, error }
    }

    if (!overdueMeetings || overdueMeetings.length === 0) {
      return { expiredCount: 0 }
    }

    console.log(`[MeetingExpiration] Found ${overdueMeetings.length} overdue active meeting(s). Processing expiration...`)
    let expiredCount = 0

    for (const mtg of overdueMeetings) {
      const res = await expireMeetingNow(mtg.meeting_id, ioInstance)
      if (res.success) expiredCount++
    }

    return { expiredCount }
  } catch (err) {
    console.error('[MeetingExpiration] Unexpected error during expiration sweep:', err)
    return { expiredCount: 0, error: err }
  }
}

/**
 * Initializes the background expiration worker on server startup.
 * 1. Sweeps and expires any meetings that reached their deadline while the server was down.
 * 2. Restores in-memory timers for any remaining active meetings with future deadlines.
 * 3. Starts a 10-second background interval sweep for continuous durability.
 */
export const initMeetingExpirationWorker = async (io = null) => {
  if (io) globalIo = io

  console.log('[MeetingExpiration] Initializing meeting expiration worker...')

  // Step 1: Immediate sweep of overdue meetings
  await runExpirationSweep(globalIo)

  // Step 2: Restore timers for upcoming active meetings
  try {
    const nowIso = new Date().toISOString()
    const { data: upcomingMeetings, error } = await activeDbClient
      .from('meetings')
      .select('meeting_id, scheduled_end_time')
      .eq('meeting_status', 'Active')
      .eq('is_deleted', false)
      .not('scheduled_end_time', 'is', null)
      .gt('scheduled_end_time', nowIso)

    if (!error && upcomingMeetings) {
      console.log(`[MeetingExpiration] Restoring timers for ${upcomingMeetings.length} active meeting(s)`)
      for (const mtg of upcomingMeetings) {
        scheduleMeetingExpiration(mtg.meeting_id, mtg.scheduled_end_time, globalIo)
      }
    }
  } catch (err) {
    console.error('[MeetingExpiration] Error restoring upcoming active meeting timers:', err)
  }

  // Step 3: Start recurring periodic sweep every 10 seconds
  if (expirationSweepInterval) {
    clearInterval(expirationSweepInterval)
  }

  expirationSweepInterval = setInterval(() => {
    runExpirationSweep(globalIo)
  }, 10000)

  if (expirationSweepInterval.unref) {
    expirationSweepInterval.unref()
  }

  console.log('[MeetingExpiration] Meeting expiration worker active (10s sweep interval).')
}

/**
 * Stops the background sweep interval and clears in-memory timers (for graceful shutdown / tests).
 */
export const stopMeetingExpirationWorker = () => {
  if (expirationSweepInterval) {
    clearInterval(expirationSweepInterval)
    expirationSweepInterval = null
  }
  for (const timer of meetingExpirationTimers.values()) {
    clearTimeout(timer)
  }
  meetingExpirationTimers.clear()
  console.log('[MeetingExpiration] Worker stopped and timers cleared.')
}
