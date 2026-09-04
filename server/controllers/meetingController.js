import crypto from 'crypto'
import bcrypt from 'bcrypt'
import { AccessToken } from 'livekit-server-sdk'
import { supabase } from '../config/supabase.js'
import { clearMeetingCounters } from '../services/aiChat.service.js'
import { scheduleCleanup, cancelCleanup } from '../services/meetingCleanup.js'
import { authorizeHost } from '../utils/authHelper.js'
import { isMuteAllEnabled } from './securityController.js'

// UUID validation helper
const isUuid = (val) => {
  if (!val) return false
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val)
}

// Clean up stale meetings and orphaned participant records for a user.
// This ensures that abandoned meetings never permanently block meeting creation.
const cleanupStaleMeetings = async (userId, isCreateIntent = false, targetMeetingId = null) => {
  const now = new Date()
  const threeMinutesAgo = new Date(now.getTime() - 3 * 60 * 1000).toISOString()

  try {
    // 1. Expire 'Waiting' meetings created > 3 minutes ago
    const { data: expiredWaiting } = await supabase
      .from('meetings')
      .select('meeting_id')
      .eq('host_id', userId)
      .eq('meeting_status', 'Waiting')
      .eq('is_deleted', false)
      .lt('created_at', threeMinutesAgo)

    if (expiredWaiting && expiredWaiting.length > 0) {
      for (const m of expiredWaiting) {
        console.log(`
[Meeting End Debug]
MeetingId: ${m.meeting_id}
MeetingCode: N/A (Expired Waiting)
AuthenticatedUserId: ${userId}
HostId: ${userId}
Trigger: cleanupStaleMeetings Expire Waiting (>3 mins)
ActiveSocketCount: N/A
HostSocketPresent: N/A
ActiveParticipantCount: 0
HostParticipantStatus: N/A
MeetingStatus: Waiting
Stack/Caller: cleanupStaleMeetings Part 1
`)
        console.log(`[Cleanup] Waiting meeting ${m.meeting_id} expired.`)
        await supabase
          .from('meetings')
          .update({ meeting_status: 'Ended', ended_at: now.toISOString(), updated_at: now.toISOString() })
          .eq('meeting_id', m.meeting_id)

        await supabase
          .from('participants')
          .update({ participant_status: 'left', left_at: now.toISOString() })
          .eq('meeting_id', m.meeting_id)
          .in('participant_status', ['joined', 'active', 'disconnected'])
      }
    }

    // 2. Fix orphaned participant records: status is 'joined' or 'disconnected' but meeting is already 'Ended' or 'Locked'
    const { data: orphanedParticipants } = await supabase
      .from('participants')
      .select('participant_id, meeting_id, meetings(meeting_status)')
      .eq('user_id', userId)
      .in('participant_status', ['joined', 'disconnected'])

    if (orphanedParticipants && orphanedParticipants.length > 0) {
      for (const p of orphanedParticipants) {
        if (!p.meetings || p.meetings.meeting_status === 'Ended' || p.meetings.meeting_status === 'Locked') {
          console.log(`[Cleanup] Participant ${p.participant_id} marked left.`)
          await supabase
            .from('participants')
            .update({ participant_status: 'left', left_at: now.toISOString() })
            .eq('participant_id', p.participant_id)
        }
      }
    }

    // 3. Clean up any abandoned joined participant records in existing Active/Waiting meetings.
    // If the user has isCreateIntent = true (creating a new meeting) OR they are joining a DIFFERENT meeting (targetMeetingId is set),
    // we release their seat in other active meetings.
    if (isCreateIntent || targetMeetingId) {
      const { data: activeJoined } = await supabase
        .from('participants')
        .select('participant_id, meeting_id, meetings(meeting_id, host_id, meeting_status, meeting_code)')
        .eq('user_id', userId)
        .in('participant_status', ['joined', 'disconnected'])

      if (activeJoined && activeJoined.length > 0) {
        for (const p of activeJoined) {
          // If we are joining a specific meeting, do not clear the participant record for that meeting
          if (targetMeetingId && p.meeting_id === targetMeetingId) {
            continue
          }

          if (p.meetings && (p.meetings.meeting_status === 'Active' || p.meetings.meeting_status === 'Waiting')) {
            console.log(`[Cleanup] Releasing seat for user ${userId} in meeting ${p.meeting_id} (Code: ${p.meetings.meeting_code}). Marking as left.`)
            await supabase
              .from('participants')
              .update({ participant_status: 'left', left_at: now.toISOString() })
              .eq('participant_id', p.participant_id)

            // Check remaining joined participants in that meeting
            const { data: remaining } = await supabase
              .from('participants')
              .select('participant_id')
              .eq('meeting_id', p.meeting_id)
              .eq('participant_status', 'joined')

            if (!remaining || remaining.length === 0) {
              console.log(`
[Meeting End Debug]
MeetingId: ${p.meeting_id}
MeetingCode: ${p.meetings?.meeting_code || 'N/A'}
AuthenticatedUserId: ${userId}
HostId: ${p.meetings?.host_id}
Trigger: cleanupStaleMeetings release seat (No active participants)
ActiveSocketCount: N/A
HostSocketPresent: N/A
ActiveParticipantCount: 0
HostParticipantStatus: N/A
MeetingStatus: ${p.meetings?.meeting_status}
Stack/Caller: cleanupStaleMeetings Part 3 (release seat)
`)
              console.log(`[Cleanup] Meeting ${p.meeting_id} ended because no active participants.`)
              await supabase
                .from('meetings')
                .update({ meeting_status: 'Ended', ended_at: now.toISOString(), updated_at: now.toISOString() })
                .eq('meeting_id', p.meeting_id)
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[Cleanup Error] Error running cleanupStaleMeetings:', err)
  }
}

// Check if a user is currently in an active meeting.
// Returns meeting_id ONLY if participant_status='joined' AND meeting_status='Active'.
const getUserActiveMeetingId = async (userId, excludeMeetingId = null) => {
  try {
    const { data: activeParticipants, error } = await supabase
      .from('participants')
      .select('meeting_id, participant_id, meetings!inner(meeting_status, is_deleted)')
      .eq('user_id', userId)
      .eq('participant_status', 'joined')
      .eq('meetings.meeting_status', 'Active')
      .eq('meetings.is_deleted', false)

    if (error) {
      console.error('[Validation Error] Checking active meeting status failed:', error)
      return null
    }

    if (!activeParticipants || activeParticipants.length === 0) {
      console.log(`[Validation Debug] User ${userId}: no 'joined' participant records found in active meetings. User is free.`)
      return null
    }

    const active = activeParticipants[0]

    // If the active meeting is the one we want to exclude (e.g. re-joining), do not block
    if (excludeMeetingId && active.meeting_id === excludeMeetingId) {
      console.log(`[Validation Debug] User ${userId} is already in the target meeting ${excludeMeetingId}. Re-join allowed.`)
      return null
    }

    console.log(`[Validation Block] User ${userId} IS in active meeting ${active.meeting_id}. Blocking.`)
    return active.meeting_id
  } catch (err) {
    console.error('[Validation Error] Unexpected error in getUserActiveMeetingId:', err)
    return null
  }
}

// Helper to generate a unique 8-character uppercase alphanumeric code
const generateUniqueMeetingCode = async () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let attempts = 0
  while (attempts < 10) {
    let code = ''
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    const { data: existing } = await supabase
      .from('meetings')
      .select('meeting_id')
      .eq('meeting_code', code)
      .maybeSingle()

    if (!existing) return code
    attempts++
  }
  throw new Error('Could not generate a unique meeting code. Please try again.')
}

// 1. CREATE MEETING
// Atomic operation: Cleanup -> Validate -> Create Meeting (Waiting) -> Insert Host Participant -> Generate Token -> Return
export const createMeeting = async (req, res) => {
  let createdMeetingId = null
  try {
    const { meetingTitle, meetingType, meetingPassword, enableAiAnalyzer, enableAiAttendance } = req.body

    if (!meetingTitle || !meetingTitle.trim()) {
      return res.status(400).json({ message: 'Meeting title is required.' })
    }

    const type = meetingType || 'public'
    if (!['public', 'private'].includes(type)) {
      return res.status(400).json({ message: 'Invalid meeting type.' })
    }

    console.log(`[Create Meeting] User ${req.user.id} requested new meeting: "${meetingTitle.trim()}"`)

    // Step 1: Clean up stale meetings for this user with isCreateIntent = true
    await cleanupStaleMeetings(req.user.id, true)

    // Step 2: Validate user is NOT already in an ACTIVE meeting
    const activeMeetingId = await getUserActiveMeetingId(req.user.id)
    if (activeMeetingId) {
      console.log(`[Create Block] User ${req.user.id} is already active in meeting ${activeMeetingId}`)
      return res.status(400).json({ message: 'You are already in an active meeting.' })
    }

    // Step 3: Generate meeting code & LiveKit room name
    const code = await generateUniqueMeetingCode()
    const roomName = crypto.randomUUID()

    let passwordHash = null
    if (type === 'private' && meetingPassword) {
      passwordHash = await bcrypt.hash(meetingPassword, 10)
    }

    // Step 4: Insert meeting into DB with status 'Waiting' (Host created, waiting for LiveKit connect)
    const { data: meeting, error: meetingErr } = await supabase
      .from('meetings')
      .insert([
        {
          meeting_code: code,
          room_name: roomName,
          meeting_title: meetingTitle.trim(),
          host_id: req.user.id,
          meeting_status: 'Waiting',
          is_deleted: false,
          meeting_password_hash: passwordHash,
          meeting_type: type,
          enable_ai_analyzer: !!enableAiAnalyzer,
          enable_ai_attendance: !!enableAiAttendance,
          // Explicitly set auto_admit=true so joinMeeting never gets NULL and
          // can't accidentally route participants to the waiting room
          auto_admit: true
        }
      ])
      .select()
      .single()

    if (meetingErr) {
      console.error('[Create Error] Failed to insert meeting into DB:', meetingErr)
      throw meetingErr
    }

    createdMeetingId = meeting.meeting_id
    console.log(`[Create Success] Inserted meeting ${code} (${createdMeetingId}) with status 'Waiting'`)

    // Step 5: Insert Host as first participant with status 'joined'
    const { error: partErr } = await supabase
      .from('participants')
      .insert([
        {
          meeting_id: createdMeetingId,
          user_id: req.user.id,
          role: 'host',
          participant_status: 'joined',
          joined_at: new Date().toISOString()
        }
      ])

    if (partErr) {
      console.error('[Create Error] Participant insertion failed, triggering rollback:', partErr)
      await supabase.from('meetings').delete().eq('meeting_id', createdMeetingId)
      throw partErr
    }

    // Step 6: Generate LiveKit token for host
    const apiKey = process.env.LIVEKIT_API_KEY
    const apiSecret = process.env.LIVEKIT_API_SECRET
    const livekitUrl = process.env.LIVEKIT_URL

    if (!apiKey || !apiSecret) {
      console.error('[Create Error] Missing LiveKit environment variables')
      await supabase.from('participants').delete().eq('meeting_id', createdMeetingId)
      await supabase.from('meetings').delete().eq('meeting_id', createdMeetingId)
      return res.status(500).json({ message: 'LiveKit credentials missing on server.' })
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: req.user.email || req.user.id,
      name: req.user.full_name || req.user.name,
      metadata: JSON.stringify({ userId: req.user.id, role: 'host' })
    })

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true
    })

    const token = await at.toJwt()

    console.log(`[Create Token Issued] Host ${req.user.id} issued LiveKit token for room ${roomName}`)

    // Structured Audit Logging
    const timestamp = new Date().toISOString()
    console.log(`[Audit Log] Action: Meeting Created | Timestamp: ${timestamp} | MeetingCode: ${code} | HostId: ${req.user.id}`)

    return res.status(200).json({
      message: 'Meeting created successfully.',
      meetingId: createdMeetingId,
      meetingCode: code,
      roomName,
      livekitToken: token,
      livekitUrl: livekitUrl || 'ws://localhost:7880',
      meeting
    })
  } catch (err) {
    console.error('Create meeting error:', err)
    if (createdMeetingId) {
      try {
        await supabase.from('participants').delete().eq('meeting_id', createdMeetingId)
        await supabase.from('meetings').delete().eq('meeting_id', createdMeetingId)
      } catch (rbErr) {
        console.error('Rollback error:', rbErr)
      }
    }
    return res.status(500).json({ message: err.message || 'Server error during meeting creation.' })
  }
}

// 2. JOIN MEETING
// Idempotent join: Upsert participant -> Issue LiveKit Token -> Return
export const joinMeeting = async (req, res) => {
  try {
    const { meetingCode, password, deviceFingerprint } = req.body

    if (!meetingCode || !meetingCode.trim()) {
      return res.status(400).json({ message: 'Meeting code is required.' })
    }

    const uppercaseCode = meetingCode.trim().toUpperCase()
    const fingerprint = (deviceFingerprint || '').trim()

    console.log(`[Join Meeting] User ${req.user.id} joining code: ${uppercaseCode} | fingerprint: ${fingerprint}`)

    // Fetch meeting by code
    const { data: meeting, error: fetchErr } = await supabase
      .from('meetings')
      .select('*')
      .eq('meeting_code', uppercaseCode)
      .eq('is_deleted', false)
      .maybeSingle()

    if (fetchErr) throw fetchErr

    if (!meeting) {
      return res.status(404).json({ message: 'Meeting not found.' })
    }

    if (meeting.meeting_status === 'Ended') {
      console.log('[Meeting Validation] Join rejected. Meeting already ended.')
      return res.status(410).json({ success: false, message: 'This meeting has already ended.' })
    }

    if (meeting.meeting_status === 'Locked') {
      return res.status(400).json({ message: 'Meeting is locked by the host.' })
    }

    // Step 0: Check Device Ban
    if (fingerprint) {
      const { data: banRecord, error: banCheckErr } = await supabase
        .from('meeting_device_bans')
        .select('*')
        .eq('meeting_code', uppercaseCode)
        .eq('device_fingerprint', fingerprint)
        .maybeSingle()

      if (banCheckErr) throw banCheckErr
      if (banRecord) {
        console.log(`[Security] Join rejected. Device is banned. fingerprint: ${fingerprint}`)
        return res.status(403).json({
          success: false,
          message: 'This device has been blocked by the meeting host.'
        })
      }
    }

    // Step 1: Clean up stale state before checking
    await cleanupStaleMeetings(req.user.id, false, meeting.meeting_id)

    // Step 2: Block only if user is in a DIFFERENT active meeting
    const activeMeetingId = await getUserActiveMeetingId(req.user.id, meeting.meeting_id)
    if (activeMeetingId) {
      console.log(`[Join Block] User ${req.user.id} blocked: active in meeting ${activeMeetingId}`)
      return res.status(400).json({ message: 'You are already in a meeting.' })
    }

    // Step 3: Password verification for private meetings
    if (meeting.meeting_type === 'private') {
      if (!password) {
        return res.status(401).json({ message: 'Password is required to join this private meeting.' })
      }
      const isMatch = await bcrypt.compare(password, meeting.meeting_password_hash || '')
      if (!isMatch) {
        return res.status(400).json({ message: 'Incorrect password.' })
      }
    }

    const isHost = String(meeting.host_id).trim().toLowerCase() === String(req.user.id).trim().toLowerCase()
    const role = isHost ? 'host' : 'participant'

    console.log(`[AUTH DEBUG]\nemail: ${req.user.email}\nuserId: ${req.user.id}\nmeetingCode: ${uppercaseCode}\nisHost: ${isHost}`)

    // Step 3.5: Handle Waiting Room / Auto Admit Setting
    // Use !== true so that null/undefined (DB default) is also treated as "waiting room required"
    // Only skip the waiting room when auto_admit is explicitly true
    if (meeting.auto_admit !== true && !isHost) {
      // Check if user is already joined (to handle reconnects / refreshes)
      const { data: currentPart } = await supabase
        .from('participants')
        .select('participant_status')
        .eq('meeting_id', meeting.meeting_id)
        .eq('user_id', req.user.id)
        .maybeSingle()

      // The rejoin exception satisfies: participant row exists and status is joined or disconnected
      const isApprovedRejoin = currentPart && (currentPart.participant_status === 'joined' || currentPart.participant_status === 'disconnected')

      if (!isApprovedRejoin) {
        // Check if there is already a pending request
        const { data: existingRequest, error: reqErr } = await supabase
          .from('meeting_join_requests')
          .select('*')
          .eq('meeting_code', uppercaseCode)
          .eq('user_id', req.user.id)
          .maybeSingle()

        if (reqErr) throw reqErr
        if (existingRequest) {
          console.log(`[Security] Duplicate join request blocked for user ${req.user.id}`)
          return res.status(200).json({
            success: true,
            status: 'waiting',
            message: 'Your join request is already waiting for host approval.'
          })
        }

        // Create a new pending request
        const { error: insertReqErr } = await supabase
          .from('meeting_join_requests')
          .insert([
            {
              meeting_code: uppercaseCode,
              user_id: req.user.id,
              device_fingerprint: fingerprint || 'unknown-fingerprint',
              status: 'pending'
            }
          ])

        if (insertReqErr) throw insertReqErr

        // Structured Audit Logging
        const reqTimestamp = new Date().toISOString()
        console.log(`[Audit Log] Action: Waiting Request Created | Timestamp: ${reqTimestamp} | MeetingCode: ${uppercaseCode} | ParticipantId: ${req.user.id}`)

        // Notify Host immediately using Socket.IO
        const io = req.app.get('io')
        if (io) {
          console.log(`[Security] Emitting waiting_list_updated for request from user ${req.user.id}`)
          io.to(meeting.room_name).emit('waiting_list_updated')
        }

        return res.status(200).json({
          success: true,
          status: 'waiting',
          message: 'Waiting for host approval.'
        })
      }
    }

    // Step 4: Idempotent Participant Upsert
    const { data: existingParticipant } = await supabase
      .from('participants')
      .select('*')
      .eq('meeting_id', meeting.meeting_id)
      .eq('user_id', req.user.id)
      .maybeSingle()

    if (existingParticipant) {
      const { error: updateErr } = await supabase
        .from('participants')
        .update({
          participant_status: 'joined',
          joined_at: new Date().toISOString(),
          left_at: null,
          device_fingerprint: fingerprint
        })
        .eq('participant_id', existingParticipant.participant_id)

      if (updateErr) throw updateErr
      console.log(`[Join] Reactivated existing participant record for user ${req.user.id}`)
    } else {
      const { error: insertErr } = await supabase
        .from('participants')
        .insert([
          {
            meeting_id: meeting.meeting_id,
            user_id: req.user.id,
            role,
            participant_status: 'joined',
            joined_at: new Date().toISOString(),
            device_fingerprint: fingerprint
          }
        ])

      if (insertErr) {
        if (insertErr.code === '23505') {
          console.log(`[Join] Duplicate key detected (race condition). Updating existing record.`)
          await supabase
            .from('participants')
            .update({
              participant_status: 'joined',
              joined_at: new Date().toISOString(),
              left_at: null,
              device_fingerprint: fingerprint
            })
            .eq('meeting_id', meeting.meeting_id)
            .eq('user_id', req.user.id)
        } else {
          throw insertErr
        }
      }
    }

    // Step 5: Issue LiveKit Token
    const apiKey = process.env.LIVEKIT_API_KEY
    const apiSecret = process.env.LIVEKIT_API_SECRET
    const livekitUrl = process.env.LIVEKIT_URL

    if (!apiKey || !apiSecret) {
      return res.status(500).json({ message: 'LiveKit server credentials missing.' })
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: req.user.email || req.user.id,
      name: req.user.full_name || req.user.name,
      metadata: JSON.stringify({ userId: req.user.id, role })
    })

    at.addGrant({
      roomJoin: true,
      room: meeting.room_name,
      canPublish: true,
      canSubscribe: true
    })

    const token = await at.toJwt()

    cancelCleanup(meeting.meeting_id)

    console.log(`[Join Success] User ${req.user.id} joined meeting ${meeting.meeting_code}`)

    const muteAllEnabled = isMuteAllEnabled(meeting.meeting_id) || isMuteAllEnabled(meeting.meeting_code)

    return res.status(200).json({
      message: 'Joined meeting successfully.',
      token,
      roomName: meeting.room_name,
      livekitUrl: livekitUrl || 'ws://localhost:7880',
      meeting: {
        ...meeting,
        mute_all_enabled: muteAllEnabled
      }
    })
  } catch (err) {
    console.error('Join meeting error:', err)
    return res.status(500).json({ message: err.message || 'Server error during joining meeting.' })
  }
}

// 3. ACTIVATE MEETING
export const activateMeeting = async (req, res) => {
  try {
    const { meetingId } = req.body

    if (!meetingId) {
      return res.status(400).json({ message: 'Meeting ID is required.' })
    }

    const query = isUuid(meetingId)
      ? supabase.from('meetings').select('meeting_id, meeting_status').eq('meeting_id', meetingId)
      : supabase.from('meetings').select('meeting_id, meeting_status').eq('meeting_code', meetingId.trim().toUpperCase())

    const { data: meeting, error: fetchErr } = await query.maybeSingle()

    if (fetchErr) throw fetchErr
    if (!meeting) {
      return res.status(404).json({ message: 'Meeting not found.' })
    }

    if (meeting.meeting_status === 'Ended') {
      console.log('[Meeting Validation] Ignoring request because meeting has ended.')
      return res.status(400).json({ message: 'This meeting has already ended.' })
    }

    if (meeting.meeting_status === 'Waiting') {
      const now = new Date().toISOString()
      const { error: updateErr } = await supabase
        .from('meetings')
        .update({
          meeting_status: 'Active',
          started_at: now,
          updated_at: now
        })
        .eq('meeting_id', meeting.meeting_id)

      if (updateErr) throw updateErr
      console.log(`[Activate] Meeting ${meeting.meeting_id} transitioned from 'Waiting' -> 'Active'`)
    }

    cancelCleanup(meeting.meeting_id)

    return res.status(200).json({ message: 'Meeting is now active.' })
  } catch (err) {
    console.error('Activate meeting error:', err)
    return res.status(500).json({ message: 'Server error activating meeting.' })
  }
}

// 4. LEAVE MEETING
export const leaveMeeting = async (req, res) => {
  try {
    const meetingId = req.body?.meetingId || req.query?.meetingId
    console.log(`[Leave Function Call] leaveMeeting called for meetingId: ${meetingId}, user: ${req.user?.id}`)

    if (!meetingId) {
      return res.status(400).json({ message: 'Meeting identifier is required.' })
    }

    const query = isUuid(meetingId)
      ? supabase.from('meetings').select('meeting_id').eq('meeting_id', meetingId)
      : supabase.from('meetings').select('meeting_id').eq('meeting_code', meetingId.trim().toUpperCase())

    const { data: meeting, error: fetchErr } = await query.maybeSingle()

    if (fetchErr) throw fetchErr
    if (!meeting) {
      return res.status(404).json({ message: 'Meeting not found.' })
    }

    const now = new Date().toISOString()

    const { error: leaveErr } = await supabase
      .from('participants')
      .update({
        participant_status: 'left',
        left_at: now
      })
      .eq('meeting_id', meeting.meeting_id)
      .eq('user_id', req.user.id)

    if (leaveErr) throw leaveErr

    console.log(`[Leave] User ${req.user.id} left meeting ${meeting.meeting_id}`)

    // Check if 0 active/joined participants remain in meeting
    const { data: remaining } = await supabase
      .from('participants')
      .select('participant_id')
      .eq('meeting_id', meeting.meeting_id)
      .eq('participant_status', 'joined')

    if (!remaining || remaining.length === 0) {
      scheduleCleanup(meeting.meeting_id, meeting.meeting_code, meeting.room_name)
    }

    return res.status(200).json({ message: 'Left meeting successfully.' })
  } catch (err) {
    console.error('Leave meeting error:', err)
    return res.status(500).json({ message: 'Server error while leaving meeting.' })
  }
}

// 5. END MEETING (Host only)
export const endMeeting = async (req, res) => {
  try {
    const { meetingId } = req.body
    console.log(`[End Function Call] endMeeting called for meetingId: ${meetingId}, user: ${req.user?.id}`)

    const auth = await authorizeHost(meetingId, req.user.id)
    if (!auth.passed) {
      return res.status(auth.status).json({ message: auth.message })
    }
    const meeting = auth.meeting

    const now = new Date().toISOString()

    console.log(`
[Meeting End Debug]
MeetingId: ${meeting.meeting_id}
MeetingCode: ${meeting.meeting_code}
AuthenticatedUserId: ${req.user.id}
HostId: ${meeting.host_id}
Trigger: endMeeting API call (Host Initiated)
ActiveSocketCount: N/A
HostSocketPresent: N/A
ActiveParticipantCount: N/A
HostParticipantStatus: N/A
MeetingStatus: ${meeting.meeting_status}
Stack/Caller: endMeeting inside meetingController.js
`)

    const { error: updateMtgErr } = await supabase
      .from('meetings')
      .update({
        meeting_status: 'Ended',
        ended_at: now,
        updated_at: now
      })
      .eq('meeting_id', meeting.meeting_id)

    if (updateMtgErr) throw updateMtgErr

    const { error: updatePartsErr } = await supabase
      .from('participants')
      .update({
        participant_status: 'left',
        left_at: now
      })
      .eq('meeting_id', meeting.meeting_id)
      .in('participant_status', ['joined', 'active', 'disconnected'])

    if (updatePartsErr) throw updatePartsErr

    // Clean up security records
    if (meeting.meeting_code) {
      await supabase.from('meeting_device_bans').delete().eq('meeting_code', meeting.meeting_code)
      await supabase.from('meeting_join_requests').delete().eq('meeting_code', meeting.meeting_code)
      console.log(`[Security] Waiting room and device bans cleaned for ended meeting ${meeting.meeting_code}`)

      // Structured Audit Logging
      console.log(`[Audit Log] Action: Meeting Ended | Timestamp: ${now} | MeetingCode: ${meeting.meeting_code} | HostId: ${req.user.id}`)
    }

    clearMeetingCounters(meeting.meeting_id)

    // BUG 2 FIX: Emit meeting_ended to ALL connected participants via Socket.IO.
    // This must happen server-side so participants are notified even before
    // the host's browser socket disconnects on navigation.
    const io = req.app.get('io')
    if (io && meeting.room_name) {
      io.to(meeting.room_name).emit('meeting_ended')
      console.log(`[End] Emitted 'meeting_ended' to Socket.IO room: ${meeting.room_name}`)
    } else {
      console.warn(`[End] io or room_name not available, participants may not receive meeting_ended event.`)
    }

    console.log(`[End] Meeting ${meeting.meeting_id} ended by host ${req.user.id}. All participants marked as left.`)

    return res.status(200).json({ message: 'Meeting ended successfully.' })
  } catch (err) {
    console.error('End meeting error:', err)
    return res.status(500).json({ message: 'Server error while ending meeting.' })
  }
}

// 6. LOCK MEETING (Host only)
export const lockMeeting = async (req, res) => {
  try {
    const { meetingId, isLocked } = req.body

    const auth = await authorizeHost(meetingId, req.user.id)
    if (!auth.passed) {
      return res.status(auth.status).json({ message: auth.message })
    }
    const meeting = auth.meeting

    if (meeting.meeting_status === 'Ended') {
      console.log('[Meeting Validation] Ignoring request because meeting has ended.')
      return res.status(400).json({ message: 'This meeting has already ended.' })
    }

    const newStatus = isLocked ? 'Locked' : 'Active'

    const { error: updateMtgErr } = await supabase
      .from('meetings')
      .update({
        meeting_status: newStatus,
        updated_at: new Date().toISOString()
      })
      .eq('meeting_id', meeting.meeting_id)

    if (updateMtgErr) throw updateMtgErr

    return res.status(200).json({ message: `Meeting ${isLocked ? 'locked' : 'unlocked'} successfully.`, status: newStatus })
  } catch (err) {
    console.error('Lock meeting error:', err)
    return res.status(500).json({ message: 'Server error during meeting lock state update.' })
  }
}

// 7. GET MEETING DETAILS
export const getMeetingDetails = async (req, res) => {
  try {
    const { meetingId } = req.params

    const query = isUuid(meetingId)
      ? supabase.from('meetings').select('*, host:host_id ( full_name )').eq('meeting_id', meetingId)
      : supabase.from('meetings').select('*, host:host_id ( full_name )').eq('meeting_code', meetingId.trim().toUpperCase())

    const { data: meeting, error: fetchErr } = await query.maybeSingle()

    if (fetchErr) throw fetchErr

    if (!meeting) {
      return res.status(404).json({ message: 'Meeting not found.' })
    }

    const { data: participants, error: partErr } = await supabase
      .from('participants')
      .select(`
        *,
        user:user_id ( full_name, email )
      `)
      .eq('meeting_id', meeting.meeting_id)

    if (partErr) throw partErr

    const muteAllEnabled = isMuteAllEnabled(meeting.meeting_id) || isMuteAllEnabled(meeting.meeting_code)

    return res.status(200).json({
      meeting: {
        ...meeting,
        mute_all_enabled: muteAllEnabled
      },
      participants
    })
  } catch (err) {
    console.error('Get meeting details error:', err)
    return res.status(500).json({ message: 'Server error retrieving meeting details.' })
  }
}

// 8. GET MEETING PARTICIPANTS
export const getMeetingParticipants = async (req, res) => {
  try {
    const { meetingId } = req.params

    const query = isUuid(meetingId)
      ? supabase.from('meetings').select('meeting_id').eq('meeting_id', meetingId)
      : supabase.from('meetings').select('meeting_id').eq('meeting_code', meetingId.trim().toUpperCase())

    const { data: meeting, error: fetchErr } = await query.maybeSingle()

    if (fetchErr) throw fetchErr

    if (!meeting) {
      return res.status(404).json({ message: 'Meeting not found.' })
    }

    const { data: participants, error: partErr } = await supabase
      .from('participants')
      .select(`
        *,
        user:user_id ( full_name, email )
      `)
      .eq('meeting_id', meeting.meeting_id)

    if (partErr) throw partErr

    return res.status(200).json(participants)
  } catch (err) {
    console.error('Get participants list error:', err)
    return res.status(500).json({ message: 'Server error retrieving participants list.' })
  }
}

// 9. RENAME MEETING (Host only)
export const renameMeeting = async (req, res) => {
  try {
    const { id } = req.params
    const { meetingTitle } = req.body

    if (!meetingTitle || !meetingTitle.trim()) {
      return res.status(400).json({ message: 'Meeting title is required.' })
    }

    const auth = await authorizeHost(id, req.user.id)
    if (!auth.passed) {
      return res.status(auth.status).json({ message: auth.message })
    }
    const meeting = auth.meeting

    const { error: updateErr } = await supabase
      .from('meetings')
      .update({ meeting_title: meetingTitle.trim(), updated_at: new Date().toISOString() })
      .eq('meeting_id', meeting.meeting_id)

    if (updateErr) throw updateErr

    return res.status(200).json({ message: 'Meeting renamed successfully.' })
  } catch (err) {
    console.error('Rename meeting error:', err)
    return res.status(500).json({ message: 'Server error while renaming meeting.' })
  }
}

// 10. DELETE MEETING (Hard Delete - Host only)
export const deleteMeeting = async (req, res) => {
  try {
    const { id } = req.params

    const auth = await authorizeHost(id, req.user.id)
    if (!auth.passed) {
      return res.status(auth.status).json({ message: auth.message })
    }
    const meeting = auth.meeting

    // Clean up security records
    if (meeting.meeting_code) {
      await supabase.from('meeting_device_bans').delete().eq('meeting_code', meeting.meeting_code)
      await supabase.from('meeting_join_requests').delete().eq('meeting_code', meeting.meeting_code)
      console.log(`[Security] Waiting room and device bans cleaned for deleted meeting ${meeting.meeting_code}`)
    }

    // Delete related participants first to satisfy foreign key constraints
    const { error: deletePartsErr } = await supabase
      .from('participants')
      .delete()
      .eq('meeting_id', meeting.meeting_id)

    if (deletePartsErr) throw deletePartsErr

    // Delete the meeting from the database
    const { error: deleteMtgErr } = await supabase
      .from('meetings')
      .delete()
      .eq('meeting_id', meeting.meeting_id)

    if (deleteMtgErr) throw deleteMtgErr

    clearMeetingCounters(meeting.meeting_id)

    console.log(`[Cleanup] Meeting ${meeting.meeting_id} deleted successfully.`)

    return res.status(200).json({ message: 'Meeting deleted successfully.' })
  } catch (err) {
    console.error('Delete meeting error:', err)
    return res.status(500).json({ message: err.message || 'Server error during meeting deletion.' })
  }
}

// 11. GET USER RECENT MEETINGS
export const getRecentMeetings = async (req, res) => {
  try {
    const { data: meetings, error: fetchMtgErr } = await supabase
      .from('meetings')
      .select(`
        *,
        host:host_id ( full_name )
      `)
      .eq('is_deleted', false)
      .eq('host_id', req.user.id)
      .order('started_at', { ascending: false })

    if (fetchMtgErr) throw fetchMtgErr

    const formatted = meetings.map((m) => {
      const date = new Date(m.started_at || m.created_at)
      return {
        id: m.meeting_code,
        dbId: m.meeting_id,
        name: m.meeting_title,
        host: m.host?.full_name || 'Organizer',
        hostId: m.host_id,
        date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        time: date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        duration: m.meeting_status === 'Ended' ? 'Completed' : m.meeting_status,
        status: m.meeting_status === 'Ended' ? 'Completed' : 'Live',
        type: m.meeting_type,
        enableAiAnalyzer: m.enable_ai_analyzer,
        enableAiAttendance: m.enable_ai_attendance
      }
    })

    return res.status(200).json(formatted)
  } catch (err) {
    console.error('Get recent meetings error:', err)
    return res.status(500).json({ message: 'Server error retrieving recent meetings.' })
  }
}

// 12. GET MEETING HISTORY
export const getMeetingHistory = async (req, res) => {
  try {
    const { data: meetings, error: fetchMtgErr } = await supabase
      .from('meetings')
      .select(`
        *,
        host:host_id ( full_name )
      `)
      .eq('is_deleted', false)
      .eq('meeting_status', 'Ended')
      .eq('host_id', req.user.id)
      .order('started_at', { ascending: false })

    if (fetchMtgErr) throw fetchMtgErr

    const formatted = await Promise.all(
      meetings.map(async (m) => {
        const { count } = await supabase
          .from('participants')
          .select('*', { count: 'exact', head: true })
          .eq('meeting_id', m.meeting_id)

        const start = new Date(m.started_at || m.created_at)
        const end = m.ended_at ? new Date(m.ended_at) : new Date()
        const diffMins = Math.round((end - start) / 60000)

        return {
          id: m.meeting_code,
          dbId: m.meeting_id,
          name: m.meeting_title,
          host: m.host?.full_name || 'Organizer',
          hostId: m.host_id,
          date: start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          time: start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          duration: `${diffMins} min`,
          status: 'Completed',
          participantsCount: count || 1,
          enableAiAnalyzer: m.enable_ai_analyzer,
          enableAiAttendance: m.enable_ai_attendance
        }
      })
    )

    return res.status(200).json(formatted)
  } catch (err) {
    console.error('Get meeting history error:', err)
    return res.status(500).json({ message: 'Server error retrieving meeting history.' })
  }
}

// 13. SUBMIT TRANSCRIPT CHUNK (Whisper Speech-to-Text)
export const submitTranscriptChunk = async (req, res) => {
  console.log('[Transcript Chunk] Transcript endpoint called')
  try {
    const { meetingId, speakerName } = req.body
    console.log('[Transcript Chunk] Request body info:', { meetingId, speakerName })
    
    if (!meetingId || !speakerName) {
      console.error('[Transcript Chunk Error] Missing meetingId or speakerName')
      return res.status(400).json({ message: 'Meeting ID and speaker name are required.' })
    }

    // Verify if the meeting exists and is active/waiting/locked
    const { data: meeting, error: mtgErr } = await supabase
      .from('meetings')
      .select('meeting_status')
      .eq('meeting_id', meetingId)
      .maybeSingle()

    if (mtgErr) {
      console.error('[Transcript Chunk Error] Error checking meeting status:', mtgErr)
      return res.status(500).json({ message: 'Failed to verify meeting status.' })
    }

    if (!meeting) {
      console.log('[Meeting Validation] Ignoring request because meeting has ended.')
      return res.status(400).json({ message: 'This meeting has already ended.' })
    }

    if (meeting.meeting_status === 'Ended') {
      console.log('[Meeting Validation] Ignoring request because meeting has ended.')
      return res.status(400).json({ message: 'This meeting has already ended.' })
    }

    if (!req.file) {
      console.error('[Transcript Chunk Error] Audio file NOT received in req.file')
      return res.status(400).json({ message: 'No audio chunk file uploaded.' })
    }

    console.log('[Transcript Chunk] Audio file received:', {
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      encoding: req.file.encoding,
      mimetype: req.file.mimetype,
      size: req.file.size
    })

    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) {
      console.warn('[Transcript Chunk Error] GROQ_API_KEY is missing.')
      return res.status(500).json({ message: 'Groq API key not configured on server.' })
    }

    // Prepare native FormData to send to Groq Whisper
    const formData = new FormData()
    const audioBlob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' })
    formData.append('file', audioBlob, 'audio.webm')
    formData.append('model', 'whisper-large-v3')

    console.log('[Transcript Chunk] Sending audio to Groq Whisper...')
    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData
    })

    if (!groqRes.ok) {
      const errorText = await groqRes.text()
      console.error('[Transcript Chunk Error] Groq API returned error status:', groqRes.status, 'Body:', errorText)
      return res.status(500).json({ message: 'Failed to transcribe audio chunk.' })
    }

    const result = await groqRes.json()
    console.log('[Transcript Chunk] Whisper response received successfully')
    const transcribedText = result.text ? result.text.trim() : ''
    console.log('[Transcript Chunk] Transcribed text:', transcribedText)

    // Skip empty transcripts or typical silent whisper hallucinations
    const hallucinations = [
      'you', 'thank you', 'subtitles by', 'subtitles', 'thanks for watching',
      'bye', 'hello', 'uh', 'um', 'please subscribe', 'subscribe'
    ]
    const isHallucination = transcribedText.length < 5 && hallucinations.includes(transcribedText.toLowerCase())

    if (transcribedText && !isHallucination) {
      console.log(`[Transcript Chunk] Transcript inserted into Supabase for ${speakerName}: "${transcribedText}"`)

      // Insert into meeting_transcripts
      const { error: insertErr } = await supabase
        .from('meeting_transcripts')
        .insert([
          {
            meeting_id: meetingId,
            speaker_name: speakerName,
            transcript: transcribedText
          }
        ])

      if (insertErr) {
        console.error('[Transcript Chunk Error] Supabase insert failed:', insertErr)
        return res.status(500).json({ message: 'Failed to save transcript chunk to database.' })
      }
      console.log('[Transcript Chunk] Insert successful')
    } else {
      console.log(`[Transcript Chunk] Silence or empty response (isHallucination: ${isHallucination}), skipping DB insert.`)
    }

    return res.status(200).json({ message: 'Chunk processed successfully.', text: transcribedText })
  } catch (err) {
    console.error('[Transcript Chunk Error] Exception caught:', err)
    return res.status(500).json({ message: err.message || 'Server error transcribing audio chunk.' })
  }
}

/**
 * Call summary LLM with NVIDIA NIM (Nemotron 3 Ultra) as primary provider,
 * and Groq as optional fallback.
 * 
 * Safe rules:
 * - Reads NVIDIA_API_KEY, NVIDIA_MODEL, NVIDIA_BASE_URL from process.env
 * - Model default: nvidia/nemotron-3-ultra-550b-a55b
 * - Base URL default: https://integrate.api.nvidia.com/v1
 * - Conservative output token limits
 * - Never log API keys or authentication secrets
 * - Logs provider=NVIDIA or provider=GROQ_FALLBACK
 * - Safe single fallback without infinite retry loops
 */
const callSummaryLLM = async ({ messages, temperature = 0.2, maxTokens = 6000, transcriptChars = 0, isJson = true }) => {
  const nvidiaApiKey = process.env.NVIDIA_API_KEY
  const nvidiaModel = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b'
  const nvidiaBaseUrl = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '')
  const groqApiKey = process.env.GROQ_API_KEY

  let lastError = null

  // ── 1. Try NVIDIA NIM (Primary Provider) ──────────────────────────────────
  if (nvidiaApiKey && nvidiaApiKey.trim()) {
    try {
      console.log(`[Summary Generation] Dispatching request to primary provider=NVIDIA model=${nvidiaModel} transcript_chars=${transcriptChars}`)

      const payload = {
        model: nvidiaModel,
        messages,
        temperature,
        max_tokens: maxTokens
      }
      if (isJson) {
        payload.response_format = { type: 'json_object' }
      }

      const res = await fetch(`${nvidiaBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${nvidiaApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      if (res.ok) {
        const data = await res.json()
        const content = data.choices?.[0]?.message?.content || ''
        if (content) {
          console.log(`[Summary Generation] provider=NVIDIA model=${nvidiaModel} transcript_chars=${transcriptChars} status=success`)
          return { content, provider: 'NVIDIA' }
        }
        throw new Error('NVIDIA API returned empty message content.')
      } else {
        const errText = await res.text().catch(() => '')
        console.warn(`[Summary Generation] provider=NVIDIA model=${nvidiaModel} transcript_chars=${transcriptChars} status=failed http_status=${res.status}`)
        lastError = new Error(`NVIDIA API HTTP ${res.status}: ${errText.slice(0, 200)}`)
      }
    } catch (err) {
      console.warn(`[Summary Generation] provider=NVIDIA model=${nvidiaModel} transcript_chars=${transcriptChars} status=failed error="${err.message}"`)
      lastError = err
    }
  } else {
    console.warn('[Summary Generation] NVIDIA_API_KEY is not configured. Checking for fallback provider...')
    lastError = new Error('NVIDIA_API_KEY not configured')
  }

  // ── 2. Fallback to Groq (Only if available & safe) ─────────────────────────
  if (groqApiKey && groqApiKey.trim()) {
    try {
      const groqModel = 'openai/gpt-oss-120b'
      console.log(`[Summary Generation] Attempting fallback provider=GROQ_FALLBACK model=${groqModel} transcript_chars=${transcriptChars}`)

      const payload = {
        model: groqModel,
        messages,
        temperature: Math.min(temperature, 0.1),
        max_tokens: Math.min(maxTokens, 4000)
      }
      if (isJson) {
        payload.response_format = { type: 'json_object' }
      }

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      if (groqRes.ok) {
        const groqData = await groqRes.json()
        const content = groqData.choices?.[0]?.message?.content || ''
        if (content) {
          console.log(`[Summary Generation] provider=GROQ_FALLBACK model=${groqModel} transcript_chars=${transcriptChars} status=success`)
          return { content, provider: 'GROQ_FALLBACK' }
        }
        throw new Error('Groq fallback returned empty message content.')
      } else {
        const errText = await groqRes.text().catch(() => '')
        console.error(`[Summary Generation] provider=GROQ_FALLBACK status=failed http_status=${groqRes.status}`)
        throw new Error(`Groq fallback HTTP ${groqRes.status}: ${errText.slice(0, 200)}`)
      }
    } catch (groqErr) {
      console.error(`[Summary Generation] provider=GROQ_FALLBACK status=failed error="${groqErr.message}"`)
      throw lastError || groqErr
    }
  }

  throw lastError || new Error('No LLM provider available on the server.')
}

// 14. GENERATE SUMMARY (meeting-type-aware, detail-preserving, NVIDIA primary)
export const generateSummary = async (req, res) => {
  try {
    const { meetingId } = req.body
    if (!meetingId) {
      return res.status(400).json({ message: 'Meeting ID is required.' })
    }

    const nvidiaApiKey = process.env.NVIDIA_API_KEY
    const groqApiKey = process.env.GROQ_API_KEY
    if (!nvidiaApiKey && !groqApiKey) {
      console.error('[Summary Configuration Error] Neither NVIDIA_API_KEY nor GROQ_API_KEY is configured on the server.')
      return res.status(500).json({ message: 'AI summary generator is not configured on the server.' })
    }

    // 1. Fetch transcripts ordered by created_at ASC
    const { data: chunks, error: fetchErr } = await supabase
      .from('meeting_transcripts')
      .select('speaker_name, transcript')
      .eq('meeting_id', meetingId)
      .order('created_at', { ascending: true })

    if (fetchErr) throw fetchErr

    if (!chunks || chunks.length === 0) {
      return res.status(400).json({
        message: 'No transcript available. AI Analyzer was disabled or transcript capture failed.'
      })
    }

    // 2. Concatenate transcripts preserving speaker order
    const transcriptText = chunks
      .map(c => `${c.speaker_name}: ${c.transcript}`)
      .join('\n')

    console.log('[Summary Generation Request]')
    console.log(`  meeting_id=${meetingId}`)
    console.log(`  transcript_chunks=${chunks.length}`)
    console.log(`  transcript_length=${transcriptText.length} chars`)

    // ── STEP 1: Classify meeting type ─────────────────────────────────────────
    //
    // Three-layer approach:
    //   Layer 1 – Generic educational signal heuristic (topic-agnostic, fast)
    //   Layer 2 – LLM classification (intent-focused, not subject-focused)
    //   Layer 3 – Heuristic safeguard: override "General Discussion" when
    //             Layer 1 finds strong educational signals
    //
    // IMPORTANT: No hardcoded subjects, technology names, or domain words.
    // Classification is based purely on INTENT (teaching vs. working).
    // ────────────────────────────────────────────────────────────────────────

    // ── Layer 1: Generic educational signal heuristic ────────────────────────
    // Detects topic-agnostic teaching/learning intent from the transcript text.
    // Returns a signal count and a boolean isEducational determination.
    const detectEducationalSignals = (text) => {
      const t = text.toLowerCase()
      let intentCount = 0
      let definitionCount = 0
      let enumerationCount = 0
      let explanatoryCount = 0

      // Teaching intent phrases — topic-agnostic instructional language
      const intentPatterns = [
        /\btoday (we|i|let'?s) (will |are |'re )?(learn|understand|study|discuss|cover|look at|go through|explain|talk about)\b/,
        /\blet'?s (learn|understand|study|look at|go through|talk about|explore)\b/,
        /\bi('?ll| will| am going to) (explain|teach|show|demonstrate|walk you through|go over)\b/,
        /\bthis (session|class|lecture|lesson|tutorial|module|unit)\b/,
        /\bby the end of (this|today|the session|the class)\b/,
        /\bpay attention\b/,
        /\btake (notes?|note of)\b/,
        /\bany (questions?|doubts?|clarifications?)\b/,
        /\bdoes (anyone|somebody|everyone) (understand|know|remember|recall|have questions)\b/,
        /\b(instructor|professor|teacher|trainer|tutor)\b/,
        /\b(students?|learners?|class|audience)\b.*\b(understand|know|see)\b/,
        /\bwe can (now|next|also|then|further)\b.*\b(see|learn|understand|look at|discuss|cover)\b/,
      ]

      // Definition patterns — explicit explanation of concepts
      const definitionPatterns = [
        /\b(is|are) (defined|known) as\b/,
        /\bthe definition of\b/,
        /\bwhat (is|are) (a |an |the )?\w+/,
        /\b(basically|simply|essentially|technically|formally) (it|this|that|they) (is|are|means|refers|works)\b/,
        /\bin other words\b/,
        /\bto put it (simply|differently|another way)\b/,
        /\bthink of it as\b/,
        /\bit means (that|when|if)?\b/,
        /\bthat is[,:]?\s/,
        /\bi\.?e\.?\b/,
      ]

      // Enumeration patterns — teaching structure signals
      const enumerationPatterns = [
        /\bthere are (\d+|one|two|three|four|five|six|seven|eight|nine|ten|multiple|several|many|different) (types?|kinds?|forms?|ways?|steps?|stages?|phases?|methods?|components?|parts?|categories?|pillars?|properties?|features?|aspects?|elements?|principles?|rules?|cases?|conditions?|levels?|modes?)\b/,
        /\bthe (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|next|final|another|one more) (type|kind|form|way|step|stage|phase|method|category|component|pillar|property|feature)\b/,
        /\bnumber (one|two|three|four|five|six|1|2|3|4|5|6)[,: ]/,
        /\bpoint (one|two|three|four|five|1|2|3|4|5)[,: ]/,
        /\b(examples?|for example|for instance|e\.?g\.?)[,: ]/,
        /\bsuch as\b/,
        /\bnamely\b/,
        /\bfirstly[,: ]/,
        /\bsecondly[,: ]/,
      ]

      // Explanatory/analytical language
      const explanatoryPatterns = [
        /\bhow (does|do|it|this|that) (work|function|happen|occur|operate|behave)\b/,
        /\bwhy (is|are|does|do|would|should|can|could|did)\b/,
        /\bthe (reason|purpose|goal|aim|advantage|benefit|disadvantage|use|usage|application) (is|of|for|behind)\b/,
        /\bused (for|to|when|in|by)\b/,
        /\b(helps?|allows?|enables?|prevents?|ensures?|provides?|offers?) (us|you|the .{0,20})\b/,
        /\bunderstand (how|why|what|when|where)\b/,
        /\bthe concept of\b/,
        /\bthe difference between\b/,
        /\badvantage(s)? of\b/,
        /\bdisadvantage(s)? of\b/,
        /\bcompared to\b/,
      ]

      for (const p of intentPatterns)      { if (p.test(t)) intentCount++ }
      for (const p of definitionPatterns)  { if (p.test(t)) definitionCount++ }
      for (const p of enumerationPatterns) { if (p.test(t)) enumerationCount++ }
      for (const p of explanatoryPatterns) { if (p.test(t)) explanatoryCount++ }

      const totalSignals = intentCount + definitionCount + enumerationCount + explanatoryCount
      const signals = []
      if (intentCount > 0)      signals.push(`intent(${intentCount})`)
      if (definitionCount > 0)  signals.push(`definition(${definitionCount})`)
      if (enumerationCount > 0) signals.push(`enumeration(${enumerationCount})`)
      if (explanatoryCount > 0) signals.push(`explanatory(${explanatoryCount})`)

      // Threshold: high confidence = 1 intent + 3+ total, or 2+ defs + 4+ total, or 6+ total
      const isEducational = (intentCount >= 1 && totalSignals >= 3)
        || (definitionCount >= 2 && totalSignals >= 4)
        || (enumerationCount >= 2 && totalSignals >= 3)
        || (totalSignals >= 6)

      return { intentCount, definitionCount, enumerationCount, explanatoryCount, totalSignals, signals, isEducational }
    }

    const heuristic = detectEducationalSignals(transcriptText.slice(0, 8000))
    const heuristicType = heuristic.isEducational ? 'Educational / Lecture' : null

    console.log('[Meeting Classification - Layer 1 Heuristic]')
    console.log(`  educational_signals=[${heuristic.signals.join(', ')}]`)
    console.log(`  total_signals=${heuristic.totalSignals}`)
    console.log(`  heuristic_verdict=${heuristicType || 'non-educational'}`)

    // ── Layer 2: LLM classification (intent-focused) ──────────────────────────
    let meetingType = 'General Discussion'
    try {
      const classifyMessages = [
        {
          role: 'system',
          content: `You are a meeting intent classifier. Read the transcript and output ONLY {"meetingType": "<value>"}.

Your job is to determine the PRIMARY INTENT of the meeting — not the subject matter.

Choose exactly one value:

- "Educational / Lecture" — The meeting's primary intent is TEACHING or LEARNING. One or more people are explaining concepts, giving definitions, describing how things work, listing types/stages/steps, demonstrating processes, or answering questions from learners. The subject can be ANYTHING: science, technology, history, law, medicine, cooking, music, finance — it does not matter. If someone is teaching and others are learning, choose this.

- "Technical / Development" — A team of professionals working together on a software project (sprint planning, code review, bug triage, system design, architecture discussion). The intent is to make decisions or coordinate work among team members — NOT to teach concepts to learners.

- "Business / Professional" — Business strategy, HR, sales, finance, project management, client meetings, or organizational planning among colleagues or clients.

- "General Discussion" — LAST RESORT ONLY. Use only when the meeting clearly does not involve teaching/learning, technical team work, or business matters. Ordinary personal conversations, casual chat, or unclassifiable content.

DECISION RULE:
Ask yourself: "Is someone primarily explaining or teaching something to someone else?"
- YES → "Educational / Lecture"
- NO, but it's a team technical work meeting → "Technical / Development"
- NO, but it's a business meeting → "Business / Professional"
- None of the above → "General Discussion"

IMPORTANT: The same subject (e.g. programming, networking) can appear in different types:
- A lecture about programming → "Educational / Lecture"
- A sprint planning meeting about a programming project → "Technical / Development"
The difference is INTENT, not SUBJECT.

Output ONLY valid JSON with no explanation: {"meetingType": "<one of the four values above>"}`
        },
        {
          role: 'user',
          content: `Classify this transcript:\n\n${transcriptText.slice(0, 5000)}`
        }
      ]

      const classifyResult = await callSummaryLLM({
        messages: classifyMessages,
        temperature: 0.0,
        maxTokens: 60,
        transcriptChars: transcriptText.length,
        isJson: true
      })

      const rawClassify = classifyResult.content || '{}'
      const parsedClassify = JSON.parse(rawClassify.replace(/```json/gi, '').replace(/```/g, '').trim())
      if (parsedClassify.meetingType && typeof parsedClassify.meetingType === 'string') {
        meetingType = parsedClassify.meetingType
      }
    } catch (classifyErr) {
      console.warn('[Summary Classification Warning] LLM classification failed, using heuristic or default:', classifyErr.message)
    }

    console.log('[Meeting Classification - Layer 2 LLM]')
    console.log(`  llm_type=${meetingType}`)

    // ── Layer 3: Heuristic safeguard ──────────────────────────────────────────
    // If the LLM returns "General Discussion" but the heuristic strongly
    // detected educational signals, override to "Educational / Lecture".
    // This prevents LLM misclassification for transcripts with clear teaching
    // intent, without hardcoding any subject or domain knowledge.
    const llmType = meetingType
    if (meetingType === 'General Discussion' && heuristic.isEducational) {
      meetingType = 'Educational / Lecture'
      console.log('[Meeting Classification - Layer 3 Safeguard]')
      console.log(`  override: "General Discussion" → "Educational / Lecture"`)
      console.log(`  reason: heuristic detected ${heuristic.totalSignals} educational signals`)
      console.log(`  signals=[${heuristic.signals.join(', ')}]`)
    }

    console.log('[Meeting Classification - Final]')
    console.log(`  llm_type=${llmType}`)
    console.log(`  educational_signals=[${heuristic.signals.join(', ')}]`)
    console.log(`  final_type=${meetingType}`)

    // ── STEP 2: Type-specific prompt ──────────────────────────────────────────
    let systemPrompt
    let expectedSchema

    if (meetingType === 'Educational / Lecture') {
      systemPrompt = `You are an expert educational content analyst and note-taker.

Your task: analyze this educational or explanatory transcript and produce DETAILED, HIGHLY STRUCTURED study notes in JSON format.

=== CORE PRINCIPLE: GENERIC RECURSIVE HIERARCHY ===

The transcript may be about ANY subject: programming, math, science, history, law, business, medicine, engineering, or anything else.
Do NOT assume or expect any specific domain. Extract the structure from what the speaker actually says.

Every concept, category, type, stage, component, method, algorithm, rule, or classification encountered in the transcript is a NODE.
All nodes share the same structure. A node may contain child nodes. Children may contain their own children. There is no fixed meaning for any depth level — the depth reflects the natural hierarchy in the transcript.

=== ENUMERATION DETECTION ===

When the speaker explicitly introduces multiple items under a topic (using phrases such as "there are N X's", "the types are", "the stages are", "the methods include", "categories are", "the forms are", "the pillars are", "the components are", "the phases are", "the cases are", "the properties are", or any similar phrasing), you MUST:
1. Create a separate child node for EACH item. Never collapse them into a single description.
2. If any of those items itself has sub-items, nest those under that child node.
3. The number of children must match exactly what the speaker says. If speaker says 4, create 4. If speaker says 2, create 2.

=== ANTI-HALLUCINATION RULES (STRICT) ===
- ONLY include content actually stated in the transcript.
- If a definition was not given: write "Not explicitly explained in the meeting."
- If no example was given: write "No specific example was provided in the meeting."
- Do NOT add textbook knowledge not mentioned by the speaker.
- Do NOT invent definitions, examples, code, or explanations.

=== FIELD RULES ===
- definition: The definition as stated by the speaker. Not a paragraph summary.
- explanation: How the speaker elaborated or explained it. Keep separate from definition.
- purpose: Why it is used, what problem it solves — only if the speaker mentioned it.
- characteristics: Bullet list of properties mentioned. Empty array if none.
- example: A specific example the speaker gave. Quote or paraphrase from transcript.
- analogy: Any comparison or analogy the speaker used. Empty string if none.
- codeExample: Verbatim code/pseudocode if the speaker wrote or said it. Empty string if none.
- importantPoints: Bullet list of notable facts or warnings mentioned. Empty array if none.
- children: Array of child nodes for any sub-items, sub-types, sub-stages, sub-categories, sub-methods, etc.

=== OUTPUT FORMAT ===

{
  "meetingType": "Educational / Lecture",
  "overview": "2-4 sentence summary of what the session covered.",
  "nodes": [
    {
      "name": "Name of this concept, topic, category, or item as stated in the transcript",
      "definition": "Definition as stated. If not given: 'Not explicitly explained in the meeting.'",
      "explanation": "Elaboration by the speaker. Empty string if covered by children.",
      "purpose": "Why it exists or is used, if mentioned. Empty string otherwise.",
      "characteristics": ["characteristic 1", "characteristic 2"],
      "example": "Example from transcript. If none: 'No specific example was provided in the meeting.'",
      "analogy": "Any analogy used. Empty string if none.",
      "codeExample": "Code or pseudocode if mentioned verbatim. Empty string if none.",
      "importantPoints": ["important point 1"],
      "children": [
        {
          "name": "Child name — a sub-type, sub-stage, sub-method, category item, or nested concept",
          "definition": "...",
          "explanation": "...",
          "purpose": "",
          "characteristics": [],
          "example": "...",
          "analogy": "",
          "codeExample": "",
          "importantPoints": [],
          "children": []
        }
      ]
    }
  ],
  "keyPoints": ["Overall key takeaway 1", "Key takeaway 2"],
  "decisionsMade": [],
  "actionItems": []
}`
      expectedSchema = 'educational'

    } else if (meetingType === 'Technical / Development') {
      systemPrompt = `You are an expert technical meeting analyst.

Analyze this technical meeting transcript and produce a structured JSON summary.

CRITICAL RULES:
- Only include content actually discussed. Never invent technical details.
- Preserve code snippets, commands, or technical specifications mentioned.
- Be specific about technical decisions and their rationale.

REQUIRED JSON SCHEMA:
{
  "meetingType": "Technical / Development",
  "overview": "2-4 sentence overview of the technical meeting.",
  "topicsDiscussed": [
    {
      "title": "Topic/Problem Title",
      "description": "Detailed technical description of what was discussed, including architecture, implementation details, and technical reasoning."
    }
  ],
  "technicalDetails": [
    {
      "area": "Area name (e.g. Architecture, API Design, Database)",
      "detail": "Specific technical detail or decision discussed.",
      "codeOrExample": "Any code, command, query, or technical example mentioned. Empty string if none."
    }
  ],
  "issuesDiscussed": ["Issue 1 discussed", "Issue 2 discussed"],
  "keyPoints": ["Key technical takeaway 1", "Key technical takeaway 2"],
  "decisionsMade": ["Technical decision 1", "Technical decision 2"],
  "actionItems": [
    {
      "assignee": "Person name or empty string",
      "task": "Specific task"
    }
  ],
  "nextSteps": ["Next step 1", "Next step 2"]
}`
      expectedSchema = 'technical'

    } else if (meetingType === 'Business / Professional') {
      systemPrompt = `You are an expert business meeting analyst.

Analyze this business meeting transcript and produce a structured JSON summary.

CRITICAL RULES:
- Only include content actually discussed. Never invent decisions, owners, or deadlines.
- If assignees or deadlines are explicitly mentioned, include them. Otherwise leave empty.

REQUIRED JSON SCHEMA:
{
  "meetingType": "Business / Professional",
  "overview": "2-4 sentence overview of the meeting purpose and outcome.",
  "topicsDiscussed": [
    {
      "title": "Topic Title",
      "description": "Detailed description of what was discussed, including context and important points raised."
    }
  ],
  "keyPoints": ["Important point 1", "Important point 2"],
  "decisionsMade": ["Decision 1 with context", "Decision 2 with context"],
  "actionItems": [
    {
      "assignee": "Person name or empty string if not explicitly assigned",
      "task": "Specific task with context",
      "deadline": "Deadline if mentioned, otherwise empty string"
    }
  ],
  "openQuestions": ["Unresolved question or issue 1", "Unresolved question 2"]
}`
      expectedSchema = 'business'

    } else {
      // General Discussion
      systemPrompt = `You are an expert meeting analyst.

Analyze this meeting transcript and produce a structured JSON summary.

CRITICAL RULES:
- Only include content actually discussed. Never invent information.
- Be proportionally detailed — longer discussions get more detail.

REQUIRED JSON SCHEMA:
{
  "meetingType": "General Discussion",
  "overview": "2-4 sentence overview of the meeting.",
  "topicsDiscussed": [
    {
      "title": "Topic Title",
      "description": "Detailed description of what was discussed about this topic."
    }
  ],
  "keyPoints": ["Key point 1", "Key point 2"],
  "decisionsMade": ["Decision 1", "Decision 2"],
  "actionItems": [
    {
      "assignee": "Person name or empty string",
      "task": "Task description"
    }
  ]
}`
      expectedSchema = 'general'
    }

    // ── STEP 3: Generate the summary ──────────────────────────────────────────
    const summaryLLMResponse = await callSummaryLLM({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Meeting Transcript:\n${transcriptText}` }
      ],
      temperature: 0.2,
      maxTokens: 6000,
      transcriptChars: transcriptText.length,
      isJson: true
    })

    const rawContent = summaryLLMResponse.content || ''
    let parsedSummary = null
    try {
      const cleanJson = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim()
      parsedSummary = JSON.parse(cleanJson)
    } catch (parseErr) {
      console.warn('[Summary Parsing Error] Failed to parse JSON response:', parseErr.message)
    }

    if (!parsedSummary || typeof parsedSummary !== 'object') {
      return res.status(500).json({ message: 'Unable to format meeting summary as structured JSON. Please try again.' })
    }

    // ── STEP 4: Sanitize & Structure with Safe Fallbacks ─────────────────────
    let finalSummary

    if (expectedSchema === 'educational') {
      // Recursively normalize any node at arbitrary depth.
      // Accepts both the new `children[]` key and the legacy `subtypes[]` key.
      // All nodes share the same fields regardless of depth.
      const sanitizeNode = (n, depth = 0) => {
        if (!n || typeof n !== 'object' || !n.name) return null
        const children = Array.isArray(n.children)
          ? n.children
          : Array.isArray(n.subtypes)
            ? n.subtypes  // legacy compat
            : []
        return {
          name: String(n.name || '').trim(),
          definition: String(n.definition || '').trim(),
          explanation: String(n.explanation || '').trim(),
          purpose: String(n.purpose || n.howAchieved || '').trim(),
          characteristics: Array.isArray(n.characteristics)
            ? n.characteristics.map(x => String(x).trim()).filter(Boolean)
            : [],
          example: String(n.example || '').trim(),
          analogy: String(n.analogy || '').trim(),
          codeExample: String(n.codeExample || '').trim(),
          importantPoints: Array.isArray(n.importantPoints)
            ? n.importantPoints.map(x => String(x).trim()).filter(Boolean)
            : [],
          children: children
            .map(child => sanitizeNode(child, depth + 1))
            .filter(Boolean)
        }
      }

      // Accept new `nodes[]` key or legacy `concepts[]` key
      const rawNodes = Array.isArray(parsedSummary.nodes)
        ? parsedSummary.nodes
        : Array.isArray(parsedSummary.concepts)
          ? parsedSummary.concepts
          : []

      const sanitizedNodes = rawNodes.map(n => sanitizeNode(n)).filter(Boolean)

      // Count total nested items for diagnostics
      const countItems = (nodes) => nodes.reduce((sum, n) => sum + 1 + countItems(n.children || []), 0)

      // Build backward-compatible topicsDiscussed from top-level nodes
      const topicsFromNodes = sanitizedNodes.map(n => ({
        title: n.name,
        description: n.definition?.slice(0, 150) || n.explanation?.slice(0, 150) || ''
      }))

      finalSummary = {
        meetingType: 'Educational / Lecture',
        overview: typeof parsedSummary.overview === 'string' ? parsedSummary.overview.trim() : '',
        nodes: sanitizedNodes,
        // Kept for backward compatibility in Report.jsx flat sections
        topicsDiscussed: topicsFromNodes,
        keyPoints: Array.isArray(parsedSummary.keyPoints)
          ? parsedSummary.keyPoints.map(k => String(k).trim()).filter(Boolean)
          : [],
        decisionsMade: [],
        actionItems: []
      }

      console.log('[Summary Generation Complete]')
      console.log(`  provider=${summaryLLMResponse.provider}`)
      console.log(`  top_level_nodes=${sanitizedNodes.length}`)
      console.log(`  total_nested_items=${countItems(sanitizedNodes)}`)

    } else if (expectedSchema === 'technical') {
      const technicalDetails = Array.isArray(parsedSummary.technicalDetails)
        ? parsedSummary.technicalDetails
            .filter(d => d && typeof d === 'object')
            .map(d => ({
              area: String(d.area || '').trim(),
              detail: String(d.detail || '').trim(),
              codeOrExample: String(d.codeOrExample || '').trim()
            }))
            .filter(d => d.detail)
        : []

      finalSummary = {
        meetingType: 'Technical / Development',
        overview: typeof parsedSummary.overview === 'string' ? parsedSummary.overview.trim() : '',
        topicsDiscussed: Array.isArray(parsedSummary.topicsDiscussed)
          ? parsedSummary.topicsDiscussed.map(t => ({ title: String(t.title || '').trim(), description: String(t.description || '').trim() })).filter(t => t.title)
          : [],
        technicalDetails,
        issuesDiscussed: Array.isArray(parsedSummary.issuesDiscussed)
          ? parsedSummary.issuesDiscussed.map(x => String(x).trim()).filter(Boolean)
          : [],
        keyPoints: Array.isArray(parsedSummary.keyPoints)
          ? parsedSummary.keyPoints.map(k => String(k).trim()).filter(Boolean)
          : [],
        decisionsMade: Array.isArray(parsedSummary.decisionsMade)
          ? parsedSummary.decisionsMade.map(d => String(d).trim()).filter(Boolean)
          : [],
        actionItems: Array.isArray(parsedSummary.actionItems)
          ? parsedSummary.actionItems.map(a => typeof a === 'string' ? { assignee: '', task: a.trim() } : { assignee: String(a.assignee || '').trim(), task: String(a.task || '').trim() }).filter(a => a.task)
          : [],
        nextSteps: Array.isArray(parsedSummary.nextSteps)
          ? parsedSummary.nextSteps.map(x => String(x).trim()).filter(Boolean)
          : []
      }

      console.log('[Summary Generation Complete]')
      console.log(`  provider=${summaryLLMResponse.provider}`)
      console.log(`  major_topics=${finalSummary.topicsDiscussed.length}`)
      console.log(`  summary_sections=${finalSummary.topicsDiscussed.length + finalSummary.technicalDetails.length}`)

    } else if (expectedSchema === 'business') {
      finalSummary = {
        meetingType: 'Business / Professional',
        overview: typeof parsedSummary.overview === 'string' ? parsedSummary.overview.trim() : '',
        topicsDiscussed: Array.isArray(parsedSummary.topicsDiscussed)
          ? parsedSummary.topicsDiscussed.map(t => ({ title: String(t.title || '').trim(), description: String(t.description || '').trim() })).filter(t => t.title)
          : [],
        keyPoints: Array.isArray(parsedSummary.keyPoints)
          ? parsedSummary.keyPoints.map(k => String(k).trim()).filter(Boolean)
          : [],
        decisionsMade: Array.isArray(parsedSummary.decisionsMade)
          ? parsedSummary.decisionsMade.map(d => String(d).trim()).filter(Boolean)
          : [],
        actionItems: Array.isArray(parsedSummary.actionItems)
          ? parsedSummary.actionItems.map(a => {
              if (typeof a === 'string') return { assignee: '', task: a.trim(), deadline: '' }
              return { assignee: String(a.assignee || '').trim(), task: String(a.task || '').trim(), deadline: String(a.deadline || '').trim() }
            }).filter(a => a.task)
          : [],
        openQuestions: Array.isArray(parsedSummary.openQuestions)
          ? parsedSummary.openQuestions.map(q => String(q).trim()).filter(Boolean)
          : []
      }

      console.log('[Summary Generation Complete]')
      console.log(`  provider=${summaryLLMResponse.provider}`)
      console.log(`  major_topics=${finalSummary.topicsDiscussed.length}`)
      console.log(`  summary_sections=${finalSummary.topicsDiscussed.length + 1}`)

    } else {
      // General Discussion
      finalSummary = {
        meetingType: 'General Discussion',
        overview: typeof parsedSummary.overview === 'string' ? parsedSummary.overview.trim() : '',
        topicsDiscussed: Array.isArray(parsedSummary.topicsDiscussed)
          ? parsedSummary.topicsDiscussed.map(t => typeof t === 'string' ? { title: t.trim(), description: '' } : { title: String(t.title || '').trim(), description: String(t.description || '').trim() }).filter(t => t.title)
          : [],
        keyPoints: Array.isArray(parsedSummary.keyPoints)
          ? parsedSummary.keyPoints.map(k => String(k).trim()).filter(Boolean)
          : [],
        decisionsMade: Array.isArray(parsedSummary.decisionsMade)
          ? parsedSummary.decisionsMade.map(d => String(d).trim()).filter(Boolean)
          : [],
        actionItems: Array.isArray(parsedSummary.actionItems)
          ? parsedSummary.actionItems.map(a => typeof a === 'string' ? { assignee: '', task: a.trim() } : { assignee: String(a.assignee || '').trim(), task: String(a.task || '').trim() }).filter(a => a.task)
          : []
      }

      console.log('[Summary Generation Complete]')
      console.log(`  provider=${summaryLLMResponse.provider}`)
      console.log(`  major_topics=${finalSummary.topicsDiscussed.length}`)
      console.log(`  summary_sections=${finalSummary.topicsDiscussed.length + 1}`)
    }

    const summaryJsonStr = JSON.stringify(finalSummary)

    // 5. Save to meeting_ai_summaries table (replace any existing record)
    await supabase
      .from('meeting_ai_summaries')
      .delete()
      .eq('meeting_id', meetingId)

    const { error: insertErr } = await supabase
      .from('meeting_ai_summaries')
      .insert([{ meeting_id: meetingId, summary: summaryJsonStr }])

    if (insertErr) {
      console.error('[Summary Error] Failed to save summary to DB:', insertErr)
      return res.status(500).json({ message: 'Failed to save summary to database.' })
    }

    console.log(`[Summary Success] Saved ${meetingType} summary for meeting ${meetingId}`)
    return res.status(200).json({ summary: finalSummary })
  } catch (err) {
    console.error('[Summary Error] Generate summary caught exception:', err.message)
    return res.status(500).json({ message: 'Unable to generate meeting summary. Please try again.' })
  }
}

// GET /api/meetings/summary/:meetingId
export const getSummary = async (req, res) => {
  try {
    const { meetingId } = req.params
    if (!meetingId) {
      return res.status(400).json({ message: 'Meeting ID is required.' })
    }

    const { data: record, error: fetchErr } = await supabase
      .from('meeting_ai_summaries')
      .select('summary')
      .eq('meeting_id', meetingId)
      .maybeSingle()

    if (fetchErr) throw fetchErr

    if (!record || !record.summary) {
      return res.status(404).json({ message: 'No summary found for this meeting.' })
    }

    let summaryObj = record.summary
    if (typeof summaryObj === 'string') {
      try {
        summaryObj = JSON.parse(summaryObj)
      } catch (e) {
        summaryObj = { overview: record.summary, topicsDiscussed: [], keyPoints: [], decisionsMade: [], actionItems: [] }
      }
    }

    return res.status(200).json({ summary: summaryObj })
  } catch (err) {
    console.error('Get summary error:', err)
    return res.status(500).json({ message: 'Server error retrieving summary.' })
  }
}

// 15. RETENTION CLEANUP SCHEDULE
export const startRetentionCleanup = () => {
  console.log('[Cleanup Job] Initializing 2-hour data retention cleanup schedule (every 10 minutes)...')
  setInterval(async () => {
    const now = new Date()
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()
    try {
      console.log('[Cleanup Job] Running periodic cleanup check for ended meetings older than 2 hours...')
      const { data: expiredMeetings, error: queryErr } = await supabase
        .from('meetings')
        .select('meeting_id, meeting_code')
        .eq('meeting_status', 'Ended')
        .lt('ended_at', twoHoursAgo)

      if (queryErr) {
        console.error('[Cleanup Job Error] Failed to query expired meetings:', queryErr)
        return
      }

      if (expiredMeetings && expiredMeetings.length > 0) {
        const expiredIds = expiredMeetings.map(m => m.meeting_id)
        console.log(`[Cleanup Job] Found ${expiredIds.length} expired meeting(s) older than 2 hours. Permanently deleting:`, expiredMeetings.map(m => m.meeting_code))

        const { error: deleteErr } = await supabase
          .from('meetings')
          .delete()
          .in('meeting_id', expiredIds)

        if (deleteErr) {
          console.error('[Cleanup Job Error] Failed to hard delete expired meetings:', deleteErr)
        } else {
          console.log('[Cleanup Job] Hard deleted expired meetings and their cascading records successfully.')
          expiredIds.forEach(id => clearMeetingCounters(id))
        }
      }
    } catch (err) {
      console.error('[Cleanup Job Error] Unexpected error during cleanup check:', err)
    }
  }, 10 * 60 * 1000)
}

// 16. SUBMIT ATTENDANCE (AI Face Detection record)
export const submitAttendance = async (req, res) => {
  try {
    const {
      meetingId,
      presenceSeconds,
      meetingDurationSeconds,
      cameraPermission,
      isFinalSubmit   // true = fresh final submission → overwrite DB; false/absent = reconnect → accumulate
    } = req.body

    console.log('[Attendance Backend]')
    console.log(`  meetingId=${meetingId}`)
    console.log(`  userId=${req.user?.id}`)
    console.log(`  presenceSeconds=${presenceSeconds}`)
    console.log(`  meetingDurationSeconds=${meetingDurationSeconds}`)
    console.log(`  isFinalSubmit=${isFinalSubmit}`)

    if (!meetingId) {
      console.error('[Attendance Error] Missing meetingId')
      return res.status(400).json({ message: 'Meeting ID is required.' })
    }

    // Fetch the meeting to check host_id and meeting timestamps (started_at, ended_at, created_at)
    const { data: meetingCheck, error: mErrCheck } = await supabase
      .from('meetings')
      .select('host_id, started_at, ended_at, created_at')
      .eq('meeting_id', meetingId)
      .maybeSingle()

    if (mErrCheck) {
      console.error('[Attendance Error] Failed to fetch meeting details:', mErrCheck)
    } else if (meetingCheck && meetingCheck.host_id === req.user.id) {
      console.log('[Attendance] Bypassing attendance submission: User is the meeting host.')
      return res.status(200).json({ message: 'Host attendance bypassed.' })
    }

    const incomingPresence = presenceSeconds !== undefined ? Number(presenceSeconds) : 0
    const incomingDuration = meetingDurationSeconds !== undefined ? Number(meetingDurationSeconds) : 0
    const incomingCamPermission = !!cameraPermission
    const isOverwrite = isFinalSubmit === true

    console.log('[Attendance Backend Received]', {
      meetingId,
      userId: req.user.id,
      incomingPresence,
      incomingDuration,
      isFinalSubmit: isOverwrite
    })

    // Fetch existing attendance record for this user and meeting if it exists
    const { data: existingRecord, error: fetchErr } = await supabase
      .from('meeting_attendance')
      .select('presence_seconds, meeting_duration_seconds, camera_permission')
      .eq('meeting_id', meetingId)
      .eq('user_id', req.user.id)
      .maybeSingle()

    if (fetchErr) {
      console.error('[Attendance Error] Attendance SELECT failed:', fetchErr)
    } else {
      console.log('[Attendance] Existing record found:', !!existingRecord, existingRecord ? `(presence_seconds=${existingRecord.presence_seconds})` : '')
    }

    let finalPresence
    let finalDuration
    let finalCameraPermission

    if (existingRecord && !isOverwrite) {
      // Reconnect path: frontend lost its state (no isFinalSubmit flag) — accumulate
      console.log('[Attendance] Accumulating (reconnect): old presence =', existingRecord.presence_seconds, '+ new =', incomingPresence)
      finalPresence = (existingRecord.presence_seconds || 0) + incomingPresence
      finalDuration = (existingRecord.meeting_duration_seconds || 0) + incomingDuration
      finalCameraPermission = existingRecord.camera_permission || incomingCamPermission
    } else {
      // Final submit path: frontend sends authoritative total — overwrite
      if (existingRecord && isOverwrite) {
        console.log('[Attendance] Overwriting stale record. Old presence =', existingRecord.presence_seconds, '→ New presence =', incomingPresence)
      } else {
        console.log('[Attendance] First submission (no existing record). Presence =', incomingPresence)
      }
      finalPresence = incomingPresence
      finalDuration = incomingDuration
      finalCameraPermission = incomingCamPermission
    }

    // Clamp to sane values
    finalPresence = Math.max(0, finalPresence)
    finalDuration = Math.max(0, finalDuration)

    // Denominator for percentage = participant's submitted connection time (meetingDurationSeconds).
    // This is the time the participant was actually connected to the meeting, submitted by the
    // frontend from sessionStartTimeRef → Date.now(). It is NOT the full meeting wall-clock time
    // from DB timestamps, which can be longer if the host started early.
    //
    // Example: host starts at T=0, participant joins at T=13s, meeting ends at T=137s.
    //   DB meeting duration = 137s
    //   Participant connection time = 124s (submitted by frontend)
    //   Face presence = 96s
    //   Correct percentage = 96/124 = 77.42%  ← use finalDuration (124s)
    //   Wrong percentage  = 96/137 = 70.07%  ← would result from DB timestamps
    let totalMeetingSec = finalDuration > 0 ? finalDuration : 0

    // Fallback: if frontend sent 0 duration (e.g., sessionStartTimeRef was never set),
    // use actual meeting wall-clock time from DB timestamps so we don't divide by zero.
    if (totalMeetingSec <= 0 && meetingCheck) {
      const start = meetingCheck.started_at || meetingCheck.created_at
      const end = meetingCheck.ended_at || new Date().toISOString()
      if (start) {
        totalMeetingSec = Math.max(1, Math.round((new Date(end) - new Date(start)) / 1000))
      }
    }
    totalMeetingSec = Math.max(1, totalMeetingSec)

    // Presence can never exceed the participant's connection time
    finalPresence = Math.min(finalPresence, totalMeetingSec)

    // Attendance percentage: face-presence / participant-connection-time
    const participantAttendanceSec = finalPresence
    const rawPercentage = (participantAttendanceSec / totalMeetingSec) * 100
    const finalPercentage = Math.max(0, Math.min(100, Number(rawPercentage.toFixed(2))))
    const finalStatus = finalPercentage >= 75 ? 'Present' : 'Absent'

    console.log('[Attendance Backend Write]')
    console.log(`  presence_seconds=${finalPresence}`)
    console.log(`  meeting_duration_seconds=${finalDuration}`)
    console.log(`  totalMeetingSec_used_as_denominator=${totalMeetingSec}`)
    console.log(`  attendance_percentage=${finalPercentage.toFixed(2)}`)
    console.log(`  status=${finalStatus}`)

    // Upsert to handle disconnects/reconnects without duplicate rows
    const { error: upsertErr } = await supabase
      .from('meeting_attendance')
      .upsert(
        {
          meeting_id: meetingId,
          user_id: req.user.id,
          meeting_duration_seconds: finalDuration,
          presence_seconds: finalPresence,
          attendance_percentage: finalPercentage,
          status: finalStatus,
          camera_permission: finalCameraPermission
        },
        {
          onConflict: 'meeting_id,user_id'
        }
      )

    if (upsertErr) {
      console.error('[Attendance Error] Supabase upsert failed:', upsertErr)
      return res.status(500).json({ message: 'Failed to save attendance record.' })
    }

    // Verify the row actually exists in DB after upsert
    const { data: verifyRow } = await supabase
      .from('meeting_attendance')
      .select('presence_seconds, attendance_percentage, status')
      .eq('meeting_id', meetingId)
      .eq('user_id', req.user.id)
      .maybeSingle()

    console.log('[Attendance DB]')
    console.log(`  record exists after upsert=${!!verifyRow}`)
    console.log(`  presence_seconds=${verifyRow?.presence_seconds ?? 'n/a'}`)
    console.log(`  attendance_percentage=${verifyRow?.attendance_percentage ?? 'n/a'}`)
    console.log(`  status=${verifyRow?.status ?? 'n/a'}`)

    console.log('[Attendance] Saved successfully — presence:', finalPresence, 's,', finalPercentage.toFixed(2), '%, status:', finalStatus)
    return res.status(200).json({ message: 'Attendance recorded successfully.' })
  } catch (err) {
    console.error('[Attendance Error] Unexpected exception:', err)
    return res.status(500).json({ message: err.message || 'Server error recording attendance.' })
  }
}

// 17. GET ATTENDANCE REPORT
export const getAttendanceReport = async (req, res) => {
  console.log('[Attendance] Attendance report request received for meetingId:', req.params.meetingId)
  try {
    const { meetingId } = req.params
    if (!meetingId) {
      return res.status(400).json({ message: 'Meeting ID is required.' })
    }

    // Fetch the meeting to find host_id and timestamps
    const { data: meeting, error: mErr } = await supabase
      .from('meetings')
      .select('host_id, started_at, ended_at, created_at')
      .eq('meeting_id', meetingId)
      .maybeSingle()

    const hostId = meeting?.host_id

    // Compute total meeting duration in seconds
    const start = meeting?.started_at ? new Date(meeting.started_at) : (meeting?.created_at ? new Date(meeting.created_at) : null)
    const end = meeting?.ended_at ? new Date(meeting.ended_at) : new Date()
    const totalMtgSec = start ? Math.max(1, Math.round((end - start) / 1000)) : 0

    console.log('[Attendance Report]')
    console.log(`  meetingId=${meetingId}`)
    console.log(`  meetingFound=${!!meeting}`)
    console.log(`  hostId=${hostId}`)
    console.log(`  totalMtgSec=${totalMtgSec}`)

    // Join users table to get the user's full_name dynamically
    let query = supabase
      .from('meeting_attendance')
      .select('*, user:user_id ( full_name )')
      .eq('meeting_id', meetingId)

    if (hostId) {
      query = query.neq('user_id', hostId)
    }

    const { data: records, error } = await query

    if (error) {
      console.error('[Attendance Error] Attendance SELECT failed for report:', error)
      return res.status(500).json({ message: 'Failed to retrieve attendance logs.' })
    }

    console.log(`  records found=${records?.length ?? 0}`)
    if (records && records.length > 0) {
      records.forEach((r, i) => {
        console.log(`  record[${i}] user_id=${r.user_id} presence_seconds=${r.presence_seconds} status=${r.status}`)
      })
    }

    const rowCount = records?.length || 0
    console.log(`[Attendance] Attendance SELECT returned ${rowCount} rows`)

    // Map records — recalculate percentage using the stored participant connection time
    // (rec.meeting_duration_seconds) as the denominator, NOT the DB wall-clock meeting time.
    // This must match the logic in submitAttendance exactly.
    const mapped = (records || []).map((rec) => {
      const pAttendanceSec = Math.max(0, rec.presence_seconds != null ? Number(rec.presence_seconds) : 0)
      const storedDuration = rec.meeting_duration_seconds != null ? Number(rec.meeting_duration_seconds) : 0

      // Denominator priority: participant's connection time → DB meeting wall-clock → 1 (safety)
      const denominator = storedDuration > 0 ? storedDuration
                        : totalMtgSec     > 0 ? totalMtgSec
                        : 1

      // Presence can never exceed the denominator used
      const clampedPresence = Math.min(pAttendanceSec, denominator)
      const calcPercentage = Math.max(0, Math.min(100, Number(((clampedPresence / denominator) * 100).toFixed(2))))
      const calcStatus = calcPercentage >= 75 ? 'Present' : 'Absent'

      console.log('[Attendance Report Calculation]')
      console.log(`  user_id=${rec.user_id}`)
      console.log(`  presence_seconds=${pAttendanceSec}`)
      console.log(`  meeting_duration_seconds=${storedDuration}`)
      console.log(`  totalMtgSec_fallback=${totalMtgSec}`)
      console.log(`  denominator_used=${denominator}`)
      console.log(`  calculated_percentage=${calcPercentage}`)

      return {
        id: rec.id,
        meeting_id: rec.meeting_id,
        user_id: rec.user_id,
        participant_name: rec.user?.full_name || 'Anonymous User',
        meeting_duration_seconds: storedDuration,
        presence_seconds: clampedPresence,
        attendance_percentage: calcPercentage,
        status: calcStatus,
        camera_permission: rec.camera_permission
      }
    })

    // Sort by name in memory
    mapped.sort((a, b) => a.participant_name.localeCompare(b.participant_name))

    console.log(`[Attendance] Attendance report generated successfully with ${mapped.length} records`)
    return res.status(200).json(mapped)
  } catch (err) {
    console.error('[Attendance Error] Unexpected exception fetching report:', err)
    return res.status(500).json({ message: 'Server error retrieving attendance report.' })
  }
}

// 18. DELETE ATTENDANCE RECORDS (After successful PDF download verification)
export const deleteAttendanceRecords = async (req, res) => {
  console.log('[Attendance] Attendance delete request received')
  try {
    const { meetingId } = req.params
    if (!meetingId) {
      return res.status(400).json({ message: 'Meeting ID is required.' })
    }

    const { error } = await supabase
      .from('meeting_attendance')
      .delete()
      .eq('meeting_id', meetingId)

    if (error) {
      console.error('[Attendance Error] Failed to delete records from DB:', error)
      return res.status(500).json({ message: 'Failed to delete attendance logs.' })
    }

    console.log('[Attendance] Attendance deleted successfully for meeting:', meetingId)
    return res.status(200).json({ message: 'Attendance records cleared.' })
  } catch (err) {
    console.error('[Attendance Error] Unexpected exception deleting attendance:', err)
    return res.status(500).json({ message: 'Server error deleting attendance records.' })
  }
}
