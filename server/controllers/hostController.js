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

    // Update: set BOTH assigned_host_id AND active_host_id immediately.
    // Assigning a host is an IMMEDIATE Active Host transfer — do not wait for Original Host to leave.
    const { error: updateErr } = await supabase
      .from('meetings')
      .update({
        assigned_host_id: userId,
        active_host_id: userId,
        updated_at: new Date().toISOString()
      })
      .eq('meeting_id', meeting.meeting_id)

    if (updateErr) throw updateErr

    // Fetch names for socket payload
    const [assignedHostName, originalHostName] = await Promise.all([
      getUserName(userId),
      getUserName(meeting.host_id)
    ])

    const io = req.app.get('io')
    if (io) {
      // Emit host_assigned so all clients know the designated backup changed
      io.to(meeting.room_name).emit('host_assigned', {
        originalHostId: meeting.host_id,
        originalHostName: originalHostName || null,
        assignedHostId: userId,
        assignedHostName: assignedHostName || userId,
        activeHostId: userId,
        activeHostName: assignedHostName || userId
      })

      // Emit active_host_changed so all clients immediately switch Active Host controls
      io.to(meeting.room_name).emit('active_host_changed', {
        originalHostId: meeting.host_id,
        assignedHostId: userId,
        activeHostId: userId,
        activeHostName: assignedHostName || userId
      })
    }

    console.log(`[HostController] assignHost: meeting=${meeting.meeting_id} assignedHost=${userId} activeHost=${userId} (assigned by originalHost=${req.user.id}). IMMEDIATE active host transfer.`)

    return res.status(200).json({
      success: true,
      message: `${assignedHostName || userId} is now the Active Host.`,
      assigned_host_id: userId,
      assigned_host_name: assignedHostName,
      active_host_id: userId
    })
  } catch (err) {
    console.error('[HostController] assignHost error:', err)
    return res.status(500).json({ success: false, message: 'Server error assigning host.' })
  }
}

/**
 * DELETE /api/meetings/:meetingId/assigned-host
 * Clears the Assigned Host designation.
 * If the Assigned Host was also the Active Host, restores active_host_id to the Original Host.
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

    // Determine whether the Assigned Host was also the Active Host
    const assignedWasActive = meeting.assigned_host_id &&
      String(meeting.assigned_host_id).toLowerCase() === String(meeting.active_host_id || '').toLowerCase()

    // Build the DB update: always clear assigned_host_id.
    // If they were the Active Host, restore active_host_id to the Original Host.
    const updatePayload = {
      assigned_host_id: null,
      updated_at: new Date().toISOString()
    }
    if (assignedWasActive) {
      updatePayload.active_host_id = meeting.host_id
    }

    const { error: updateErr } = await supabase
      .from('meetings')
      .update(updatePayload)
      .eq('meeting_id', meeting.meeting_id)

    if (updateErr) throw updateErr

    const newActiveHostId = assignedWasActive ? meeting.host_id : meeting.active_host_id
    const io = req.app.get('io')
    if (io) {
      const [newActiveHostName, originalHostName] = await Promise.all([
        getUserName(newActiveHostId),
        getUserName(meeting.host_id)
      ])

      // Emit host_removed so all clients clear assignedHostId
      io.to(meeting.room_name).emit('host_removed', {
        originalHostId: meeting.host_id,
        originalHostName: originalHostName || null,
        activeHostId: newActiveHostId,
        activeHostName: newActiveHostName || null
      })

      // If active host changed, emit active_host_changed so all clients sync permissions immediately
      if (assignedWasActive) {
        io.to(meeting.room_name).emit('active_host_changed', {
          originalHostId: meeting.host_id,
          assignedHostId: null,
          activeHostId: meeting.host_id,
          activeHostName: originalHostName || meeting.host_id
        })
      }
    }

    console.log(`[HostController] removeAssignedHost: meeting=${meeting.meeting_id} clearedAssignedHost=${meeting.assigned_host_id} assignedWasActive=${assignedWasActive} newActiveHostId=${newActiveHostId} (by originalHost=${req.user.id}).`)

    return res.status(200).json({
      success: true,
      message: 'Assigned Host designation has been removed.',
      active_host_id: newActiveHostId
    })
  } catch (err) {
    console.error('[HostController] removeAssignedHost error:', err)
    return res.status(500).json({ success: false, message: 'Server error removing assigned host.' })
  }
}
