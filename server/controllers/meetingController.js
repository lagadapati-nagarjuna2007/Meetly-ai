import crypto from 'crypto'
import bcrypt from 'bcrypt'
import { AccessToken } from 'livekit-server-sdk'
import { supabase } from '../config/supabase.js'

// UUID validation helper
const isUuid = (val) => {
  if (!val) return false
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val)
}

// Clean up stale meetings and orphaned participant records for a user.
// This ensures that abandoned meetings never permanently block meeting creation.
const cleanupStaleMeetings = async (userId, isCreateIntent = false) => {
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

    // 3. If user has intent to create a NEW meeting from Dashboard (isCreateIntent = true),
    // clean up any abandoned joined participant records in existing Active/Waiting meetings.
    if (isCreateIntent) {
      const { data: activeJoined } = await supabase
        .from('participants')
        .select('participant_id, meeting_id, meetings(meeting_id, host_id, meeting_status)')
        .eq('user_id', userId)
        .in('participant_status', ['joined', 'disconnected'])

      if (activeJoined && activeJoined.length > 0) {
        for (const p of activeJoined) {
          if (p.meetings && (p.meetings.meeting_status === 'Active' || p.meetings.meeting_status === 'Waiting')) {
            console.log(`[Cleanup] User ${userId} creating new meeting from dashboard. Marking participant ${p.participant_id} in meeting ${p.meeting_id} as left.`)
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
const getUserActiveMeetingId = async (userId) => {
  try {
    const { data: activeParticipants, error } = await supabase
      .from('participants')
      .select('meeting_id, participant_id, meetings(meeting_status)')
      .eq('user_id', userId)
      .eq('participant_status', 'joined')

    if (error) {
      console.error('[Validation Error] Checking active meeting status failed:', error)
      return null
    }

    if (!activeParticipants || activeParticipants.length === 0) {
      console.log(`[Validation Debug] User ${userId}: no 'joined' participant records found. User is free.`)
      return null
    }

    // Only block if associated meeting_status is 'Active'
    const active = activeParticipants.find(p => p.meetings?.meeting_status === 'Active')
    if (active) {
      console.log(`[Validation Block] User ${userId} IS in active meeting ${active.meeting_id}. Blocking.`)
      return active.meeting_id
    }

    console.log(`[Validation Pass] User ${userId} has joined records but none in 'Active' meetings. User is free.`)
    return null
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
    const { meetingTitle, meetingType, meetingPassword } = req.body

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
          meeting_type: type
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
    const { meetingCode, password } = req.body

    if (!meetingCode || !meetingCode.trim()) {
      return res.status(400).json({ message: 'Meeting code is required.' })
    }

    const uppercaseCode = meetingCode.trim().toUpperCase()

    console.log(`[Join Meeting] User ${req.user.id} joining code: ${uppercaseCode}`)

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
      return res.status(400).json({ message: 'Meeting has ended.' })
    }

    if (meeting.meeting_status === 'Locked') {
      return res.status(400).json({ message: 'Meeting is locked by the host.' })
    }

    // Step 1: Clean up stale state before checking
    await cleanupStaleMeetings(req.user.id, false)

    // Step 2: Block only if user is in a DIFFERENT active meeting
    const activeMeetingId = await getUserActiveMeetingId(req.user.id)
    if (activeMeetingId && activeMeetingId !== meeting.meeting_id) {
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

    // Step 4: Idempotent Participant Upsert
    const isHost = meeting.host_id === req.user.id
    const role = isHost ? 'host' : 'participant'

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
          left_at: null
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
            joined_at: new Date().toISOString()
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
              left_at: null
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
      console.log(`[Cleanup] Meeting ${meeting.meeting_id} ended because no active participants.`)
      await supabase
        .from('meetings')
        .update({ meeting_status: 'Ended', ended_at: now, updated_at: now })
        .eq('meeting_id', meeting.meeting_id)
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

    if (!meetingId) {
      return res.status(400).json({ message: 'Meeting identifier is required.' })
    }

    const query = isUuid(meetingId)
      ? supabase.from('meetings').select('meeting_id, host_id').eq('meeting_id', meetingId)
      : supabase.from('meetings').select('meeting_id, host_id').eq('meeting_code', meetingId.trim().toUpperCase())

    const { data: meeting, error: fetchErr } = await query.maybeSingle()

    if (fetchErr) throw fetchErr

    if (!meeting) {
      return res.status(404).json({ message: 'Meeting not found.' })
    }

    if (meeting.host_id !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized. Only the host can end the meeting.' })
    }

    const now = new Date().toISOString()

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

    if (!meetingId) {
      return res.status(400).json({ message: 'Meeting identifier is required.' })
    }

    const query = isUuid(meetingId)
      ? supabase.from('meetings').select('meeting_id, host_id').eq('meeting_id', meetingId)
      : supabase.from('meetings').select('meeting_id, host_id').eq('meeting_code', meetingId.trim().toUpperCase())

    const { data: meeting, error: fetchErr } = await query.maybeSingle()

    if (fetchErr) throw fetchErr

    if (!meeting) {
      return res.status(404).json({ message: 'Meeting not found.' })
    }

    if (meeting.host_id !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized. Only the host can lock/unlock meetings.' })
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

    const query = isUuid(id)
      ? supabase.from('meetings').select('meeting_id, host_id').eq('meeting_id', id)
      : supabase.from('meetings').select('meeting_id, host_id').eq('meeting_code', id.trim().toUpperCase())

    const { data: meeting, error: fetchErr } = await query.maybeSingle()

    if (fetchErr) throw fetchErr

    if (!meeting) {
      return res.status(404).json({ message: 'Meeting not found.' })
    }

    if (meeting.host_id !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized. Only the host can rename the meeting.' })
    }

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

// 10. DELETE MEETING (Soft Delete - Host only)
export const deleteMeeting = async (req, res) => {
  try {
    const { id } = req.params

    const query = isUuid(id)
      ? supabase.from('meetings').select('meeting_id, host_id').eq('meeting_id', id)
      : supabase.from('meetings').select('meeting_id, host_id').eq('meeting_code', id.trim().toUpperCase())

    const { data: meeting, error: fetchErr } = await query.maybeSingle()

    if (fetchErr) throw fetchErr

    if (!meeting) {
      return res.status(404).json({ message: 'Meeting not found.' })
    }

    if (meeting.host_id !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized. Only the host can delete the meeting.' })
    }

    const now = new Date().toISOString()

    const { error: updateMtgErr } = await supabase
      .from('meetings')
      .update({
        is_deleted: true,
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

    return res.status(200).json({ message: 'Meeting deleted successfully.' })
  } catch (err) {
    console.error('Delete meeting error:', err)
    return res.status(500).json({ message: 'Server error during meeting deletion.' })
  }
}

// 11. GET USER RECENT MEETINGS
export const getRecentMeetings = async (req, res) => {
  try {
    const { data: participants, error: fetchPartErr } = await supabase
      .from('participants')
      .select('meeting_id')
      .eq('user_id', req.user.id)
      .in('participant_status', ['joined', 'active'])

    if (fetchPartErr) throw fetchPartErr

    const meetingIds = participants.map((p) => p.meeting_id)

    const { data: meetings, error: fetchMtgErr } = await supabase
      .from('meetings')
      .select(`
        *,
        host:host_id ( full_name )
      `)
      .eq('is_deleted', false)
      .or(`host_id.eq.${req.user.id},meeting_id.in.(${meetingIds.join(',') || '00000000-0000-0000-0000-000000000000'})`)
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
        type: m.meeting_type
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
    const { data: participants, error: fetchPartErr } = await supabase
      .from('participants')
      .select('meeting_id')
      .eq('user_id', req.user.id)

    if (fetchPartErr) throw fetchPartErr

    const meetingIds = participants.map((p) => p.meeting_id)

    if (meetingIds.length === 0) {
      return res.status(200).json([])
    }

    const { data: meetings, error: fetchMtgErr } = await supabase
      .from('meetings')
      .select(`
        *,
        host:host_id ( full_name )
      `)
      .eq('is_deleted', false)
      .eq('meeting_status', 'Ended')
      .in('meeting_id', meetingIds)
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
          participantsCount: count || 1
        }
      })
    )

    return res.status(200).json(formatted)
  } catch (err) {
    console.error('Get meeting history error:', err)
    return res.status(500).json({ message: 'Server error retrieving meeting history.' })
  }
}
