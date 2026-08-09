import { supabase } from '../config/supabase.js'

// UUID validation helper
const isUuid = (val) => {
  if (!val) return false
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val)
}

/**
 * Shared helper to verify if the authenticated user is the meeting host.
 * Resolves the meeting from database and checks authorization.
 * Returns { passed: boolean, meeting: object, status: number, message: string }
 */
export const authorizeHost = async (meetingIdOrCode, userId) => {
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

    // Convert both to string and lowercase to avoid any type/casing mismatch
    const hostIdStr = String(meeting.host_id).trim().toLowerCase()
    const userIdStr = String(userId).trim().toLowerCase()
    const passed = hostIdStr === userIdStr

    console.log(`\n==================================================`)
    console.log(`Meeting Host ID: ${meeting.host_id}`)
    console.log(`Authenticated User ID: ${userId}`)
    console.log(`Meeting Code: ${meeting.meeting_code}`)
    console.log(`Authorization Passed: ${passed}`)
    console.log(`==================================================\n`)

    if (!passed) {
      return {
        passed: false,
        status: 403,
        message: 'Unauthorized. Only the meeting host can perform this action.',
        meeting
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
