import { supabase } from '../config/supabase.js'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { cancelCleanup } from '../services/meetingCleanup.js'
import { authorizeHost } from '../utils/authHelper.js'

// Helper for structured audit logging
const logAudit = ({ action, meetingCode, hostId, participantId, value }) => {
  const timestamp = new Date().toISOString()
  console.log(
    `[Audit Log] Action: ${action} | Timestamp: ${timestamp} | MeetingCode: ${meetingCode || 'N/A'} | HostId: ${hostId || 'N/A'} | ParticipantId: ${participantId || 'N/A'} | Value: ${value !== undefined ? value : 'N/A'}`
  )
}

// UUID validation helper
const isUuid = (val) => {
  if (!val) return false
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val)
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
 * Host accepts a pending participant using atomic db transaction
 */
export const acceptJoinRequest = async (req, res) => {
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

    // 1. Verify meeting exists and caller is host
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
    const meeting = auth.meeting

    // 2. Execute transaction inside PostgreSQL RPC function
    const { data: fingerprint, error: txErr } = await supabase
      .rpc('accept_join_request_tx', {
        p_meeting_code: uppercaseCode,
        p_user_id: userId
      })

    if (txErr) {
      console.error('[Security Transaction Error] accept_join_request_tx failed:', txErr)
      return res.status(400).json({
        success: false,
        code: 'TRANSACTION_FAILED',
        message: txErr.message || 'Database transaction failed.'
      })
    }

    // 3. Fetch user record to issue LiveKit token
    const { data: userRecord } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .maybeSingle()

    if (!userRecord) {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: 'User record not found.'
      })
    }

    // 4. Generate LiveKit token
    const apiKey = process.env.LIVEKIT_API_KEY
    const apiSecret = process.env.LIVEKIT_API_SECRET
    const livekitUrl = process.env.LIVEKIT_URL

    const at = new AccessToken(apiKey, apiSecret, {
      identity: userRecord.email || userRecord.id,
      name: userRecord.full_name,
      metadata: JSON.stringify({ userId: userRecord.id, role: 'participant' })
    })

    at.addGrant({
      roomJoin: true,
      room: meeting.room_name,
      canPublish: true,
      canSubscribe: true
    })

    const token = await at.toJwt()

    cancelCleanup(meeting.meeting_id)

    // 5. Emit Socket.IO events (Post-Commit)
    const io = req.app.get('io')
    if (io) {
      io.to(meeting.room_name).emit('participant_accepted', {
        userId,
        token,
        livekitUrl: livekitUrl || 'ws://localhost:7880',
        roomName: meeting.room_name
      })
      io.to(meeting.room_name).emit('waiting_list_updated')
    }

    // 6. Structured audit log
    logAudit({
      action: 'Participant Accepted',
      meetingCode: uppercaseCode,
      hostId: req.user.id,
      participantId: userId
    })

    return res.status(200).json({ success: true, message: 'Participant accepted.' })
  } catch (err) {
    console.error('[Security] acceptJoinRequest error:', err)
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
      return res.status(400).json({
        success: false,
        code: 'TRANSACTION_FAILED',
        message: txErr.message || 'Database transaction failed.'
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
      return res.status(400).json({
        success: false,
        code: 'TRANSACTION_FAILED',
        message: txErr.message || 'Database transaction failed.'
      })
    }

    // 2.5. Update participant record status to 'removed'
    await supabase
      .from('participants')
      .update({ participant_status: 'removed', left_at: new Date().toISOString() })
      .eq('meeting_id', meeting.meeting_id)
      .eq('user_id', userId)

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

    // 2. Update participant status to 'removed'
    const { data: participant } = await supabase
      .from('participants')
      .select('participant_id')
      .eq('meeting_id', meeting.meeting_id)
      .eq('user_id', userId)
      .maybeSingle()

    if (participant) {
      const { error: updateErr } = await supabase
        .from('participants')
        .update({
          participant_status: 'removed',
          left_at: new Date().toISOString()
        })
        .eq('participant_id', participant.participant_id)

      if (updateErr) throw updateErr
    }

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

    return res.status(200).json({ success: true, message: 'Participant removed successfully.' })
  } catch (err) {
    console.error('[Security] removeParticipant error:', err)
    return res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: 'Server error removing participant.'
    })
  }
}

/**
 * Helper to get LiveKit RoomServiceClient if environment variables exist
 */
const getRoomServiceClient = () => {
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  const livekitUrl = process.env.LIVEKIT_URL
  if (!apiKey || !apiSecret || !livekitUrl) return null
  const httpUrl = livekitUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  return new RoomServiceClient(httpUrl, apiKey, apiSecret)
}

/**
 * POST /api/meetings/security/mute-participant
 * Host moderator mutes or unmutes a participant's microphone via LiveKit RoomServiceClient.mutePublishedTrack
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

    // 2. Call LiveKit RoomServiceClient.mutePublishedTrack for BOTH mute=true and mute=false
    const roomService = getRoomServiceClient()
    if (!roomService) {
      console.error('[Security Error] LiveKit server credentials missing in process.env')
      return res.status(500).json({
        success: false,
        code: 'SERVER_ERROR',
        message: 'LiveKit server credentials missing on server.'
      })
    }

    console.log(`[Security LiveKit Mute] Calling mutePublishedTrack(room=${roomName}, identity=${participantIdentity}, trackSid=${trackSid}, muted=${!!mute})`)

    try {
      await roomService.mutePublishedTrack(roomName, participantIdentity, trackSid.trim(), !!mute)
      console.log(`[Security LiveKit Mute] Successfully set mutePublishedTrack to ${!!mute} for track ${trackSid}`)
    } catch (lkErr) {
      console.error('[Security LiveKit Error] mutePublishedTrack failed:', lkErr)
      const lkMsg = lkErr.message || String(lkErr)
      return res.status(400).json({
        success: false,
        code: 'LIVEKIT_ERROR',
        message: `LiveKit rejected remote mute operation: ${lkMsg}`
      })
    }

    // 3. Emit Socket.IO event to room so participant client executes local setMicrophoneEnabled
    const io = req.app.get('io')
    if (io) {
      io.to(roomName).emit('host_mute_toggle', {
        participantIdentity,
        trackSid,
        mute: !!mute
      })
      console.log(`[Security Socket] Emitted 'host_mute_toggle' (mute=${!!mute}) to room ${roomName} for ${participantIdentity}`)
    }

    // 4. Structured audit log
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
