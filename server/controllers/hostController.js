import { supabase } from '../config/supabase.js'
import { authorizeHost } from '../utils/authHelper.js'

// UUID validation helper
const isUuid = (val) => {
  if (!val) return false
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val)
}

/**
 * Helper: look up a user's full_name by their UUID.
 * Returns null if not found.
 */
const getUserName = async (userId) => {
  if (!userId) return null
  const { data } = await supabase
    .from('users')
    .select('full_name')
    .eq('id', userId)
    .maybeSingle()
  return data?.full_name || null
}

/**
 * GET /api/meetings/:meetingId/host-status
 * Returns the current host state for a meeting.
 * Any authenticated participant may call this.
 */
export const getHostStatus = async (req, res) => {
  try {
    const { meetingId } = req.params

    if (!meetingId) {
      return res.status(400).json({ success: false, message: 'meetingId is required.' })
    }

    const cleanInput = String(meetingId).trim()
    const query = isUuid(cleanInput)
      ? supabase.from('meetings').select('meeting_id, host_id, assigned_host_id, active_host_id, meeting_status, is_deleted').eq('meeting_id', cleanInput)
      : supabase.from('meetings').select('meeting_id, host_id, assigned_host_id, active_host_id, meeting_status, is_deleted').eq('meeting_code', cleanInput.toUpperCase())

    const { data: meeting, error } = await query.maybeSingle()

    if (error) throw error
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' })
    }

    // Fetch display names in parallel
    const [hostName, assignedHostName, activeHostName] = await Promise.all([
      getUserName(meeting.host_id),
      getUserName(meeting.assigned_host_id),
      getUserName(meeting.active_host_id)
    ])

    return res.status(200).json({
      success: true,
      host_id: meeting.host_id,
      host_name: hostName,
      assigned_host_id: meeting.assigned_host_id || null,
      assigned_host_name: assignedHostName || null,
      active_host_id: meeting.active_host_id || null,
      active_host_name: activeHostName || null
    })
  } catch (err) {
    console.error('[HostController] getHostStatus error:', err)
    return res.status(500).json({ success: false, message: 'Server error retrieving host status.' })
  }
}

/**
 * POST /api/meetings/:meetingId/assign-host
 * Assigns a participant as the designated backup (Assigned Host).
 * Does NOT change active_host_id.
 * Authorization: ownership — only meeting.host_id may call this.
 *
 * Body: { userId }
 *
 * Validation:
 *  1. userId is a valid UUID.
 *  2. userId is not the Original Host.
 *  3. userId is an existing participant with status 'joined'.
 *  4. userId is currently connected to the meeting room (per roomUserSockets).
 */
export const assignHost = async (req, res) => {
  try {
    const { meetingId } = req.params
    const { userId } = req.body

    if (!meetingId) {
      return res.status(400).json({ success: false, message: 'meetingId is required.' })
    }
    if (!userId || !isUuid(userId)) {
      return res.status(400).json({ success: false, message: 'A valid userId (UUID) is required.' })
    }

    // Authorization: only the Original Host (host_id) can assign
    const auth = await authorizeHost(meetingId, req.user.id, 'ownership')
    if (!auth.passed) {
      return res.status(auth.status).json({
        success: false,
        code: auth.status === 403 ? 'FORBIDDEN' : auth.status === 404 ? 'NOT_FOUND' : 'ERROR',
        message: auth.message
      })
    }
    const meeting = auth.meeting

    // Cannot assign the Original Host as Assigned Host
    if (String(userId).toLowerCase() === String(meeting.host_id).toLowerCase()) {
      return res.status(400).json({
        success: false,
        message: 'The Original Host cannot be assigned as the Assigned Host.'
      })
    }

    // Validate: participant must exist with status 'joined' in this meeting
    const { data: participant, error: partErr } = await supabase
      .from('participants')
      .select('participant_id, participant_status, user_id')
      .eq('meeting_id', meeting.meeting_id)
      .eq('user_id', userId)
      .maybeSingle()

    if (partErr) throw partErr
    if (!participant) {
      return res.status(404).json({
        success: false,
        message: 'The selected user is not a participant in this meeting.'
      })
    }
    if (participant.participant_status !== 'joined') {
      return res.status(400).json({
        success: false,
        message: `Participant must be actively joined (status='joined'). Current status: '${participant.participant_status}'.`
      })
    }

    // Validate: participant must be currently connected (socket presence)
    const roomUserSockets = req.app.get('roomUserSockets')
    const userKey = String(userId).trim().toLowerCase()
    const userSockets = roomUserSockets?.get(meeting.room_name)?.get(userKey)
    const isConnected = userSockets && userSockets.size > 0
    if (!isConnected) {
      return res.status(400).json({
        success: false,
        message: 'The selected participant is not currently connected to the meeting.'
      })
    }

    // Update: set assigned_host_id only — do NOT touch active_host_id
    const { error: updateErr } = await supabase
      .from('meetings')
      .update({ assigned_host_id: userId, updated_at: new Date().toISOString() })
      .eq('meeting_id', meeting.meeting_id)

    if (updateErr) throw updateErr

    // Fetch names for socket payload
    const [assignedHostName, activeHostName] = await Promise.all([
      getUserName(userId),
      getUserName(meeting.active_host_id)
    ])

    // Emit host_assigned to all participants in the room
    const io = req.app.get('io')
    if (io) {
      io.to(meeting.room_name).emit('host_assigned', {
        originalHostId: meeting.host_id,
        assignedHostId: userId,
        assignedHostName: assignedHostName || userId,
        activeHostId: meeting.active_host_id,
        activeHostName: activeHostName || null
      })
    }

    console.log(`[HostController] assignHost: meeting=${meeting.meeting_id} assignedHost=${userId} (assigned by originalHost=${req.user.id}). active_host_id unchanged.`)

    return res.status(200).json({
      success: true,
      message: `${assignedHostName || userId} has been designated as the Assigned Host.`,
      assigned_host_id: userId,
      assigned_host_name: assignedHostName
    })
  } catch (err) {
    console.error('[HostController] assignHost error:', err)
    return res.status(500).json({ success: false, message: 'Server error assigning host.' })
  }
}

/**
 * DELETE /api/meetings/:meetingId/assigned-host
 * Clears the Assigned Host designation.
 * Does NOT change active_host_id.
 * Authorization: ownership — only meeting.host_id may call this.
 */
export const removeAssignedHost = async (req, res) => {
  try {
    const { meetingId } = req.params

    if (!meetingId) {
      return res.status(400).json({ success: false, message: 'meetingId is required.' })
    }

    // Authorization: only the Original Host (host_id) can remove the assignment
    const auth = await authorizeHost(meetingId, req.user.id, 'ownership')
    if (!auth.passed) {
      return res.status(auth.status).json({
        success: false,
        code: auth.status === 403 ? 'FORBIDDEN' : auth.status === 404 ? 'NOT_FOUND' : 'ERROR',
        message: auth.message
      })
    }
    const meeting = auth.meeting

    if (!meeting.assigned_host_id) {
      return res.status(400).json({
        success: false,
        message: 'There is no Assigned Host to remove.'
      })
    }

    // Update: clear assigned_host_id only — do NOT touch active_host_id
    const { error: updateErr } = await supabase
      .from('meetings')
      .update({ assigned_host_id: null, updated_at: new Date().toISOString() })
      .eq('meeting_id', meeting.meeting_id)

    if (updateErr) throw updateErr

    // Emit host_removed to all participants in the room
    const io = req.app.get('io')
    if (io) {
      const activeHostName = await getUserName(meeting.active_host_id)
      io.to(meeting.room_name).emit('host_removed', {
        originalHostId: meeting.host_id,
        activeHostId: meeting.active_host_id,
        activeHostName: activeHostName || null
      })
    }

    console.log(`[HostController] removeAssignedHost: meeting=${meeting.meeting_id} clearedAssignedHost=${meeting.assigned_host_id} (by originalHost=${req.user.id}). active_host_id unchanged.`)

    return res.status(200).json({
      success: true,
      message: 'Assigned Host designation has been removed.'
    })
  } catch (err) {
    console.error('[HostController] removeAssignedHost error:', err)
    return res.status(500).json({ success: false, message: 'Server error removing assigned host.' })
  }
}
