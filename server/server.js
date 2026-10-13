import { fileURLToPath } from 'url'
import path from 'path'
import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import { Server } from 'socket.io'
import authRoutes from './routes/auth.js'
import meetingRoutes from './routes/meetings.js'
import aiChatRoutes from './routes/aiChat.routes.js'
import recordingRoutes from './routes/recording.js'
import { supabase } from './config/supabase.js'
import { startRetentionCleanup } from './controllers/meetingController.js'
import { startRecordingRetentionCleanup } from './services/recordingRetention.js'
import { scheduleCleanup, cancelCleanup } from './services/meetingCleanup.js'
import {
  CHAT_POLICIES,
  getOrCreateRoomChat,
  getChatPolicy,
  setChatPolicy,
  isUserHostOrCoHost,
  canUserSendMessage,
  addRoomMessage,
  getGroupMessages,
  getUserDirectMessages,
  getUserVisibleMessages,
  restoreParticipantChatSession,
  isRoomChatEnded,
  clearMeetingChat
} from './services/meetingChatService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const app = express()
app.set('trust proxy', 1)
const PORT = process.env.PORT || 5000

// Configure CORS with explicit origin matching and credentials support
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'https://uneaten-unsheathe-waviness.ngrok-free.dev',
  'https://meetly-ai-platform.netlify.app'
]

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true)
      } else {
        callback(new Error('Not allowed by CORS'))
      }
    },
    credentials: true
  })
)

app.use(express.json())
app.use(cookieParser())

// Mount API routes
app.use('/api/auth', authRoutes)
app.use('/api/meeting', meetingRoutes)
app.use('/api/meetings', meetingRoutes)
app.use('/api/meetings', aiChatRoutes)
app.use('/api/meeting', aiChatRoutes)
app.use('/api/recordings/:meetingId', recordingRoutes)
app.use('/api/recordings', recordingRoutes)

// Server Health Check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date(),
    classifier_version: '3layer-2026-09-04'
  })
})

const httpServer = app.listen(PORT, () => {
  console.log(`[Meetly AI Backend] server successfully listening on port ${PORT}`)
  startRetentionCleanup()
  startRecordingRetentionCleanup()
})

// Configure Socket.IO server
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true
  }
})
app.set('io', io)

// Active socket room tracking — multi-tab/multi-socket aware.
// roomSockets: Map<roomName, Set<socketId>>  — tracks all socket IDs per room (for cleanup trigger)
// roomUserSockets: Map<roomName, Map<userId, Set<socketId>>>  — tracks which users are connected per room
// A user is considered disconnected only when their Set<socketId>.size === 0.
const roomSockets = new Map()
const roomUserSockets = new Map()

// Expose roomUserSockets on app so hostController can read connection state for validation
app.set('roomUserSockets', roomUserSockets)

// Grace period timers: Map<roomName, { timer, originalHostId, activeHostId }>
// Started when the Active Host's last socket disconnects. Cancelled if they reconnect.
const hostGracePeriodTimers = new Map()

/**
 * Returns true if a userId has at least one connected socket in the given room.
 */
const isUserConnected = (roomName, userId) => {
  if (!roomName || !userId) return false
  const userMap = roomUserSockets.get(roomName)
  if (!userMap) return false
  const sockets = userMap.get(String(userId).trim().toLowerCase())
  return sockets ? sockets.size > 0 : false
}

/**
 * Adds a socket ID to the presence maps for a user in a room.
 */
const addSocketPresence = (roomName, userId, socketId) => {
  if (!roomName || !userId || !socketId) return

  // roomSockets — flat set of all socket IDs per room
  if (!roomSockets.has(roomName)) roomSockets.set(roomName, new Set())
  roomSockets.get(roomName).add(socketId)

  // roomUserSockets — per-user set of socket IDs
  if (!roomUserSockets.has(roomName)) roomUserSockets.set(roomName, new Map())
  const userMap = roomUserSockets.get(roomName)
  const userKey = String(userId).trim().toLowerCase()
  if (!userMap.has(userKey)) userMap.set(userKey, new Set())
  userMap.get(userKey).add(socketId)
}

/**
 * Removes a socket ID from the presence maps.
 * Returns true if the user is now fully disconnected from the room (no sockets left).
 */
const removeSocketPresence = (roomName, userId, socketId) => {
  if (!roomName || !socketId) return true

  // roomSockets
  const sockets = roomSockets.get(roomName)
  if (sockets) {
    sockets.delete(socketId)
    if (sockets.size === 0) roomSockets.delete(roomName)
  }

  // roomUserSockets
  if (!userId) return true
  const userMap = roomUserSockets.get(roomName)
  if (!userMap) return true
  const userKey = String(userId).trim().toLowerCase()
  const userSockets = userMap.get(userKey)
  if (userSockets) {
    userSockets.delete(socketId)
    if (userSockets.size === 0) {
      userMap.delete(userKey)
      if (userMap.size === 0) roomUserSockets.delete(roomName)
      return true // user is now fully disconnected
    }
  }
  return false // user still has other sockets
}

/**
 * Host transfer algorithm.
 * Called after grace period expires. Re-checks presence and DB state before transferring.
 *
 * @param {string} roomName
 * @param {string} originalHostId  - meeting.host_id
 * @param {string} disconnectedActiveHostId - the active_host_id that triggered the grace period
 * @param {object} io  - Socket.IO server instance
 */
const performHostTransfer = async (roomName, originalHostId, disconnectedActiveHostId, io) => {
  try {
    console.log(`[HostTransfer] Grace period expired for room ${roomName}. Starting race-safe transfer.`)

    // Step 1: Re-check presence — confirm Original Host is still disconnected
    if (isUserConnected(roomName, originalHostId)) {
      console.log(`[HostTransfer] ABORTED — Original Host ${originalHostId} has reconnected. No transfer needed.`)
      return
    }

    // Step 2: Re-read meeting state from DB
    const { data: meeting, error } = await supabase
      .from('meetings')
      .select('meeting_id, host_id, assigned_host_id, active_host_id, meeting_status, room_name')
      .eq('room_name', roomName)
      .maybeSingle()

    if (error || !meeting) {
      console.log(`[HostTransfer] ABORTED — Could not read meeting for room ${roomName}.`)
      return
    }

    // Only transfer for active/waiting meetings
    if (meeting.meeting_status === 'Ended' || meeting.meeting_status === 'Locked') {
      console.log(`[HostTransfer] ABORTED — Meeting ${meeting.meeting_id} status is ${meeting.meeting_status}. No transfer.`)
      return
    }

    // Step 3: Confirm active_host_id still points to the disconnected host
    const currentActiveHost = String(meeting.active_host_id || meeting.host_id || '').trim().toLowerCase()
    const expectedDisconnected = String(disconnectedActiveHostId || '').trim().toLowerCase()
    if (currentActiveHost !== expectedDisconnected) {
      console.log(`[HostTransfer] ABORTED — active_host_id changed (now ${meeting.active_host_id}) since grace period started. Transfer already handled.`)
      return
    }

    // Step 4: Determine new Active Host
    let newActiveHostId = null

    // 4a. Check if Assigned Host is currently connected
    if (meeting.assigned_host_id && isUserConnected(roomName, meeting.assigned_host_id)) {
      newActiveHostId = meeting.assigned_host_id
      console.log(`[HostTransfer] Assigned Host ${newActiveHostId} is connected — transferring to them.`)
    }

    // 4b. If not, find earliest eligible connected participant
    if (!newActiveHostId) {
      const { data: participants } = await supabase
        .from('participants')
        .select('user_id, joined_at')
        .eq('meeting_id', meeting.meeting_id)
        .eq('participant_status', 'joined')
        .order('joined_at', { ascending: true })

      if (participants && participants.length > 0) {
        const origHostLower = String(meeting.host_id || '').trim().toLowerCase()
        const assignedHostLower = meeting.assigned_host_id
          ? String(meeting.assigned_host_id).trim().toLowerCase()
          : null

        for (const p of participants) {
          const pId = String(p.user_id || '').trim().toLowerCase()
          // Exclude Original Host and the disconnected Assigned Host
          if (pId === origHostLower) continue
          if (assignedHostLower && pId === assignedHostLower && !isUserConnected(roomName, p.user_id)) continue

          if (isUserConnected(roomName, p.user_id)) {
            newActiveHostId = p.user_id
            console.log(`[HostTransfer] Auto-selected earliest connected participant ${newActiveHostId} as new Active Host.`)
            break
          }
        }
      }
    }

    // 4c. No eligible participant — follow existing cleanup
    if (!newActiveHostId) {
      console.log(`[HostTransfer] No eligible connected participant found for room ${roomName}. Existing cleanup will handle.`)
      return
    }

    // Step 5: Update DB
    const { error: updateErr } = await supabase
      .from('meetings')
      .update({ active_host_id: newActiveHostId, updated_at: new Date().toISOString() })
      .eq('meeting_id', meeting.meeting_id)

    if (updateErr) {
      console.error(`[HostTransfer] DB update failed:`, updateErr)
      return
    }

    console.log(`[HostTransfer] active_host_id updated: ${disconnectedActiveHostId} → ${newActiveHostId} for meeting ${meeting.meeting_id}`)

    // Step 6: Fetch name and emit events
    const { data: newHostUser } = await supabase
      .from('users')
      .select('full_name')
      .eq('id', newActiveHostId)
      .maybeSingle()

    if (io) {
      const payload = {
        originalHostId: meeting.host_id,
        assignedHostId: meeting.assigned_host_id || null,
        activeHostId: newActiveHostId,
        activeHostName: newHostUser?.full_name || newActiveHostId
      }
      io.to(roomName).emit('active_host_changed', payload)
      console.log(`[HostTransfer] Emitted 'active_host_changed' to room ${roomName}.`)
    }
  } catch (err) {
    console.error(`[HostTransfer] Unexpected error:`, err)
  }
}

/**
 * Extracts and verifies a participant's JWT from Socket.IO handshake or event payload.
 */
const extractSocketAuthUser = (socket, explicitToken = null) => {
  let token = explicitToken || socket?.handshake?.auth?.token || null

  if (!token && socket?.handshake?.headers?.authorization) {
    const authHeader = socket.handshake.headers.authorization
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim()
    }
  }

  if (!token && socket?.handshake?.headers?.cookie) {
    const cookies = socket.handshake.headers.cookie.split(';')
    for (const c of cookies) {
      const [rawKey, ...rawVal] = c.trim().split('=')
      if (rawKey === 'meetly_token' && rawVal.length > 0) {
        token = decodeURIComponent(rawVal.join('='))
        break
      }
    }
  }

  if (!token || !process.env.JWT_SECRET) {
    return { userId: null, authenticated: false }
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    return {
      userId: decoded?.id || null,
      email: decoded?.email || null,
      authenticated: Boolean(decoded?.id)
    }
  } catch {
    return { userId: null, authenticated: false, invalidToken: true }
  }
}

/**
 * Reauthenticates a socket participant, checks meeting active state and membership,
 * and restores their authorized in-memory chat history.
 */
const verifySocketMeetingParticipant = async (
  socket,
  roomName,
  claimedUserId = null,
  explicitToken = null,
  recipientId = null
) => {
  const authResult = extractSocketAuthUser(socket, explicitToken)
  const effectiveUserId = authResult.userId || claimedUserId || null

  if (!roomName) {
    return {
      authorized: false,
      ended: false,
      userId: effectiveUserId,
      reason: 'Room name is required.'
    }
  }

  if (isRoomChatEnded(roomName)) {
    return {
      authorized: false,
      ended: true,
      userId: effectiveUserId,
      reason: 'This meeting has ended.'
    }
  }

  const { data: meeting, error: mtgErr } = await supabase
    .from('meetings')
    .select('meeting_id, meeting_code, host_id, assigned_host_id, active_host_id, meeting_status, is_deleted, room_name')
    .eq('room_name', roomName)
    .maybeSingle()

  if (mtgErr || !meeting) {
    return {
      authorized: false,
      ended: false,
      userId: effectiveUserId,
      meeting: null,
      reason: 'Unable to verify active meeting.'
    }
  }

  if (meeting.is_deleted || meeting.meeting_status === 'Ended') {
    clearMeetingChat(roomName)
    return {
      authorized: false,
      ended: true,
      userId: effectiveUserId,
      meeting,
      reason: 'This meeting has ended.'
    }
  }

  if (!effectiveUserId) {
    return {
      authorized: false,
      ended: false,
      userId: null,
      meeting,
      reason: 'Authentication required to access meeting chat.'
    }
  }

  const isHost = isUserHostOrCoHost(meeting, effectiveUserId)
  let isMember = isHost

  if (!isMember) {
    const { data: partRow } = await supabase
      .from('participants')
      .select('participant_id, participant_status')
      .eq('meeting_id', meeting.meeting_id)
      .eq('user_id', effectiveUserId)
      .maybeSingle()

    if (partRow && ['joined', 'active', 'disconnected'].includes(partRow.participant_status)) {
      isMember = true
    }
  }

  const session = restoreParticipantChatSession({
    roomName,
    userId: effectiveUserId,
    recipientId,
    meeting,
    isParticipantAuthorized: isMember
  })

  return {
    ...session,
    userId: effectiveUserId,
    meeting
  }
}

io.on('connection', (socket) => {
  let currentRoom = null
  let currentUserId = null

  // Join Room — handles both new joins and reconnects
  socket.on('join_room', (data, callback) => {
    // Support both legacy string and new object payload { roomName, userId, token }
    const roomName = typeof data === 'string' ? data : data?.roomName
    const claimedUserId = typeof data === 'object' ? data?.userId : null
    const explicitToken = typeof data === 'object' ? data?.token : null
    const authUser = extractSocketAuthUser(socket, explicitToken)
    const joinedUserId = authUser.userId || claimedUserId || null

    if (!roomName) {
      if (typeof callback === 'function') callback({ success: false, error: 'Room name is required.' })
      return
    }

    currentRoom = roomName
    currentUserId = joinedUserId || null
    socket.join(roomName)

    // Update multi-socket presence maps
    if (joinedUserId) {
      addSocketPresence(roomName, joinedUserId, socket.id)
      console.log(`[Socket Connected] Socket ${socket.id} (user=${joinedUserId}) joined room ${roomName}.`)
    } else {
      // Legacy join without userId — only update flat roomSockets for cleanup trigger
      if (!roomSockets.has(roomName)) roomSockets.set(roomName, new Set())
      roomSockets.get(roomName).add(socket.id)
      console.log(`[Socket Connected] Socket ${socket.id} (no userId) joined room ${roomName}.`)
    }

    // Cancel pending cleanup for this room and verify chat restoration
    supabase
      .from('meetings')
      .select('meeting_id, host_id, assigned_host_id, active_host_id, meeting_status, is_deleted, room_name')
      .eq('room_name', roomName)
      .maybeSingle()
      .then(async ({ data: meeting, error: mtgErr }) => {
        if (isRoomChatEnded(roomName) || (meeting && (meeting.is_deleted || meeting.meeting_status === 'Ended'))) {
          clearMeetingChat(roomName)
          socket.emit('chat:cleared')
          if (typeof callback === 'function') callback({ success: false, ended: true })
          return
        }

        if (mtgErr || !meeting) {
          if (typeof callback === 'function') callback({ success: false, error: 'Unable to verify active meeting.' })
          return
        }

        cancelCleanup(meeting.meeting_id)

        // Verify participant membership and restore authorized in-memory chat history
        if (joinedUserId) {
          const isHost = isUserHostOrCoHost(meeting, joinedUserId)
          let isMember = isHost
          if (!isMember) {
            const { data: partRow } = await supabase
              .from('participants')
              .select('participant_id, participant_status')
              .eq('meeting_id', meeting.meeting_id)
              .eq('user_id', joinedUserId)
              .maybeSingle()
            if (partRow && ['joined', 'active', 'disconnected'].includes(partRow.participant_status)) {
              isMember = true
            }
          }

          const restored = restoreParticipantChatSession({
            roomName,
            userId: joinedUserId,
            meeting,
            isParticipantAuthorized: isMember
          })

          if (restored.authorized) {
            const initPayload = {
              policy: restored.policy,
              isHost: restored.isHost,
              groupMessages: restored.groupMessages,
              directMessages: restored.directMessages,
              selectedDirectMessages: restored.selectedDirectMessages,
              messages: restored.messages
            }
            socket.emit('chat:init', initPayload)
            if (typeof callback === 'function') {
              callback({ success: true, ...initPayload })
            }
          } else if (typeof callback === 'function') {
            callback({ success: false, error: restored.reason })
          }
        } else if (typeof callback === 'function') {
          callback({ success: true, messages: [] })
        }

        // --- Reconnect detection: Original Host ---
        if (joinedUserId && String(joinedUserId).toLowerCase() === String(meeting.host_id || '').toLowerCase()) {
          // Cancel any pending grace period for this room
          const gracePending = hostGracePeriodTimers.get(roomName)
          if (gracePending) {
            clearTimeout(gracePending.timer)
            hostGracePeriodTimers.delete(roomName)
            console.log(`[HostTransfer] Grace period CANCELLED — Original Host ${joinedUserId} reconnected to room ${roomName}.`)
          }

          const currentActiveHost = String(meeting.active_host_id || '').toLowerCase()
          const origHostLower = String(meeting.host_id || '').toLowerCase()
          const needsRestore = Boolean(gracePending)

          if (needsRestore) {
            const { error: updateErr } = await supabase
              .from('meetings')
              .update({ active_host_id: meeting.host_id, updated_at: new Date().toISOString() })
              .eq('meeting_id', meeting.meeting_id)

            if (!updateErr) {
              const { data: hostUser } = await supabase
                .from('users')
                .select('full_name')
                .eq('id', meeting.host_id)
                .maybeSingle()

              const payload = {
                originalHostId: meeting.host_id,
                assignedHostId: meeting.assigned_host_id || null,
                activeHostId: meeting.host_id,
                activeHostName: hostUser?.full_name || meeting.host_id
              }
              io.to(roomName).emit('active_host_changed', payload)
              io.to(roomName).emit('original_host_reconnected', payload)
              console.log(`[HostTransfer] Original Host ${joinedUserId} reconnected — active_host_id restored. Emitted active_host_changed + original_host_reconnected.`)
            }
          } else if (currentActiveHost === origHostLower) {
            console.log(`[HostTransfer] Original Host ${joinedUserId} joined room ${roomName} — already active host, no restore needed.`)
          } else {
            const { data: hostUser } = await supabase
              .from('users')
              .select('full_name')
              .eq('id', meeting.host_id)
              .maybeSingle()

            const payload = {
              originalHostId: meeting.host_id,
              assignedHostId: meeting.assigned_host_id || null,
              activeHostId: meeting.active_host_id,
              activeHostName: hostUser?.full_name || meeting.host_id
            }
            io.to(roomName).emit('original_host_reconnected', payload)
            console.log(`[HostTransfer] Original Host ${joinedUserId} joined room ${roomName} while ${meeting.active_host_id} is Active Host — no restore. B continues.`)
          }
        }
      })
      .catch((err) => {
        console.error('[Socket Join Error]:', err)
        if (typeof callback === 'function') callback({ success: false, error: 'Failed to join socket room.' })
      })
  })

  // Zoom-style Ephemeral Chat: Explicit History & Permission Sync on Refresh / Reconnect / Tab Mount
  const handleChatSync = async (data, callback) => {
    try {
      const roomName = data?.roomName || currentRoom
      const claimedUserId = data?.userId || currentUserId
      const explicitToken = data?.token || null
      const recipientId = data?.recipientId || null

      const verified = await verifySocketMeetingParticipant(
        socket,
        roomName,
        claimedUserId,
        explicitToken,
        recipientId
      )

      if (verified.ended) {
        socket.emit('chat:cleared')
        if (typeof callback === 'function') {
          callback({
            success: false,
            ended: true,
            error: verified.reason || 'This meeting has ended.',
            policy: CHAT_POLICIES.NO_ONE,
            groupMessages: [],
            directMessages: [],
            selectedDirectMessages: [],
            messages: []
          })
        }
        return
      }

      if (!verified.authorized) {
        if (typeof callback === 'function') {
          callback({
            success: false,
            ended: false,
            error: verified.reason || 'Not authorized to restore meeting chat.',
            policy: verified.policy || CHAT_POLICIES.EVERYONE_AND_DIRECT,
            groupMessages: [],
            directMessages: [],
            selectedDirectMessages: [],
            messages: []
          })
        }
        return
      }

      // Ensure socket presence and room membership are registered after refresh/reconnect
      currentRoom = roomName
      currentUserId = verified.userId
      socket.join(roomName)
      addSocketPresence(roomName, verified.userId, socket.id)

      const payload = {
        policy: verified.policy,
        isHost: verified.isHost,
        groupMessages: verified.groupMessages,
        directMessages: verified.directMessages,
        selectedDirectMessages: verified.selectedDirectMessages,
        messages: verified.messages
      }

      socket.emit('chat:init', payload)

      if (typeof callback === 'function') {
        callback({
          success: true,
          ...payload
        })
      }
    } catch (err) {
      console.error('[Chat Sync Error]:', err)
      if (typeof callback === 'function') {
        callback({
          success: false,
          error: 'Failed to synchronize meeting chat history.',
          groupMessages: [],
          directMessages: [],
          selectedDirectMessages: [],
          messages: []
        })
      }
    }
  }

  socket.on('chat:sync', handleChatSync)
  socket.on('chat:get_history', handleChatSync)

  // Zoom-style Ephemeral Chat: Send message (Everyone or Direct 1:1)
  socket.on('chat:send_message', async (data, callback) => {
    try {
      const { roomName, text, formatted, attachment, recipientId, recipientName, isDirect, token } = data || {}
      if (!roomName) {
        if (typeof callback === 'function') callback({ success: false, error: 'roomName is required' })
        return
      }

      const claimedSenderId = currentUserId || data.senderId
      const verified = await verifySocketMeetingParticipant(socket, roomName, claimedSenderId, token)

      if (verified.ended) {
        socket.emit('chat:cleared')
        const endError = 'This meeting has ended.'
        if (typeof callback === 'function') callback({ success: false, ended: true, error: endError })
        socket.emit('chat:error', { error: endError })
        return
      }

      if (!verified.authorized) {
        const authError = verified.reason || 'You are not authorized to send messages in this meeting.'
        if (typeof callback === 'function') callback({ success: false, error: authError })
        socket.emit('chat:error', { error: authError })
        return
      }

      const senderId = verified.userId
      const senderName = data.senderName || 'Anonymous'
      const meeting = verified.meeting

      // Ensure socket presence is registered so sender also receives direct messages across tabs
      currentRoom = roomName
      currentUserId = senderId
      socket.join(roomName)
      addSocketPresence(roomName, senderId, socket.id)

      const isSenderHost = isUserHostOrCoHost(meeting, senderId)
      const isRecipientHost = recipientId ? isUserHostOrCoHost(meeting, recipientId) : false

      const check = canUserSendMessage({
        roomName,
        senderId,
        isSenderHost,
        isDirect: Boolean(isDirect || recipientId),
        recipientId,
        isRecipientHost
      })

      if (!check.allowed) {
        if (typeof callback === 'function') callback({ success: false, error: check.reason })
        socket.emit('chat:error', { error: check.reason })
        return
      }

      const senderRole = isSenderHost ? 'host' : 'participant'
      const createdMessage = addRoomMessage(roomName, {
        senderId,
        senderName,
        senderRole,
        recipientId,
        recipientName,
        isDirect: Boolean(isDirect || recipientId),
        text,
        formatted,
        attachment
      })

      if (createdMessage.isDirect && createdMessage.recipientId) {
        // Direct message: deliver ONLY to recipient socket(s) and sender socket(s)
        const deliveredSockets = new Set()
        const userMap = roomUserSockets.get(roomName)
        if (userMap) {
          const recKey = String(createdMessage.recipientId).trim().toLowerCase()
          const recSockets = userMap.get(recKey)
          if (recSockets) {
            recSockets.forEach((sId) => {
              deliveredSockets.add(sId)
              io.to(sId).emit('chat:message', createdMessage)
            })
          }

          const sendKey = String(createdMessage.senderId).trim().toLowerCase()
          const sendSockets = userMap.get(sendKey)
          if (sendSockets) {
            sendSockets.forEach((sId) => {
              deliveredSockets.add(sId)
              io.to(sId).emit('chat:message', createdMessage)
            })
          }
        }
        if (!deliveredSockets.has(socket.id)) {
          socket.emit('chat:message', createdMessage)
        }
      } else {
        // Everyone group chat: broadcast to all room participants
        io.to(roomName).emit('chat:message', createdMessage)
      }

      // Legacy broadcast compatibility for any legacy listeners
      if (!createdMessage.isDirect) {
        const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
        io.to(roomName).emit('receive_message', {
          name: createdMessage.senderName,
          text: createdMessage.text,
          timestamp
        })
      }

      if (typeof callback === 'function') {
        callback({ success: true, message: createdMessage })
      }
    } catch (err) {
      console.error('[Chat Send Error]:', err)
      if (typeof callback === 'function') {
        callback({ success: false, error: err.message || 'Failed to send message' })
      }
    }
  })

  // Zoom-style Ephemeral Chat: Set host permission policy
  socket.on('chat:set_policy', async (data, callback) => {
    try {
      const { roomName, policy, token } = data || {}
      if (!roomName || !policy) {
        if (typeof callback === 'function') callback({ success: false, error: 'roomName and policy are required' })
        return
      }

      const claimedUserId = currentUserId || data.userId
      const verified = await verifySocketMeetingParticipant(socket, roomName, claimedUserId, token)

      if (verified.ended) {
        socket.emit('chat:cleared')
        const endMsg = 'This meeting has ended.'
        if (typeof callback === 'function') callback({ success: false, ended: true, error: endMsg })
        return
      }

      const requesterId = verified.userId
      const isHost = isUserHostOrCoHost(verified.meeting, requesterId)
      if (!isHost) {
        const errorMsg = 'Only the host or co-host can change chat permissions.'
        if (typeof callback === 'function') callback({ success: false, error: errorMsg })
        socket.emit('chat:error', { error: errorMsg })
        return
      }

      setChatPolicy(roomName, policy)
      console.log(`[MeetingChat] Chat policy in room ${roomName} updated to: ${policy} by host ${requesterId}`)

      io.to(roomName).emit('chat:policy_updated', {
        roomName,
        policy,
        updatedBy: requesterId
      })

      if (typeof callback === 'function') {
        callback({ success: true, policy })
      }
    } catch (err) {
      console.error('[Chat Set Policy Error]:', err)
      if (typeof callback === 'function') {
        callback({ success: false, error: err.message || 'Failed to update policy' })
      }
    }
  })

  // Legacy chat message broadcasting
  socket.on('send_message', (data) => {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    io.to(data.roomName).emit('receive_message', {
      name: data.name,
      text: data.text,
      timestamp
    })
  })

  // Typing state broadcasting
  socket.on('typing', (data) => {
    socket.to(data.roomName).emit('typing', {
      name: data.name,
      isTyping: data.isTyping
    })
  })

  // Host locked room trigger
  socket.on('lock_meeting', (data) => {
    io.to(data.roomName).emit('meeting_locked', { isLocked: data.isLocked })
  })

  // Remove participant trigger
  socket.on('remove_participant_from_meeting', (data) => {
    const timestamp = new Date().toISOString()
    console.log(`[Audit Log] Action: Participant Removed | Timestamp: ${timestamp} | MeetingCode: ${data.roomName} | HostId: ${socket.id} | ParticipantId: ${data.userId}`)
    io.to(data.roomName).emit('participant_removed', { userId: data.userId })
  })

  // Reaction broadcasting
  socket.on('send_reaction', (data) => {
    if (data && data.roomName) {
      io.to(data.roomName).emit('participant_reaction', {
        identity: data.identity,
        senderName: data.senderName,
        reaction: data.reaction
      })
    }
  })

  // Raise hand broadcasting
  socket.on('toggle_raise_hand', (data) => {
    if (data && data.roomName) {
      io.to(data.roomName).emit('participant_raise_hand', {
        identity: data.identity,
        senderName: data.senderName,
        raised: data.raised
      })
    }
  })

  // Status change broadcasting (e.g., Be Right Back)
  socket.on('toggle_status', (data) => {
    if (data && data.roomName) {
      io.to(data.roomName).emit('participant_status_change', {
        identity: data.identity,
        senderName: data.senderName,
        status: data.status
      })
    }
  })

  // Host ended room trigger
  socket.on('end_meeting', (roomName) => {
    if (roomName) {
      clearMeetingChat(roomName)
      io.to(roomName).emit('chat:cleared')
      io.to(roomName).emit('meeting_ended')
    }
  })

  // Socket Disconnect — multi-socket-aware with grace period + race-safe host transfer
  socket.on('disconnect', () => {
    if (!currentRoom) return

    const roomName = currentRoom
    const disconnectedUserId = currentUserId

    // Update presence maps — returns true if user is now fully disconnected
    const userFullyDisconnected = removeSocketPresence(roomName, disconnectedUserId, socket.id)

    if (disconnectedUserId) {
      console.log(`[Socket Disconnected] Socket ${socket.id} (user=${disconnectedUserId}) left room ${roomName}. User fully disconnected: ${userFullyDisconnected}`)
    } else {
      console.log(`[Socket Disconnected] Socket ${socket.id} (no userId) left room ${roomName}.`)
    }

    // --- Host Grace Period: only start if user is fully disconnected ---
    if (userFullyDisconnected && disconnectedUserId) {
      supabase
        .from('meetings')
        .select('meeting_id, meeting_code, host_id, assigned_host_id, active_host_id, meeting_status, room_name')
        .eq('room_name', roomName)
        .maybeSingle()
        .then((result) => {
          const meeting = result?.data
          if (!meeting) return
          if (meeting.meeting_status === 'Ended' || meeting.meeting_status === 'Locked') return

          const activeHostId = meeting.active_host_id || meeting.host_id
          const disconnectedLower = String(disconnectedUserId).toLowerCase()
          const activeHostLower = String(activeHostId || '').toLowerCase()

          // Only start grace period if the disconnected user IS the current Active Host.
          // CASE 3 note: If A assigned B (active_host_id = B) and then A leaves, disconnectedLower = A but
          // activeHostLower = B, so this outer condition is FALSE — no grace period starts automatically.
          // B continues as Active Host uninterrupted. No additional guard needed here.
          if (disconnectedLower === activeHostLower) {
            // Cancel any pre-existing grace timer for this room
            const existing = hostGracePeriodTimers.get(roomName)
            if (existing) {
              clearTimeout(existing.timer)
            }

            console.log(`[HostTransfer] Active Host ${disconnectedUserId} disconnected from room ${roomName}. Starting 30s grace period.`)

            const timer = setTimeout(() => {
              hostGracePeriodTimers.delete(roomName)
              performHostTransfer(roomName, meeting.host_id, activeHostId, io)
            }, 30000)

            hostGracePeriodTimers.set(roomName, {
              timer,
              originalHostId: meeting.host_id,
              activeHostId
            })
          }

          // Trigger existing room-empty cleanup if no sockets remain
          const remainingSockets = roomSockets.get(roomName)
          if (!remainingSockets || remainingSockets.size === 0) {
            if (meeting.meeting_status === 'Active' || meeting.meeting_status === 'Waiting') {
              scheduleCleanup(meeting.meeting_id, meeting.meeting_code, roomName)
            }
          }
        })
        .catch((err) => {
          console.error('[Socket Disconnect Error]:', err)
        })
    } else if (!disconnectedUserId) {
      // Legacy path (no userId on socket) — fall back to old room-empty cleanup check
      const sockets = roomSockets.get(roomName)
      if (!sockets || sockets.size === 0) {
        supabase
          .from('meetings')
          .select('meeting_id, meeting_code, meeting_status')
          .eq('room_name', roomName)
          .maybeSingle()
          .then(({ data: meeting }) => {
            if (meeting && (meeting.meeting_status === 'Active' || meeting.meeting_status === 'Waiting')) {
              scheduleCleanup(meeting.meeting_id, meeting.meeting_code, roomName)
            }
          })
          .catch((err) => {
            console.error('[Socket Cleanup Query Error]:', err)
          })
      }
    }
  })
})