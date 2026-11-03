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
import { initMeetingExpirationWorker } from './services/meetingExpiration.service.js'
import { scheduleCleanup, cancelCleanup } from './services/meetingCleanup.js'
import {
  executeParticipantRemoval,
  recoverPendingRevocations,
  startRemovalWorker,
  stopRemovalWorker,
  importLegacyFilePendingRevocations
} from './services/participantRemovalService.js'
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

const isRunningInTest =
  process.env.NODE_ENV === 'test' ||
  process.execArgv.some((arg) => arg.includes('--test')) ||
  process.argv.some((arg) => arg.includes('--test'))

let httpServer = null
let io = null

/**
 * Extracts and verifies a participant's JWT from Socket.IO handshake or explicit token.
 */
export const extractSocketAuthUser = (socket, explicitToken = null) => {
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
 * Strictly uses socket.user.id and never trusts claimedUserId.
 */
export const verifySocketMeetingParticipant = async (
  socket,
  roomName,
  recipientId = null,
  dbClient = supabase
) => {
  const effectiveUserId = socket?.user?.id || null

  if (!effectiveUserId) {
    return {
      authorized: false,
      ended: false,
      userId: null,
      meeting: null,
      reason: 'Authentication required to access meeting chat.'
    }
  }

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

  const { data: meeting, error: mtgErr } = await dbClient
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

  const isHost = isUserHostOrCoHost(meeting, effectiveUserId)
  let isMember = isHost

  if (!isMember) {
    const { data: partRow } = await dbClient
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

/**
 * Initializes and registers all secure Socket.IO handlers, authentication middleware,
 * presence tracking, host transfers, and event authorizations.
 */
export const setupSocketServer = (ioInstance, dbClient = supabase, cloudflareClient = undefined) => {
  // 1. One-time safe import of any legacy file-based pending revocations into Supabase
  importLegacyFilePendingRevocations({ dbClient }).catch((impErr) => {
    console.warn('[ParticipantRemoval Legacy Import] Error:', impErr.message)
  })

  // 2. Start background Supabase participant removal retry worker
  startRemovalWorker({ ioInstance, dbClient, cfService: cloudflareClient })

  // Active socket room tracking — multi-tab/multi-socket aware.
  const roomSockets = new Map()
  const roomUserSockets = new Map()

  // Grace period timers: Map<roomName, { timer, originalHostId, activeHostId }>
  const hostGracePeriodTimers = new Map()

  const isUserConnected = (roomName, userId) => {
    if (!roomName || !userId) return false
    const userMap = roomUserSockets.get(roomName)
    if (!userMap) return false
    const sockets = userMap.get(String(userId).trim().toLowerCase())
    return sockets ? sockets.size > 0 : false
  }

  const addSocketPresence = (roomName, userId, socketId) => {
    if (!roomName || !userId || !socketId) return

    if (!roomSockets.has(roomName)) roomSockets.set(roomName, new Set())
    roomSockets.get(roomName).add(socketId)

    if (!roomUserSockets.has(roomName)) roomUserSockets.set(roomName, new Map())
    const userMap = roomUserSockets.get(roomName)
    const userKey = String(userId).trim().toLowerCase()
    if (!userMap.has(userKey)) userMap.set(userKey, new Set())
    userMap.get(userKey).add(socketId)
  }

  const removeSocketPresence = (roomName, userId, socketId) => {
    if (!roomName || !socketId) return true

    const sockets = roomSockets.get(roomName)
    if (sockets) {
      sockets.delete(socketId)
      if (sockets.size === 0) roomSockets.delete(roomName)
    }

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
        return true
      }
    }
    return false
  }

  const performHostTransfer = async (roomName, originalHostId, disconnectedActiveHostId, ioRef, clientDb = dbClient) => {
    try {
      console.log(`[HostTransfer] Grace period expired for room ${roomName}. Starting race-safe transfer.`)

      if (isUserConnected(roomName, originalHostId)) {
        console.log(`[HostTransfer] ABORTED — Original Host ${originalHostId} has reconnected. No transfer needed.`)
        return
      }

      const { data: meeting, error } = await clientDb
        .from('meetings')
        .select('meeting_id, host_id, assigned_host_id, active_host_id, meeting_status, room_name')
        .eq('room_name', roomName)
        .maybeSingle()

      if (error || !meeting) {
        console.log(`[HostTransfer] ABORTED — Could not read meeting for room ${roomName}.`)
        return
      }

      if (meeting.meeting_status === 'Ended' || meeting.meeting_status === 'Locked') {
        console.log(`[HostTransfer] ABORTED — Meeting ${meeting.meeting_id} status is ${meeting.meeting_status}. No transfer.`)
        return
      }

      const currentActiveHost = String(meeting.active_host_id || meeting.host_id || '').trim().toLowerCase()
      const expectedDisconnected = String(disconnectedActiveHostId || '').trim().toLowerCase()
      if (currentActiveHost !== expectedDisconnected) {
        console.log(`[HostTransfer] ABORTED — active_host_id changed (now ${meeting.active_host_id}) since grace period started. Transfer already handled.`)
        return
      }

      let newActiveHostId = null

      if (meeting.assigned_host_id && isUserConnected(roomName, meeting.assigned_host_id)) {
        newActiveHostId = meeting.assigned_host_id
        console.log(`[HostTransfer] Assigned Host ${newActiveHostId} is connected — transferring to them.`)
      }

      if (!newActiveHostId) {
        const { data: participants } = await clientDb
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

      if (!newActiveHostId) {
        console.log(`[HostTransfer] No eligible connected participant found for room ${roomName}. Existing cleanup will handle.`)
        return
      }

      const { error: updateErr } = await clientDb
        .from('meetings')
        .update({ active_host_id: newActiveHostId, updated_at: new Date().toISOString() })
        .eq('meeting_id', meeting.meeting_id)

      if (updateErr) {
        console.error(`[HostTransfer] DB update failed:`, updateErr)
        return
      }

      console.log(`[HostTransfer] active_host_id updated: ${disconnectedActiveHostId} → ${newActiveHostId} for meeting ${meeting.meeting_id}`)

      const { data: newHostUser } = await clientDb
        .from('users')
        .select('full_name')
        .eq('id', newActiveHostId)
        .maybeSingle()

      if (ioRef) {
        const payload = {
          originalHostId: meeting.host_id,
          assignedHostId: meeting.assigned_host_id || null,
          activeHostId: newActiveHostId,
          activeHostName: newHostUser?.full_name || newActiveHostId
        }
        ioRef.to(roomName).emit('active_host_changed', payload)
        console.log(`[HostTransfer] Emitted 'active_host_changed' to room ${roomName}.`)
      }
    } catch (err) {
      console.error(`[HostTransfer] Unexpected error:`, err)
    }
  }

  // 1. Connection-time Authentication Middleware
  ioInstance.use((socket, next) => {
    const authResult = extractSocketAuthUser(socket)
    if (!authResult.authenticated || !authResult.userId) {
      console.warn(`[Socket Auth] Connection rejected for socket ${socket.id}: ${authResult.invalidToken ? 'Invalid token' : 'Unauthenticated'}`)
      const err = new Error(authResult.invalidToken ? 'Invalid or expired authentication token' : 'Authentication required')
      err.data = { code: authResult.invalidToken ? 'INVALID_TOKEN' : 'UNAUTHORIZED' }
      return next(err)
    }

    socket.user = {
      id: authResult.userId,
      email: authResult.email
    }
    socket.userId = authResult.userId
    next()
  })

  // 2. Connection event registration
  ioInstance.on('connection', (socket) => {
    let currentRoom = null
    const currentUserId = socket.user.id

    // Join Room — strictly uses authenticated socket.user.id
    socket.on('join_room', async (data, callback) => {
      try {
        const roomName = typeof data === 'string' ? data : data?.roomName
        const userId = socket.user.id

        if (!roomName) {
          if (typeof callback === 'function') callback({ success: false, error: 'Room name is required.' })
          return
        }

        const { data: meeting, error: mtgErr } = await dbClient
          .from('meetings')
          .select('meeting_id, meeting_code, host_id, assigned_host_id, active_host_id, meeting_status, is_deleted, room_name')
          .eq('room_name', roomName)
          .maybeSingle()

        if (mtgErr || !meeting) {
          if (typeof callback === 'function') callback({ success: false, error: 'Unable to verify active meeting.' })
          return
        }

        if (isRoomChatEnded(roomName) || meeting.is_deleted || meeting.meeting_status === 'Ended') {
          clearMeetingChat(roomName)
          socket.emit('chat:cleared')
          if (typeof callback === 'function') callback({ success: false, ended: true, error: 'This meeting has ended.' })
          return
        }

        const isHost = isUserHostOrCoHost(meeting, userId)
        let partRow = null

        if (!isHost) {
          const { data: pRow } = await dbClient
            .from('participants')
            .select('participant_id, participant_status, device_fingerprint')
            .eq('meeting_id', meeting.meeting_id)
            .eq('user_id', userId)
            .maybeSingle()

          partRow = pRow

          let isBanned = partRow?.participant_status === 'removed'

          if (!isBanned && partRow?.device_fingerprint && meeting.meeting_code) {
            const { data: banRow } = await dbClient
              .from('meeting_device_bans')
              .select('id')
              .eq('meeting_code', meeting.meeting_code)
              .eq('device_fingerprint', partRow.device_fingerprint)
              .maybeSingle()
            if (banRow) isBanned = true
          }

          if (isBanned) {
            console.log(`[Security Socket] Banned/removed participant ${userId} attempted to join room ${roomName}. Rejecting.`)
            socket.leave(roomName)
            removeSocketPresence(roomName, userId, socket.id)
            socket.emit('participant_banned', { userId })
            if (typeof callback === 'function') callback({ success: false, error: 'This device has been blocked by the meeting host.' })
            return
          }

          const validStatuses = ['joined', 'active', 'disconnected', 'waiting', 'enrolling']
          if (!partRow || !validStatuses.includes(partRow.participant_status)) {
            console.warn(`[Security Socket] Unauthorized join attempt by user ${userId} for room ${roomName} (status: ${partRow?.participant_status})`)
            if (typeof callback === 'function') callback({ success: false, error: 'User is not an authorized participant of this meeting.' })
            return
          }
        }

        currentRoom = roomName
        socket.join(roomName)
        addSocketPresence(roomName, userId, socket.id)
        cancelCleanup(meeting.meeting_id)
        console.log(`[Socket Connected] Socket ${socket.id} (user=${userId}) joined room ${roomName}.`)

        const isAdmittedMember = isHost || Boolean(partRow && ['joined', 'active', 'disconnected'].includes(partRow.participant_status))

        const restored = restoreParticipantChatSession({
          roomName,
          userId,
          meeting,
          isParticipantAuthorized: isAdmittedMember
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
          callback({ success: true, isWaiting: !isAdmittedMember, messages: [] })
        }

        // Reconnect detection: Original Host
        if (String(userId).toLowerCase() === String(meeting.host_id || '').toLowerCase()) {
          const gracePending = hostGracePeriodTimers.get(roomName)
          if (gracePending) {
            clearTimeout(gracePending.timer)
            hostGracePeriodTimers.delete(roomName)
            console.log(`[HostTransfer] Grace period CANCELLED — Original Host ${userId} reconnected to room ${roomName}.`)
          }

          const currentActiveHost = String(meeting.active_host_id || '').toLowerCase()
          const origHostLower = String(meeting.host_id || '').toLowerCase()
          const needsRestore = Boolean(gracePending)

          if (needsRestore) {
            const { error: updateErr } = await dbClient
              .from('meetings')
              .update({ active_host_id: meeting.host_id, updated_at: new Date().toISOString() })
              .eq('meeting_id', meeting.meeting_id)

            if (!updateErr) {
              const { data: hostUser } = await dbClient
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
              ioInstance.to(roomName).emit('active_host_changed', payload)
              ioInstance.to(roomName).emit('original_host_reconnected', payload)
              console.log(`[HostTransfer] Original Host ${userId} reconnected — active_host_id restored. Emitted active_host_changed + original_host_reconnected.`)
            }
          } else if (currentActiveHost === origHostLower) {
            console.log(`[HostTransfer] Original Host ${userId} joined room ${roomName} — already active host, no restore needed.`)
          } else {
            const { data: hostUser } = await dbClient
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
            ioInstance.to(roomName).emit('original_host_reconnected', payload)
            console.log(`[HostTransfer] Original Host ${userId} joined room ${roomName} while ${meeting.active_host_id} is Active Host — no restore. B continues.`)
          }
        }
      } catch (err) {
        console.error('[Socket Join Error]:', err)
        if (typeof callback === 'function') callback({ success: false, error: 'Failed to join socket room.' })
      }
    })

    // Ephemeral Chat Sync
    const handleChatSync = async (data, callback) => {
      try {
        const roomName = data?.roomName || currentRoom
        const recipientId = data?.recipientId || null

        const verified = await verifySocketMeetingParticipant(
          socket,
          roomName,
          recipientId,
          dbClient
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

        currentRoom = roomName
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

    // Ephemeral Chat Send Message
    socket.on('chat:send_message', async (data, callback) => {
      try {
        const { roomName, text, formatted, attachment, recipientId, recipientName, isDirect } = data || {}
        if (!roomName) {
          if (typeof callback === 'function') callback({ success: false, error: 'roomName is required' })
          return
        }

        const verified = await verifySocketMeetingParticipant(socket, roomName, null, dbClient)

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
        const meeting = verified.meeting

        const { data: userRow } = await dbClient
          .from('users')
          .select('full_name')
          .eq('id', senderId)
          .maybeSingle()
        const senderName = userRow?.full_name || data?.senderName || 'Participant'

        currentRoom = roomName
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
          const deliveredSockets = new Set()
          const userMap = roomUserSockets.get(roomName)
          if (userMap) {
            const recKey = String(createdMessage.recipientId).trim().toLowerCase()
            const recSockets = userMap.get(recKey)
            if (recSockets) {
              recSockets.forEach((sId) => {
                deliveredSockets.add(sId)
                ioInstance.to(sId).emit('chat:message', createdMessage)
              })
            }

            const sendKey = String(createdMessage.senderId).trim().toLowerCase()
            const sendSockets = userMap.get(sendKey)
            if (sendSockets) {
              sendSockets.forEach((sId) => {
                deliveredSockets.add(sId)
                ioInstance.to(sId).emit('chat:message', createdMessage)
              })
            }
          }
          if (!deliveredSockets.has(socket.id)) {
            socket.emit('chat:message', createdMessage)
          }
        } else {
          ioInstance.to(roomName).emit('chat:message', createdMessage)
        }

        if (!createdMessage.isDirect) {
          const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          ioInstance.to(roomName).emit('receive_message', {
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

    // Ephemeral Chat Policy update (Host / Co-host only)
    socket.on('chat:set_policy', async (data, callback) => {
      try {
        const { roomName, policy } = data || {}
        if (!roomName || !policy) {
          if (typeof callback === 'function') callback({ success: false, error: 'roomName and policy are required' })
          return
        }

        const verified = await verifySocketMeetingParticipant(socket, roomName, null, dbClient)

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

        ioInstance.to(roomName).emit('chat:policy_updated', {
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

    // Meeting Lock Control (Host / Co-host only)
    socket.on('lock_meeting', async (data, callback) => {
      try {
        const roomName = data?.roomName
        const isLocked = Boolean(data?.isLocked)

        if (!roomName) {
          if (typeof callback === 'function') callback({ success: false, error: 'roomName is required' })
          return
        }

        const { data: meeting, error: mtgErr } = await dbClient
          .from('meetings')
          .select('meeting_id, host_id, assigned_host_id, active_host_id, meeting_status')
          .eq('room_name', roomName)
          .maybeSingle()

        if (mtgErr || !meeting) {
          if (typeof callback === 'function') callback({ success: false, error: 'Meeting not found' })
          return
        }

        if (!isUserHostOrCoHost(meeting, socket.user.id)) {
          console.warn(`[Security Socket] Unauthorized lock_meeting attempt by user ${socket.user.id} on meeting ${meeting.meeting_id}`)
          if (typeof callback === 'function') callback({ success: false, error: 'Unauthorized: Only the host or co-host can lock or unlock the meeting.' })
          socket.emit('error', { message: 'Unauthorized: Only the host or co-host can lock or unlock the meeting.' })
          return
        }

        const newStatus = isLocked ? 'Locked' : 'Active'
        await dbClient
          .from('meetings')
          .update({
            meeting_status: newStatus,
            updated_at: new Date().toISOString()
          })
          .eq('meeting_id', meeting.meeting_id)

        ioInstance.to(roomName).emit('meeting_locked', { isLocked })

        if (typeof callback === 'function') {
          callback({ success: true, isLocked })
        }
      } catch (err) {
        console.error('[Lock Meeting Socket Error]:', err)
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message || 'Failed to lock meeting' })
        }
      }
    })

    // Remove Participant Control (Host / Co-host only)
    socket.on('remove_participant_from_meeting', async (data, callback) => {
      try {
        const roomName = data?.roomName
        const targetUserId = data?.userId

        if (!roomName || !targetUserId) {
          if (typeof callback === 'function') callback({ success: false, error: 'roomName and userId are required' })
          return
        }

        const { data: meeting, error: mtgErr } = await dbClient
          .from('meetings')
          .select('meeting_id, meeting_code, host_id, assigned_host_id, active_host_id, meeting_status, cloudflare_meeting_id, room_name')
          .eq('room_name', roomName)
          .maybeSingle()

        if (mtgErr || !meeting) {
          if (typeof callback === 'function') callback({ success: false, error: 'Meeting not found' })
          return
        }

        if (!isUserHostOrCoHost(meeting, socket.user.id)) {
          console.warn(`[Security Socket] Unauthorized remove_participant attempt by user ${socket.user.id} on meeting ${meeting.meeting_id}`)
          if (typeof callback === 'function') callback({ success: false, error: 'Unauthorized: Only the host or co-host can remove participants.' })
          socket.emit('error', { message: 'Unauthorized: Only the host or co-host can remove participants.' })
          return
        }

        const removalResult = await executeParticipantRemoval({
          meeting,
          userId: targetUserId,
          initiatorUserId: socket.user.id,
          dbClient,
          cfService: cloudflareClient,
          ioInstance,
          roomUserSockets
        })

        const timestamp = new Date().toISOString()
        console.log(`[Audit Log] Action: Participant Removed | Timestamp: ${timestamp} | Meeting: ${roomName} | HostId: ${socket.user.id} | ParticipantId: ${targetUserId}`)
        ioInstance.to(roomName).emit('participant_removed', { userId: targetUserId })

        // Disconnect target user sockets from room
        const targetKey = String(targetUserId).trim().toLowerCase()
        const userMap = roomUserSockets.get(roomName)
        const targetSockets = userMap?.get(targetKey)
        if (targetSockets) {
          targetSockets.forEach((sId) => {
            const s = ioInstance.sockets.sockets.get(sId)
            if (s) {
              s.emit('participant_removed', { userId: targetUserId })
              s.leave(roomName)
            }
          })
          userMap.delete(targetKey)
        }

        if (typeof callback === 'function') {
          callback({ success: true, status: removalResult.status, userId: targetUserId })
        }
      } catch (err) {
        console.error('[Remove Participant Socket Error]:', err)
        if (typeof callback === 'function') {
          callback({
            success: false,
            code: err.code || 'REMOVAL_ERROR',
            error: err.message || 'Failed to remove participant',
            status: err.code === 'CLOUDFLARE_REVOCATION_PENDING' ? 'pending_revocation' : 'failed'
          })
        }
        socket.emit('error', {
          code: err.code || 'REMOVAL_ERROR',
          message: err.message || 'Failed to remove participant'
        })
      }
    })

    // Meeting End Control (Host / Co-host only)
    socket.on('end_meeting', async (data, callback) => {
      try {
        const roomName = typeof data === 'string' ? data : data?.roomName

        if (!roomName) {
          if (typeof callback === 'function') callback({ success: false, error: 'roomName is required' })
          return
        }

        const { data: meeting, error: mtgErr } = await dbClient
          .from('meetings')
          .select('meeting_id, host_id, assigned_host_id, active_host_id, meeting_status')
          .eq('room_name', roomName)
          .maybeSingle()

        if (mtgErr || !meeting) {
          if (typeof callback === 'function') callback({ success: false, error: 'Meeting not found' })
          return
        }

        if (!isUserHostOrCoHost(meeting, socket.user.id)) {
          console.warn(`[Security Socket] Unauthorized end_meeting attempt by user ${socket.user.id} on meeting ${meeting.meeting_id}`)
          if (typeof callback === 'function') callback({ success: false, error: 'Unauthorized: Only the host or co-host can end the meeting.' })
          socket.emit('error', { message: 'Unauthorized: Only the host or co-host can end the meeting.' })
          return
        }

        if (meeting.meeting_status !== 'Ended') {
          await dbClient
            .from('meetings')
            .update({
              meeting_status: 'Ended',
              actual_end_time: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('meeting_id', meeting.meeting_id)
        }

        clearMeetingChat(roomName)
        ioInstance.to(roomName).emit('chat:cleared')
        ioInstance.to(roomName).emit('meeting_ended')

        if (typeof callback === 'function') {
          callback({ success: true })
        }
      } catch (err) {
        console.error('[End Meeting Socket Error]:', err)
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message || 'Failed to end meeting' })
        }
      }
    })

    // Participant Reactions (Active room members only)
    socket.on('send_reaction', async (data) => {
      try {
        if (!data?.roomName || !socket.user?.id) return
        const roomName = data.roomName
        if (!socket.rooms.has(roomName)) return

        const { data: meeting } = await dbClient
          .from('meetings')
          .select('meeting_id, host_id, assigned_host_id, active_host_id, meeting_status')
          .eq('room_name', roomName)
          .maybeSingle()
        if (!meeting || meeting.meeting_status === 'Ended') return

        const isHost = isUserHostOrCoHost(meeting, socket.user.id)
        if (!isHost) {
          const { data: partRow } = await dbClient
            .from('participants')
            .select('participant_status')
            .eq('meeting_id', meeting.meeting_id)
            .eq('user_id', socket.user.id)
            .maybeSingle()
          if (!partRow || !['joined', 'active'].includes(partRow.participant_status)) return
        }

        const { data: userRow } = await dbClient
          .from('users')
          .select('full_name')
          .eq('id', socket.user.id)
          .maybeSingle()

        const senderName = userRow?.full_name || data.senderName || 'Participant'
        const identity = data.identity || socket.user.id

        ioInstance.to(roomName).emit('participant_reaction', {
          identity,
          senderName,
          reaction: data.reaction
        })
      } catch (err) {
        console.error('[Send Reaction Error]:', err)
      }
    })

    // Hand Raises (Active room members only)
    socket.on('toggle_raise_hand', async (data) => {
      try {
        if (!data?.roomName || !socket.user?.id) return
        const roomName = data.roomName
        if (!socket.rooms.has(roomName)) return

        const { data: meeting } = await dbClient
          .from('meetings')
          .select('meeting_id, host_id, assigned_host_id, active_host_id, meeting_status')
          .eq('room_name', roomName)
          .maybeSingle()
        if (!meeting || meeting.meeting_status === 'Ended') return

        const isHost = isUserHostOrCoHost(meeting, socket.user.id)
        if (!isHost) {
          const { data: partRow } = await dbClient
            .from('participants')
            .select('participant_status')
            .eq('meeting_id', meeting.meeting_id)
            .eq('user_id', socket.user.id)
            .maybeSingle()
          if (!partRow || !['joined', 'active'].includes(partRow.participant_status)) return
        }

        const { data: userRow } = await dbClient
          .from('users')
          .select('full_name')
          .eq('id', socket.user.id)
          .maybeSingle()

        const senderName = userRow?.full_name || data.senderName || 'Participant'
        const identity = data.identity || socket.user.id

        ioInstance.to(roomName).emit('participant_raise_hand', {
          identity,
          senderName,
          raised: Boolean(data.raised)
        })
      } catch (err) {
        console.error('[Toggle Raise Hand Error]:', err)
      }
    })

    // Status changes (Active room members only)
    socket.on('toggle_status', async (data) => {
      try {
        if (!data?.roomName || !socket.user?.id) return
        const roomName = data.roomName
        if (!socket.rooms.has(roomName)) return

        const { data: meeting } = await dbClient
          .from('meetings')
          .select('meeting_id, host_id, assigned_host_id, active_host_id, meeting_status')
          .eq('room_name', roomName)
          .maybeSingle()
        if (!meeting || meeting.meeting_status === 'Ended') return

        const isHost = isUserHostOrCoHost(meeting, socket.user.id)
        if (!isHost) {
          const { data: partRow } = await dbClient
            .from('participants')
            .select('participant_status')
            .eq('meeting_id', meeting.meeting_id)
            .eq('user_id', socket.user.id)
            .maybeSingle()
          if (!partRow || !['joined', 'active'].includes(partRow.participant_status)) return
        }

        const { data: userRow } = await dbClient
          .from('users')
          .select('full_name')
          .eq('id', socket.user.id)
          .maybeSingle()

        const senderName = userRow?.full_name || data.senderName || 'Participant'
        const identity = data.identity || socket.user.id

        ioInstance.to(roomName).emit('participant_status_change', {
          identity,
          senderName,
          status: data.status
        })
      } catch (err) {
        console.error('[Toggle Status Error]:', err)
      }
    })

    // Legacy chat message broadcasting (Authorized room members only)
    socket.on('send_message', async (data) => {
      try {
        if (!data?.roomName || !socket.user?.id) return
        const roomName = data.roomName
        if (!socket.rooms.has(roomName)) return

        const verified = await verifySocketMeetingParticipant(socket, roomName, null, dbClient)
        if (!verified.authorized || verified.ended) return

        const { data: userRow } = await dbClient
          .from('users')
          .select('full_name')
          .eq('id', socket.user.id)
          .maybeSingle()

        const name = userRow?.full_name || data.name || 'Participant'
        const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
        ioInstance.to(roomName).emit('receive_message', {
          name,
          text: data.text,
          timestamp
        })
      } catch (err) {
        console.error('[Send Message Error]:', err)
      }
    })

    // Typing state broadcasting (Authorized room members only)
    socket.on('typing', (data) => {
      if (!data?.roomName || !socket.user?.id) return
      if (!socket.rooms.has(data.roomName)) return

      socket.to(data.roomName).emit('typing', {
        userId: socket.user.id,
        name: data.name,
        isTyping: Boolean(data.isTyping)
      })
    })

    // Socket Disconnect — multi-socket-aware with grace period + race-safe host transfer
    socket.on('disconnect', () => {
      if (!currentRoom) return

      const roomName = currentRoom
      const disconnectedUserId = socket.user.id

      const userFullyDisconnected = removeSocketPresence(roomName, disconnectedUserId, socket.id)
      console.log(`[Socket Disconnected] Socket ${socket.id} (user=${disconnectedUserId}) left room ${roomName}. User fully disconnected: ${userFullyDisconnected}`)

      if (userFullyDisconnected && disconnectedUserId) {
        dbClient
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

            if (disconnectedLower === activeHostLower) {
              const existing = hostGracePeriodTimers.get(roomName)
              if (existing) {
                clearTimeout(existing.timer)
              }

              console.log(`[HostTransfer] Active Host ${disconnectedUserId} disconnected from room ${roomName}. Starting 30s grace period.`)

              const timer = setTimeout(() => {
                hostGracePeriodTimers.delete(roomName)
                performHostTransfer(roomName, meeting.host_id, activeHostId, ioInstance, dbClient)
              }, 30000)

              hostGracePeriodTimers.set(roomName, {
                timer,
                originalHostId: meeting.host_id,
                activeHostId
              })
            }

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
      }
    })
  })

  return {
    roomSockets,
    roomUserSockets,
    hostGracePeriodTimers,
    isUserConnected,
    addSocketPresence,
    removeSocketPresence,
    performHostTransfer,
    extractSocketAuthUser,
    verifySocketMeetingParticipant
  }
}

// In normal runtime (not test runner), start HTTP & Socket.IO server
if (!isRunningInTest) {
  httpServer = app.listen(PORT, () => {
    console.log(`[Meetly AI Backend] server successfully listening on port ${PORT}`)
    startRetentionCleanup()
    startRecordingRetentionCleanup()
  })

  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true
    }
  })
  app.set('io', io)
  initMeetingExpirationWorker(io)

  const socketState = setupSocketServer(io, supabase)
  app.set('roomUserSockets', socketState.roomUserSockets)

  const handleShutdown = () => {
    stopRemovalWorker()
    stopMeetingExpirationWorker()
  }
  process.on('SIGTERM', handleShutdown)
  process.on('SIGINT', handleShutdown)
}

export {
  app,
  httpServer,
  io,
  isUserHostOrCoHost
}
