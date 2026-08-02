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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const app = express()
const PORT = process.env.PORT || 5000

// Configure CORS with explicit origin matching and credentials support
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'https://uneaten-unsheathe-waviness.ngrok-free.dev'
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
  res.status(200).json({ status: 'OK', timestamp: new Date() })
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

// Active socket room tracking map: roomName -> Set of socket IDs
const roomSockets = new Map()

io.on('connection', (socket) => {
  let currentRoom = null

  // Join Room
  socket.on('join_room', (roomName) => {
    currentRoom = roomName
    socket.join(roomName)

    if (!roomSockets.has(roomName)) {
      roomSockets.set(roomName, new Set())
    }
    roomSockets.get(roomName).add(socket.id)
    console.log(`[Socket Connected] Socket ${socket.id} joined room ${roomName}. Total sockets: ${roomSockets.get(roomName).size}`)
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

  // Host ended room trigger
  socket.on('end_meeting', (roomName) => {
    io.to(roomName).emit('meeting_ended')
  })

  // Socket Disconnect
  socket.on('disconnect', () => {
    if (currentRoom && roomSockets.has(currentRoom)) {
      const sockets = roomSockets.get(currentRoom)
      sockets.delete(socket.id)
      console.log(`[Socket Disconnected] Socket ${socket.id} left room ${currentRoom}. Remaining sockets: ${sockets.size}`)

      // If room is now empty of socket connections, schedule a 30s check to clean up meeting if no participants remain
      if (sockets.size === 0) {
        roomSockets.delete(currentRoom)
        const roomToClean = currentRoom
        setTimeout(async () => {
          try {
            const { data: meeting } = await supabase
              .from('meetings')
              .select('meeting_id, meeting_status')
              .eq('room_name', roomToClean)
              .maybeSingle()

            if (meeting && (meeting.meeting_status === 'Active' || meeting.meeting_status === 'Waiting')) {
              const { data: activeParts } = await supabase
                .from('participants')
                .select('participant_id')
                .eq('meeting_id', meeting.meeting_id)
                .eq('participant_status', 'joined')

              if (!activeParts || activeParts.length === 0) {
                const now = new Date().toISOString()
                console.log(`[Cleanup] Meeting ${meeting.meeting_id} ended because no active participants remaining after socket disconnect timeout.`)
                await supabase
                  .from('meetings')
                  .update({ meeting_status: 'Ended', ended_at: now, updated_at: now })
                  .eq('meeting_id', meeting.meeting_id)
                clearMeetingCounters(meeting.meeting_id)
              }
            }
          } catch (err) {
            console.error('[Socket Cleanup Error]:', err)
          }
        }, 30000)
      }
    }
  })
})