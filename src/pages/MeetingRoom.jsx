import React, { useState, useEffect, useRef, useCallback } from 'react'
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
import { Track, RoomEvent } from 'livekit-client'
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

import AIChatPanel from '../components/AIChatPanel'

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
    setLivekitToken,
    setLivekitUrl,
    joinMeeting
  } = useMeetings()
  const { showToast } = useToast()
  const navigate = useNavigate()

  const [meetingData, setMeetingData] = useState(null)
  const meetingHostId = meetingData?.host_id || meetingData?.hostId
  const currentUserId = user?.id
  const isHost = Boolean(currentUserId) && Boolean(meetingHostId) && String(currentUserId).trim().toLowerCase() === String(meetingHostId).trim().toLowerCase()

  const isHostRef = useRef(isHost)
  useEffect(() => {
    isHostRef.current = isHost
    if (isHost) {
      setAttendanceConsent('Granted')
    }
  }, [isHost])
  const [isWaitingForApproval, setIsWaitingForApproval] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [roomError, setRoomError] = useState(null)
  const [attendanceConsent, setAttendanceConsent] = useState(null)
  const joinAttemptedRef = useRef(false)
  const isIntentionalLeaveRef = useRef(false)

  const [chatMessages, setChatMessages] = useState([
    { name: 'System', text: 'Welcome to the meeting room. Chat messages and AI queries are enabled.' }
  ])
  const [typingUsers, setTypingUsers] = useState({})
  const socket = useRef(null)
  const handleLeaveWithAttendanceRef = useRef(null)

  const [waitingRequests, setWaitingRequests] = useState([])

  const fetchWaitingRequests = useCallback(async () => {
    if (!meetingData?.meeting_code) return
    try {
      const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
      const headers = token ? { Authorization: `Bearer ${token}` } : {}
      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/security/pending/${meetingData.meeting_code}`, {
        headers,
        credentials: 'include'
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setWaitingRequests(data.requests || [])
      }
    } catch (err) {
      console.error('[Security] Failed to fetch waiting requests:', err)
    }
  }, [meetingData?.meeting_code])

  const fetchWaitingRequestsRef = useRef(fetchWaitingRequests)
  useEffect(() => {
    fetchWaitingRequestsRef.current = fetchWaitingRequests
  }, [fetchWaitingRequests])

  const handleLeaveRef = useRef(null)

  const enableAiAttendanceRef = useRef(meetingData?.enable_ai_attendance)
  useEffect(() => {
    enableAiAttendanceRef.current = meetingData?.enable_ai_attendance
  }, [meetingData?.enable_ai_attendance])

  useEffect(() => {
    if (meetingData && isHost) {
      fetchWaitingRequests()
    }
  }, [meetingData, isHost, fetchWaitingRequests])

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
        // REFRESH GUARD: If meeting is already Ended (e.g. participant refreshes after host ended it),
        // do not allow re-entry. Show clear error and redirect after a short delay.
        if (data.meeting?.meeting_status === 'Ended') {
          console.log('[MeetingRoom] Meeting is already ended. Blocking re-entry.')
          setRoomError('This meeting has ended.')
          setIsLoading(false)
          setTimeout(() => { if (isMounted) navigate('/') }, 3000)
          return
        }
        setMeetingData(data.meeting)
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
  }, [id, fetchMeetingDetails, showToast, navigate])


  // Synced host verification
  useEffect(() => {
    if (isHost) {
      setAttendanceConsent('Granted')
    }
  }, [isHost])

  // 2. Auto-join meeting room if Token is missing (e.g. on F5 Refresh)
  useEffect(() => {
    console.log('[MeetingRoom useEffect 2] ensureToken check. meetingData:', !!meetingData, 'hasToken:', !!livekitToken, 'attempted:', joinAttemptedRef.current, 'attendanceConsent:', attendanceConsent)

    let timeoutId = null
    const ensureToken = async () => {
      if (isIntentionalLeaveRef.current) {
        console.log('[MeetingRoom useEffect 2] Intentional leave in progress, skipping auto-join.')
        return
      }
      if (meetingData && !livekitToken && !joinAttemptedRef.current) {
        // If AI Attendance is enabled, wait until consent is resolved before joining
        if (meetingData.enable_ai_attendance && attendanceConsent === null) {
          console.log('[MeetingRoom useEffect 2] AI Attendance is enabled, waiting for user consent.')
          return
        }

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

        let fingerprint = ''
        try {
          console.log('[Security] Browser fingerprint generated.')
          const FingerprintJS = (await import('@fingerprintjs/fingerprintjs')).default
          const fp = await FingerprintJS.load()
          const fpResult = await fp.get()
          fingerprint = fpResult.visitorId
        } catch (fpErr) {
          console.error('[Security Error] Failed to generate browser fingerprint:', fpErr)
        }

        try {
          const res = await joinMeeting(meetingData.meeting_code, '', fingerprint)
          if (res && res.status === 'waiting') {
            console.log('[MeetingRoom useEffect 2] Join pending approval, entering waiting room.')
            if (timeoutId) clearTimeout(timeoutId)
            setIsWaitingForApproval(true)
            setIsLoading(false)
          } else {
            console.log('[MeetingRoom useEffect 2] joinMeeting succeeded')
          }
        } catch (err) {
          console.error('[MeetingRoom useEffect 2] Session recovery/join failed:', err)
          joinAttemptedRef.current = false
          const msg = err.message || 'Access token could not be fetched.'
          setRoomError(msg)
          showToast(msg, 'error')
        } finally {
          if (timeoutId && !isWaitingForApproval) clearTimeout(timeoutId)
        }
      }
    }

    ensureToken()

    return () => {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [meetingData, livekitToken, joinMeeting, showToast, attendanceConsent, isWaitingForApproval])



  const handleLeave = useCallback(async () => {
    console.log('[MeetingRoom] handleLeave triggered')
    isIntentionalLeaveRef.current = true
    if (meetingData) {
      try {
        await leaveMeeting(meetingData.meeting_id)
      } catch (e) {
        console.error('[MeetingRoom] leaveMeeting error:', e)
      }
    }
    showToast('You left the meeting.', 'info')
    navigate('/')
  }, [meetingData, leaveMeeting, navigate, showToast])

  useEffect(() => {
    handleLeaveRef.current = handleLeave
  }, [handleLeave])

  const handleEndMeeting = useCallback(async () => {
    if (!meetingData) return
    const confirmEnd = window.confirm('Are you sure you want to end this meeting for all participants?')
    if (!confirmEnd) return

    isIntentionalLeaveRef.current = true
    try {
      await endMeeting(meetingData.meeting_id)
      showToast('Meeting ended successfully.', 'success')
      navigate('/')
    } catch (err) {
      showToast(err.message || 'Failed to end meeting', 'error')
    }
  }, [meetingData, endMeeting, navigate, showToast])

  const handleDeleteMeeting = useCallback(async () => {
    if (!meetingData) return
    const confirmDel = window.confirm('Are you sure you want to delete this meeting?')
    if (!confirmDel) return

    isIntentionalLeaveRef.current = true
    try {
      await deleteMeeting(meetingData.meeting_id)
      showToast('Meeting deleted successfully.', 'success')
      navigate('/')
    } catch (err) {
      showToast(err.message || 'Failed to delete meeting', 'error')
    }
  }, [meetingData, deleteMeeting, navigate, showToast])

  const handleRename = useCallback(async () => {
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
  }, [meetingData, renameMeeting, showToast])

  const handleCopyCode = useCallback(() => {
    if (!meetingData) return
    navigator.clipboard.writeText(meetingData.meeting_code)
    showToast('Meeting code copied!', 'success')
  }, [meetingData, showToast])

  const handleCopyLink = useCallback(() => {
    if (!meetingData) return
    const link = `${window.location.origin}/meeting/${meetingData.meeting_code}`
    navigator.clipboard.writeText(link)
    showToast('Meeting link copied!', 'success')
  }, [meetingData, showToast])



  // Configure Socket.IO connection
  useEffect(() => {
    if (!meetingData?.room_name) return
    console.log('[MeetingRoomInner useEffect socket] Initializing Socket.IO for room:', meetingData.room_name)
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

      socket.current.on('participant_accepted', ({ userId, token, livekitUrl }) => {
        const currentUserId = user?.id
        console.log('[Security Socket] participant_accepted received for user:', userId, 'current user:', currentUserId)
        if (currentUserId && userId === currentUserId) {
          showToast('Admitted to meeting by host!', 'success')
          setLivekitToken(token)
          setLivekitUrl(livekitUrl)
          setIsWaitingForApproval(false)
        }
      })

      socket.current.on('participant_rejected', ({ userId }) => {
        const currentUserId = user?.id
        console.log('[Security Socket] participant_rejected received for user:', userId, 'current user:', currentUserId)
        if (currentUserId && userId === currentUserId) {
          showToast('Host rejected your join request.', 'error')
          if (socket.current) {
            socket.current.disconnect()
            socket.current = null
          }
          navigate('/')
        }
      })

      socket.current.on('participant_banned', ({ userId }) => {
        const currentUserId = user?.id
        console.log('[Security Socket] participant_banned received for user:', userId, 'current user:', currentUserId)
        if (currentUserId && userId === currentUserId) {
          showToast('This device has been blocked by the meeting host.', 'error')
          if (socket.current) {
            socket.current.disconnect()
            socket.current = null
          }
          setLivekitToken(null)
          setLivekitUrl(null)
          navigate('/')
        }
      })

      socket.current.on('participant_removed', ({ userId }) => {
        const currentUserId = user?.id
        console.log('[Security Socket] participant_removed received for user:', userId, 'current user:', currentUserId)
        if (currentUserId && userId === currentUserId) {
          showToast('You have been removed from the meeting.', 'info')
          if (socket.current) {
            socket.current.disconnect()
            socket.current = null
          }
          setLivekitToken(null)
          setLivekitUrl(null)
          navigate('/')
        }
      })

      socket.current.on('waiting_list_updated', () => {
        console.log('[Security Socket] waiting_list_updated received.')
        if (isHostRef.current) {
          if (fetchWaitingRequestsRef.current) {
            fetchWaitingRequestsRef.current()
          }
        }
      })

      socket.current.on('meeting_ended', async () => {
        showToast('The host has ended this meeting.', 'info')
        console.log('[Frontend] Meeting ended. Redirecting user to dashboard.')
        if (enableAiAttendanceRef.current && !isHostRef.current) {
          if (handleLeaveWithAttendanceRef.current) {
            await handleLeaveWithAttendanceRef.current()
          } else {
            if (handleLeaveRef.current) {
              await handleLeaveRef.current()
            }
          }
        } else {
          if (handleLeaveRef.current) {
            await handleLeaveRef.current()
          }
        }
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
      console.error('[MeetingRoomInner useEffect socket] Socket.IO initialization error:', socketErr)
    }

    return () => {
      if (socket.current) {
        console.log('[MeetingRoomInner useEffect socket] Disconnecting socket...')
        socket.current.disconnect()
      }
    }
  }, [meetingData?.room_name])

  // Error UI — differentiate "meeting ended" from other errors
  if (roomError) {
    const isMeetingEnded = roomError === 'This meeting has ended.'
    return (
      <div className="fixed inset-0 z-40 bg-[#04050b] flex flex-col items-center justify-center p-6 text-center select-none">
        <div className={`max-w-md w-full bg-slate-900/90 border ${
          isMeetingEnded ? 'border-purple-500/20' : 'border-red-500/20'
        } rounded-2xl p-6 flex flex-col items-center gap-4 shadow-2xl`}>
          <div className={`w-12 h-12 rounded-full flex items-center justify-center text-2xl ${
            isMeetingEnded
              ? 'bg-purple-500/10 border border-purple-500/20'
              : 'bg-red-500/10 border border-red-500/20'
          }`}>
            {isMeetingEnded ? <span>🏁</span> : <AlertTriangle size={24} className="text-red-400" />}
          </div>
          <h2 className="text-base font-bold text-white">
            {isMeetingEnded ? 'Meeting Ended' : 'Unable to Join Meeting'}
          </h2>
          <p className="text-xs text-gray-400 bg-black/40 border border-white/5 p-3 rounded-xl w-full text-center">
            {isMeetingEnded
              ? 'This meeting has been ended by the host. Redirecting you to the dashboard…'
              : roomError}
          </p>
          <div className="flex items-center gap-3 w-full mt-2">
            {!isMeetingEnded && (
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
            )}
            <button
              onClick={() => navigate('/')}
              className="flex-1 px-4 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-bold transition-all cursor-pointer"
            >
              {isMeetingEnded ? 'Go to Dashboard' : 'Back to Home'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // If AI Attendance is enabled and consent is not decided, show the consent dialog
  if (meetingData && meetingData.enable_ai_attendance && attendanceConsent === null) {
    return (
      <div className="fixed inset-0 z-50 bg-[#04050b]/90 backdrop-blur-md flex items-center justify-center p-6 text-left select-none">
        <div className="max-w-md w-full bg-slate-900 border border-white/10 rounded-2xl p-6 flex flex-col gap-4 shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
              <AlertTriangle size={20} className="text-purple-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">AI Attendance Consent</h2>
              <p className="text-[10px] text-gray-500">Privacy-First Face Detection</p>
            </div>
          </div>
          <div className="text-xs text-gray-300 leading-relaxed flex flex-col gap-2.5 p-4 bg-black/40 rounded-xl border border-white/5">
            <p className="font-semibold text-white">AI Attendance uses your camera locally for face-presence detection during the meeting.</p>
            <p>If you turn off your meeting video, other participants will not see you, but AI Attendance may continue using your camera locally.</p>
            <p className="text-[11px] text-gray-400">No attendance video, image, screenshot, face embedding, or biometric identifier is stored or transmitted.</p>
          </div>
          <div className="flex flex-col gap-2 mt-2">
            <button
              onClick={async () => {
                try {
                  console.log('[Attendance] Requesting camera access for AI Attendance...')
                  const stream = await navigator.mediaDevices.getUserMedia({ video: true })
                  // Stop the track immediately so it can be requested again inside the detector session
                  stream.getTracks().forEach(track => track.stop())
                  console.log('[Attendance] Camera permission granted')
                  setAttendanceConsent('Granted')
                } catch (err) {
                  console.warn('[Attendance] Camera permission denied or failed:', err)
                  setAttendanceConsent('Denied')
                }
              }}
              className="w-full py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-2"
            >
              Allow AI Attendance
            </button>
            <button
              onClick={() => {
                console.log('[Attendance] User opted out of AI Attendance')
                setAttendanceConsent('Camera Disabled')
              }}
              className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-gray-300 rounded-xl text-xs font-bold transition-all cursor-pointer"
            >
              Join Without AI Attendance
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Waiting Room UI
  if (isWaitingForApproval) {
    return (
      <div className="fixed inset-0 z-50 bg-[#04050b] flex flex-col items-center justify-center p-6 text-center select-none">
        <div className="max-w-md w-full bg-slate-900 border border-white/10 rounded-2xl p-8 flex flex-col items-center gap-6 shadow-2xl">
          <div className="w-16 h-16 rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 text-3xl font-bold animate-pulse">
            ⏳
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-base font-bold text-white">Waiting for Host Approval</h2>
            <p className="text-xs text-gray-400 max-w-xs mx-auto">
              You will join the meeting automatically once the host accepts your request.
            </p>
          </div>
          <button
            onClick={handleLeave}
            className="px-6 py-2 bg-slate-800 hover:bg-slate-700 text-gray-300 rounded-xl text-xs font-bold transition-all cursor-pointer"
          >
            Cancel and Return
          </button>
        </div>
      </div>
    )
  }

  const serverUrl = livekitUrl || import.meta.env.VITE_LIVEKIT_URL

  useEffect(() => {
    if (livekitToken && serverUrl) {
      console.log('[LiveKit Connection] Connecting LiveKitRoom to serverUrl:', serverUrl)
    }
  }, [livekitToken, serverUrl])

  // Loading UI
  if (isLoading || !livekitToken || !meetingData || isIntentionalLeaveRef.current) {
    if (isIntentionalLeaveRef.current) {
      return null
    }
    return (
      <div className="fixed inset-0 z-40 bg-[#04050b] flex flex-col items-center justify-center text-xs font-semibold text-gray-500 select-none">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border border-white/10 border-t-purple-500 animate-spin" />
          <span className="uppercase tracking-widest text-[9px] font-bold text-gray-400">Connecting to Room...</span>
        </div>
      </div>
    )
  }

  return (
    <LiveKitRoom
      token={livekitToken}
      serverUrl={serverUrl}
      connect={true}
      video={false}
      audio={false}
      onDisconnected={() => {
        console.log('[LiveKit Connection] Event onDisconnected triggered')
        if (isIntentionalLeaveRef.current) {
          console.log('[LiveKit Connection] Intentional disconnect, leave already handled.')
        } else {
          console.log('[LiveKit Connection] Temporary/automatic disconnect. Allowing reconnect lifecycle to operate.')
        }
      }}
      onError={(err) => {
        console.error('[LiveKit Connection] Event onError triggered:', err)
        if (isIntentionalLeaveRef.current) {
          console.log('[LiveKit Connection] Bypassing onError toast for intentional disconnect.')
          return
        }
        const errMsg = err?.message || ''
        if (
          errMsg.toLowerCase().includes('client initiated disconnect') ||
          errMsg.toLowerCase().includes('user initiated') ||
          errMsg.toLowerCase().includes('client initiated')
        ) {
          console.log('[LiveKit Connection] Bypassing error toast for expected client disconnect:', errMsg)
          return
        }
        showToast('LiveKit connection error: ' + (errMsg || 'Check your credentials.'), 'error')
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
        attendanceConsent={attendanceConsent}
        endMeeting={endMeeting}
        socket={socket}
        chatMessages={chatMessages}
        setChatMessages={setChatMessages}
        typingUsers={typingUsers}
        setTypingUsers={setTypingUsers}
        handleLeaveWithAttendanceRef={handleLeaveWithAttendanceRef}
        waitingRequests={waitingRequests}
        fetchWaitingRequests={fetchWaitingRequests}
        isIntentionalLeaveRef={isIntentionalLeaveRef}
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
  isHost: isHostProp,
  handleLeave,
  handleEndMeeting,
  handleDeleteMeeting,
  handleRename,
  handleCopyCode,
  handleCopyLink,
  lockMeeting,
  activateMeeting,
  showToast,
  user,
  attendanceConsent,
  endMeeting,
  socket,
  chatMessages,
  setChatMessages,
  typingUsers,
  setTypingUsers,
  handleLeaveWithAttendanceRef,
  waitingRequests,
  fetchWaitingRequests,
  isIntentionalLeaveRef
}) {
  const navigate = useNavigate()
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
  const [attendanceCamError, setAttendanceCamError] = useState(false)
  const [isShuttingDown, setIsShuttingDown] = useState(false)

  // Drawer Panel Toggles
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [activeTab, setActiveTab] = useState('chat') // chat | participants | ai

  // Local Chat / AI States
  const [chatInput, setChatInput] = useState('')
  const [aiInput, setAiInput] = useState('')
  const [aiResponses, setAiResponses] = useState([
    { sender: 'bot', text: 'I am tracking the meeting. You can ask me to summarize the current discussion.' }
  ])

  const meetingHostId = meetingData?.host_id || meetingData?.hostId
  const currentUserId = user?.id
  const isHost = Boolean(currentUserId) && Boolean(meetingHostId) && String(currentUserId).trim().toLowerCase() === String(meetingHostId).trim().toLowerCase()

  console.log(`[HOST UI DEBUG]\nuserId: ${currentUserId}\nmeetingHostId: ${meetingHostId}\nisHost: ${isHost}\nsecurityTabVisible: ${isHost}`)

  const roomState = room?.state
  console.log('[MeetingRoomContent Render] roomState:', roomState, 'localParticipant:', !!localParticipant, 'participants count:', participants?.length || 0)

  // AI Attendance tracking parameters
  const detectorRef = useRef(null)
  const cameraStreamRef = useRef(null)
  const animationFrameIdRef = useRef(null)
  const hasUploaded = useRef(false)

  const presenceSeconds = useRef(0)
  const tempAbsenceSeconds = useRef(0)
  const consecutiveDetections = useRef(0)
  const isPresent = useRef(false)
  const totalSeconds = useRef(0)
  const cameraInterruptedCount = useRef(0)
  const tempAbsenceIncidents = useRef(0)
  const videoRef = useRef(null)
  const attendanceCameraStreamRef = useRef(null)
  const transcriptMediaRecorderRef = useRef(null)
  const transcriptStreamRef = useRef(null)
  const transcriptIntervalRef = useRef(null)
  const isTranscriptActiveRef = useRef(false)
  const activeTranscriptUploadsRef = useRef(0)

  // Get local camera video track from LiveKit
  const localVideoTrack = localParticipant?.getTrackPublication(Track.Source.Camera)?.videoTrack ||
                          Array.from(localParticipant?.videoTrackPublications?.values() || []).find(p => p.source === Track.Source.Camera)?.videoTrack

  const isInitializingRef = useRef(false)
  const sessionStartTimeRef = useRef(null)

  const meetingDataRef = useRef(meetingData)
  const isHostRef = useRef(isHost)
  const attendanceConsentRef = useRef(attendanceConsent)
  const userRef = useRef(user)
  const handleLeaveRef = useRef(handleLeave)

  useEffect(() => {
    meetingDataRef.current = meetingData
  }, [meetingData])

  useEffect(() => {
    isHostRef.current = isHost
  }, [isHost])

  useEffect(() => {
    attendanceConsentRef.current = attendanceConsent
  }, [attendanceConsent])

  useEffect(() => {
    userRef.current = user
  }, [user])

  useEffect(() => {
    handleLeaveRef.current = handleLeave
  }, [handleLeave])



  // Track when the participant successfully joins the LiveKit room
  useEffect(() => {
    if (meetingData?.enable_ai_attendance && !isHost && roomState === 'connected') {
      if (!sessionStartTimeRef.current) {
        sessionStartTimeRef.current = Date.now()
        console.log('[Attendance Debug] Participant joined. Session timer started:', new Date(sessionStartTimeRef.current).toISOString())
      }
    }
  }, [meetingData, isHost, roomState])

  // LiveKit Identity & Remote Participant Debugging
  useEffect(() => {
    if (!room || roomState !== 'connected') return

    if (localParticipant) {
      console.log(`[LIVEKIT IDENTITY DEBUG]\nlocal participant identity: ${localParticipant.identity || 'N/A'}\nlocal participant sid: ${localParticipant.sid || 'N/A'}\nroom name: ${room.name || 'N/A'}`)
    }

    const onParticipantConnected = (p) => {
      console.log(`[REMOTE PARTICIPANT DEBUG]\nparticipant connected: ${p.identity}\nidentity: ${p.identity}\nsid: ${p.sid}\nisLocal: ${p.isLocal}`)
    }

    const onTrackPublished = (pub, p) => {
      console.log(`[REMOTE TRACK DEBUG]\ntrack published: ${pub.trackSid || pub.sid}\nparticipant identity: ${p?.identity || 'N/A'}\ntrack kind: ${pub.kind}\ntrack source: ${pub.source}`)
    }

    const onTrackSubscribed = (track, pub, p) => {
      console.log(`[TRACK SUBSCRIBED DEBUG]\nparticipant identity: ${p?.identity || 'N/A'}\ntrack kind: ${track.kind}\ntrack source: ${pub?.source || 'N/A'}`)
    }

    room.on(RoomEvent.ParticipantConnected, onParticipantConnected)
    room.on(RoomEvent.TrackPublished, onTrackPublished)
    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed)

    // Log existing remote participants
    room.remoteParticipants.forEach((p) => {
      console.log(`[REMOTE PARTICIPANT DEBUG]\nparticipant connected: ${p.identity}\nidentity: ${p.identity}\nsid: ${p.sid}\nisLocal: false`)
    })

    return () => {
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected)
      room.off(RoomEvent.TrackPublished, onTrackPublished)
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed)
    }
  }, [room, roomState, localParticipant])

  const uploadAttendance = async () => {
    if (isHost) {
      console.log('[Attendance] Bypassing upload: User is the meeting host.')
      return true
    }

    const duration = sessionStartTimeRef.current 
      ? Math.max(0, Math.floor((Date.now() - sessionStartTimeRef.current) / 1000))
      : 0

    if (duration <= 0) {
      console.log('[Attendance] Bypassing upload: Session duration is 0 seconds (startup check or join event).')
      return true
    }

    if (hasUploaded.current) return true
    hasUploaded.current = true

    const percentage = duration > 0 ? (presenceSeconds.current / duration) * 100 : 0
    const status = percentage >= 75 ? 'Present' : 'Absent'
    const camPermission = attendanceConsent === 'Granted'

    const payload = {
      meetingId: meetingData.meeting_id,
      presenceSeconds: presenceSeconds.current,
      meetingDurationSeconds: duration,
      attendancePercentage: Number(percentage.toFixed(2)),
      status,
      cameraPermission: camPermission
    }

    console.log('[Attendance Finalize]', {
      meetingId: meetingData.meeting_id,
      userId: user?.id || 'unknown',
      isHost,
      sessionStart: sessionStartTimeRef.current ? new Date(sessionStartTimeRef.current).toISOString() : null,
      sessionDurationSeconds: duration,
      presenceSeconds: presenceSeconds.current,
      cameraPermission: camPermission
    })
    console.log('[Attendance Upload Payload]', payload)

    const maxRetries = 3
    let attempt = 0
    const delay = (ms) => new Promise(res => setTimeout(res, ms))

    while (attempt < maxRetries) {
      try {
        const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
        const headers = { 'Content-Type': 'application/json' }
        if (token) headers['Authorization'] = `Bearer ${token}`

        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000'
        const res = await fetch(`${apiUrl}/api/meetings/attendance`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          credentials: 'include'
        })
        if (res.ok) {
          console.log('[Attendance] Upload successful')
          return true
        }
      } catch (err) {
        console.error(`[Attendance] Attempt ${attempt + 1} failed:`, err)
      }
      attempt++
      if (attempt < maxRetries) {
        await delay(Math.pow(2, attempt) * 500)
      }
    }
    hasUploaded.current = false
    return false
  }

  const stopTranscriptCapture = () => {
    if (!isTranscriptActiveRef.current) return
    isTranscriptActiveRef.current = false
    console.log('[AI Analyzer] Stopping transcript capture (clean shutdown)...')

    // 1. Stop MediaRecorder immediately
    if (transcriptMediaRecorderRef.current && transcriptMediaRecorderRef.current.state !== 'inactive') {
      try {
        transcriptMediaRecorderRef.current.stop()
      } catch (e) {
        console.error('[AI Analyzer] Error stopping MediaRecorder:', e)
      }
      transcriptMediaRecorderRef.current = null
    }

    // 2. Stop microphone capture
    if (transcriptStreamRef.current) {
      try {
        transcriptStreamRef.current.getTracks().forEach(track => track.stop())
      } catch (e) {
        console.error('[AI Analyzer] Error stopping mic stream tracks:', e)
      }
      transcriptStreamRef.current = null
    }

    // 3. Clear transcript intervals
    if (transcriptIntervalRef.current) {
      clearInterval(transcriptIntervalRef.current)
      transcriptIntervalRef.current = null
    }
  }

  const waitPendingTranscriptUploads = () => {
    return new Promise((resolve) => {
      if (activeTranscriptUploadsRef.current === 0) {
        console.log('[Transcript Queue] All uploads finished.')
        resolve()
        return
      }

      console.log('[Transcript Queue] Waiting for uploads...')
      let checks = 0
      const checkInterval = setInterval(() => {
        checks++
        console.log(`[Transcript Queue] Active uploads: ${activeTranscriptUploadsRef.current}`)
        if (activeTranscriptUploadsRef.current === 0) {
          clearInterval(checkInterval)
          console.log('[Transcript Queue] All uploads finished.')
          resolve()
        } else if (checks >= 600) { // 60 seconds safety timeout
          clearInterval(checkInterval)
          console.warn('[Transcript Queue Warning] Timeout reached while waiting for transcript uploads. Continuing shutdown safely.')
          resolve()
        }
      }, 100)
    })
  }

  const cleanupResources = () => {
    console.log('[Attendance] Cleaning up attendance resources...')
    stopTranscriptCapture()
    if (socket.current) {
      console.log('[Cleanup] Disconnecting Socket.IO immediately...')
      try {
        socket.current.disconnect()
      } catch (e) {
        console.error('[Cleanup Error] Error disconnecting socket:', e)
      }
      socket.current = null
    }
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current)
      animationFrameIdRef.current = null
    }
    if (detectorRef.current) {
      try {
        detectorRef.current.close()
      } catch (e) {
        console.error('[Attendance Error] Error closing detector:', e)
      }
      detectorRef.current = null
    }
    if (cameraStreamRef.current) {
      try {
        cameraStreamRef.current.getTracks().forEach(track => track.stop())
      } catch (e) {
        console.error('[Attendance Error] Error stopping camera tracks:', e)
      }
      cameraStreamRef.current = null
    }
    if (attendanceCameraStreamRef.current) {
      try {
        attendanceCameraStreamRef.current.getTracks().forEach(track => track.stop())
      } catch (e) {
        console.error('[Attendance Error] Error stopping attendance camera tracks:', e)
      }
      attendanceCameraStreamRef.current = null
    }
  }

  const handleMuteParticipant = (pName) => {
    console.log(`[Participant Controls]\nuserId: ${user?.id}\nhostId: ${meetingData?.host_id || meetingData?.hostId}\nisHost: ${isHost}`)
    if (!isHost) {
      showToast('Only the meeting host can mute participants.', 'error')
      return
    }
    showToast(`Mute request sent for ${pName}.`, 'info')
  }

  const handleRemoveParticipant = async (pName, pUserId) => {
    console.log(`[HOST ACTION DEBUG]\naction: remove_participant\nmeetingId: ${meetingData?.meeting_id}\ncurrentUserId: ${user?.id}\nisHost: ${isHost}\ntargetParticipantId: ${pUserId}`)
    console.log(`[Participant Controls]\nuserId: ${user?.id}\nhostId: ${meetingData?.host_id || meetingData?.hostId}\nisHost: ${isHost}`)
    if (!isHost) {
      showToast('Only the meeting host can remove participants.', 'error')
      return
    }

    const confirmRemove = window.confirm(`Are you sure you want to remove ${pName} from the meeting?`)
    if (!confirmRemove) return

    try {
      console.log('[Security] Requesting backend to remove participant:', pUserId)
      const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
      const headers = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/security/remove`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ meetingCode: meetingData.meeting_code, userId: pUserId }),
        credentials: 'include'
      })
      if (res.ok) {
        showToast(`Participant ${pName} has been removed.`, 'success')
      } else {
        const data = await res.json()
        showToast(data.message || 'Failed to remove participant.', 'error')
      }
    } catch (err) {
      console.error(err)
      showToast('Error removing participant.', 'error')
    }
  }

  const handleBanDevice = async (pName, pUserId) => {
    if (!meetingData) return
    console.log(`[HOST ACTION DEBUG]\naction: ban_device\nmeetingId: ${meetingData?.meeting_id}\ncurrentUserId: ${user?.id}\nisHost: ${isHost}\ntargetParticipantId: ${pUserId}`)
    console.log(`[Participant Controls]\nuserId: ${user?.id}\nhostId: ${meetingData?.host_id || meetingData?.hostId}\nisHost: ${isHost}`)
    if (!isHost) {
      showToast('Only the meeting host can ban devices.', 'error')
      return
    }

    const confirmBan = window.confirm(
      `This participant (${pName}) will be removed immediately.\nThis browser/device will not be able to rejoin this meeting.\n\nContinue?`
    )
    if (!confirmBan) return

    try {
      console.log('[Security] Sending ban device request for userId:', pUserId)
      const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
      const headers = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/security/ban-device`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ meetingCode: meetingData.meeting_code, userId: pUserId }),
        credentials: 'include'
      })
      if (res.ok) {
        showToast(`Participant ${pName} has been banned successfully.`, 'success')
      } else {
        const data = await res.json()
        showToast(data.message || 'Failed to ban participant.', 'error')
      }
    } catch (err) {
      console.error(err)
      showToast('Error banning participant.', 'error')
    }
  }

  const handleLeaveWithAttendance = async () => {
    console.log('[Attendance Finalize Trigger] leave-button')
    if (isIntentionalLeaveRef) {
      isIntentionalLeaveRef.current = true
    }
    setIsShuttingDown(true)
    stopTranscriptCapture()
    await waitPendingTranscriptUploads()
    if (meetingData?.enable_ai_attendance) {
      try {
        await uploadAttendance()
      } catch (err) {
        console.error('[Attendance] Final upload error:', err)
      } finally {
        cleanupResources()
      }
    } else {
      cleanupResources()
    }
    setIsShuttingDown(false)
    await handleLeave()
  }
  handleLeaveWithAttendanceRef.current = handleLeaveWithAttendance

  const handleEndWithAttendance = async () => {
    if (!meetingData) return
    if (!isHostRef.current) {
      console.error('[Security Guard] Non-host attempted to call handleEndWithAttendance. Bypassing host end.')
      return handleLeaveWithAttendance()
    }
    const confirmEnd = window.confirm('Are you sure you want to end this meeting for all participants?')
    if (!confirmEnd) return

    console.log('[Attendance Finalize Trigger] host-ended-meeting')
    if (isIntentionalLeaveRef) {
      isIntentionalLeaveRef.current = true
    }
    setIsShuttingDown(true)
    stopTranscriptCapture()
    await waitPendingTranscriptUploads()
    if (meetingData?.enable_ai_attendance) {
      try {
        await uploadAttendance()
      } catch (err) {
        console.error('[Attendance] Final upload error:', err)
      } finally {
        cleanupResources()
      }
    } else {
      cleanupResources()
    }
    setIsShuttingDown(false)

    try {
      console.log('[Frontend] Calling endMeeting API...')
      await endMeeting(meetingData.meeting_id)
      // The server already emits meeting_ended to all room members via the REST handler.
      // Also emit from host socket as a secondary safety net.
      if (socket?.current && meetingData.room_name) {
        socket.current.emit('end_meeting', meetingData.room_name)
      }
      showToast('Meeting ended successfully.', 'success')
      navigate('/')
    } catch (err) {
      showToast(err.message || 'Failed to end meeting', 'error')
    }
  }

  // 1. MediaPipe Detector Initialization Effect (runs once)
  useEffect(() => {
    if (!meetingData || !meetingData.enable_ai_attendance || isHost || attendanceConsent !== 'Granted') {
      return
    }

    if (detectorRef.current || isInitializingRef.current) {
      return // Prevent duplicate initialization
    }

    isInitializingRef.current = true
    console.log('[Attendance] Starting AI Attendance')

    const loadDetector = async () => {
      try {
        console.log('[Attendance] Loading MediaPipe')
        const { FilesetResolver, FaceDetector } = await import('@mediapipe/tasks-vision')
        
        console.log('[Attendance] Loading WASM')
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/wasm'
        )

        console.log('[Attendance] Loading Face Detector model')
        const modelUrl = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
        
        console.log(`[Attendance] Verifying model access: ${modelUrl}`)
        try {
          const checkRes = await fetch(modelUrl, { method: 'HEAD' })
          if (!checkRes.ok) {
            throw new Error(`Model request returned HTTP ${checkRes.status} for URL: ${modelUrl}`)
          }
          console.log('[Attendance] Model URL accessibility verified (HTTP 200)')
        } catch (fetchErr) {
          console.error(`[Attendance Error] Pre-fetch verification check failed for URL ${modelUrl}:`, fetchErr)
        }

        console.log('[Attendance] Creating detector')
        const detector = await FaceDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: modelUrl,
            delegate: 'GPU'
          },
          runningMode: 'VIDEO'
        })

        detectorRef.current = detector
        isInitializingRef.current = false
        console.log('[Attendance] Model loaded successfully')
        console.log('[Attendance] Initialization completed')
      } catch (err) {
        isInitializingRef.current = false
        console.error('[Attendance Error] MediaPipe FaceDetector initialization failed:', err)
        console.error('[Attendance Error] Error details:', {
          message: err.message,
          stack: err.stack,
          errorObject: err
        })
        showToast('AI Attendance system initialization failed: ' + (err.message || err), 'error')
      }
    }

    loadDetector()

    return () => {
      console.log('[Attendance] Cleaning up detector on unmount')
      if (detectorRef.current) {
        try {
          detectorRef.current.close()
        } catch (e) {
          console.error('[Attendance Error] Failed to close detector:', e)
        }
        detectorRef.current = null
      }
    }
  }, [meetingData, attendanceConsent, showToast, isHost])

  // 2. Local Camera Tracking Loop Effect
  useEffect(() => {
    if (!meetingData || !meetingData.enable_ai_attendance || isHost || attendanceConsent !== 'Granted') {
      return
    }

    // Wait until detector is loaded
    if (!detectorRef.current) {
      console.log('[Attendance] Waiting for detector to be loaded...')
      return
    }

    console.log('[Attendance] Initializing separate local camera stream for AI Attendance...')

    // Create a hidden video element to attach the track
    const video = document.createElement('video')
    video.autoplay = true
    video.playsInline = true
    video.muted = true
    video.style.position = 'fixed'
    video.style.top = '0'
    video.style.left = '0'
    video.style.width = '1px'
    video.style.height = '1px'
    video.style.opacity = '0.001'
    video.style.pointerEvents = 'none'
    video.style.zIndex = '-9999'
    document.body.appendChild(video)
    videoRef.current = video

    let activeStream = null
    let clockInterval = null
    let rafId = null

    const startCamera = async () => {
      try {
        setAttendanceCamError(false)
        console.log('[Attendance] Requesting getUserMedia for local camera stream...')
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: 'user'
          },
          audio: false
        })
        activeStream = stream
        attendanceCameraStreamRef.current = stream
        console.log('[Attendance] Separate local camera stream obtained successfully.')

        // Attach stream to hidden video element
        video.srcObject = stream
        videoRef.current = video
        console.log('[Attendance] Separate camera stream attached to hidden video element.')

        // Start requestAnimationFrame loop
        console.log('[Attendance] Starting detection loop')
        let lastTime = 0
        const runDetection = (timestamp) => {
          if (!detectorRef.current || !videoRef.current) return

          if (timestamp - lastTime >= 400) {
            lastTime = timestamp
            try {
              if (video.readyState >= 2) { // HAVE_CURRENT_DATA
                const results = detectorRef.current.detectForVideo(video, timestamp)
                const faceDetected = results && results.detections && results.detections.length > 0
                
                if (faceDetected) {
                  console.log('[Attendance] Face detected')
                  consecutiveDetections.current++
                  if (consecutiveDetections.current >= 3) {
                    if (!isPresent.current) {
                      isPresent.current = true
                    }
                    if (tempAbsenceSeconds.current > 0) {
                      console.log('[Attendance] Temporary absence cleared')
                      tempAbsenceSeconds.current = 0
                    }
                  }
                } else {
                  console.log('[Attendance] Face missing')
                  consecutiveDetections.current = 0
                }
              }
            } catch (err) {
              console.error('[Attendance Error] Face detection frame processing failed:', err)
            }
          }
          rafId = requestAnimationFrame(runDetection)
          animationFrameIdRef.current = rafId
        }

        rafId = requestAnimationFrame(runDetection)
        animationFrameIdRef.current = rafId

        // Clock timer (runs every 1 second)
        clockInterval = setInterval(() => {
          totalSeconds.current++

          if (isPresent.current) {
            if (consecutiveDetections.current === 0) {
              tempAbsenceSeconds.current++
              if (tempAbsenceSeconds.current === 1) {
                console.log('[Attendance] Temporary absence started')
                tempAbsenceIncidents.current++
              }

              if (tempAbsenceSeconds.current >= 20) {
                if (isPresent.current) {
                  console.log('[Attendance] Face missing for 20s. Marking Absent.')
                  isPresent.current = false
                }
              } else {
                presenceSeconds.current++
              }
            } else {
              presenceSeconds.current++
              tempAbsenceSeconds.current = 0
            }
          } else {
            tempAbsenceSeconds.current++

            if (consecutiveDetections.current >= 3) {
              console.log('[Attendance] Face returned. Restoring presence state.')
              isPresent.current = true
              tempAbsenceSeconds.current = 0
              presenceSeconds.current++
            }
          }

          const elapsedSessionSeconds = sessionStartTimeRef.current 
            ? Math.floor((Date.now() - sessionStartTimeRef.current) / 1000)
            : 0
          console.log(`[Attendance Debug] Face detected: ${isPresent.current} | Session duration: ${elapsedSessionSeconds} | Presence seconds: ${presenceSeconds.current}`)
        }, 1000)

      } catch (err) {
        console.error('[Attendance Error] Failed to obtain separate local camera stream:', err)
        setAttendanceCamError(true)
        showToast('AI Attendance: Camera access failed or hardware busy.', 'warning')
      }
    }

    startCamera()

    return () => {
      console.log('[Attendance] Cleaning up tracking loop and separate camera track')
      if (clockInterval) clearInterval(clockInterval)
      if (rafId) cancelAnimationFrame(rafId)
      if (activeStream) {
        try {
          activeStream.getTracks().forEach(track => track.stop())
        } catch (e) {
          console.error('[Attendance Error] Failed to stop stream tracks:', e)
        }
      }
      attendanceCameraStreamRef.current = null
      if (video && video.parentNode) {
        video.parentNode.removeChild(video)
      }
      videoRef.current = null
    }
  }, [meetingData, attendanceConsent, isHost])

  // beforeunload listener for browser closing / refresh events
  useEffect(() => {
    const handleBeforeUnloadAttendance = () => {
      const currentMeetingData = meetingDataRef.current
      const currentIsHost = isHostRef.current
      const currentConsent = attendanceConsentRef.current

      if (currentMeetingData?.enable_ai_attendance && !currentIsHost && !hasUploaded.current) {
        const duration = sessionStartTimeRef.current 
          ? Math.max(0, Math.floor((Date.now() - sessionStartTimeRef.current) / 1000))
          : 0

        if (duration <= 0) {
          console.log('[Attendance] Bypassing beforeunload upload: Session duration is 0 seconds.')
          return
        }

        hasUploaded.current = true

        const percentage = duration > 0 ? (presenceSeconds.current / duration) * 100 : 0
        const status = percentage >= 75 ? 'Present' : 'Absent'
        const camPermission = currentConsent === 'Granted'

        const payload = {
          meetingId: currentMeetingData.meeting_id,
          presenceSeconds: presenceSeconds.current,
          meetingDurationSeconds: duration,
          attendancePercentage: Number(percentage.toFixed(2)),
          status,
          cameraPermission: camPermission
        }

        console.log('[Attendance Finalize Trigger] beforeunload')
        console.log('[Attendance Finalize]', {
          meetingId: currentMeetingData.meeting_id,
          userId: userRef.current?.id || 'unknown',
          isHost: currentIsHost,
          sessionStart: sessionStartTimeRef.current ? new Date(sessionStartTimeRef.current).toISOString() : null,
          sessionDurationSeconds: duration,
          presenceSeconds: presenceSeconds.current,
          cameraPermission: camPermission
        })
        console.log('[Attendance Upload Payload]', payload)

        const apiUrl = `${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/attendance`
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
        navigator.sendBeacon(apiUrl, blob)
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnloadAttendance)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnloadAttendance)
    }
  }, [])

  // Dedicated mount/unmount effect for AI Attendance finalization fallback
  useEffect(() => {
    return () => {
      // On unmount, stop transcript capture immediately
      stopTranscriptCapture()
      const currentMeetingData = meetingDataRef.current
      const currentIsHost = isHostRef.current
      const currentConsent = attendanceConsentRef.current

      if (currentMeetingData?.enable_ai_attendance && !currentIsHost && !hasUploaded.current) {
        const duration = sessionStartTimeRef.current 
          ? Math.max(0, Math.floor((Date.now() - sessionStartTimeRef.current) / 1000))
          : 0

        if (duration <= 0) {
          console.log('[Attendance] Bypassing unmount upload: Session duration is 0 seconds.')
          return
        }

        hasUploaded.current = true
        
        const percentage = duration > 0 ? (presenceSeconds.current / duration) * 100 : 0
        const status = percentage >= 75 ? 'Present' : 'Absent'
        const camPermission = currentConsent === 'Granted'

        const payload = {
          meetingId: currentMeetingData.meeting_id,
          presenceSeconds: presenceSeconds.current,
          meetingDurationSeconds: duration,
          attendancePercentage: Number(percentage.toFixed(2)),
          status,
          cameraPermission: camPermission
        }

        console.log('[Attendance Finalize Trigger] component-unmount')
        console.log('[Attendance Finalize]', {
          meetingId: currentMeetingData.meeting_id,
          userId: userRef.current?.id || 'unknown',
          isHost: currentIsHost,
          sessionStart: sessionStartTimeRef.current ? new Date(sessionStartTimeRef.current).toISOString() : null,
          sessionDurationSeconds: duration,
          presenceSeconds: presenceSeconds.current,
          cameraPermission: camPermission
        })
        console.log('[Attendance Upload Payload]', payload)

        const apiUrl = `${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/attendance`
        if (navigator.sendBeacon) {
          const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
          navigator.sendBeacon(apiUrl, blob)
        } else {
          const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
          const headers = { 'Content-Type': 'application/json' }
          if (token) headers['Authorization'] = `Bearer ${token}`

          fetch(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            keepalive: true,
            credentials: 'include'
          }).catch(err => {
            console.error('[Attendance] Unmount background upload failed:', err)
          })
        }
      }
    }
  }, [])

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
    isTranscriptActiveRef.current = true

    const startRecording = async () => {
      try {
        console.log('[AI Analyzer] Requesting microphone access stream...')
        // Request dedicated mic stream specifically for recording to prevent interfering with LiveKit
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (!isTranscriptActiveRef.current) {
          stream.getTracks().forEach(track => track.stop())
          return
        }
        transcriptStreamRef.current = stream
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
        const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
        transcriptMediaRecorderRef.current = mediaRecorder
        let chunks = []

        mediaRecorder.ondataavailable = (e) => {
          if (!isTranscriptActiveRef.current) return
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

          // Issue 2: Validate audio chunk size (filter out small invalid header-only audio files)
          if (!audioBlob || audioBlob.size < 1000) {
            console.log(`[AI Analyzer] Audio chunk too small or invalid (${audioBlob?.size || 0} bytes). Discarding chunk.`)
            return
          }

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

          // Prevents new requests if transcript has deactivated
          if (!isTranscriptActiveRef.current) {
            console.log('[AI Analyzer] Transcript is deactivated. Skipping chunk upload.')
            return
          }

          // Send to backend via multipart/form-data
          const formData = new FormData()
          formData.append('file', audioBlob, 'audio.webm')
          formData.append('meetingId', meetingData.meeting_id)
          formData.append('speakerName', user?.full_name || user?.name || 'Anonymous')

          try {
            console.log('[AI Analyzer] Uploading transcript chunk...')
            activeTranscriptUploadsRef.current++
            console.log(`[Transcript Queue] Active uploads: ${activeTranscriptUploadsRef.current}`)
            const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
            const headers = {}
            if (token) headers['Authorization'] = `Bearer ${token}`

            const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000'
            const res = await fetch(`${apiUrl}/api/meetings/transcript`, {
              method: 'POST',
              headers,
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
          } finally {
            activeTranscriptUploadsRef.current = Math.max(0, activeTranscriptUploadsRef.current - 1)
            console.log('[Transcript Queue] Upload completed.')
            console.log(`[Transcript Queue] Active uploads: ${activeTranscriptUploadsRef.current}`)
          }
        }

        // Start recording
        mediaRecorder.start()
        console.log('[AI Analyzer] MediaRecorder started')

        // Trigger recording slice every 30 seconds
        const intervalId = setInterval(() => {
          if (isTranscriptActiveRef.current && mediaRecorder && mediaRecorder.state === 'recording') {
            console.log('[AI Analyzer] Slicing recorder chunk (30s interval)...')
            mediaRecorder.stop()
            mediaRecorder.start()
          }
        }, 30000) // 30 seconds chunks
        transcriptIntervalRef.current = intervalId

      } catch (err) {
        console.error('[AI Analyzer Error] Failed to initialize mic recording:', err)
        showToast('AI Analyzer failed to start recording: ' + (err.message || err), 'error')
      }
    }

    startRecording()

    return () => {
      stopTranscriptCapture()
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
      {(isShuttingDown || meetingData?.meeting_status === 'Ended') && (
        <div className="absolute inset-0 z-50 bg-[#04050b]/90 backdrop-blur-md flex flex-col items-center justify-center gap-4 text-center">
          {meetingData?.meeting_status === 'Ended' ? (
            <>
              <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-500 text-2xl font-bold">!</div>
              <div className="text-white text-lg font-semibold">This meeting has ended.</div>
              <p className="text-gray-400 text-sm max-w-sm">
                You cannot join, send chat messages, ask AI, or access controls for this meeting because it has already finished.
              </p>
              <Button onClick={handleLeave} className="mt-4 px-6 py-2">
                Back to Dashboard
              </Button>
            </>
          ) : (
            <>
              <div className="w-12 h-12 border-4 border-brand-purple border-t-transparent rounded-full animate-spin" />
              <div className="text-white text-base font-semibold">Finalizing Meeting Details</div>
              <div className="text-gray-400 text-sm max-w-md">
                Please wait while the final transcript uploads and calculations complete. Do not close this window.
              </div>
            </>
          )}
        </div>
      )}
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
              {isHost && (
                <button
                  onClick={() => setActiveTab('security')}
                  className={`flex-1 py-3 text-xs font-semibold border-b-2 transition-all duration-200 cursor-pointer ${
                    activeTab === 'security'
                      ? 'border-brand-purple text-white'
                      : 'border-transparent text-gray-500 hover:text-gray-300'
                  }`}
                >
                  Security {waitingRequests.length > 0 && `(${waitingRequests.length})`}
                </button>
              )}
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
                    let pUserId = p.identity
                    try {
                      const meta = JSON.parse(p?.metadata || '{}')
                      role = meta.role || 'participant'
                      pUserId = meta.userId || p.identity
                    } catch (e) {}

                    return (
                      <div key={p.sid || p.identity} className="flex items-center gap-3 p-2 bg-white/2 border border-white/5 rounded-xl justify-between">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-xs font-bold text-gray-300 shrink-0">
                            {p.name?.charAt(0).toUpperCase() || 'P'}
                          </div>
                          <div className="flex flex-col text-left min-w-0">
                            <span className="text-xs font-semibold text-white truncate">
                              {p.name} {p.identity === localParticipant?.identity && ' (You)'}
                            </span>
                            <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mt-0.5">{role}</span>
                          </div>
                        </div>

                        {isHost && role !== 'host' && p.identity !== localParticipant?.identity && (
                          <div className="flex items-center gap-1 shrink-0 select-none">
                            <button
                              onClick={() => handleMuteParticipant(p.name)}
                              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-gray-400 hover:text-white rounded-lg transition-all cursor-pointer"
                              title="Mute Participant"
                            >
                              🎤
                            </button>
                            <button
                              onClick={() => handleRemoveParticipant(p.name, pUserId)}
                              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-amber-500 hover:text-amber-400 rounded-lg transition-all cursor-pointer"
                              title="Remove Participant"
                            >
                              👢
                            </button>
                            <button
                              onClick={() => handleBanDevice(p.name, pUserId)}
                              className="p-1.5 bg-red-950/40 hover:bg-red-900/40 border border-red-500/10 text-red-500 hover:text-red-400 rounded-lg transition-all cursor-pointer"
                              title="Ban Device"
                            >
                              🚫
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* TAB: SECURITY */}
              {activeTab === 'security' && isHost && (
                <div className="flex flex-col gap-4 h-full justify-start text-left">
                  <div className="flex items-center justify-between p-3 bg-white/2 border border-white/5 rounded-xl">
                    <span className="text-xs font-semibold text-white">Auto Admit Participants</span>
                    <input
                      type="checkbox"
                      checked={meetingData?.auto_admit !== false}
                      onChange={async (e) => {
                        const checked = e.target.checked
                        try {
                          const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
                          const headers = { 'Content-Type': 'application/json' }
                          if (token) headers['Authorization'] = `Bearer ${token}`

                          const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/security/toggle-auto-admit`, {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({ meetingId: meetingData.meeting_id, autoAdmit: checked }),
                            credentials: 'include'
                          })
                          if (res.ok) {
                            setMeetingData(prev => prev ? { ...prev, auto_admit: checked } : null)
                            showToast(`Auto Admit toggled ${checked ? 'ON' : 'OFF'}`, 'success')
                          } else {
                            showToast('Failed to toggle Auto Admit', 'error')
                          }
                        } catch (err) {
                          console.error(err)
                          showToast('Error toggling Auto Admit', 'error')
                        }
                      }}
                      className="accent-brand-purple cursor-pointer h-4 w-4"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <h3 className="text-xs font-bold text-gray-400 select-none">
                      Waiting Participants ({waitingRequests.length})
                    </h3>
                    <div className="flex flex-col gap-2 overflow-y-auto max-h-[300px]">
                      {waitingRequests.length === 0 ? (
                        <p className="text-[11px] text-gray-500 italic py-2">No pending join requests.</p>
                      ) : (
                        waitingRequests.map((req) => (
                          <div key={req.id} className="flex flex-col gap-2 p-3 bg-slate-900/40 border border-white/5 rounded-xl">
                            <div className="flex flex-col">
                              <span className="text-xs font-semibold text-white">{req.fullName}</span>
                              <span className="text-[10px] text-gray-500">{req.email}</span>
                            </div>
                            <div className="flex gap-2 justify-end">
                              <button
                                onClick={async () => {
                                  try {
                                    const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
                                    const headers = { 'Content-Type': 'application/json' }
                                    if (token) headers['Authorization'] = `Bearer ${token}`

                                    const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/security/accept`, {
                                      method: 'POST',
                                      headers,
                                      body: JSON.stringify({ meetingCode: meetingData.meeting_code, userId: req.userId }),
                                      credentials: 'include'
                                    })
                                    if (res.ok) {
                                      showToast('User accepted.', 'success')
                                      fetchWaitingRequests()
                                    } else {
                                      showToast('Failed to accept request', 'error')
                                    }
                                  } catch (err) {
                                    showToast('Error accepting request', 'error')
                                  }
                                }}
                                className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[10px] font-bold cursor-pointer transition-all"
                              >
                                ✔ Accept
                              </button>
                              <button
                                onClick={async () => {
                                  try {
                                    const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
                                    const headers = { 'Content-Type': 'application/json' }
                                    if (token) headers['Authorization'] = `Bearer ${token}`

                                    const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/security/reject`, {
                                      method: 'POST',
                                      headers,
                                      body: JSON.stringify({ meetingCode: meetingData.meeting_code, userId: req.userId }),
                                      credentials: 'include'
                                    })
                                    if (res.ok) {
                                      showToast('User rejected.', 'info')
                                      fetchWaitingRequests()
                                    } else {
                                      showToast('Failed to reject request', 'error')
                                    }
                                  } catch (err) {
                                    showToast('Error rejecting request', 'error')
                                  }
                                }}
                                className="px-2.5 py-1 bg-red-600 hover:bg-red-500 text-white rounded text-[10px] font-bold cursor-pointer transition-all"
                              >
                                ✗ Reject
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB: AI ASSISTANT */}
              {activeTab === 'ai' && (
                <AIChatPanel meetingId={meetingData.meeting_id} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Controls Toolbar */}
      <footer className="h-16 border-t border-white/5 bg-[#080913] px-6 flex items-center justify-between shrink-0 select-none">
        {/* Toggle Right Drawer panel & AI Attendance Indicator */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => setRightPanelOpen(!rightPanelOpen)}
            className={`p-2.5 rounded-xl border border-white/5 text-gray-400 hover:text-white transition-all duration-200 cursor-pointer ${rightPanelOpen ? 'bg-white/5 text-white' : 'hover:bg-white/5'}`}
          >
            <MessageSquare size={16} />
          </button>

          {meetingData?.enable_ai_attendance && !isHost && attendanceConsent === 'Granted' && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900/80 border border-white/10 select-none">
              {attendanceCamError ? (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                  </span>
                  <span className="text-[10px] font-bold text-red-400">
                    AI Attendance: Camera Unavailable
                  </span>
                </>
              ) : (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500"></span>
                  </span>
                  <span className="text-[10px] font-bold text-gray-300">
                    {camActive ? (
                      <span>AI Attendance: Active</span>
                    ) : (
                      <span>Meeting Camera: Off | AI Attendance Camera: Active Locally</span>
                    )}
                  </span>
                </>
              )}
            </div>
          )}
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
            <Button variant="danger" onClick={handleEndWithAttendance} className="px-5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-red-600/25">
              <PhoneOff size={14} />
              <span>End Meeting</span>
            </Button>
          </div>
        ) : (
          <Button variant="danger" onClick={handleLeaveWithAttendance} className="px-5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-red-600/25">
            <PhoneOff size={14} />
            <span>Leave Room</span>
          </Button>
        )}
      </footer>
    </div>
  )
}
