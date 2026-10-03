import { supabase } from '../config/supabase.js'

// UUID validation helper
const isUuid = (val) => {
  if (!val) return false
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val)
}

/**
 * Shared helper to verify host authorization for meeting operations.
 *
 * mode = 'manage'   (default) — checks userId === meeting.active_host_id
 *                               Used by all meeting-management endpoints (mute, remove, ban, end, lock, etc.)
 *                               Does NOT fall back to host_id. The Original Host passes because they
 *                               are normally also the Active Host. If they have disconnected and
 *                               another user became active_host_id, the disconnected Original Host
 *                               will correctly fail.
 *
 * mode = 'ownership'          — checks userId === meeting.host_id only
 *                               Used exclusively by host-assignment endpoints (assign, remove assigned host).
 *
 * Returns { passed: boolean, meeting: object, status: number, message: string }
 */
export const authorizeHost = async (meetingIdOrCode, userId, mode = 'manage') => {
  try {
    if (!meetingIdOrCode) {
      return {
        passed: false,
        status: 400,
        message: 'Meeting identifier is required.'
      }
    }

    if (!userId) {
      return {
        passed: false,
        status: 401,
        message: 'Authentication required.'
      }
    }

    const cleanInput = String(meetingIdOrCode).trim()
    const uppercaseCode = cleanInput.toUpperCase()

    const query = isUuid(cleanInput)
      ? supabase.from('meetings').select('*').eq('meeting_id', cleanInput)
      : supabase.from('meetings').select('*').eq('meeting_code', uppercaseCode)

    const { data: meeting, error: fetchErr } = await query.maybeSingle()

    if (fetchErr) {
      console.error('[AuthorizeHost Error] DB fetch failed:', fetchErr)
      return {
        passed: false,
        status: 500,
        message: 'Database error verifying host authorization.'
      }
    }

    if (!meeting) {
      return {
        passed: false,
        status: 404,
        message: 'Meeting not found.'
      }
    }

    const userIdStr = String(userId).trim().toLowerCase()

    let passed = false
    let authorizedId = null

    if (mode === 'ownership') {
      // Ownership: only the permanent Original Host (host_id) is allowed.
      // Used for assign-host and remove-assigned-host operations.
      authorizedId = String(meeting.host_id || '').trim().toLowerCase()
      passed = authorizedId === userIdStr

      console.log(`\n==================================================`)
      console.log(`[HOST AUTH DEBUG] mode=ownership\nauthenticatedUserId: ${userId}\nmeetingId: ${meeting.meeting_id}\noriginalHostId: ${meeting.host_id}\npassed: ${passed}`)
      console.log(`==================================================\n`)

      if (!passed) {
        return {
          passed: false,
          status: 403,
          message: `Unauthorized. Only the Original Host can perform this action. (OriginalHost: ${authorizedId}, User: ${userIdStr})`,
          meeting
        }
      }
    } else {
      // Management: only the current Active Host (active_host_id) is allowed.
      // Does NOT fall back to host_id. The Original Host naturally passes when
      // active_host_id === host_id (normal state). When disconnected, they fail correctly.
      //
      // NOTE: if active_host_id is NULL (e.g., meeting has no active host yet after migration),
      // we fall back to host_id to prevent breaking existing meetings that were created
      // before active_host_id was populated.
      const activeHostId = meeting.active_host_id
        ? String(meeting.active_host_id).trim().toLowerCase()
        : String(meeting.host_id || '').trim().toLowerCase()

      passed = activeHostId === userIdStr

      console.log(`\n==================================================`)
      console.log(`[HOST AUTH DEBUG] mode=manage\nauthenticatedUserId: ${userId}\nmeetingId: ${meeting.meeting_id}\nactiveHostId: ${meeting.active_host_id || '(null→fallback to host_id)'}\noriginalHostId: ${meeting.host_id}\npassed: ${passed}`)
      console.log(`==================================================\n`)

      if (!passed) {
        return {
          passed: false,
          status: 403,
          message: `Unauthorized. Only the Active Host can perform this action. (ActiveHost: ${activeHostId}, User: ${userIdStr})`,
          meeting
        }
      }
    }

    return { passed: true, meeting }
  } catch (err) {
    console.error('[AuthorizeHost Error] Unexpected error:', err)
    return {
      passed: false,
      status: 500,
      message: 'Server error verifying host authorization.'
    }
  }
}
