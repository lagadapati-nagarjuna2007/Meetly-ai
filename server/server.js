import { fileURLToPath } from 'url'
import path from 'path'
import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { Server } from 'socket.io'
import authRoutes from './routes/auth.js'
import meetingRoutes from './routes/meetings.js'
import aiChatRoutes from './routes/aiChat.routes.js'
import { supabase } from './config/supabase.js'
import { startRetentionCleanup } from './controllers/meetingController.js'
import { clearMeetingCounters } from './services/aiChat.service.js'
import { scheduleCleanup, cancelCleanup } from './services/meetingCleanup.js'

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

io.on('connection', (socket) => {
  let currentRoom = null
  let currentUserId = null

  // Join Room — handles both new joins and reconnects
  socket.on('join_room', (data) => {
    // Support both legacy string and new object payload { roomName, userId }
    const roomName = typeof data === 'string' ? data : data?.roomName
    const joinedUserId = typeof data === 'object' ? data?.userId : null

    if (!roomName) return

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

    // Cancel pending cleanup for this room if any participant joins
    supabase
      .from('meetings')
      .select('meeting_id, host_id, assigned_host_id, active_host_id')
      .eq('room_name', roomName)
      .maybeSingle()
      .then(async ({ data: meeting }) => {
        if (!meeting) return
        cancelCleanup(meeting.meeting_id)

        // --- Reconnect detection: Original Host ---
        if (joinedUserId && String(joinedUserId).toLowerCase() === String(meeting.host_id || '').toLowerCase()) {
          // Cancel any pending grace period for this room
          const gracePending = hostGracePeriodTimers.get(roomName)
          if (gracePending) {
            clearTimeout(gracePending.timer)
            hostGracePeriodTimers.delete(roomName)
            console.log(`[HostTransfer] Grace period CANCELLED — Original Host ${joinedUserId} reconnected to room ${roomName}.`)
          }

          // Only restore active_host_id when the Original Host actually disconnected and is now reconnecting.
          // Do NOT restore if the Original Host is continuously present (e.g., socket re-join after page refresh)
          // and intentionally assigned B as the Active Host — gracePending being set is the indicator
          // that A was truly absent. Without it, A was present the whole time and B's assignment stands.
          const currentActiveHost = String(meeting.active_host_id || '').toLowerCase()
          const origHostLower = String(meeting.host_id || '').toLowerCase()

          // needsRestore is true ONLY when there was a real disconnection (gracePending timer existed).
          // If gracePending is false but active_host_id !== host_id, the Original Host intentionally
          // delegated Active Host to someone else — do NOT override that.
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
            // Original Host was already the active host and no grace period was pending — normal join/refresh, nothing to do.
            console.log(`[HostTransfer] Original Host ${joinedUserId} joined room ${roomName} — already active host, no restore needed.`)
          } else {
            // Original Host joined but active_host_id points to someone else (e.g., B after intentional assignment).
            // No grace period was active, so this is a normal join while B is intentionally the Active Host.
            // Emit original_host_reconnected so clients know A is back, but keep active_host_id as B.
            const { data: hostUser } = await supabase
              .from('users')
              .select('full_name')
              .eq('id', meeting.host_id)
              .maybeSingle()

            const payload = {
              originalHostId: meeting.host_id,
              assignedHostId: meeting.assigned_host_id || null,
              activeHostId: meeting.active_host_id,  // B remains active
              activeHostName: hostUser?.full_name || meeting.host_id
            }
            io.to(roomName).emit('original_host_reconnected', payload)
            console.log(`[HostTransfer] Original Host ${joinedUserId} joined room ${roomName} while ${meeting.active_host_id} is Active Host — no restore. B continues.`)
          }
        }
        // Assigned Host reconnect is silent — they simply become eligible for future transfers again
      })
      .catch((err) => {
        console.error('[Socket Join Error]:', err)
      })
  })

  // Chat message broadcasting
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
    io.to(roomName).emit('meeting_ended')
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