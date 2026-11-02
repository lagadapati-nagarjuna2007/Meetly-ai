import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { io } from 'socket.io-client'

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
  Clock,
  RefreshCw,
  Search,
  Smile,
  MoreHorizontal
} from 'lucide-react'

import Modal from '../components/Modal'
import AIChatPanel from '../components/AIChatPanel'
import ScreenShareView from '../components/ScreenShareView'
import RecordingControlPopover from '../components/RecordingControlPopover'
import ParticipantVideoTile from '../components/ParticipantVideoTile'
import ExpandedParticipantStage from '../components/ExpandedParticipantStage'
import MeetingChat, { mergeAndSortMessages } from '../components/MeetingChat'
import RealtimeKitAdapter from '../components/meeting/RealtimeKitAdapter'
import {
  resolveEffectiveProvider,
  shouldMountProvider
} from '../components/meeting/providerSelectionUtils'
import { useScreenRecorder } from '../hooks/useScreenRecorder'
import {
  resolveMediaUserId,
  resolveInitialMediaState,
  applyInitialMediaState,
  toggleMicrophoneState,
  toggleCameraState,
  syncAndEnforceMediaState
} from '../utils/mediaPreferences'
import { mergeIntervals } from '../utils/durationHelper'

const EMOJI_CATEGORIES = [
  { id: 'all', label: 'All', icon: '⭐', emojis: [] },
  { id: 'frequently', label: 'Frequently Used', icon: '⭐', emojis: ['👍', '❤️', '😂', '🎉', '😮', '👏', '🚀', '🎈'] },
  { id: 'smileys', label: 'Smileys & People', icon: '😃', emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕'] },
  { id: 'gestures', label: 'Gestures & Body', icon: '👍', emojis: ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '<ctrl42>', '💪'] },
  { id: 'symbols', label: 'Hearts & Symbols', icon: '❤️', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '✨', '🌟', '💫', '💥', '💢', '💦', '💧', '💤', '🎉', '🎊'] },
  { id: 'objects', label: 'Objects & Food', icon: '💡', emojis: ['💡', '🔦', '🎈', '🎉', '🎂', '🏆', '🥇', '⚽', '🏀', '🏈', '⚾', '🎾', '🍕', '🍔', '🍟', '🌭', '🍿', '☕', '🍵', '🧃', '🥤', '🍺', '🍻', '🥂', '🍷'] }
]

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

// UUID validation helper
const isUuid = (val) => {
  if (!val || typeof val !== 'string') return false
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val.trim())
}

/**
 * Robust participant user_id resolver.
 * Priority:
 *  1. p.customParticipantId (RealtimeKit Meetly user UUID)
 *  2. p.metadata JSON (contains { userId, role })
 *  3. p.identity (if already a valid UUID)
 *  4. p.userId (if property directly exists and is a UUID)
 *  5. dbParticipants lookup by email or user_id
 */
const resolveParticipantUserId = (p, dbParticipantsList = []) => {
  if (!p) return null
  if (p.customParticipantId && isUuid(p.customParticipantId)) {
    return p.customParticipantId
  }
  if (p.metadata) {
    try {
      const meta = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata
      if (meta?.userId && isUuid(meta.userId)) {
        return meta.userId
      }
    } catch (e) {}
  }
  if (p.identity && isUuid(p.identity)) {
    return p.identity
  }
  if (p.userId && isUuid(p.userId)) {
    return p.userId
  }
  if (Array.isArray(dbParticipantsList) && dbParticipantsList.length > 0) {
    const pIdent = String(p.identity || p.name || '').trim().toLowerCase()
    const matched = dbParticipantsList.find(dbP => {
      const dbEmail = String(dbP.user?.email || '').trim().toLowerCase()
      const dbUid = String(dbP.user_id || '').trim().toLowerCase()
      return (dbEmail && pIdent && dbEmail === pIdent) || (dbUid && pIdent && dbUid === pIdent)
    })
    if (matched?.user_id && isUuid(matched.user_id)) {
      return matched.user_id
    }
  }
  return null
}

/**
 * Returns human-readable display name for a given user UUID.
 */
const getDisplayNameForUserId = (uid, participantsList = [], dbParticipantsList = []) => {
  if (!uid) return null
  const targetUid = String(uid).trim().toLowerCase()

  // First check in active room participants
  for (const p of (participantsList || [])) {
    const pUid = resolveParticipantUserId(p, dbParticipantsList)
    if (pUid && pUid.toLowerCase() === targetUid) {
      return p.name || p.identity || targetUid
    }
  }

  // Fallback to dbParticipants
  if (Array.isArray(dbParticipantsList)) {
    const dbP = dbParticipantsList.find(p => String(p.user_id).trim().toLowerCase() === targetUid)
    if (dbP?.user?.full_name) return dbP.user.full_name
    if (dbP?.user?.email) return dbP.user.email
  }

  return uid
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
    expireMeeting,
    deleteMeeting,
    renameMeeting,
    leaveMeeting,
    lockMeeting,
    activateMeeting,
    cloudflareToken,
    cloudflareMeetingId,
    cloudflareParticipantId,
    setCloudflareToken,
    setCloudflareMeetingId,
    setCloudflareParticipantId,
    activeProvider,
    setActiveProvider,
    clearCredentials,
    joinMeeting,
    isJoiningMeeting
  } = useMeetings()
  const { showToast } = useToast()
  const navigate = useNavigate()

  // Track session provider to prevent mid-call switching once established
  const sessionProviderRef = useRef(null)

  // Resolve effective media provider (Cloudflare RealtimeKit is sole provider)
  const effectiveProvider = useMemo(() => {
    return resolveEffectiveProvider({
      activeProvider,
      cloudflareToken
    })
  }, [activeProvider, cloudflareToken])

  useEffect(() => {
    if (effectiveProvider && !sessionProviderRef.current) {
      sessionProviderRef.current = effectiveProvider
    }
    if (!effectiveProvider) {
      sessionProviderRef.current = null
    }
  }, [effectiveProvider])

  const [meetingData, setMeetingData] = useState(null)
  const originalHostId = meetingData?.host_id || meetingData?.hostId
  const assignedHostId = meetingData?.assigned_host_id
  const activeHostId   = meetingData?.active_host_id
  const currentUserId  = user?.id

  const isOriginalHost = Boolean(currentUserId) && Boolean(originalHostId) &&
    String(currentUserId).trim().toLowerCase() === String(originalHostId).trim().toLowerCase()

  const isAssignedHost = Boolean(currentUserId) && Boolean(assignedHostId) &&
    String(currentUserId).trim().toLowerCase() === String(assignedHostId).trim().toLowerCase()

  const isActiveHost = Boolean(currentUserId) && Boolean(activeHostId) &&
    String(currentUserId).trim().toLowerCase() === String(activeHostId).trim().toLowerCase()

  // canManageMeeting: Original Host or Active Host can manage meeting
  const canManageMeeting = isOriginalHost || isActiveHost

  // canManageHostAssignment: Original Host only (can assign/change/remove Assigned Host)
  const canManageHostAssignment = isOriginalHost

  // Legacy alias for all existing code that references isHost — bound to canManageMeeting
  const isHost = canManageMeeting

  console.log(`[HOST UI STATE]\ncurrentUserId: ${currentUserId}\nhost_id: ${originalHostId}\nassigned_host_id: ${assignedHostId}\nactive_host_id: ${activeHostId}\nisOriginalHost: ${isOriginalHost}\nisAssignedHost: ${isAssignedHost}\nisActiveHost: ${isActiveHost}\ncanManageMeeting: ${canManageMeeting}\ncanManageHostAssignment: ${canManageHostAssignment}`)

  const isHostRef = useRef(isHost)
  useEffect(() => {
    isHostRef.current = isHost
    if (isHost) {
      setAttendanceConsent('Granted')
    }
  }, [isHost])
  const [isWaitingForApproval, setIsWaitingForApproval] = useState(false)
  const isWaitingForApprovalRef = useRef(isWaitingForApproval)
  useEffect(() => {
    isWaitingForApprovalRef.current = isWaitingForApproval
  }, [isWaitingForApproval])
  const [isLoading, setIsLoading] = useState(true)
  const [isJoinInFlight, setIsJoinInFlight] = useState(false)
  const [roomError, setRoomError] = useState(null)
  const [attendanceConsent, setAttendanceConsent] = useState(null)
  const joinAttemptedRef = useRef(false)
  const isIntentionalLeaveRef = useRef(false)
  const [dbParticipants, setDbParticipants] = useState([])

  const [chatMessages, setChatMessages] = useState([
    { name: 'System', text: 'Welcome to the meeting room. Chat messages and AI queries are enabled.' }
  ])
  const [ephemeralChatMessages, setEphemeralChatMessages] = useState([])
  const [ephemeralChatPolicy, setEphemeralChatPolicy] = useState('everyone_and_direct')
  const [activeChatConvTab, setActiveChatConvTab] = useState('everyone')
  const [selectedChatRecipient, setSelectedChatRecipient] = useState(null)
  const [socketReady, setSocketReady] = useState(0)
  const userIdRef = useRef(user?.id)
  userIdRef.current = user?.id
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

  console.log('[MeetingRoom Render] id:', id, 'isLoading:', isLoading, 'hasMeetingData:', !!meetingData, 'effectiveProvider:', effectiveProvider, 'hasCloudflareToken:', !!cloudflareToken, 'roomError:', roomError)

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
        console.log('[MEETING DATA FROM API]', {
          host_id: data.meeting?.host_id,
          assigned_host_id: data.meeting?.assigned_host_id,
          active_host_id: data.meeting?.active_host_id
        })
        setMeetingData(data.meeting)
        if (data.participants) {
          setDbParticipants(data.participants)
        }
        console.log('[MEETING DATA AFTER API STATE UPDATE]', {
          host_id: data.meeting?.host_id,
          assigned_host_id: data.meeting?.assigned_host_id,
          active_host_id: data.meeting?.active_host_id
        })
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
    const hasValidCredentials = Boolean(
      (effectiveProvider === 'cloudflare' && cloudflareToken) ||
      cloudflareToken
    )

    console.log('[MeetingRoom useEffect 2] ensureToken check. meetingData:', !!meetingData, 'hasValidCredentials:', hasValidCredentials, 'attempted:', joinAttemptedRef.current, 'attendanceConsent:', attendanceConsent)

    let timeoutId = null
    const ensureToken = async () => {
      if (isIntentionalLeaveRef.current) {
        console.log('[MeetingRoom useEffect 2] Intentional leave in progress, skipping auto-join.')
        return
      }
      if (meetingData && !hasValidCredentials && !joinAttemptedRef.current) {
        // If AI Attendance is enabled, wait until consent is resolved before joining
        if (meetingData.enable_ai_attendance && attendanceConsent === null) {
          console.log('[MeetingRoom useEffect 2] AI Attendance is enabled, waiting for user consent.')
          return
        }

        joinAttemptedRef.current = true
        setIsJoinInFlight(true)
        console.log('[MeetingRoom useEffect 2] Starting auto-join for meeting code:', meetingData.meeting_code)

        // Set a 15 second safety timeout to prevent infinite loading
        timeoutId = setTimeout(() => {
          if (!cloudflareToken) {
            console.error('[MeetingRoom useEffect 2] Connection timeout reached (15s)')
            setRoomError('Connection to meeting room timed out. Please check your credentials or network.')
            setIsLoading(false)
          }
        }, 15000)

        try {
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
          setIsJoinInFlight(false)
          if (timeoutId && !isWaitingForApproval) clearTimeout(timeoutId)
        }
      }
    }

    ensureToken()

    return () => {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [meetingData, cloudflareToken, effectiveProvider, joinMeeting, showToast, attendanceConsent, isWaitingForApproval])



  const isLeavingMeetingRef = useRef(false)

  const handleLeave = useCallback(async () => {
    if (isLeavingMeetingRef.current) {
      console.log('[MeetingRoom] handleLeave already in-flight, skipping duplicate call.')
      return
    }
    isLeavingMeetingRef.current = true
    console.log('[MeetingRoom] handleLeave triggered')
    isIntentionalLeaveRef.current = true
    if (sessionProviderRef) sessionProviderRef.current = null

    try {
      if (meetingData) {
        try {
          await leaveMeeting(meetingData.meeting_id)
        } catch (e) {
          console.error('[MeetingRoom] leaveMeeting error:', e)
        }
      }
    } finally {
      clearCredentials?.()
      showToast('You left the meeting.', 'info')
      navigate('/')
    }
  }, [meetingData, leaveMeeting, clearCredentials, navigate, showToast])

  useEffect(() => {
    handleLeaveRef.current = handleLeave
  }, [handleLeave])

  const handleEndMeeting = useCallback(async () => {
    if (!meetingData) return
    const confirmEnd = window.confirm('Are you sure you want to end this meeting for all participants?')
    if (!confirmEnd) return

    isIntentionalLeaveRef.current = true
    if (sessionProviderRef) sessionProviderRef.current = null
    try {
      await endMeeting(meetingData.meeting_id)
      showToast('Meeting ended successfully.', 'success')
      clearCredentials?.()
      navigate('/')
    } catch (err) {
      showToast(err.message || 'Failed to end meeting', 'error')
    }
  }, [meetingData, endMeeting, clearCredentials, navigate, showToast])

  const handleDeleteMeeting = useCallback(async () => {
    if (!meetingData) return
    const confirmDel = window.confirm('Are you sure you want to delete this meeting?')
    if (!confirmDel) return

    isIntentionalLeaveRef.current = true
    if (sessionProviderRef) sessionProviderRef.current = null
    try {
      await deleteMeeting(meetingData.meeting_id)
      showToast('Meeting deleted successfully.', 'success')
      clearCredentials?.()
      navigate('/')
    } catch (err) {
      showToast(err.message || 'Failed to delete meeting', 'error')
    }
  }, [meetingData, deleteMeeting, clearCredentials, navigate, showToast])

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
    const authToken = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null

    try {
      socket.current = io(socketUrl, {
        withCredentials: true,
        auth: authToken ? { token: authToken } : undefined
      })
      setSocketReady((v) => v + 1)

      // 1. Register ephemeral chat listeners BEFORE emitting join_room or chat:sync
      socket.current.on('chat:init', (data) => {
        if (data?.policy) setEphemeralChatPolicy(data.policy)
        const incoming = [
          ...(Array.isArray(data?.messages) ? data.messages : []),
          ...(Array.isArray(data?.groupMessages) ? data.groupMessages : []),
          ...(Array.isArray(data?.directMessages) ? data.directMessages : []),
          ...(Array.isArray(data?.selectedDirectMessages) ? data.selectedDirectMessages : [])
        ]
        if (incoming.length > 0) {
          setEphemeralChatMessages((prev) => mergeAndSortMessages(prev, incoming))
        }
      })

      socket.current.on('chat:message', (msg) => {
        if (!msg?.id) return
        setEphemeralChatMessages((prev) => mergeAndSortMessages(prev, [msg]))
      })

      socket.current.on('chat:policy_updated', (data) => {
        if (data?.policy) {
          setEphemeralChatPolicy(data.policy)
        }
      })

      socket.current.on('chat:cleared', () => {
        setEphemeralChatMessages([])
        setSelectedChatRecipient(null)
        setActiveChatConvTab('everyone')
      })

      const syncRoomAndChat = () => {
        if (!socket.current) return
        setSocketReady((v) => v + 1)
        const currentToken = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
        const latestUserId = userIdRef.current
        socket.current.emit('join_room', {
          roomName: meetingData.room_name,
          userId: latestUserId,
          token: currentToken
        })
        if (latestUserId) {
          socket.current.emit(
            'chat:sync',
            { roomName: meetingData.room_name, userId: latestUserId, token: currentToken },
            (res) => {
              if (res?.ended) {
                setEphemeralChatMessages([])
                setSelectedChatRecipient(null)
                setActiveChatConvTab('everyone')
                return
              }
              if (res?.success) {
                if (res.policy) setEphemeralChatPolicy(res.policy)
                const incoming = [
                  ...(Array.isArray(res.messages) ? res.messages : []),
                  ...(Array.isArray(res.groupMessages) ? res.groupMessages : []),
                  ...(Array.isArray(res.directMessages) ? res.directMessages : []),
                  ...(Array.isArray(res.selectedDirectMessages) ? res.selectedDirectMessages : [])
                ]
                setEphemeralChatMessages((prev) => mergeAndSortMessages(prev, incoming))
              } else if (res?.error) {
                console.warn('[MeetingRoomInner] Chat sync warning:', res.error)
              }
            }
          )
        }
      }

      // 2. Register room immediately and on every socket reconnect
      syncRoomAndChat()
      socket.current.on('connect', syncRoomAndChat)

      // WebSocket listeners
      socket.current.on('receive_message', (msg) => {
        setChatMessages((prev) => [...prev, msg])
      })

      socket.current.on('participant_accepted', (payload) => {
        const {
          userId,
          cloudflareToken: incomingCfToken,
          cloudflareMeetingId: incomingCfMeetingId,
          cloudflareParticipantId: incomingCfPartId
        } = payload || {}

        const currentUserId = user?.id || userIdRef.current
        console.log('[Security Socket] participant_accepted received for user:', userId, 'current user:', currentUserId)

        // 1. Validate the authenticated user ID
        if (
          !currentUserId ||
          !userId ||
          String(userId).trim().toLowerCase() !== String(currentUserId).trim().toLowerCase()
        ) {
          return
        }

        // 2. Ignore duplicate admission events (e.g. if already admitted and out of waiting room)
        if (!isWaitingForApprovalRef.current) {
          console.log('[Security Socket] Ignoring duplicate participant_accepted event (already admitted).')
          return
        }

        // 3. Determine provider credentials and validate
        const hasCf = Boolean(typeof incomingCfToken === 'string' && incomingCfToken.trim())

        if (hasCf) {
          // Cloudflare RealtimeKit credentials received
          setCloudflareToken(incomingCfToken.trim())
          if (incomingCfMeetingId) setCloudflareMeetingId(incomingCfMeetingId)
          if (incomingCfPartId && setCloudflareParticipantId) setCloudflareParticipantId(incomingCfPartId)
          if (setActiveProvider) setActiveProvider('cloudflare')

          showToast('Admitted to meeting by host!', 'success')
          // Set isWaitingForApproval to false only after valid Cloudflare credentials are received
          setIsWaitingForApproval(false)
        } else {
          console.warn('[Security Socket] participant_accepted event received without usable Cloudflare credentials')
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
          if (sessionProviderRef) sessionProviderRef.current = null
          clearCredentials?.()
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
          if (sessionProviderRef) sessionProviderRef.current = null
          clearCredentials?.()
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

      socket.current.on('meeting_ended', async (data) => {
        setEphemeralChatMessages([])
        setSelectedChatRecipient(null)
        setActiveChatConvTab('everyone')
        const endMsg = data?.message || (data?.reason === 'duration_expired' ? 'The meeting duration has ended.' : 'The host has ended this meeting.')
        showToast(endMsg, 'info')
        console.log('[Frontend] Meeting ended. Reason:', data?.reason, 'Redirecting user to dashboard.')
        setMeetingData((prev) => (prev ? { ...prev, meeting_status: 'Ended' } : null))
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
      // ── Host Management socket events ────────────────────────────────────────
      // Server is the authoritative source — frontend only syncs state from these events.

      socket.current.on('host_assigned', ({ assignedHostId, assignedHostName, activeHostId, originalHostId }) => {
        console.log(`[HOST UI STATE] immediately before host_assigned\nhost_id: ${originalHostId}\nassignedHostId: ${assignedHostId}\nactiveHostId: ${activeHostId}`)
        setMeetingData((prev) => {
          const next = prev ? {
            ...prev,
            host_id: prev.host_id || originalHostId,
            assigned_host_id: assignedHostId,
            // Immediately reflect the active host transfer — assigning B makes B the Active Host
            active_host_id: activeHostId || prev.active_host_id
          } : null
          console.log(`[HOST UI STATE] immediately after host_assigned meetingData update\nhost_id: ${next?.host_id}\nassigned_host_id: ${next?.assigned_host_id}\nactive_host_id: ${next?.active_host_id}`)
          return next
        })
        showToast(`${assignedHostName || 'A participant'} is now the Active Host.`, 'info')
      })

      socket.current.on('host_removed', ({ activeHostId, originalHostId }) => {
        console.log(`[HOST UI STATE] immediately before host_removed\nhost_id: ${originalHostId}\nactiveHostId: ${activeHostId}`)
        setMeetingData((prev) => {
          const next = prev ? {
            ...prev,
            host_id: prev.host_id || originalHostId,
            assigned_host_id: null,
            // Restore active_host_id if the server reverted it (e.g., Original Host regains control)
            active_host_id: activeHostId || prev.active_host_id
          } : null
          console.log(`[HOST UI STATE] immediately after host_removed meetingData update\nhost_id: ${next?.host_id}\nassigned_host_id: ${next?.assigned_host_id}\nactive_host_id: ${next?.active_host_id}`)
          return next
        })
        showToast('Assigned Host designation has been removed.', 'info')
      })

      socket.current.on('active_host_changed', ({ activeHostId, activeHostName, assignedHostId, originalHostId }) => {
        console.log(`[HOST UI STATE] immediately before active_host_changed\nhost_id: ${originalHostId}\nassignedHostId: ${assignedHostId}\nactiveHostId: ${activeHostId}`)
        if (!activeHostId) return
        setMeetingData((prev) => {
          const next = prev ? {
            ...prev,
            host_id: prev.host_id || originalHostId,
            active_host_id: activeHostId,
            assigned_host_id: assignedHostId !== undefined ? assignedHostId : prev.assigned_host_id
          } : null
          console.log(`[HOST UI STATE] immediately after active_host_changed meetingData update\nhost_id: ${next?.host_id}\nassigned_host_id: ${next?.assigned_host_id}\nactive_host_id: ${next?.active_host_id}`)
          return next
        })
        showToast(`${activeHostName || 'A participant'} is now the Active Host.`, 'info')
      })

      socket.current.on('original_host_reconnected', ({ activeHostId, activeHostName, assignedHostId, originalHostId }) => {
        console.log(`[HOST UI STATE] immediately before original_host_reconnected\nhost_id: ${originalHostId}\nassignedHostId: ${assignedHostId}\nactiveHostId: ${activeHostId}`)
        if (!activeHostId) return
        setMeetingData((prev) => {
          const next = prev ? {
            ...prev,
            host_id: prev.host_id || originalHostId,
            active_host_id: activeHostId,
            assigned_host_id: assignedHostId !== undefined ? assignedHostId : prev.assigned_host_id
          } : null
          console.log(`[HOST UI STATE] immediately after original_host_reconnected meetingData update\nhost_id: ${next?.host_id}\nassigned_host_id: ${next?.assigned_host_id}\nactive_host_id: ${next?.active_host_id}`)
          return next
        })
        // Show different message depending on whether Original Host regained control or B continues
        const activeIsOriginalHost = originalHostId && activeHostId &&
          String(activeHostId).toLowerCase() === String(originalHostId).toLowerCase()
        if (activeIsOriginalHost) {
          showToast(`${activeHostName || 'The original host'} has rejoined and regained host control.`, 'info')
        } else {
          showToast('The original host has rejoined the meeting.', 'info')
        }
      })
      // ── Meeting Duration & Extension Socket Events ───────────────────────────
      socket.current.on('meeting_extended', ({ scheduledEndTime, extensionMinutes, extensionUsed, extensionCount }) => {
        console.log('[Socket] meeting_extended received:', scheduledEndTime, extensionMinutes)
        setMeetingData((prev) => (prev ? {
          ...prev,
          scheduled_end_time: scheduledEndTime,
          extension_used: extensionUsed !== undefined ? extensionUsed : true,
          extension_count: extensionCount !== undefined ? extensionCount : 1
        } : null))
        setIsWarningModalOpen(false)
        setIsExtensionModalOpen(false)
        showToast(`Meeting time extended by ${extensionMinutes} minutes.`, 'success')
      })

      socket.current.on('meeting_activated', ({ scheduledEndTime, extensionUsed, extensionCount }) => {
        console.log('[Socket] meeting_activated received:', scheduledEndTime)
        if (scheduledEndTime) {
          setMeetingData((prev) => (prev ? {
            ...prev,
            scheduled_end_time: scheduledEndTime,
            meeting_status: 'Active',
            extension_used: extensionUsed !== undefined ? extensionUsed : prev.extension_used,
            extension_count: extensionCount !== undefined ? extensionCount : prev.extension_count
          } : null))
        }
      })
      // ── End Host Management socket events ────────────────────────────────────

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

  // Re-sync room presence and chat history once user.id, socketReady, or cloudflareToken is ready
  useEffect(() => {
    if (!socket.current || !meetingData?.room_name || !user?.id) return
    const currentToken = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
    socket.current.emit('join_room', {
      roomName: meetingData.room_name,
      userId: user.id,
      token: currentToken
    })
    socket.current.emit(
      'chat:sync',
      { roomName: meetingData.room_name, userId: user.id, token: currentToken },
      (res) => {
        if (res?.ended) {
          setEphemeralChatMessages([])
          setSelectedChatRecipient(null)
          setActiveChatConvTab('everyone')
          return
        }
        if (res?.success) {
          if (res.policy) setEphemeralChatPolicy(res.policy)
          const incoming = [
            ...(Array.isArray(res.messages) ? res.messages : []),
            ...(Array.isArray(res.groupMessages) ? res.groupMessages : []),
            ...(Array.isArray(res.directMessages) ? res.directMessages : []),
            ...(Array.isArray(res.selectedDirectMessages) ? res.selectedDirectMessages : [])
          ]
          setEphemeralChatMessages((prev) => mergeAndSortMessages(prev, incoming))
        }
      }
    )
  }, [meetingData?.room_name, user?.id, cloudflareToken, socketReady])

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



  // Intentional leave exits immediately without rendering room
  if (isIntentionalLeaveRef.current) {
    return null
  }

  // Loading UI while meeting metadata is being fetched
  if (isLoading || !meetingData || isJoinInFlight || isJoiningMeeting) {
    return (
      <div className="fixed inset-0 z-40 bg-[#04050b] flex flex-col items-center justify-center text-xs font-semibold text-gray-500 select-none">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border border-white/10 border-t-purple-500 animate-spin" />
          <span className="uppercase tracking-widest text-[9px] font-bold text-gray-400">Connecting to Room...</span>
        </div>
      </div>
    )
  }

  const { mountCloudflare, hasUsableCredentials } = shouldMountProvider({
    effectiveProvider,
    cloudflareToken
  })

  // Recovery state if provider has no valid credentials
  if (!hasUsableCredentials) {
    if (joinAttemptedRef.current && !isJoinInFlight && !isJoiningMeeting) {
      return (
        <div className="fixed inset-0 z-40 bg-[#04050b] flex flex-col items-center justify-center p-6 text-center select-none">
          <div className="max-w-md w-full bg-slate-900/90 border border-amber-500/20 rounded-2xl p-6 flex flex-col items-center gap-4 shadow-2xl">
            <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
              <AlertTriangle size={24} />
            </div>
            <h2 className="text-base font-bold text-white">Missing Meeting Credentials</h2>
            <p className="text-xs text-gray-400 bg-black/40 border border-white/5 p-3 rounded-xl w-full text-center">
              Unable to join media room: Cloudflare RealtimeKit credentials not found. Please try rejoining.
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

    return (
      <div className="fixed inset-0 z-40 bg-[#04050b] flex flex-col items-center justify-center text-xs font-semibold text-gray-500 select-none">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border border-white/10 border-t-purple-500 animate-spin" />
          <span className="uppercase tracking-widest text-[9px] font-bold text-gray-400">Connecting to Room...</span>
        </div>
      </div>
    )
  }

  const sharedAdapterProps = {
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
    user,
    attendanceConsent,
    endMeeting,
    expireMeeting,
    socket,
    socketReady,
    chatMessages,
    setChatMessages,
    ephemeralChatMessages,
    setEphemeralChatMessages,
    ephemeralChatPolicy,
    setEphemeralChatPolicy,
    activeChatConvTab,
    setActiveChatConvTab,
    selectedChatRecipient,
    setSelectedChatRecipient,
    typingUsers,
    setTypingUsers,
    handleLeaveWithAttendanceRef,
    waitingRequests,
    fetchWaitingRequests,
    isIntentionalLeaveRef,
    dbParticipants
  }

  // ── Sole Media Provider: Cloudflare RealtimeKit ─────────────
  return (
    <RealtimeKitAdapter
      {...sharedAdapterProps}
      cloudflareToken={cloudflareToken}
      cloudflareMeetingId={cloudflareMeetingId}
    />
  )
}
