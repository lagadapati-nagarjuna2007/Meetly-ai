import crypto from 'crypto'
import bcrypt from 'bcrypt'
import { AccessToken } from 'livekit-server-sdk'
import { supabase } from '../config/supabase.js'
import { clearMeetingCounters } from '../services/aiChat.service.js'
import { scheduleCleanup, cancelCleanup } from '../services/meetingCleanup.js'
import { authorizeHost } from '../utils/authHelper.js'

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
          enable_ai_attendance: !!enableAiAttendance
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
    if (meeting.auto_admit === false && !isHost) {
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

    return res.status(200).json({
      message: 'Joined meeting successfully.',
      token,
      roomName: meeting.room_name,
      livekitUrl: livekitUrl || 'ws://localhost:7880',
      meeting
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

    return res.status(200).json({
      meeting,
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

// 14. GENERATE SUMMARY (Llama 3.3 Chat Completions)
export const generateSummary = async (req, res) => {
  try {
    const { meetingId } = req.body
    if (!meetingId) {
      return res.status(400).json({ message: 'Meeting ID is required.' })
    }

    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) {
      return res.status(500).json({ message: 'Groq API key not configured on server.' })
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

    // 2. Concatenate transcripts
    const transcriptText = chunks
      .map(c => `${c.speaker_name}: ${c.transcript}`)
      .join('\n')

    console.log(`[Summary] Generating summary for meeting ${meetingId} from ${chunks.length} transcript chunks...`)

    // 3. Call Groq Llama 3.3
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `You are an AI Meeting Assistant.

Read the following meeting transcript and generate a professional meeting summary.

Requirements:
- Summarize only what was discussed.
- Include important decisions.
- Include conclusions if mentioned.
- Include action items only if explicitly discussed.
- Do not invent information.
- Do not include attendance.
- Do not include timestamps.
- Do not include speaker statistics.
- Do not include sentiment analysis.
- Return clean plain text suitable for a PDF.`
          },
          {
            role: 'user',
            content: transcriptText
          }
        ],
        temperature: 0.1
      })
    })

    if (!groqRes.ok) {
      const errorText = await groqRes.text()
      console.error('[Summary Error] Groq API returned error:', errorText)
      return res.status(500).json({ message: 'Unable to generate meeting summary. Please try again.' })
    }

    const result = await groqRes.json()
    const summary = result.choices?.[0]?.message?.content || ''

    if (!summary) {
      return res.status(500).json({ message: 'Unable to generate meeting summary. Please try again.' })
    }

    // 4. Save to meeting_ai_summaries table
    // Delete any existing summary for this meeting first
    await supabase
      .from('meeting_ai_summaries')
      .delete()
      .eq('meeting_id', meetingId)

    const { error: insertErr } = await supabase
      .from('meeting_ai_summaries')
      .insert([
        {
          meeting_id: meetingId,
          summary
        }
      ])

    if (insertErr) {
      console.error('[Summary Error] Failed to save summary to DB:', insertErr)
      return res.status(500).json({ message: 'Failed to save summary to database.' })
    }

    console.log(`[Summary Success] Generated summary for meeting ${meetingId}`)
    return res.status(200).json({ summary })
  } catch (err) {
    console.error('Generate summary error:', err)
    return res.status(500).json({ message: 'Unable to generate meeting summary. Please try again.' })
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
  console.log('[Attendance] Attendance endpoint called')
  try {
    const {
      meetingId,
      presenceSeconds,
      meetingDurationSeconds,
      cameraPermission
    } = req.body

    if (!meetingId) {
      console.error('[Attendance Error] Missing meetingId')
      return res.status(400).json({ message: 'Meeting ID is required.' })
    }

    // Fetch the meeting to check if current user is the host
    const { data: meetingCheck, error: mErrCheck } = await supabase
      .from('meetings')
      .select('host_id')
      .eq('meeting_id', meetingId)
      .maybeSingle()

    if (mErrCheck) {
      console.error('[Attendance Error] Failed to fetch meeting host_id:', mErrCheck)
    } else if (meetingCheck && meetingCheck.host_id === req.user.id) {
      console.log('[Attendance] Bypassing attendance submission: User is the meeting host.')
      return res.status(200).json({ message: 'Host attendance bypassed.' })
    }

    console.log('[Attendance Backend Received]', {
      meetingId,
      userId: req.user.id,
      presenceSeconds,
      meetingDurationSeconds
    })

    // Fetch existing attendance record for this user and meeting if it exists
    console.log(`[Attendance] Attendance SELECT running for meetingId=${meetingId}, userId=${req.user.id}`)
    const { data: existingRecord, error: fetchErr } = await supabase
      .from('meeting_attendance')
      .select('presence_seconds, meeting_duration_seconds, camera_permission')
      .eq('meeting_id', meetingId)
      .eq('user_id', req.user.id)
      .maybeSingle()

    if (fetchErr) {
      console.error('[Attendance Error] Attendance SELECT failed:', fetchErr)
    } else {
      console.log(`[Attendance] Attendance SELECT completed. Record found:`, !!existingRecord)
    }

    let finalDuration = meetingDurationSeconds !== undefined ? Number(meetingDurationSeconds) : 0
    let finalPresence = presenceSeconds !== undefined ? Number(presenceSeconds) : 0
    let finalCameraPermission = !!cameraPermission

    if (existingRecord) {
      console.log('[Attendance] Attendance UPDATE (Rejoin): Accumulating metrics')
      finalDuration = (existingRecord.meeting_duration_seconds || 0) + finalDuration
      finalPresence = (existingRecord.presence_seconds || 0) + finalPresence
      finalCameraPermission = existingRecord.camera_permission || finalCameraPermission
    } else {
      console.log('[Attendance] Attendance INSERT (First Join): Initializing metrics')
    }

    const finalPercentage = finalDuration > 0 ? (finalPresence / finalDuration) * 100 : 0
    const finalStatus = finalPercentage >= 75 ? 'Present' : 'Absent'

    console.log('[Attendance Backend Mapped Values to Write]', {
      meetingId,
      userId: req.user.id,
      finalDuration,
      finalPresence,
      finalPercentage: finalPercentage.toFixed(2),
      finalStatus,
      finalCameraPermission
    })

    // Upsert to handle disconnects/reconnects without duplicate rows
    const { error: upsertErr } = await supabase
      .from('meeting_attendance')
      .upsert(
        {
          meeting_id: meetingId,
          user_id: req.user.id,
          meeting_duration_seconds: finalDuration,
          presence_seconds: finalPresence,
          attendance_percentage: Number(finalPercentage.toFixed(2)),
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

    console.log('[Attendance] Attendance saved successfully')
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

    // Fetch the meeting to find host_id
    const { data: meeting, error: mErr } = await supabase
      .from('meetings')
      .select('host_id')
      .eq('meeting_id', meetingId)
      .maybeSingle()

    const hostId = meeting?.host_id

    // Join users table to get the user's full_name dynamically
    console.log(`[Attendance] Attendance SELECT running for report meetingId=${meetingId}`)
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

    const rowCount = records?.length || 0
    console.log(`[Attendance] Attendance SELECT returned ${rowCount} rows`)

    // Map records to match frontend expected fields
    const mapped = (records || []).map((rec) => ({
      id: rec.id,
      meeting_id: rec.meeting_id,
      user_id: rec.user_id,
      participant_name: rec.user?.full_name || 'Anonymous User',
      meeting_duration_seconds: rec.meeting_duration_seconds,
      presence_seconds: rec.presence_seconds,
      attendance_percentage: rec.attendance_percentage,
      status: rec.status,
      camera_permission: rec.camera_permission
    }))

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
