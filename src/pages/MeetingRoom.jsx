import React, { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { io } from 'socket.io-client'
import {
  LiveKitRoom,
  useTracks,
  useLocalParticipant,
  useParticipants,
  VideoTrack,
  RoomAudioRenderer,
  useMaybeRoomContext
} from '@livekit/components-react'
import { Track } from 'livekit-client'
import { useMeetings } from '../context/MeetingContext'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/Toast'
import Button from '../components/Button'
import {
  Mic,
  MicOff,
  Video as Cam,
  VideoOff,
  Monitor,
  MessageSquare,
  Users,
  Sparkles,
  PhoneOff,
  Radio,
  Send,
  Bot,
  Copy,
  Edit2,
  Lock,
  Unlock,
  AlertTriangle,
  RefreshCw
} from 'lucide-react'

// Error Boundary component to catch unhandled React errors in MeetingRoom
class MeetingErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('[MeetingErrorBoundary] Caught runtime exception:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 z-50 bg-[#04050b] flex flex-col items-center justify-center p-6 text-center select-none">
          <div className="max-w-md w-full bg-slate-900/90 border border-red-500/20 rounded-2xl p-6 flex flex-col items-center gap-4 shadow-2xl">
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 font-bold text-xl">
              <AlertTriangle size={24} />
            </div>
            <h2 className="text-base font-bold text-white">Meeting Room Error</h2>
            <p className="text-xs text-red-300 bg-red-950/40 border border-red-900/50 p-3 rounded-xl w-full text-left font-mono break-words">
              {this.state.error?.message || String(this.state.error)}
            </p>
            <button
              onClick={() => (window.location.href = '/')}
              className="mt-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
            >
              Return to Dashboard
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// Export main MeetingRoom component wrapped with Error Boundary
export default function MeetingRoom() {
  return (
    <MeetingErrorBoundary>
      <MeetingRoomInner />
    </MeetingErrorBoundary>
  )
}

function MeetingRoomInner() {
  const { id } = useParams()
  const { user } = useAuth()
  const {
    fetchMeetingDetails,
    endMeeting,
    deleteMeeting,
    renameMeeting,
    leaveMeeting,
    lockMeeting,
    activateMeeting,
    livekitToken,
    livekitUrl,
    joinMeeting
  } = useMeetings()
  const { showToast } = useToast()
  const navigate = useNavigate()

  const [meetingData, setMeetingData] = useState(null)
  const [isHost, setIsHost] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [roomError, setRoomError] = useState(null)
  const joinAttemptedRef = useRef(false)

  console.log('[MeetingRoom Render] id:', id, 'isLoading:', isLoading, 'hasMeetingData:', !!meetingData, 'hasToken:', !!livekitToken, 'roomError:', roomError)

  // 1. Fetch meeting metadata on mount and verify login session
  useEffect(() => {
    console.log('[MeetingRoom useEffect 1] Fetching meeting details for id:', id)
    let isMounted = true

    const getDetails = async () => {
      try {
        setRoomError(null)
        const data = await fetchMeetingDetails(id)
        if (!isMounted) return
        setMeetingData(data.meeting)
        if (data.meeting && user) {
          setIsHost(data.meeting.host_id === user.id)
        }
      } catch (err) {
        if (!isMounted) return
        console.error('[MeetingRoom useEffect 1] Failed to load meeting details:', err)
        const msg = err.message || 'Meeting not found or has ended.'
        setRoomError(msg)
        showToast(msg, 'error')
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    getDetails()
    return () => {
      isMounted = false
    }
  }, [id, user, fetchMeetingDetails, showToast])

  // 2. Auto-join meeting room if Token is missing (e.g. on F5 Refresh)
  useEffect(() => {
    console.log('[MeetingRoom useEffect 2] ensureToken check. meetingData:', !!meetingData, 'hasToken:', !!livekitToken, 'attempted:', joinAttemptedRef.current)

    let timeoutId = null
    const ensureToken = async () => {
      if (meetingData && !livekitToken && !joinAttemptedRef.current) {
        joinAttemptedRef.current = true
        console.log('[MeetingRoom useEffect 2] Starting auto-join for meeting code:', meetingData.meeting_code)

        // Set a 15 second safety timeout to prevent infinite loading
        timeoutId = setTimeout(() => {
          if (!livekitToken) {
            console.error('[MeetingRoom useEffect 2] Connection timeout reached (15s)')
            setRoomError('Connection to LiveKit room timed out. Please check your credentials or network.')
            setIsLoading(false)
          }
        }, 15000)

        try {
          await joinMeeting(meetingData.meeting_code)
          console.log('[MeetingRoom useEffect 2] joinMeeting succeeded')
        } catch (err) {
          console.error('[MeetingRoom useEffect 2] Session recovery/join failed:', err)
          joinAttemptedRef.current = false
          const msg = err.message || 'Access token could not be fetched.'
          setRoomError(msg)
          showToast(msg, 'error')
        } finally {
          if (timeoutId) clearTimeout(timeoutId)
        }
      }
    }

    ensureToken()

    return () => {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [meetingData, livekitToken, joinMeeting, showToast])

  // 3. Browser Tab Close & Refresh Handling (sendBeacon)
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (meetingData?.meeting_id) {
        console.log('[Unload] Sending beacon for leaveMeeting:', meetingData.meeting_id)
        const apiUrl = `${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meeting/leave?meetingId=${meetingData.meeting_id}`
        navigator.sendBeacon(apiUrl)
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [meetingData?.meeting_id])

  const handleLeave = async () => {
    console.log('[MeetingRoom] handleLeave triggered')
    if (meetingData) {
      try {
        await leaveMeeting(meetingData.meeting_id)
      } catch (e) {
        console.error('[MeetingRoom] leaveMeeting error:', e)
      }
    }
    showToast('You left the meeting.', 'info')
    navigate('/')
  }

  const handleEndMeeting = async () => {
    if (!meetingData) return
    const confirmEnd = window.confirm('Are you sure you want to end this meeting for all participants?')
    if (!confirmEnd) return

    try {
      await endMeeting(meetingData.meeting_id)
      showToast('Meeting ended successfully.', 'success')
      navigate('/')
    } catch (err) {
      showToast(err.message || 'Failed to end meeting', 'error')
    }
  }

  const handleDeleteMeeting = async () => {
    if (!meetingData) return
    const confirmDel = window.confirm('Are you sure you want to delete this meeting?')
    if (!confirmDel) return

    try {
      await deleteMeeting(meetingData.meeting_id)
      showToast('Meeting deleted successfully.', 'success')
      navigate('/')
    } catch (err) {
      showToast(err.message || 'Failed to delete meeting', 'error')
    }
  }

  const handleRename = async () => {
    if (!meetingData) return
    const newTitle = prompt('Enter new meeting title:', meetingData.meeting_title)
    if (newTitle && newTitle.trim() && newTitle.trim() !== meetingData.meeting_title) {
      try {
        await renameMeeting(meetingData.meeting_id, newTitle.trim())
        setMeetingData((prev) => ({ ...prev, meeting_title: newTitle.trim() }))
        showToast('Meeting title updated.', 'success')
      } catch (err) {
        showToast(err.message || 'Failed to rename meeting', 'error')
      }
    }
  }

  const handleCopyCode = () => {
    if (!meetingData) return
    navigator.clipboard.writeText(meetingData.meeting_code)
    showToast('Meeting code copied!', 'success')
  }

  const handleCopyLink = () => {
    if (!meetingData) return
    const link = `${window.location.origin}/meeting/${meetingData.meeting_code}`
    navigator.clipboard.writeText(link)
    showToast('Meeting link copied!', 'success')
  }

  // Error UI
  if (roomError) {
    return (
      <div className="fixed inset-0 z-40 bg-[#04050b] flex flex-col items-center justify-center p-6 text-center select-none">
        <div className="max-w-md w-full bg-slate-900/90 border border-red-500/20 rounded-2xl p-6 flex flex-col items-center gap-4 shadow-2xl">
          <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
            <AlertTriangle size={24} />
          </div>
          <h2 className="text-base font-bold text-white">Unable to Join Meeting</h2>
          <p className="text-xs text-gray-400 bg-black/40 border border-white/5 p-3 rounded-xl w-full text-center">
            {roomError}
          </p>
          <div className="flex items-center gap-3 w-full mt-2">
            <button
              onClick={() => {
                setRoomError(null)
                setIsLoading(true)
                joinAttemptedRef.current = false
                window.location.reload()
              }}
              className="flex-1 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2"
            >
              <RefreshCw size={14} />
              <span>Retry</span>
            </button>
            <button
              onClick={() => navigate('/')}
              className="flex-1 px-4 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
            >
              Back to Home
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Loading UI
  if (isLoading || !livekitToken || !meetingData) {
    return (
      <div className="fixed inset-0 z-40 bg-[#04050b] flex flex-col items-center justify-center text-xs font-semibold text-gray-500 select-none">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border border-white/10 border-t-purple-500 animate-spin" />
          <span className="uppercase tracking-widest text-[9px] font-bold text-gray-400">Connecting to Room...</span>
        </div>
      </div>
    )
  }

  const serverUrl = livekitUrl || import.meta.env.VITE_LIVEKIT_URL
  console.log('[LiveKit Connection] Connecting LiveKitRoom to serverUrl:', serverUrl)

  return (
    <LiveKitRoom
      token={livekitToken}
      serverUrl={serverUrl}
      connect={true}
      video={false}
      audio={false}
      onDisconnected={() => {
        console.log('[LiveKit Connection] Event onDisconnected triggered')
        handleLeave()
      }}
      onError={(err) => {
        console.error('[LiveKit Connection] Event onError triggered:', err)
        showToast('LiveKit connection error: ' + (err?.message || 'Check your credentials.'), 'error')
      }}
    >
      <MeetingRoomContent
        meetingData={meetingData}
        setMeetingData={setMeetingData}
        isHost={isHost}
        handleLeave={handleLeave}
        handleEndMeeting={handleEndMeeting}
        handleDeleteMeeting={handleDeleteMeeting}
        handleRename={handleRename}
        handleCopyCode={handleCopyCode}
        handleCopyLink={handleCopyLink}
        lockMeeting={lockMeeting}
        activateMeeting={activateMeeting}
        showToast={showToast}
        user={user}
      />
      <RoomAudioRenderer />
    </LiveKitRoom>
  )
}

// Helper: convert camera/getUserMedia errors into user-friendly messages
function getCameraErrorMessage(err) {
  const name = err?.name || ''
  const message = err?.message || ''

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera permission denied. Please allow camera access in your browser settings.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera found. Please connect a camera and try again.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Camera is in use by another application. Please close it and try again.'
  }
  if (name === 'OverconstrainedError') {
    return 'Camera does not support the requested settings. Try a different camera.'
  }
  if (name === 'AbortError') {
    return 'Camera initialization was interrupted. Please try again.'
  }
  if (message.toLowerCase().includes('could not start video source')) {
    return 'Camera is in use by another application. Please close it and try again.'
  }
  return `Camera error: ${message || name || 'Unknown error'}`
}

function MeetingRoomContent({
  meetingData,
  setMeetingData,
  isHost,
  handleLeave,
  handleEndMeeting,
  handleDeleteMeeting,
  handleRename,
  handleCopyCode,
  handleCopyLink,
  lockMeeting,
  activateMeeting,
  showToast,
  user
}) {
  const room = useMaybeRoomContext()
  const { localParticipant } = useLocalParticipant()
  const participants = useParticipants()
  const tracks = useTracks([Track.Source.ScreenShare])
  const mediaInitRef = useRef(false)
  const activatedRef = useRef(false)

  const [micActive, setMicActive] = useState(false)
  const [camActive, setCamActive] = useState(false)
  const [sharingActive, setSharingActive] = useState(false)
  const [camError, setCamError] = useState(null)
  const [camInitializing, setCamInitializing] = useState(false)

  // Drawer Panel Toggles
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [activeTab, setActiveTab] = useState('chat') // chat | participants | ai

  // Local Chat / AI States
  const [chatMessages, setChatMessages] = useState([
    { name: 'System', text: 'Welcome to the meeting room. Chat messages and AI queries are enabled.' }
  ])
  const [chatInput, setChatInput] = useState('')
  const [aiInput, setAiInput] = useState('')
  const [aiResponses, setAiResponses] = useState([
    { sender: 'bot', text: 'I am tracking the meeting. You can ask me to summarize the current discussion.' }
  ])
  const [typingUsers, setTypingUsers] = useState({})

  // Socket.IO Ref
  const socket = useRef(null)

  const roomState = room?.state
  console.log('[MeetingRoomContent Render] roomState:', roomState, 'localParticipant:', !!localParticipant, 'participants count:', participants?.length || 0)

  // Transcript chunk collection
  useEffect(() => {
    console.log('[AI Analyzer Debug] useEffect triggered. conditions check:', {
      hasMeetingData: !!meetingData,
      enable_ai_analyzer: meetingData?.enable_ai_analyzer,
      roomState
    })

    if (!meetingData || !meetingData.enable_ai_analyzer || roomState !== 'connected') {
      return
    }

    console.log('[AI Analyzer] AI Analyzer started')
    let mediaRecorder = null
    let stream = null
    let intervalId = null

    const startRecording = async () => {
      try {
        console.log('[AI Analyzer] Requesting microphone access stream...')
        // Request dedicated mic stream specifically for recording to prevent interfering with LiveKit
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        console.log('[AI Analyzer] Microphone access granted successfully.')
        
        // Choose supported mimeType
        let mimeType = 'audio/webm'
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          if (MediaRecorder.isTypeSupported('audio/mp4')) {
            mimeType = 'audio/mp4'
          } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
            mimeType = 'audio/ogg'
          } else {
            mimeType = '' // Default
          }
        }
        console.log('[AI Analyzer] Using MediaRecorder mimeType:', mimeType)

        // Setup MediaRecorder
        mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
        let chunks = []

        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            chunks.push(e.data)
            console.log('[AI Analyzer] Audio data available:', e.data.size, 'bytes')
          }
        }

        mediaRecorder.onstop = async () => {
          console.log('[AI Analyzer] MediaRecorder stopped. Processing chunks...')
          const audioBlob = new Blob(chunks, { type: mimeType || 'audio/webm' })
          chunks = [] // Reset chunks

          console.log('[AI Analyzer] Audio chunk created:', audioBlob.size, 'bytes')

          // Analyze simple volume/silence using Web Audio API to prevent empty API calls
          let isSilent = false
          try {
            const arrayBuffer = await audioBlob.arrayBuffer()
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)
            const channelData = audioBuffer.getChannelData(0)
            
            // Calculate Root Mean Square (RMS) volume
            let sum = 0
            for (let i = 0; i < channelData.length; i++) {
              sum += channelData[i] * channelData[i]
            }
            const rms = Math.sqrt(sum / channelData.length)
            console.log('[AI Analyzer] Audio chunk RMS volume:', rms)
            if (rms < 0.005) {
              isSilent = true
            }
            await audioCtx.close()
          } catch (volErr) {
            console.warn('[AI Analyzer Warning] Web Audio API volume analysis failed or skipped (continuing upload):', volErr)
          }

          if (isSilent) {
            console.log('[AI Analyzer] Audio chunk is silent, skipping upload.')
            return
          }

          // Send to backend via multipart/form-data
          const formData = new FormData()
          formData.append('file', audioBlob, 'audio.webm')
          formData.append('meetingId', meetingData.meeting_id)
          formData.append('speakerName', user?.full_name || user?.name || 'Anonymous')

          try {
            console.log('[AI Analyzer] Uploading transcript chunk...')
            const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000'
            const res = await fetch(`${apiUrl}/api/meetings/transcript`, {
              method: 'POST',
              body: formData,
              credentials: 'include' // Sent with session auth cookies
            })
            if (!res.ok) {
              console.error('[AI Analyzer] Upload failed. Server returned status:', res.status, await res.text())
            } else {
              console.log('[AI Analyzer] Upload successful')
            }
          } catch (uploadErr) {
            console.error('[AI Analyzer] Upload failed. Network error:', uploadErr)
          }
        }

        // Start recording
        mediaRecorder.start()
        console.log('[AI Analyzer] MediaRecorder started')

        // Trigger recording slice every 30 seconds
        intervalId = setInterval(() => {
          if (mediaRecorder && mediaRecorder.state === 'recording') {
            console.log('[AI Analyzer] Slicing recorder chunk (30s interval)...')
            mediaRecorder.stop()
            mediaRecorder.start()
          }
        }, 30000) // 30 seconds chunks

      } catch (err) {
        console.error('[AI Analyzer Error] Failed to initialize mic recording:', err)
        showToast('AI Analyzer failed to start recording: ' + (err.message || err), 'error')
      }
    }

    startRecording()

    return () => {
      console.log('[AI Analyzer] Stopping transcript capture...')
      if (intervalId) clearInterval(intervalId)
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try {
          mediaRecorder.stop()
        } catch (e) {}
      }
      if (stream) {
        stream.getTracks().forEach(track => track.stop())
      }
    }
  }, [meetingData, roomState, user, showToast])

  // Timer simulation
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    console.log('[MeetingRoomContent useEffect timer] Starting timer...')
    const timer = setInterval(() => {
      setSeconds((prev) => prev + 1)
    }, 1000)
    return () => {
      console.log('[MeetingRoomContent useEffect timer] Clearing timer...')
      clearInterval(timer)
    }
  }, [])

  // Transition meeting to ACTIVE and initialize media ONLY when room is connected
  useEffect(() => {
    console.log('[MeetingRoomContent useEffect initMedia] Checking room connection. roomState:', roomState, 'localParticipant:', !!localParticipant, 'alreadyInit:', mediaInitRef.current)

    const initRoomSession = async () => {
      try {
        if (!room || roomState !== 'connected') {
          console.log('[Media Init] Waiting for room connection. Current state:', roomState)
          return
        }

        // Notify backend to activate meeting (transition Waiting -> Active)
        if (!activatedRef.current && meetingData?.meeting_id) {
          activatedRef.current = true
          console.log('[Activate] LiveKit connected! Activating meeting:', meetingData.meeting_id)
          activateMeeting(meetingData.meeting_id)
        }

        if (!localParticipant || mediaInitRef.current) return
        mediaInitRef.current = true

        console.log('[Media Init] Room connected! Initializing camera and microphone...')

        // Initialize camera
        setCamInitializing(true)
        setCamError(null)
        try {
          console.log('[Camera Init] Requesting camera access via setCameraEnabled(true)...')
          await localParticipant.setCameraEnabled(true)
          setCamActive(true)
          setCamInitializing(false)
          console.log('[Camera Init] Camera enabled successfully!')
        } catch (err) {
          setCamInitializing(false)
          console.error('[Camera Init] Failed to enable camera:', err)
          const errorMsg = getCameraErrorMessage(err)
          setCamError(errorMsg)
          showToast(errorMsg, 'error')
        }

        // Initialize microphone
        try {
          console.log('[Microphone Init] Requesting microphone access via setMicrophoneEnabled(true)...')
          await localParticipant.setMicrophoneEnabled(true)
          setMicActive(true)
          console.log('[Microphone Init] Microphone enabled successfully!')
        } catch (err) {
          console.error('[Microphone Init] Failed to enable microphone:', err)
          showToast('Microphone permission denied or unavailable.', 'error')
        }
      } catch (globalErr) {
        console.error('[Media Init] Unhandled error during media initialization:', globalErr)
      }
    }

    initRoomSession()
  }, [room, roomState, localParticipant, meetingData?.meeting_id, activateMeeting, showToast])

  // Configure Socket.IO connection
  useEffect(() => {
    if (!meetingData?.room_name) return
    console.log('[MeetingRoomContent useEffect socket] Initializing Socket.IO for room:', meetingData.room_name)
    const socketUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000'

    try {
      socket.current = io(socketUrl, {
        withCredentials: true
      })

      // Register room
      socket.current.emit('join_room', meetingData.room_name)

      // WebSocket listeners
      socket.current.on('receive_message', (msg) => {
        setChatMessages((prev) => [...prev, msg])
      })

      socket.current.on('meeting_ended', () => {
        showToast('The host has ended this meeting.', 'info')
        handleLeave()
      })

      socket.current.on('meeting_locked', ({ isLocked }) => {
        showToast(isLocked ? 'The meeting is now locked by the host.' : 'The meeting is now unlocked by the host.', 'info')
        setMeetingData((prev) => (prev ? { ...prev, meeting_status: isLocked ? 'Locked' : 'Active' } : null))
      })

      socket.current.on('typing', ({ name, isTyping }) => {
        setTypingUsers((prev) => {
          const next = { ...prev }
          if (isTyping) {
            next[name] = true
          } else {
            delete next[name]
          }
          return next
        })
      })
    } catch (socketErr) {
      console.error('[MeetingRoomContent useEffect socket] Socket.IO initialization error:', socketErr)
    }

    return () => {
      if (socket.current) {
        console.log('[MeetingRoomContent useEffect socket] Disconnecting socket...')
        socket.current.disconnect()
      }
    }
  }, [meetingData?.room_name, handleLeave, setMeetingData, showToast])

  const formatTimer = (sec) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0')
    const s = (sec % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  // Handle control actions
  const handleToggleMic = async () => {
    if (!localParticipant) return
    try {
      const nextState = !micActive
      console.log(`[Microphone Toggle] Setting microphone to ${nextState ? 'ON' : 'OFF'}...`)
      await localParticipant.setMicrophoneEnabled(nextState)
      setMicActive(nextState)
      showToast(nextState ? 'Microphone unmuted' : 'Microphone muted', 'info')
    } catch (err) {
      console.error('[Microphone Toggle] Failed:', err)
      showToast('Failed to toggle microphone.', 'error')
    }
  }

  const handleToggleCam = async () => {
    if (!localParticipant) return
    setCamError(null)
    setCamInitializing(true)
    try {
      const nextState = !camActive
      console.log(`[Camera Toggle] Setting camera to ${nextState ? 'ON' : 'OFF'}...`)
      await localParticipant.setCameraEnabled(nextState)
      setCamActive(nextState)
      setCamInitializing(false)
      showToast(nextState ? 'Camera enabled' : 'Camera disabled', 'info')
    } catch (err) {
      setCamInitializing(false)
      console.error('[Camera Toggle] Failed:', err)
      const errorMsg = getCameraErrorMessage(err)
      setCamError(errorMsg)
      showToast(errorMsg, 'error')
    }
  }

  const handleToggleShare = async () => {
    if (!localParticipant) return
    try {
      const nextState = !sharingActive
      console.log(`[ScreenShare Toggle] Setting screen share to ${nextState ? 'ON' : 'OFF'}...`)
      await localParticipant.setScreenShareEnabled(nextState)
      setSharingActive(nextState)
      showToast(nextState ? 'Screen sharing started' : 'Screen sharing stopped', 'info')
    } catch (err) {
      console.error('[ScreenShare Toggle] Failed:', err)
      showToast('Failed to toggle screen sharing.', 'error')
    }
  }

  const handleToggleLock = async () => {
    if (!meetingData) return
    const isCurrentlyLocked = meetingData.meeting_status === 'Locked'
    try {
      const nextStatus = await lockMeeting(meetingData.meeting_id, !isCurrentlyLocked)
      setMeetingData((prev) => (prev ? { ...prev, meeting_status: nextStatus } : null))
      if (socket.current) {
        socket.current.emit('lock_meeting', { roomName: meetingData.room_name, isLocked: !isCurrentlyLocked })
      }
      showToast(isCurrentlyLocked ? 'Meeting unlocked successfully.' : 'Meeting locked successfully.', 'success')
    } catch (err) {
      showToast(err.message || 'Failed to update lock status.', 'error')
    }
  }

  const handleSendChat = (e) => {
    e.preventDefault()
    if (!chatInput.trim()) return

    if (socket.current) {
      socket.current.emit('send_message', {
        roomName: meetingData.room_name,
        name: user?.full_name || user?.name || 'Anonymous',
        text: chatInput.trim()
      })
      // Clear typing indicator
      socket.current.emit('typing', {
        roomName: meetingData.room_name,
        name: user?.full_name || user?.name || 'Anonymous',
        isTyping: false
      })
    }
    setChatInput('')
  }

  const handleChatInputChange = (e) => {
    setChatInput(e.target.value)
    if (socket.current) {
      socket.current.emit('typing', {
        roomName: meetingData.room_name,
        name: user?.full_name || user?.name || 'Anonymous',
        isTyping: e.target.value.trim().length > 0
      })
    }
  }

  const handleAskAI = (e) => {
    e.preventDefault()
    if (!aiInput.trim()) return
    const query = aiInput
    setAiResponses((prev) => [...prev, { sender: 'user', text: query }])
    setAiInput('')

    setTimeout(() => {
      let botAnswer = 'I am currently collecting raw meeting transcripts. Whisper summaries are not enabled in this phase.'
      if (query.toLowerCase().includes('summary') || query.toLowerCase().includes('summarize')) {
        botAnswer = `Active meeting session summary: The room title is "${meetingData?.meeting_title || 'Meeting'}". No AI focus metrics are enabled yet.`
      }
      setAiResponses((prev) => [...prev, { sender: 'bot', text: botAnswer }])
    }, 600)
  }

  // Deduplicate participants list by identity or sid to prevent duplicate cards
  const rawParticipants = [localParticipant, ...(participants || [])].filter(Boolean)
  const participantMap = new Map()
  rawParticipants.forEach((p) => {
    const key = p.identity || p.sid
    if (key && !participantMap.has(key)) {
      participantMap.set(key, p)
    }
  })
  const allParticipants = Array.from(participantMap.values())

  return (
    <div className="fixed inset-0 z-40 bg-[#04050b] flex flex-col items-stretch overflow-hidden text-left">
      {/* Top Header Panel */}
      <header className="h-14 border-b border-white/5 bg-[#080913] px-6 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm text-white tracking-wide flex items-center gap-2">
            <span>{meetingData?.meeting_title || 'Live Meeting Room'}</span>
            {isHost && (
              <button
                onClick={handleRename}
                className="text-gray-500 hover:text-white cursor-pointer transition-colors duration-200"
                title="Rename Meeting"
              >
                <Edit2 size={12} />
              </button>
            )}
          </span>
          <div className="w-1.5 h-1.5 rounded-full bg-white/10" />
          <span className="text-xs font-semibold text-gray-500 flex items-center gap-2">
            <span>Code:</span>
            <span className="text-gray-300 font-mono select-all bg-white/3 px-1.5 py-0.5 rounded border border-white/5">{meetingData?.meeting_code}</span>
            <button onClick={handleCopyCode} className="text-gray-500 hover:text-white transition-colors cursor-pointer" title="Copy Code">
              <Copy size={11} />
            </button>
            <button onClick={handleCopyLink} className="text-gray-500 hover:text-white transition-colors cursor-pointer" title="Copy Link">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </button>
          </span>
        </div>

        {/* Live Status Indicators */}
        <div className="flex items-center gap-4 text-xs font-bold">
          <span className="flex items-center gap-1.5 text-emerald-400">
            <Radio size={14} className="animate-pulse" />
            <span>LIVE</span>
          </span>
          <span className="text-gray-400 font-mono">{formatTimer(seconds)}</span>
          <span className="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-gray-400 text-[10px] font-mono">
            {allParticipants.length} In Call
          </span>
        </div>
      </header>

      {/* Main Grid + Drawer Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Video Grid Section */}
        <div className="flex-1 p-6 overflow-y-auto flex items-center justify-center bg-[#05060b]">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-5xl h-full max-h-[560px]">
            {/* Screen share presentations first */}
            {(tracks || []).map((t) => (
              <div
                key={t.publication?.trackSid || t.sid || Math.random()}
                className="bg-slate-900/60 rounded-2xl border border-white/5 relative overflow-hidden flex flex-col justify-end items-center group shadow-xl col-span-2 min-h-[220px]"
              >
                <VideoTrack trackRef={t} className="absolute inset-0 w-full h-full object-contain bg-black" />
                <div className="absolute bottom-3 left-3 px-3 py-1.5 rounded-xl bg-black/60 border border-white/5 text-[10px] font-bold text-white z-10">
                  {t.participant?.name || 'User'}'s Presentation
                </div>
              </div>
            ))}

            {/* Video feeds for all participants */}
            {allParticipants.map((p) => {
              let role = 'participant'
              try {
                const meta = JSON.parse(p?.metadata || '{}')
                role = meta.role || 'participant'
              } catch (e) {}

              const isCurrentUser = p?.identity === localParticipant?.identity

              return (
                <div
                  key={p.sid || p.identity || Math.random()}
                  className="bg-slate-900/60 rounded-2xl border border-white/5 relative overflow-hidden flex flex-col justify-end items-center group shadow-xl min-h-[220px]"
                >
                  {p.isCameraEnabled ? (
                    <VideoTrack trackRef={{ participant: p, source: Track.Source.Camera }} className="absolute inset-0 w-full h-full object-cover" />
                  ) : isCurrentUser && camInitializing ? (
                    <div className="absolute inset-0 bg-slate-950 flex flex-col items-center justify-center gap-3">
                      <div className="w-8 h-8 rounded-full border-2 border-white/10 border-t-purple-500 animate-spin" />
                      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Starting camera...</span>
                    </div>
                  ) : isCurrentUser && camError ? (
                    <div className="absolute inset-0 bg-slate-950 flex flex-col items-center justify-center gap-3 px-4">
                      <VideoOff size={28} className="text-red-400/60" />
                      <span className="text-[10px] font-semibold text-red-400/80 text-center max-w-[200px]">{camError}</span>
                      <button
                        onClick={handleToggleCam}
                        className="mt-1 px-3 py-1 rounded-lg bg-purple-600/20 border border-purple-500/30 text-[10px] font-bold text-purple-300 hover:bg-purple-600/30 transition-colors cursor-pointer"
                      >
                        Retry Camera
                      </button>
                    </div>
                  ) : (
                    <div className="absolute inset-0 bg-slate-950 flex flex-col items-center justify-center">
                      <div className="w-16 h-16 rounded-full bg-[#7c3aed]/10 border border-[#7c3aed]/20 flex items-center justify-center text-[#8b5cf6] font-bold text-lg">
                        {p.name?.charAt(0).toUpperCase() || 'P'}
                      </div>
                    </div>
                  )}

                  {/* Quality quality status */}
                  <div className="absolute top-3 left-3 flex flex-col gap-1 z-10 text-[9px] font-bold uppercase tracking-wider">
                    <span className="px-2 py-1 rounded bg-black/70 border border-white/10 flex items-center gap-1.5 text-gray-300">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          p.connectionQuality === 'excellent' ? 'bg-emerald-500' :
                          p.connectionQuality === 'good' ? 'bg-yellow-500' :
                          p.connectionQuality === 'poor' ? 'bg-red-500' : 'bg-gray-500'
                        }`}
                      />
                      <span>Signal: {p.connectionQuality}</span>
                    </span>
                  </div>

                  {/* Name Tag (Bottom bar) */}
                  <div className="absolute bottom-3 left-3 px-3 py-1.5 rounded-xl bg-black/60 border border-white/5 text-[10px] font-bold text-white z-10">
                    {p.name} {isCurrentUser && ' (You)'} {role === 'host' && ' (Host)'}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Right Side Drawer Panel */}
        {rightPanelOpen && (
          <div className="w-80 h-full border-l border-white/5 bg-[#080913] flex flex-col justify-between shrink-0">
            {/* Drawer Tabs Header */}
            <div className="flex border-b border-white/5 select-none">
              <button
                onClick={() => setActiveTab('chat')}
                className={`flex-1 py-3 text-xs font-semibold border-b-2 transition-all duration-200 cursor-pointer ${
                  activeTab === 'chat'
                    ? 'border-brand-purple text-white'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                Chat
              </button>
              <button
                onClick={() => setActiveTab('participants')}
                className={`flex-1 py-3 text-xs font-semibold border-b-2 transition-all duration-200 cursor-pointer ${
                  activeTab === 'participants'
                    ? 'border-brand-purple text-white'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                Participants
              </button>
              <button
                onClick={() => setActiveTab('ai')}
                className={`flex-1 py-3 text-xs font-semibold border-b-2 transition-all duration-200 cursor-pointer ${
                  activeTab === 'ai'
                    ? 'border-brand-purple text-white'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                AI Assistant
              </button>
            </div>

            {/* Drawer Contents */}
            <div className="flex-1 overflow-y-auto p-4 flex flex-col justify-between">
              {/* TAB: CHAT */}
              {activeTab === 'chat' && (
                <div className="flex flex-col gap-3 h-full justify-between">
                  <div className="flex-1 overflow-y-auto flex flex-col gap-3">
                    {chatMessages.map((msg, idx) => (
                      <div key={idx} className="flex flex-col gap-0.5 text-xs">
                        <span className="font-bold text-gray-400">{msg.name}</span>
                        <p className="bg-white/3 rounded-xl p-2.5 text-gray-200 border border-white/5">{msg.text}</p>
                      </div>
                    ))}
                  </div>

                  {Object.keys(typingUsers).length > 0 && (
                    <div className="text-[10px] text-gray-500 italic px-1 select-none">
                      {Object.keys(typingUsers).join(', ')} is typing...
                    </div>
                  )}

                  <form onSubmit={handleSendChat} className="flex items-center gap-2 border-t border-white/5 pt-3">
                    <input
                      type="text"
                      placeholder="Type a message..."
                      value={chatInput}
                      onChange={handleChatInputChange}
                      className="flex-1 bg-slate-900/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand-purple transition-all duration-200"
                    />
                    <Button type="submit" className="px-3 py-2 shrink-0">
                      <Send size={12} />
                    </Button>
                  </form>
                </div>
              )}

              {/* TAB: PARTICIPANTS */}
              {activeTab === 'participants' && (
                <div className="flex flex-col gap-3 overflow-y-auto">
                  {allParticipants.map((p) => {
                    let role = 'participant'
                    try {
                      const meta = JSON.parse(p?.metadata || '{}')
                      role = meta.role || 'participant'
                    } catch (e) {}

                    return (
                      <div key={p.sid || p.identity} className="flex items-center gap-3 p-2 bg-white/2 border border-white/5 rounded-xl">
                        <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-xs font-bold text-gray-300">
                          {p.name?.charAt(0).toUpperCase() || 'P'}
                        </div>
                        <div className="flex flex-col text-left flex-1">
                          <span className="text-xs font-semibold text-white">
                            {p.name} {p.identity === localParticipant?.identity && ' (You)'}
                          </span>
                          <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mt-0.5">{role}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* TAB: AI ASSISTANT */}
              {activeTab === 'ai' && (
                <div className="flex flex-col gap-3 h-full justify-between">
                  <div className="flex-1 overflow-y-auto flex flex-col gap-3">
                    {aiResponses.map((msg, idx) => (
                      <div key={idx} className={`flex gap-2 max-w-[90%] ${msg.sender === 'user' ? 'self-end flex-row-reverse' : 'self-start'}`}>
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 border ${msg.sender === 'user' ? 'bg-brand-blue/10 border-brand-blue/20 text-brand-blue' : 'bg-brand-purple/10 border-brand-purple/20 text-brand-purple'}`}>
                          {msg.sender === 'user' ? <Users size={12} /> : <Bot size={12} />}
                        </div>
                        <p className={`p-2.5 rounded-xl text-xs leading-normal ${msg.sender === 'user' ? 'bg-brand-blue text-white' : 'bg-white/3 text-gray-200 border border-white/5'}`}>{msg.text}</p>
                      </div>
                    ))}
                  </div>

                  <form onSubmit={handleAskAI} className="flex items-center gap-2 border-t border-white/5 pt-3">
                    <input
                      type="text"
                      placeholder="Ask meeting bot..."
                      value={aiInput}
                      onChange={(e) => setAiInput(e.target.value)}
                      className="flex-1 bg-slate-900/40 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand-purple transition-all duration-200"
                    />
                    <Button type="submit" className="px-3 py-2 shrink-0">
                      <Sparkles size={12} />
                    </Button>
                  </form>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Controls Toolbar */}
      <footer className="h-16 border-t border-white/5 bg-[#080913] px-6 flex items-center justify-between shrink-0 select-none">
        {/* Toggle Right Drawer panel */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setRightPanelOpen(!rightPanelOpen)}
            className={`p-2.5 rounded-xl border border-white/5 text-gray-400 hover:text-white transition-all duration-200 cursor-pointer ${rightPanelOpen ? 'bg-white/5 text-white' : 'hover:bg-white/5'}`}
          >
            <MessageSquare size={16} />
          </button>
        </div>

        {/* Core Media Controls */}
        <div className="flex items-center gap-3">
          {/* Microphone */}
          <button
            onClick={handleToggleMic}
            className={`w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-200 cursor-pointer ${
              micActive ? 'bg-[#0f1122]/60 hover:bg-[#141629] border-white/10 text-white' : 'bg-red-600 hover:bg-red-500 border-transparent text-white'
            }`}
          >
            {micActive ? <Mic size={18} /> : <MicOff size={18} />}
          </button>

          {/* Camera */}
          <button
            onClick={handleToggleCam}
            className={`w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-200 cursor-pointer ${
              camActive ? 'bg-[#0f1122]/60 hover:bg-[#141629] border-white/10 text-white' : 'bg-red-600 hover:bg-red-500 border-transparent text-white'
            }`}
          >
            {camActive ? <Cam size={18} /> : <VideoOff size={18} />}
          </button>

          {/* Screen Share */}
          <button
            onClick={handleToggleShare}
            className={`w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-200 cursor-pointer ${
              sharingActive ? 'bg-brand-blue hover:bg-brand-blue-hover border-transparent text-white shadow-lg shadow-brand-blue/20' : 'bg-[#0f1122]/60 hover:bg-[#141629] border-white/10 text-white'
            }`}
          >
            <Monitor size={18} />
          </button>
        </div>

        {/* End Call / Leave room controls based on host permissions */}
        {isHost ? (
          <div className="flex items-center gap-2">
            <button
              onClick={handleToggleLock}
              className="px-3.5 py-2 border border-[#8b5cf6]/20 hover:border-[#8b5cf6]/40 bg-[#8b5cf6]/5 hover:bg-[#8b5cf6]/10 text-[#c084fc] hover:text-[#d8b4fe] rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer flex items-center gap-1.5"
            >
              {meetingData?.meeting_status === 'Locked' ? <Unlock size={12} /> : <Lock size={12} />}
              <span>{meetingData?.meeting_status === 'Locked' ? 'Unlock Room' : 'Lock Room'}</span>
            </button>
            <button
              onClick={handleDeleteMeeting}
              className="px-3.5 py-2 border border-red-500/20 hover:border-red-500/40 bg-red-600/5 hover:bg-red-600/10 text-red-400 hover:text-red-300 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer"
            >
              Delete
            </button>
            <Button variant="danger" onClick={handleEndMeeting} className="px-5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-red-600/25">
              <PhoneOff size={14} />
              <span>End Meeting</span>
            </Button>
          </div>
        ) : (
          <Button variant="danger" onClick={handleLeave} className="px-5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-red-600/25">
            <PhoneOff size={14} />
            <span>Leave Room</span>
          </Button>
        )}
      </footer>
    </div>
  )
}
