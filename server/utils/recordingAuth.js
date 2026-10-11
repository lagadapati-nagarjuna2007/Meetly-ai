import { supabase } from '../config/supabase.js'

const isUuid = (val) => {
  if (!val) return false
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val)
}

/**
 * Resolves meeting by UUID meeting_id or uppercase meeting_code.
 */
export const getMeetingByIdOrCode = async (meetingIdOrCode) => {
  if (!meetingIdOrCode) return null
  const cleanInput = String(meetingIdOrCode).trim()
  const uppercaseCode = cleanInput.toUpperCase()

  const query = isUuid(cleanInput)
    ? supabase.from('meetings').select('*').eq('meeting_id', cleanInput)
    : supabase.from('meetings').select('*').eq('meeting_code', uppercaseCode)

  const { data: meeting } = await query.maybeSingle()
  if (meeting) return meeting

  // If cleanInput is a UUID, check if it matches a recording_id directly
  if (isUuid(cleanInput)) {
    const { data: rec } = await supabase
      .from('recordings')
      .select('meeting_id')
      .eq('recording_id', cleanInput)
      .maybeSingle()
    if (rec?.meeting_id) {
      const { data: mtg } = await supabase
        .from('meetings')
        .select('*')
        .eq('meeting_id', rec.meeting_id)
        .maybeSingle()
      if (mtg) return mtg
    }
  }

  return null
}

/**
 * Checks if a user is the Original Host or the currently authorized Active Host.
 * Allowed to start, stop, part-url, complete, abort, and download recordings.
 */
export const authorizeRecordingHost = async (meetingIdOrCode, userId) => {
  if (!meetingIdOrCode || !userId) {
    return { passed: false, status: 401, message: 'Authentication and meeting identifier required.' }
  }

  const meeting = await getMeetingByIdOrCode(meetingIdOrCode)
  if (!meeting) {
    return { passed: false, status: 404, message: 'Meeting not found.' }
  }

  const userIdStr = String(userId).trim().toLowerCase()
  const origHost = String(meeting.host_id || '').trim().toLowerCase()
  const activeHost = meeting.active_host_id
    ? String(meeting.active_host_id).trim().toLowerCase()
    : origHost

  const isHost = (userIdStr === origHost) || (userIdStr === activeHost)
  if (!isHost) {
    return {
      passed: false,
      status: 403,
      message: 'Unauthorized. Only the Meeting Host or Active Host can manage recordings.',
      meeting
    }
  }

  return { passed: true, meeting, isOriginalHost: userIdStr === origHost, isActiveHost: userIdStr === activeHost }
}

/**
 * Checks if a user is authorized to stream or view recording metadata:
 * - Original Host
 * - Active Host
 * - Historical Attendee (row exists in participants with joined_at != null or status in ('joined', 'left'))
 */
export const authorizeRecordingViewer = async (meetingIdOrCode, userId) => {
  if (!meetingIdOrCode || !userId) {
    return { passed: false, status: 401, message: 'Authentication required.' }
  }

  const meeting = await getMeetingByIdOrCode(meetingIdOrCode)
  if (!meeting) {
    return { passed: false, status: 404, message: 'Meeting not found.' }
  }

  const userIdStr = String(userId).trim().toLowerCase()
  const origHost = String(meeting.host_id || '').trim().toLowerCase()
  const activeHost = meeting.active_host_id
    ? String(meeting.active_host_id).trim().toLowerCase()
    : origHost

  // Host or active host passes immediately
  if (userIdStr === origHost || userIdStr === activeHost) {
    return {
      passed: true,
      meeting,
      role: userIdStr === origHost ? 'owner' : 'active_host',
      canDownload: true
    }
  }

  // Check historical attendance from participants table
  const { data: participant, error } = await supabase
    .from('participants')
    .select('participant_id, participant_status, joined_at')
    .eq('meeting_id', meeting.meeting_id)
    .eq('user_id', userId)
    .maybeSingle()

  if (error || !participant) {
    return {
      passed: false,
      status: 403,
      message: 'Unauthorized. You did not attend this meeting.',
      meeting
    }
  }

  // Verify historical attendance proof (either has joined_at timestamp or status is joined/left)
  const hasAttended = Boolean(
    participant.joined_at ||
    participant.participant_status === 'joined' ||
    participant.participant_status === 'left'
  )

  if (!hasAttended) {
    return {
      passed: false,
      status: 403,
      message: 'Unauthorized. Attendance record indicates you did not attend.',
      meeting
    }
  }

  return {
    passed: true,
    meeting,
    role: 'attendee',
    canDownload: false // Attendees can only stream, not download
  }
}
