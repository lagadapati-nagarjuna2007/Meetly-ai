import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
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
import Modal from '../Modal'
import AIChatPanel from '../AIChatPanel'
import ScreenShareView from '../ScreenShareView'
import RecordingControlPopover from '../RecordingControlPopover'
import ParticipantVideoTile from '../ParticipantVideoTile'
import ExpandedParticipantStage from '../ExpandedParticipantStage'
import MeetingChat from '../MeetingChat'
import Button from '../Button'
import { useScreenRecorder } from '../../hooks/useScreenRecorder'
import { resolveMediaUserId } from '../../utils/mediaPreferences'
import { mergeIntervals } from '../../utils/durationHelper'
const TRACK_SOURCE_MICROPHONE = 'microphone'
import {
  createTranscriptUploadQueue,
  executeMeetingEndSequence
} from './meetingEndLifecycleUtils'

export const EMOJI_CATEGORIES = [
  { id: 'all', label: 'All', icon: '⭐', emojis: [] },
  { id: 'frequently', label: 'Frequently Used', icon: '⭐', emojis: ['👍', '❤️', '😂', '🎉', '😮', '👏', '🚀', '🎈'] },
  { id: 'smileys', label: 'Smileys & People', icon: '😃', emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕'] },
  { id: 'gestures', label: 'Gestures & Body', icon: '👍', emojis: ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '💪'] },
  { id: 'symbols', label: 'Hearts & Symbols', icon: '❤️', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '✨', '🌟', '💫', '💥', '💢', '💦', '💧', '💤', '🎉', '🎊'] },
  { id: 'objects', label: 'Objects & Food', icon: '💡', emojis: ['💡', '🔦', '🎈', '🎉', '🎂', '🏆', '🥇', '⚽', '🏀', '🏈', '⚾', '🎾', '🍕', '🍔', '🍟', '🌭', '🍿', '☕', '🍵', '🧃', '🥤', '🍺', '🍻', '🥂', '🍷'] }
]

export const isUuid = (val) => {
  if (!val || typeof val !== 'string') return false
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val.trim())
}

export const resolveParticipantUserId = (p, dbParticipantsList = []) => {
  if (!p) return null
  if (p.metadata) {
    try {
      const meta = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata
      if (meta?.userId && isUuid(meta.userId)) {
        return meta.userId
      }
    } catch (_) {}
  }
  if (p.identity && isUuid(p.identity)) {
    return p.identity
  }
  if (p.userId && isUuid(p.userId)) {
    return p.userId
  }
  if (Array.isArray(dbParticipantsList) && dbParticipantsList.length > 0) {
    const pIdent = String(p.identity || '').trim().toLowerCase()
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

export const getDisplayNameForUserId = (uid, participantsList = [], dbParticipantsList = []) => {
  if (!uid) return null
  const targetUid = String(uid).trim().toLowerCase()

  for (const p of (participantsList || [])) {
    const pUid = resolveParticipantUserId(p, dbParticipantsList)
    if (pUid && pUid.toLowerCase() === targetUid) {
      return p.name || p.identity || targetUid
    }
  }

  if (Array.isArray(dbParticipantsList)) {
    const dbP = dbParticipantsList.find(p => String(p.user_id).trim().toLowerCase() === targetUid)
    if (dbP?.user?.full_name) return dbP.user.full_name
    if (dbP?.user?.email) return dbP.user.email
  }

  return uid
}

export default function MeetingRoomView({
  // Provider & Room context
  room,
  localParticipant,
  participants,
  allParticipants = [],
  tracks = [],
  connectionState,
  isReconnecting = false,
  roomState,

  // Media states
  micActive = false,
  camActive = false,
  sharingActive = false,
  camInitializing = false,
  camError = null,

  // Media actions
  onToggleMic,
  onToggleCam,
  onToggleShare,

  // Shared camera refs & management
  getOrCreatePhysicalTrack,
  releasePhysicalCameraIfUnneeded,
  attendanceNeedsCameraRef,
  meetingCamActiveRef,
  physicalCameraStreamRef,

  // Meeting metadata & controls
  meetingData,
  setMeetingData,
  isHost: isHostProp,
  canManageMeeting: canManageMeetingProp,
  canManageHostAssignment: canManageHostAssignmentProp,
  isOriginalHost: isOriginalHostProp,
  isAssignedHost: isAssignedHostProp,
  isActiveHost: isActiveHostProp,
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
  dbParticipants = []
}) {
  const navigate = useNavigate()

  const [attendanceCamError, setAttendanceCamError] = useState(false)
  const [isShuttingDown, setIsShuttingDown] = useState(false)

  // ── Reaction / Raise Hand / BRB state ─────────────────────────────────────
  // Declared here (inside MeetingRoomContent) where they are used in JSX,
  // handlers, and socket listeners. socket is passed as a prop from MeetingRoomInner.
  const [activeReactionsMap, setActiveReactionsMap] = useState({})
  const [raisedHandsMap, setRaisedHandsMap] = useState({})
  const [participantStatusMap, setParticipantStatusMap] = useState({})
  const [raisedHand, setRaisedHand] = useState(false)
  const [beRightBack, setBeRightBack] = useState(false)

  // Timer state — must live here with all other useState calls to avoid hook-order violations
  const [seconds, setSeconds] = useState(0)

  // Duration & Scheduled Expiration / Extension States
  const [remainingSeconds, setRemainingSeconds] = useState(null)
  const [isWarningModalOpen, setIsWarningModalOpen] = useState(false)
  const [isExtensionModalOpen, setIsExtensionModalOpen] = useState(false)
  const [selectedExtension, setSelectedExtension] = useState(null)
  const [isSubmittingExtension, setIsSubmittingExtension] = useState(false)

  // Deduplication refs so 3-minute warning triggers exactly once per scheduled deadline
  const warningTriggeredDeadlineRef = useRef(null)
  const warningDismissedDeadlineRef = useRef(null)
  const expirationTriggeredDeadlineRef = useRef(null)

  // Strict Rule: One-Time Extension Limit (Persisted in DB / meetingData)
  const isExtensionUsed = Boolean(
    meetingData?.extension_used ||
    (meetingData?.extension_count != null && meetingData.extension_count >= 1)
  )

  // Drawer Panel Toggles
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [activeTab, setActiveTab] = useState('chat') // chat | participants | ai

  // Local Chat / AI States
  const [chatInput, setChatInput] = useState('')
  const [aiInput, setAiInput] = useState('')
  const [aiResponses, setAiResponses] = useState([
    { sender: 'bot', text: 'I am tracking the meeting. You can ask me to summarize the current discussion.' }
  ])


  const originalHostId = meetingData?.host_id || meetingData?.hostId
  const assignedHostId = meetingData?.assigned_host_id
  const activeHostId   = meetingData?.active_host_id
  const currentUserId  = user?.id

  const isOriginalHost = isOriginalHostProp !== undefined
    ? isOriginalHostProp
    : Boolean(currentUserId) && Boolean(originalHostId) &&
      String(currentUserId).trim().toLowerCase() === String(originalHostId).trim().toLowerCase()

  const isAssignedHost = isAssignedHostProp !== undefined
    ? isAssignedHostProp
    : Boolean(currentUserId) && Boolean(assignedHostId) &&
      String(currentUserId).trim().toLowerCase() === String(assignedHostId).trim().toLowerCase()

  const isActiveHost = isActiveHostProp !== undefined
    ? isActiveHostProp
    : Boolean(currentUserId) && Boolean(activeHostId) &&
      String(currentUserId).trim().toLowerCase() === String(activeHostId).trim().toLowerCase()

  const canManageMeeting = canManageMeetingProp !== undefined ? canManageMeetingProp : (isOriginalHost || isActiveHost)
  const canManageHostAssignment = canManageHostAssignmentProp !== undefined ? canManageHostAssignmentProp : isOriginalHost
  const isHost = canManageMeeting

  const handleToggleMic = onToggleMic
  const handleToggleCam = onToggleCam
  const handleToggleShare = onToggleShare

  const effectiveMediaUserId = useMemo(
    () => resolveMediaUserId(user, localParticipant, resolveParticipantUserId, dbParticipants),
    [user, localParticipant, dbParticipants]
  )

  // ── Screen Recording Engine (Independent from AI Analyzer) ─────────────────
  const {
    recordingState,
    isRecording,
    isPaused,
    isRecordingOrPaused,
    recordingDuration,
    isRoomRecording,
    includeTabAudio,
    setIncludeTabAudio,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording
  } = useScreenRecorder({
    meetingId: meetingData?.meeting_id,
    room,
    localParticipant,
    participants,
    socket,
    showToast
  })

  // Popover state for Zoom-style recording popover: 'header' | 'bottom' | null
  const [recordingPopoverAnchor, setRecordingPopoverAnchor] = useState(null)

  // ── Host Management UI state ─────────────────────────────────────────────────
  const [showHostPicker, setShowHostPicker] = useState(false)
  const [hostActionLoading, setHostActionLoading] = useState(false)

  // ─── AI Attendance State Machine (Face-Presence Intervals) ─────────────────
  //
  // States:  WAITING_FOR_FACE → PRESENT → GRACE → PAUSED
  //
  // Source of truth for presence time: TIMESTAMPS, not tick counters.
  // presenceSeconds.current is only used for fast UI display; all final
  // calculations use getFacePresenceSeconds() which derives from intervals.

  const GRACE_PERIOD_SECONDS = 3
  const detectorRef = useRef(null)
  const cameraStreamRef = useRef(null)
  const animationFrameIdRef = useRef(null)
  const hasUploaded = useRef(false)

  // State machine
  const attendanceStateRef = useRef('WAITING_FOR_FACE') // 'WAITING_FOR_FACE'|'PRESENT'|'GRACE'|'PAUSED'
  const graceStartTimeRef = useRef(null)       // Date.now() when GRACE started
  const currentIntervalStartRef = useRef(null) // Date.now() when current PRESENT interval started
  const attendanceIntervalsRef = useRef([])    // { start: ms, end: ms, seconds: n }[]
  const consecutiveDetections = useRef(0)
  const totalSeconds = useRef(0)

  // presenceSeconds is a fast display counter only — NOT the source of truth.
  // Use getFacePresenceSeconds() for any final calculations.
  const presenceSeconds = useRef(0)

  // Flag so the backend knows this is a fresh final submission, not a reconnect accumulation
  const isFirstSubmitRef = useRef(true)

  const videoRef = useRef(null)
  const attendanceCameraStreamRef = useRef(null)
  const transcriptMediaRecorderRef = useRef(null)
  const transcriptStreamRef = useRef(null)
  const transcriptIntervalRef = useRef(null)
  const isTranscriptActiveRef = useRef(false)
  const isTranscriptAbortedRef = useRef(false)
  const activeTranscriptUploadsRef = useRef(0)
  const transcriptQueueRef = useRef(null)
  if (!transcriptQueueRef.current) {
    transcriptQueueRef.current = createTranscriptUploadQueue({ defaultMaxWaitMs: 1500, pollIntervalMs: 50 })
  }

  /**
   * Compute total face-presence seconds from closed intervals + current open interval.
   * This is the SINGLE SOURCE OF TRUTH for presence duration.
   * Merges overlapping intervals to prevent double-counting.
   */
  const getFacePresenceSeconds = useCallback(() => {
    const intervals = [...attendanceIntervalsRef.current]
    const state = attendanceStateRef.current
    if ((state === 'PRESENT' || state === 'GRACE') && currentIntervalStartRef.current) {
      const now = Date.now()
      intervals.push({
        start: currentIntervalStartRef.current,
        end: now,
        seconds: Math.max(0, Math.floor((now - currentIntervalStartRef.current) / 1000))
      })
    }
    const merged = mergeIntervals(intervals)
    return merged.reduce((sum, iv) => sum + iv.seconds, 0)
  }, [])

  /**
   * Close any open interval and set state to PAUSED.
   * Must be called before every attendance upload.
   * Merges intervals to ensure reliable accumulation without overlapping spans.
   */
  const finalizeAttendanceState = useCallback((reason = 'leave') => {
    const now = Date.now()
    if (attendanceStateRef.current === 'PRESENT' || attendanceStateRef.current === 'GRACE') {
      if (currentIntervalStartRef.current) {
        const intervalDuration = Math.max(0, Math.floor((now - currentIntervalStartRef.current) / 1000))
        attendanceIntervalsRef.current.push({
          start: currentIntervalStartRef.current,
          end: now,
          seconds: intervalDuration
        })
        console.log(`[AI Attendance] Interval closed (${reason}) | duration: ${intervalDuration}s`)
        currentIntervalStartRef.current = null
      }
    }
    attendanceStateRef.current = 'PAUSED'
    graceStartTimeRef.current = null
    // Merge any overlapping intervals and sync the display counter
    attendanceIntervalsRef.current = mergeIntervals(attendanceIntervalsRef.current)
    presenceSeconds.current = attendanceIntervalsRef.current.reduce((sum, iv) => sum + iv.seconds, 0)

    // Close any open connected interval
    if (currentConnectedStartRef.current) {
      const connectedDur = Math.max(0, Math.floor((now - currentConnectedStartRef.current) / 1000))
      connectedIntervalsRef.current.push({
        start: currentConnectedStartRef.current,
        end: now,
        seconds: connectedDur
      })
      currentConnectedStartRef.current = null
    }
    connectedIntervalsRef.current = mergeIntervals(connectedIntervalsRef.current)

    console.log(`[AI Attendance] Finalized (${reason}) | total face-presence: ${presenceSeconds.current}s | intervals: ${attendanceIntervalsRef.current.length}`)
  }, [])
  const isInitializingRef = useRef(false)
  const sessionStartTimeRef = useRef(null)
  const connectedIntervalsRef = useRef([])    // { start: ms, end: ms, seconds: n }[]
  const currentConnectedStartRef = useRef(null)

  /**
   * Compute total connected session seconds from closed intervals + active open interval.
   * Excludes time spent disconnected.
   */
  const getConnectedDurationSeconds = useCallback(() => {
    const intervals = [...connectedIntervalsRef.current]
    if (currentConnectedStartRef.current) {
      const now = Date.now()
      intervals.push({
        start: currentConnectedStartRef.current,
        end: now,
        seconds: Math.max(0, Math.floor((now - currentConnectedStartRef.current) / 1000))
      })
    }
    const merged = mergeIntervals(intervals)
    return merged.reduce((sum, iv) => sum + iv.seconds, 0)
  }, [])

  const meetingDataRef = useRef(meetingData)
  const isHostRef = useRef(isHost)
  const isAnyHost = Boolean(isHost || isOriginalHost || isAssignedHost || isActiveHost)
  const isAnyHostRef = useRef(isAnyHost)
  const attendanceConsentRef = useRef(attendanceConsent)
  const userRef = useRef(user)
  const handleLeaveRef = useRef(handleLeave)

  useEffect(() => {
    meetingDataRef.current = meetingData
  }, [meetingData])

  useEffect(() => {
    isHostRef.current = isHost
    isAnyHostRef.current = isAnyHost
  }, [isHost, isAnyHost])

  // CRITICAL: sync attendanceConsentRef when the user grants/denies consent
  // Without this, the ref stays null even after the user clicks "Grant"
  useEffect(() => {
    attendanceConsentRef.current = attendanceConsent
  }, [attendanceConsent])

  useEffect(() => {
    userRef.current = user
  }, [user])

  const showToastRef = useRef(showToast)
  useEffect(() => {
    showToastRef.current = showToast
  }, [showToast])

  const getOrCreatePhysicalTrackRef = useRef(getOrCreatePhysicalTrack)
  useEffect(() => {
    getOrCreatePhysicalTrackRef.current = getOrCreatePhysicalTrack
  }, [getOrCreatePhysicalTrack])

  const releasePhysicalCameraIfUnneededRef = useRef(releasePhysicalCameraIfUnneeded)
  useEffect(() => {
    releasePhysicalCameraIfUnneededRef.current = releasePhysicalCameraIfUnneeded
  }, [releasePhysicalCameraIfUnneeded])

  // Ensure attendanceNeedsCameraRef is locked true whenever AI attendance is enabled and consent granted
  useEffect(() => {
    if (meetingData?.enable_ai_attendance && attendanceConsent === 'Granted') {
      if (attendanceNeedsCameraRef) {
        attendanceNeedsCameraRef.current = true
      }
    }
  }, [meetingData?.enable_ai_attendance, attendanceConsent, attendanceNeedsCameraRef])

  // Synchronize localParticipant name with current user profile name in LiveKit
  useEffect(() => {
    if (!localParticipant) return
    const currentName = (user?.name || user?.full_name || '').trim()
    if (currentName && localParticipant.name !== currentName) {
      console.log(`[Participant Sync] Updating localParticipant name from "${localParticipant.name}" to "${currentName}"`)
      localParticipant.setName(currentName).catch((err) => {
        console.warn('[Participant Sync] Failed to update localParticipant name via LiveKit:', err)
      })
    }
  }, [localParticipant, user?.name, user?.full_name])

  // Guards that prevent the detector and camera loop from being destroyed/recreated
  // mid-meeting whenever meetingData object identity changes (re-render).
  // Both effects run exactly once after consent is granted.
  const detectorInitializedOnceRef = useRef(false)
  const cameraLoopStartedOnceRef   = useRef(false)


  const [activePopup, setActivePopup] = useState(null) // 'react' | 'more' | null
  const [showEndConfirmModal, setShowEndConfirmModal] = useState(false)
  const [expandedParticipantId, setExpandedParticipantId] = useState(null)

  const [emojiSearchQuery, setEmojiSearchQuery] = useState('')
  const [emojiCategory, setEmojiCategory] = useState('all')

  const reactionCooldownRef = useRef(0)

  // Keyboard shortcut listener (Escape closes popups, modals & expanded view)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setActivePopup(null)
        setRecordingPopoverAnchor(null)
        setShowEndConfirmModal(false)
        setIsWarningModalOpen(false)
        setIsExtensionModalOpen(false)
        setExpandedParticipantId(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
  // \u2500\u2500 Socket listeners for reactions, raise hand, Be Right Back \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Registered here inside MeetingRoomContent, where the state setters live.
  // The socket ref is passed as a prop from MeetingRoomInner and is already
  // connected by the time meetingData?.room_name is truthy.
  useEffect(() => {
    const currentSocket = socket?.current
    if (!currentSocket) return

    const onReaction = ({ identity, reaction }) => {
      console.log('[Reaction RECEIVE]', identity, reaction)
      if (!identity || !reaction) return
      setActiveReactionsMap((prev) => ({ ...prev, [identity]: reaction }))
      setTimeout(() => {
        setActiveReactionsMap((prev) => {
          const next = { ...prev }
          delete next[identity]
          return next
        })
      }, 3500)
    }

    const onRaiseHand = ({ identity, raised }) => {
      console.log('[RaiseHand RECEIVE]', identity, raised)
      if (!identity) return
      setRaisedHandsMap((prev) => ({ ...prev, [identity]: !!raised }))
    }

    const onStatusChange = ({ identity, status }) => {
      console.log('[Status RECEIVE]', identity, status)
      if (!identity) return
      setParticipantStatusMap((prev) => ({ ...prev, [identity]: status }))
    }

    currentSocket.on('participant_reaction', onReaction)
    currentSocket.on('participant_raise_hand', onRaiseHand)
    currentSocket.on('participant_status_change', onStatusChange)

    return () => {
      currentSocket.off('participant_reaction', onReaction)
      currentSocket.off('participant_raise_hand', onRaiseHand)
      currentSocket.off('participant_status_change', onStatusChange)
    }
  // meetingData?.room_name is the proxy signal that socket is ready
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingData?.room_name])


  const handleSendReaction = (emoji) => {
    const now = Date.now()
    if (now - reactionCooldownRef.current < 400) return
    reactionCooldownRef.current = now

    const currentSocket = socket?.current
    // BUG FIX #1: use room_name (what join_room emits) NOT meeting_code
    const roomName = meetingData?.room_name
    const identity = localParticipant?.identity

    console.log('[Reaction SEND] roomName:', roomName, 'identity:', identity, 'emoji:', emoji)

    // BUG FIX #3: Show reaction locally immediately (don't wait for server echo)
    if (identity) {
      setActiveReactionsMap((prev) => ({ ...prev, [identity]: emoji }))
      setTimeout(() => {
        setActiveReactionsMap((prev) => {
          const next = { ...prev }
          delete next[identity]
          return next
        })
      }, 3500)
    }

    if (currentSocket && identity && roomName) {
      currentSocket.emit('send_reaction', {
        roomName,
        identity,
        senderName: user?.full_name || 'Participant',
        reaction: emoji
      })
    } else {
      console.warn('[Reaction SEND] Missing socket/identity/roomName. socket:', !!currentSocket, 'identity:', identity, 'roomName:', roomName)
    }
  }

  const handleToggleRaiseHand = () => {
    const newRaised = !raisedHand
    setRaisedHand(newRaised)
    // BUG FIX #1: use room_name not meeting_code
    const roomName = meetingData?.room_name
    const currentSocket = socket?.current
    const identity = localParticipant?.identity

    console.log('[RaiseHand SEND] roomName:', roomName, 'identity:', identity, 'raised:', newRaised)

    // Show locally immediately
    if (identity) {
      setRaisedHandsMap((prev) => ({ ...prev, [identity]: newRaised }))
    }

    if (currentSocket && identity && roomName) {
      currentSocket.emit('toggle_raise_hand', {
        roomName,
        identity,
        senderName: user?.full_name || 'Participant',
        raised: newRaised
      })
    } else {
      console.warn('[RaiseHand SEND] Missing socket/identity/roomName.')
    }
  }

  const handleToggleBeRightBack = () => {
    const newBRB = !beRightBack
    setBeRightBack(newBRB)
    const newStatus = newBRB ? 'be_right_back' : 'active'
    // BUG FIX #1: use room_name not meeting_code
    const roomName = meetingData?.room_name
    const currentSocket = socket?.current
    const identity = localParticipant?.identity

    console.log('[BRB SEND] roomName:', roomName, 'identity:', identity, 'status:', newStatus)

    // Show locally immediately
    if (identity) {
      setParticipantStatusMap((prev) => ({ ...prev, [identity]: newStatus }))
    }

    if (currentSocket && identity && roomName) {
      currentSocket.emit('toggle_status', {
        roomName,
        identity,
        senderName: user?.full_name || 'Participant',
        status: newStatus
      })
    } else {
      console.warn('[BRB SEND] Missing socket/identity/roomName.')
    }
  }

  useEffect(() => {
    userRef.current = user
  }, [user])

  useEffect(() => {
    handleLeaveRef.current = handleLeave
  }, [handleLeave])



  // Track when the participant successfully joins/reconnects or disconnects from room
  useEffect(() => {
    const isConnected = connectionState === 'connected' || roomState === 'connected' || roomState === 'joined'
    if (meetingData?.enable_ai_attendance) {
      if (isConnected) {
        if (!sessionStartTimeRef.current) {
          sessionStartTimeRef.current = Date.now()
          hasUploaded.current = false
          console.log('[Attendance Debug] Participant joined. Session timer started:', new Date(sessionStartTimeRef.current).toISOString())
        }
        if (!currentConnectedStartRef.current) {
          currentConnectedStartRef.current = Date.now()
          hasUploaded.current = false
          console.log('[Attendance Continuity] Connected interval opened at:', new Date(currentConnectedStartRef.current).toISOString())
        }
      } else {
        // Disconnected: close active connected interval so time spent disconnected is excluded
        if (currentConnectedStartRef.current) {
          const now = Date.now()
          const duration = Math.max(0, Math.floor((now - currentConnectedStartRef.current) / 1000))
          connectedIntervalsRef.current.push({
            start: currentConnectedStartRef.current,
            end: now,
            seconds: duration
          })
          currentConnectedStartRef.current = null
          console.log(`[Attendance Continuity] Disconnected. Interval closed: ${duration}s | Total connected intervals: ${connectedIntervalsRef.current.length}`)
        }
        // Pause face attendance during disconnect
        finalizeAttendanceState('disconnect')
      }
    }
  }, [meetingData, connectionState, roomState, finalizeAttendanceState])

  const uploadAttendance = async () => {
    // ── Diagnostic: entry ──────────────────────────────────────────────────
    const safeMeetingData = meetingDataRef.current
    const safeMeetingId   = safeMeetingData?.meeting_id  ?? null
    const safeUserId      = userRef.current?.id          ?? 'unknown'

    console.log('[Attendance Finalize]')
    console.log(`  meetingId=${safeMeetingId}`)
    console.log(`  userId=${safeUserId}`)
    console.log(`  isHost=${isHost}`)
    console.log(`  enable_ai_attendance=${safeMeetingData?.enable_ai_attendance}`)
    console.log(`  attendanceConsent=${attendanceConsentRef.current}`)
    console.log(`  hasUploaded=${hasUploaded.current}`)
    console.log(`  attendanceState=${attendanceStateRef.current}`)
    console.log(`  intervalCount=${attendanceIntervalsRef.current.length}`)

    // Exclude all host roles from attendance tracking
    const isAnyHost = Boolean(
      isHost ||
      isOriginalHost ||
      isAssignedHost ||
      isActiveHost ||
      isHostRef.current ||
      (safeUserId !== 'unknown' && safeMeetingData?.host_id === safeUserId) ||
      (safeUserId !== 'unknown' && safeMeetingData?.active_host_id === safeUserId) ||
      (safeUserId !== 'unknown' && safeMeetingData?.assigned_host_id === safeUserId)
    )

    if (isAnyHost) {
      console.log('[Attendance Finalize] SKIP — host roles are excluded from attendance tracking.')
      hasUploaded.current = true
      return true
    }

    if (!safeMeetingId) {
      console.error('[Attendance Finalize] ABORT — meetingId is null/undefined. Cannot upload.')
      return false
    }

    // Close any open interval and sync presenceSeconds
    finalizeAttendanceState('uploadAttendance')

    // Source of truth: sum of timestamp-based intervals
    const effectivePresence = getFacePresenceSeconds()
    const connectedDuration = getConnectedDurationSeconds()
    const duration = connectedDuration > 0
      ? connectedDuration
      : (sessionStartTimeRef.current
        ? Math.max(0, Math.floor((Date.now() - sessionStartTimeRef.current) / 1000))
        : 0)

    console.log('[Attendance Finalize]')
    console.log(`  presenceSeconds=${effectivePresence}`)
    console.log(`  meetingDurationSeconds=${duration}`)
    console.log(`  isFinalSubmit=${isFirstSubmitRef.current}`)

    // Prevent double-upload (guard is set before fetch, reset if all retries fail)
    if (hasUploaded.current) {
      console.log('[Attendance Finalize] SKIP — already uploaded (hasUploaded=true)')
      return true
    }
    hasUploaded.current = true

    const percentage = duration > 0
      ? Math.min(100, Math.max(0, (effectivePresence / duration) * 100))
      : 0
    const status = percentage >= 75 ? 'Present' : 'Absent'
    const camPermission = attendanceConsentRef.current === 'Granted'
    const isFinalSubmit = isFirstSubmitRef.current
    isFirstSubmitRef.current = false

    const payload = {
      meetingId: safeMeetingId,
      presenceSeconds: effectivePresence,
      meetingDurationSeconds: duration,
      attendancePercentage: Number(percentage.toFixed(2)),
      status,
      cameraPermission: camPermission,
      isFinalSubmit
    }

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

        const httpStatus = res.status
        let responseText = ''
        try { responseText = await res.text() } catch (_) {}

        console.log('[Attendance Upload]')
        console.log(`  attempt=${attempt + 1}`)
        console.log(`  HTTP status=${httpStatus}`)
        console.log(`  response=${responseText}`)

        if (res.ok) {
          console.log('[Attendance Upload] SUCCESS — record written to database')
          return true
        } else {
          console.error(`[Attendance Upload] Non-OK response on attempt ${attempt + 1}: status=${httpStatus} body=${responseText}`)
        }
      } catch (err) {
        console.error(`[Attendance Upload] Network error on attempt ${attempt + 1}:`, err)
      }
      attempt++
      if (attempt < maxRetries) {
        await delay(Math.pow(2, attempt) * 500)
      }
    }

    console.error('[Attendance Upload] ALL RETRIES FAILED — attendance record NOT saved')
    hasUploaded.current = false
    return false
  }

  const stopTranscriptCapture = ({ abortInFlight = false } = {}) => {
    if (!isTranscriptActiveRef.current && !abortInFlight) return
    isTranscriptActiveRef.current = false
    isTranscriptAbortedRef.current = abortInFlight
    console.log('[AI Analyzer] Stopping transcript capture (clean shutdown)...')

    // 1. Clear transcript intervals immediately
    if (transcriptIntervalRef.current) {
      clearInterval(transcriptIntervalRef.current)
      transcriptIntervalRef.current = null
    }

    // 2. Stop MediaRecorder immediately (fires onstop to flush pending audio if not aborted)
    if (transcriptMediaRecorderRef.current && transcriptMediaRecorderRef.current.state !== 'inactive') {
      try {
        transcriptMediaRecorderRef.current.stop()
      } catch (e) {
        console.error('[AI Analyzer] Error stopping MediaRecorder:', e)
      }
      transcriptMediaRecorderRef.current = null
    }

    // 3. Stop microphone capture
    if (transcriptStreamRef.current) {
      try {
        transcriptStreamRef.current.getTracks().forEach(track => track.stop())
      } catch (e) {
        console.error('[AI Analyzer] Error stopping mic stream tracks:', e)
      }
      transcriptStreamRef.current = null
    }

    // 4. Optionally abort all in-flight transcript uploads
    if (abortInFlight && transcriptQueueRef.current) {
      transcriptQueueRef.current.abortAll()
      activeTranscriptUploadsRef.current = 0
    }
  }

  const waitPendingTranscriptUploads = (maxWaitMs = 1500) => {
    if (!transcriptQueueRef.current) {
      return Promise.resolve({ finished: true, timedOut: false })
    }
    return transcriptQueueRef.current.waitPending(maxWaitMs).then((res) => {
      activeTranscriptUploadsRef.current = transcriptQueueRef.current.getActiveCount()
      return res
    })
  }

  const cleanupResources = () => {
    console.log('[Attendance] Cleaning up attendance resources...')
    stopTranscriptCapture({ abortInFlight: true })
    attendanceNeedsCameraRef.current = false
    meetingCamActiveRef.current = false
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
    if (physicalCameraStreamRef && physicalCameraStreamRef.current) {
      try {
        physicalCameraStreamRef.current.getTracks().forEach(track => track.stop())
      } catch (e) {
        console.error('[Camera Architecture] Error stopping physical tracks on cleanup:', e)
      }
      physicalCameraStreamRef.current = null
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

  const handleMuteParticipant = async (p) => {
    console.log(`[Participant Controls]\nuserId: ${user?.id}\nhostId: ${meetingData?.host_id || meetingData?.hostId}\nisHost: ${isHost}`)
    if (!isHost) {
      showToast('Only the meeting host can control participant microphones.', 'error')
      return
    }

    const micPub = p.getTrackPublication ? p.getTrackPublication(TRACK_SOURCE_MICROPHONE) : null
    const trackSid = micPub?.trackSid || micPub?.sid

    if (!trackSid) {
      console.warn('[Host Mic Toggle] Participant has no active microphone track SID:', p.name || p.identity)
      showToast(`${p.name || 'Participant'} has no active microphone track.`, 'warning')
      return
    }

    const isCurrentlyMuted = p.isMicrophoneEnabled === false || (micPub && micPub.isMuted === true)
    const shouldMute = !isCurrentlyMuted

    console.log(`[Host Mic Toggle]\ntargetParticipant: ${p.name || p.identity}\ntrackSid: ${trackSid}\nisCurrentlyMuted: ${isCurrentlyMuted}\nshouldMute: ${shouldMute}`)

    try {
      const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
      const headers = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/security/mute-participant`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          meetingCode: meetingData.meeting_code,
          participantIdentity: p.identity,
          trackSid: trackSid,
          mute: shouldMute
        }),
        credentials: 'include'
      })

      if (!res.ok) {
        const data = await res.json()
        showToast(data.message || 'Failed to toggle participant microphone.', 'error')
      }
    } catch (err) {
      console.error('[Host Mic Toggle Error]', err)
      showToast('Error changing participant microphone state.', 'error')
    }
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

  const isLeavingWithAttendanceRef = useRef(false)

  const handleLeaveWithAttendance = async () => {
    if (isLeavingWithAttendanceRef.current) {
      console.log('[Attendance Finalize Trigger] Leave already in-flight, skipping duplicate call.')
      return
    }
    isLeavingWithAttendanceRef.current = true
    console.log('[Attendance Finalize Trigger] handleLeaveWithAttendance called')
    console.log(`  meetingId=${meetingDataRef.current?.meeting_id}`)
    console.log(`  enable_ai_attendance=${meetingDataRef.current?.enable_ai_attendance}`)
    console.log(`  isHost=${isHost}`)
    console.log(`  attendanceConsent=${attendanceConsentRef.current}`)
    console.log(`  hasUploaded=${hasUploaded.current}`)
    console.log(`  attendanceState=${attendanceStateRef.current}`)
    console.log(`  intervalCount=${attendanceIntervalsRef.current.length}`)
    if (isIntentionalLeaveRef) {
      isIntentionalLeaveRef.current = true
    }
    setIsShuttingDown(true)
    try {
      try {
        stopTranscriptCapture({ abortInFlight: false })
      } catch (e) {
        console.warn('[Attendance] stopTranscriptCapture warning:', e)
      }
      try {
        await waitPendingTranscriptUploads(1500)
      } catch (e) {
        console.warn('[Attendance] waitPendingTranscriptUploads warning:', e)
      }
      const isAnyHost = Boolean(
        isHost ||
        isOriginalHost ||
        isAssignedHost ||
        isActiveHost ||
        isHostRef.current ||
        (userRef.current?.id && meetingDataRef.current?.host_id === userRef.current.id) ||
        (userRef.current?.id && meetingDataRef.current?.active_host_id === userRef.current.id) ||
        (userRef.current?.id && meetingDataRef.current?.assigned_host_id === userRef.current.id)
      )
      if (meetingData?.enable_ai_attendance && !isAnyHost) {
        try {
          await uploadAttendance()
        } catch (err) {
          console.error('[Attendance] Final upload error:', err)
        }
      }
    } finally {
      setIsShuttingDown(false)
      try {
        cleanupResources()
      } catch (cleanupErr) {
        console.error('[Attendance] Error during cleanupResources:', cleanupErr)
      }
      try {
        const leaveFn = handleLeaveRef.current || handleLeave
        if (typeof leaveFn === 'function') {
          await leaveFn()
        } else {
          navigate('/')
        }
      } catch (leaveErr) {
        console.error('[Attendance] Error executing handleLeave, navigating to /:', leaveErr)
        navigate('/')
      }
    }
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
    await executeMeetingEndSequence({
      isHost: isHostRef.current,
      meetingId: meetingData.meeting_id,
      roomName: meetingData.room_name,
      enableAiAttendance: Boolean(meetingData.enable_ai_attendance),
      stopTranscriptCapture: () => stopTranscriptCapture({ abortInFlight: false }),
      waitPendingTranscriptUploads: (maxWaitMs) => waitPendingTranscriptUploads(maxWaitMs),
      uploadAttendance,
      endMeeting,
      cleanupResources,
      setIsShuttingDown,
      socketRef: socket,
      navigate,
      showToast,
      isIntentionalLeaveRef
    })
  }
  // ─────────────────────────────────────────────────────────────────────────
  // 1. MediaPipe Detector Initialization Effect
  //
  // IMPORTANT: deps = [attendanceConsent] ONLY (not meetingData).
  //   • meetingData was previously in deps — any re-render that created a new
  //     meetingData object identity caused cleanup (detector.close()) then
  //     re-init, producing the "Cleaning up detector → Starting AI Attendance"
  //     cycle observed in production.
  //   • detectorInitializedOnceRef prevents this effect from running more than
  //     once per component lifetime even if attendanceConsent flickers.
  //   • Cleanup only closes the detector on TRUE component unmount (not on
  //     re-run caused by dependency changes).
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    // Read conditions from refs — never from closure — so stale values don't block init
    const md = meetingDataRef.current
    if (!md || !md.enable_ai_attendance) return
    if (attendanceConsent !== 'Granted') return

    // One-shot guard: never re-initialize after first successful init
    if (detectorInitializedOnceRef.current) return
    if (detectorRef.current || isInitializingRef.current) return

    detectorInitializedOnceRef.current = true
    isInitializingRef.current = true
    console.log('[Attendance] Starting AI Attendance')

    let destroyed = false
    const loadDetector = async () => {
      try {
        console.log('[Attendance] Loading MediaPipe')
        const { FilesetResolver, FaceDetector } = await import('@mediapipe/tasks-vision')

        console.log('[Attendance] Loading WASM')
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
        )

        console.log('[Attendance] Loading Face Detector model')
        const modelUrl = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'

        console.log(`[Attendance] Verifying model access: ${modelUrl}`)
        try {
          const checkRes = await fetch(modelUrl, { method: 'HEAD' })
          if (!checkRes.ok) throw new Error(`Model HTTP ${checkRes.status}`)
          console.log('[Attendance] Model URL accessibility verified (HTTP 200)')
        } catch (fetchErr) {
          console.warn('[Attendance] Model pre-check failed (may still work):', fetchErr.message)
        }

        console.log('[Attendance] Creating detector')
        let detector
        try {
          detector = await FaceDetector.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: modelUrl,
              delegate: 'GPU'
            },
            runningMode: 'VIDEO'
          })
          console.log('[Attendance] Detector created with GPU delegate')
        } catch (gpuErr) {
          console.warn('[Attendance] GPU delegate failed, falling back to CPU:', gpuErr?.message || gpuErr)
          detector = await FaceDetector.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: modelUrl,
              delegate: 'CPU'
            },
            runningMode: 'VIDEO'
          })
          console.log('[Attendance] Detector created with CPU delegate')
        }

        if (destroyed) {
          console.log('[Attendance] Detector created after effect cleanup; closing orphaned detector')
          try { detector.close() } catch (_) {}
          return
        }

        detectorRef.current = detector
        isInitializingRef.current = false
        console.log('[Attendance] Model loaded successfully')
        console.log('[Attendance] Initialization completed')
      } catch (err) {
        isInitializingRef.current = false
        detectorInitializedOnceRef.current = false // allow retry on error
        console.error('[Attendance Error] MediaPipe FaceDetector initialization failed:', err.message)
        showToastRef.current?.('AI Attendance initialization failed: ' + (err.message || err), 'error')
      }
    }

    loadDetector()

    // Cleanup: only destroy the detector on TRUE component unmount
    return () => {
      destroyed = true
      console.log('[Attendance] Detector cleanup on component unmount')
      if (detectorRef.current) {
        try { detectorRef.current.close() } catch (_) {}
        detectorRef.current = null
      }
      isInitializingRef.current = false
      detectorInitializedOnceRef.current = false
    }
  }, [attendanceConsent]) // ← meetingData & showToast intentionally REMOVED

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Local Camera Stream + Detection Loop Effect
  //
  // IMPORTANT: deps = [attendanceConsent] ONLY (not meetingData, not showToast).
  //   • Same reason as above: meetingData in deps caused stream teardown and
  //     restart on every re-render, killing active face detection.
  //   • cameraLoopStartedOnceRef ensures we only call getUserMedia once.
  //   • Instead of early-returning when detectorRef.current is null, we poll
  //     for up to 15 seconds so the camera stream and rAF loop start as soon
  //     as the async detector init completes — regardless of render timing.
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const md = meetingDataRef.current
    if (!md || !md.enable_ai_attendance) return
    if (attendanceConsent !== 'Granted') return
    if (cameraLoopStartedOnceRef.current) return

    cameraLoopStartedOnceRef.current = true
    console.log('[Attendance] Initializing separate local camera stream for AI Attendance...')

    // Clean up any stale leftover attendance video before creating a fresh one
    const staleVideo = document.getElementById('__meetly_attendance_video')
    if (staleVideo) {
      try { staleVideo.remove() } catch (_) {}
    }

    // Create a hidden video element for offscreen frame decoding
    const video = document.createElement('video')
    video.id = '__meetly_attendance_video'
    video.autoplay = true
    video.playsInline = true
    video.muted = true
    video.setAttribute('playsinline', 'true')
    video.setAttribute('autoplay', 'true')
    video.setAttribute('muted', 'true')
    video.style.position = 'fixed'
    video.style.top = '-9999px'
    video.style.left = '-9999px'
    video.style.width = '320px'
    video.style.height = '240px'
    video.style.opacity = '0'
    video.style.pointerEvents = 'none'
    video.style.zIndex = '-9999'
    document.body.appendChild(video)
    videoRef.current = video

    let activeStream = null
    let clockInterval = null
    let rafId = null
    let destroyed = false // flag set by cleanup to stop any async work after unmount

    const startCamera = async () => {
      try {
        setAttendanceCamError(false)
        attendanceNeedsCameraRef.current = true
        console.log('[Attendance] Acquiring physical camera via shared camera architecture...')
        const physicalTrack = await (getOrCreatePhysicalTrackRef.current ? getOrCreatePhysicalTrackRef.current() : getOrCreatePhysicalTrack())
        if (destroyed) {
          attendanceNeedsCameraRef.current = false
          if (releasePhysicalCameraIfUnneededRef.current) releasePhysicalCameraIfUnneededRef.current()
          else releasePhysicalCameraIfUnneeded()
          return
        }
        const attendanceStream = new MediaStream([physicalTrack])
        activeStream = attendanceStream
        attendanceCameraStreamRef.current = attendanceStream

        // Attach stream to hidden video element
        video.srcObject = attendanceStream
        videoRef.current = video
        try {
          await video.play()
        } catch (playErr) {
          console.warn('[Attendance] video.play() warning:', playErr)
        }
        console.log('[Attendance] Shared physical camera stream attached to hidden video element.')

        // Poll for detector ready (up to 35 s, checking every 200 ms)
        // This handles the race where getUserMedia resolves before the async
        // model download completes.
        let waitMs = 0
        while (!detectorRef.current && waitMs < 35000 && !destroyed) {
          await new Promise(r => setTimeout(r, 200))
          waitMs += 200
        }
        if (destroyed) return
        if (!detectorRef.current) {
          console.error('[Attendance Error] Detector never became ready after 35s — stopping camera')
          setAttendanceCamError(true)
          return
        }

        console.log('[Attendance Detection Loop] started=true')

        // ── rAF: Face Detection Loop (~400 ms cadence) ───────────────────
        let lastRafTime = 0
        let framesProcessed = 0
        let lastDiagnosticLog = 0
        let lastFaceLog = 0

        const runDetection = (timestamp) => {
          if (destroyed || !detectorRef.current || !videoRef.current) return

          if (timestamp - lastRafTime >= 400) {
            lastRafTime = timestamp

            // ── Video readiness diagnostics (every 2s) ───────────────────
            const nowMs = Date.now()
            if (nowMs - lastDiagnosticLog >= 2000) {
              lastDiagnosticLog = nowMs
              const vt = videoRef.current
              const track = activeStream?.getVideoTracks?.()[0] ?? null
              console.log('[Attendance Detection Input]')
              console.log(`  videoExists=${!!vt}`)
              console.log(`  videoReadyState=${vt?.readyState ?? 'n/a'}`)
              console.log(`  videoWidth=${vt?.videoWidth ?? 0}`)
              console.log(`  videoHeight=${vt?.videoHeight ?? 0}`)
              console.log(`  videoPaused=${vt?.paused ?? 'n/a'}`)
              console.log(`  videoCurrentTime=${vt?.currentTime ?? 0}`)
              console.log(`  srcObjectExists=${!!(vt?.srcObject)}`)
              console.log(`  cameraTrackExists=${!!track}`)
              console.log(`  trackReadyState=${track?.readyState ?? 'n/a'}`)
              console.log(`  trackEnabled=${track?.enabled ?? 'n/a'}`)
              console.log('[Attendance Detection Loop]')
              console.log(`  framesProcessed=${framesProcessed}`)
              console.log(`  lastFrameTimestamp=${lastRafTime.toFixed(0)}`)
            }

            try {
              const vt = videoRef.current
              if (vt && vt.readyState >= 2 && vt.videoWidth > 0 && vt.videoHeight > 0) {
                framesProcessed++
                const results = detectorRef.current.detectForVideo(vt, timestamp)
                const faceDetected = results?.detections?.length > 0 || (typeof window !== 'undefined' && Boolean(window.__meetly_simulate_face))
                const prevState = attendanceStateRef.current

                // ── Face result log (throttled) ──────────────────────────
                if (nowMs - lastFaceLog >= 1000) {
                  lastFaceLog = nowMs
                  console.log('[Attendance Face Detection]')
                  console.log(`  faceDetected=${faceDetected}`)
                  console.log(`  detectionsCount=${results?.detections?.length ?? 0}`)
                  console.log(`  timestamp=${timestamp.toFixed(0)}`)
                  console.log(`  state=${prevState}`)
                }

                if (faceDetected) {
                  consecutiveDetections.current++

                  if (prevState === 'WAITING_FOR_FACE' || prevState === 'PAUSED') {
                    if (consecutiveDetections.current >= 2) {
                      attendanceStateRef.current = 'PRESENT'
                      graceStartTimeRef.current = null
                      currentIntervalStartRef.current = Date.now()
                      console.log(`[Attendance State] ${prevState} → PRESENT`)
                      console.log('[Attendance Interval] started')
                    }
                  } else if (prevState === 'GRACE') {
                    attendanceStateRef.current = 'PRESENT'
                    graceStartTimeRef.current = null
                    console.log('[Attendance State] GRACE → PRESENT (face returned within grace)')
                  }
                } else {
                  if (consecutiveDetections.current > 0) {
                    consecutiveDetections.current = 0
                  }
                  if (prevState === 'PRESENT') {
                    attendanceStateRef.current = 'GRACE'
                    graceStartTimeRef.current = Date.now()
                    console.log('[Attendance State] PRESENT → GRACE')
                  }
                }
              } else {
                // Throttled: only log once every 2s when not ready
                if (nowMs - lastDiagnosticLog <= 100) {
                  console.log('[Attendance Detection Input] video not ready — readyState:', videoRef.current?.readyState, 'w:', videoRef.current?.videoWidth, 'h:', videoRef.current?.videoHeight)
                }
              }
            } catch (err) {
              console.error('[Attendance Error] Face detection frame error:', err.message)
            }
          }

          rafId = requestAnimationFrame(runDetection)
          animationFrameIdRef.current = rafId
        }

        rafId = requestAnimationFrame(runDetection)
        animationFrameIdRef.current = rafId

        // ── Clock: Grace Expiry + Display Sync (every 1 second) ──────────
        let lastDebugLog = 0
        clockInterval = setInterval(() => {
          if (destroyed) return
          totalSeconds.current++

          if (attendanceStateRef.current === 'GRACE' && graceStartTimeRef.current) {
            const elapsedGraceSec = Math.floor((Date.now() - graceStartTimeRef.current) / 1000)
            if (elapsedGraceSec >= GRACE_PERIOD_SECONDS) {
              console.log(`[Attendance State] GRACE → PAUSED (grace expired after ${elapsedGraceSec}s)`)
              attendanceStateRef.current = 'PAUSED'
              graceStartTimeRef.current = null

              if (currentIntervalStartRef.current) {
                const intervalEnd = Date.now()
                const intervalDuration = Math.max(0, Math.floor((intervalEnd - currentIntervalStartRef.current) / 1000))
                attendanceIntervalsRef.current.push({
                  start: currentIntervalStartRef.current,
                  end: intervalEnd,
                  seconds: intervalDuration
                })
                console.log(`[Attendance Interval] closed | duration: ${intervalDuration}s | total intervals: ${attendanceIntervalsRef.current.length}`)
                currentIntervalStartRef.current = null
              }
            }
          }

          // Sync display counter from timestamps (not tick-based)
          presenceSeconds.current = attendanceIntervalsRef.current.reduce((sum, iv) => sum + iv.seconds, 0)
          if ((attendanceStateRef.current === 'PRESENT' || attendanceStateRef.current === 'GRACE') && currentIntervalStartRef.current) {
            presenceSeconds.current += Math.max(0, Math.floor((Date.now() - currentIntervalStartRef.current) / 1000))
          }

          // Debug log every 5 seconds
          const now = Date.now()
          if (now - lastDebugLog >= 5000) {
            lastDebugLog = now
            const elapsedSessionSec = sessionStartTimeRef.current
              ? Math.floor((Date.now() - sessionStartTimeRef.current) / 1000)
              : 0
            console.log('[Attendance Debug]')
            console.log(`  state=${attendanceStateRef.current}`)
            console.log(`  session=${elapsedSessionSec}s`)
            console.log(`  facePresence=${presenceSeconds.current}s`)
            console.log(`  intervalCount=${attendanceIntervalsRef.current.length}`)
          }

          // Background tab watchdog: if requestAnimationFrame is throttled or paused by browser,
          // ensure detection continues running every ~500ms
          const nowPerf = performance.now()
          if (nowPerf - lastRafTime >= 500 && !destroyed && detectorRef.current && videoRef.current) {
            runDetection(nowPerf)
          }
        }, 1000)

      } catch (err) {
        if (!destroyed) {
          console.error('[Attendance Error] Failed to obtain camera stream:', err)
          setAttendanceCamError(true)
          showToastRef.current?.('AI Attendance: Camera access failed or hardware busy.', 'warning')
        }
      }
    }

    startCamera()

    return () => {
      destroyed = true
      console.log('[Attendance] Cleaning up tracking loop')
      if (attendanceNeedsCameraRef && (!meetingDataRef.current?.enable_ai_attendance || attendanceConsentRef.current !== 'Granted' || isIntentionalLeaveRef?.current)) {
        attendanceNeedsCameraRef.current = false
      }
      if (clockInterval) clearInterval(clockInterval)
      if (rafId) cancelAnimationFrame(rafId)
      attendanceCameraStreamRef.current = null
      const domVideo = document.getElementById('__meetly_attendance_video')
      if (domVideo) {
        try { domVideo.remove() } catch (_) {}
      }
      if (video && video.parentNode) {
        try { video.parentNode.removeChild(video) } catch (_) {}
      }
      videoRef.current = null
      cameraLoopStartedOnceRef.current = false
      if (releasePhysicalCameraIfUnneededRef.current) releasePhysicalCameraIfUnneededRef.current()
      else releasePhysicalCameraIfUnneeded()
    }
  }, [attendanceConsent]) // ← meetingData, showToast, & callbacks intentionally REMOVED

  // beforeunload listener for browser closing / refresh events
  useEffect(() => {
    const handleBeforeUnloadAttendance = () => {
      const currentMeetingData = meetingDataRef.current
      const currentConsent = attendanceConsentRef.current
      const isAnyHostRole = Boolean(
        isAnyHostRef.current ||
        isHostRef.current ||
        (userRef.current?.id && currentMeetingData?.host_id === userRef.current.id) ||
        (userRef.current?.id && currentMeetingData?.active_host_id === userRef.current.id) ||
        (userRef.current?.id && currentMeetingData?.assigned_host_id === userRef.current.id)
      )

      if (currentMeetingData?.enable_ai_attendance && !hasUploaded.current && !isAnyHostRole) {
        finalizeAttendanceState('beforeunload')

        const connectedDuration = getConnectedDurationSeconds()
        const duration = connectedDuration > 0
          ? connectedDuration
          : (sessionStartTimeRef.current 
            ? Math.max(0, Math.floor((Date.now() - sessionStartTimeRef.current) / 1000))
            : 0)

        // Send even if presence=0 so backend can overwrite stale records
        hasUploaded.current = true

        const effectivePresence = attendanceIntervalsRef.current.reduce((sum, iv) => sum + iv.seconds, 0)
        const percentage = duration > 0
          ? Math.min(100, Math.max(0, (effectivePresence / duration) * 100))
          : 0
        const status = percentage >= 75 ? 'Present' : 'Absent'
        const camPermission = currentConsent === 'Granted'
        const isFinalSubmit = isFirstSubmitRef.current
        isFirstSubmitRef.current = false

        const payload = {
          meetingId: currentMeetingData.meeting_id,
          presenceSeconds: effectivePresence,
          meetingDurationSeconds: duration,
          attendancePercentage: Number(percentage.toFixed(2)),
          status,
          cameraPermission: camPermission,
          isFinalSubmit
        }

        console.log('[AI Attendance] beforeunload | facePresence:', effectivePresence, 's | duration:', duration, 's | %:', percentage.toFixed(2))

        const apiUrl = `${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/attendance`
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
        navigator.sendBeacon(apiUrl, blob)
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnloadAttendance)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnloadAttendance)
    }
  }, [finalizeAttendanceState, getConnectedDurationSeconds])

  // Dedicated mount/unmount effect for AI Attendance finalization fallback
  useEffect(() => {
    return () => {
      // On unmount, stop transcript capture immediately
      stopTranscriptCapture()
      const currentMeetingData = meetingDataRef.current
      const currentConsent = attendanceConsentRef.current
      const isAnyHostRole = Boolean(
        isAnyHostRef.current ||
        isHostRef.current ||
        (userRef.current?.id && currentMeetingData?.host_id === userRef.current.id) ||
        (userRef.current?.id && currentMeetingData?.active_host_id === userRef.current.id) ||
        (userRef.current?.id && currentMeetingData?.assigned_host_id === userRef.current.id)
      )

      if (currentMeetingData?.enable_ai_attendance && !hasUploaded.current && !isAnyHostRole) {
        const connectedDuration = getConnectedDurationSeconds()
        const prelimPresence = attendanceIntervalsRef.current.reduce((sum, iv) => sum + iv.seconds, 0)
        if (connectedDuration === 0 && prelimPresence === 0 && !sessionStartTimeRef.current) {
          console.log('[AI Attendance] unmount before room connection; skipping dummy upload')
          return
        }

        finalizeAttendanceState('component-unmount')

        const duration = connectedDuration > 0
          ? connectedDuration
          : (sessionStartTimeRef.current 
            ? Math.max(0, Math.floor((Date.now() - sessionStartTimeRef.current) / 1000))
            : 0)

        // Send even if presence=0 so backend can overwrite stale records
        hasUploaded.current = true

        const effectivePresence = attendanceIntervalsRef.current.reduce((sum, iv) => sum + iv.seconds, 0)
        const percentage = duration > 0
          ? Math.min(100, Math.max(0, (effectivePresence / duration) * 100))
          : 0
        const status = percentage >= 75 ? 'Present' : 'Absent'
        const camPermission = currentConsent === 'Granted'
        const isFinalSubmit = isFirstSubmitRef.current
        isFirstSubmitRef.current = false

        const payload = {
          meetingId: currentMeetingData.meeting_id,
          presenceSeconds: effectivePresence,
          meetingDurationSeconds: duration,
          attendancePercentage: Number(percentage.toFixed(2)),
          status,
          cameraPermission: camPermission,
          isFinalSubmit
        }

        console.log('[AI Attendance] unmount | facePresence:', effectivePresence, 's | duration:', duration, 's | %:', percentage.toFixed(2))

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
            console.error('[AI Attendance] Unmount background upload failed:', err)
          })
        }
      }
    }
  }, [finalizeAttendanceState, getConnectedDurationSeconds])

  // Transcript chunk collection
  useEffect(() => {
    const isConnected = connectionState === 'connected' || roomState === 'connected' || roomState === 'joined'
    console.log('[AI Analyzer Debug] useEffect triggered. conditions check:', {
      hasMeetingData: !!meetingData,
      enable_ai_analyzer: meetingData?.enable_ai_analyzer,
      roomState,
      connectionState,
      isConnected
    })

    if (!meetingData || !meetingData.enable_ai_analyzer || !isConnected) {
      return
    }

    console.log('[AI Analyzer] AI Analyzer started')
    isTranscriptActiveRef.current = true
    isTranscriptAbortedRef.current = false

    const startRecording = async () => {
      try {
        console.log('[AI Analyzer] Requesting microphone access stream...')
        // Request dedicated mic stream specifically for recording to prevent interfering with LiveKit / RealtimeKit
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
          if (isTranscriptAbortedRef.current) return
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

          // If aborted (e.g. hard cancel on unmount), skip upload
          if (isTranscriptAbortedRef.current) {
            console.log('[AI Analyzer] Transcript capture was aborted. Skipping chunk upload.')
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
            if (rms < 0.001) {
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

          // If aborted while analyzing volume, skip upload
          if (isTranscriptAbortedRef.current) {
            console.log('[AI Analyzer] Transcript capture was aborted. Skipping chunk upload.')
            return
          }

          // Send to backend via multipart/form-data
          const formData = new FormData()
          formData.append('file', audioBlob, 'audio.webm')
          formData.append('meetingId', meetingData.meeting_id)
          formData.append('speakerName', user?.full_name || user?.name || 'Anonymous')
          if (user?.id) {
            formData.append('speakerUserId', user.id)
          }

          const queue = transcriptQueueRef.current
          const uploadTicket = queue ? queue.startUpload() : null
          activeTranscriptUploadsRef.current = queue ? queue.getActiveCount() : activeTranscriptUploadsRef.current + 1

          try {
            console.log('[AI Analyzer] Uploading transcript chunk...')
            console.log(`[Transcript Queue] Active uploads: ${activeTranscriptUploadsRef.current}`)
            const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
            const headers = {}
            if (token) headers['Authorization'] = `Bearer ${token}`

            const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000'
            const res = await fetch(`${apiUrl}/api/meetings/transcript`, {
              method: 'POST',
              headers,
              body: formData,
              credentials: 'include', // Sent with session auth cookies
              signal: uploadTicket?.signal
            })
            if (!res.ok) {
              console.error('[AI Analyzer] Upload failed. Server returned status:', res.status, await res.text())
            } else {
              console.log('[AI Analyzer] Upload successful')
            }
          } catch (uploadErr) {
            if (uploadErr?.name === 'AbortError') {
              console.log('[AI Analyzer] Transcript chunk upload aborted on shutdown/timeout.')
            } else {
              console.error('[AI Analyzer] Upload failed. Network error:', uploadErr)
            }
          } finally {
            if (queue && uploadTicket) {
              queue.finishUpload(uploadTicket.id)
              activeTranscriptUploadsRef.current = queue.getActiveCount()
            } else {
              activeTranscriptUploadsRef.current = Math.max(0, activeTranscriptUploadsRef.current - 1)
            }
            console.log('[Transcript Queue] Upload completed.')
            console.log(`[Transcript Queue] Active uploads: ${activeTranscriptUploadsRef.current}`)
          }
        }

        // Start recording
        mediaRecorder.start()
        console.log('[AI Analyzer] MediaRecorder started')

        // Trigger recording slice every 15 seconds
        const intervalId = setInterval(() => {
          if (isTranscriptActiveRef.current && mediaRecorder && mediaRecorder.state === 'recording') {
            console.log('[AI Analyzer] Slicing recorder chunk (15s interval)...')
            mediaRecorder.stop()
            mediaRecorder.start()
          }
        }, 15000) // 15 seconds chunks
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
  }, [meetingData, roomState, connectionState, user, showToast])

  // Timer simulation — effect only; state is declared at the top of this component
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

  // Authoritative scheduled end countdown & 3-minute warning trigger
  useEffect(() => {
    const scheduledEndTime = meetingData?.scheduled_end_time
    if (!scheduledEndTime) {
      setRemainingSeconds(null)
      return
    }

    const calculateRemaining = () => {
      const end = new Date(scheduledEndTime).getTime()
      const now = Date.now()
      const diffSec = Math.max(0, Math.floor((end - now) / 1000))
      setRemainingSeconds(diffSec)

      // When countdown reaches 00:00 and meeting is Active, trigger backend expiration check
      if (diffSec <= 0 && meetingData?.meeting_status === 'Active') {
        if (expirationTriggeredDeadlineRef.current !== scheduledEndTime) {
          expirationTriggeredDeadlineRef.current = scheduledEndTime
          console.log('[Frontend] Countdown reached 00:00. Requesting authoritative meeting expiration check from backend...')
          if (typeof expireMeeting === 'function' && meetingData?.meeting_id) {
            expireMeeting(meetingData.meeting_id).then((res) => {
              console.log('[Frontend] Expire meeting response:', res)
            }).catch((err) => {
              console.warn('[Frontend] Error requesting meeting expiration:', err)
            })
          }
        }
      }

      // Host 3-minute warning: trigger when remaining time <= 180s and > 0s
      // Strict Rule: Display ONLY ONCE, for the original deadline, and NEVER if extension is already used!
      if (diffSec <= 180 && diffSec > 0 && canManageMeeting && !isExtensionUsed) {
        if (
          warningTriggeredDeadlineRef.current !== scheduledEndTime &&
          warningDismissedDeadlineRef.current !== scheduledEndTime
        ) {
          warningTriggeredDeadlineRef.current = scheduledEndTime
          setIsWarningModalOpen(true)
        }
      }
    }

    calculateRemaining()
    const timer = setInterval(calculateRemaining, 1000)
    return () => clearInterval(timer)
  }, [meetingData?.scheduled_end_time, meetingData?.meeting_id, meetingData?.meeting_status, canManageMeeting, isExtensionUsed, expireMeeting])
  const formatTimer = (sec) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0')
    const s = (sec % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  const formatCountdown = (sec) => {
    if (sec == null || isNaN(sec)) return '00:00'
    const totalSec = Math.max(0, Math.floor(sec))
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }

  // Handle Host 3-minute warning response: Decline extension
  const handleDeclineExtension = () => {
    if (meetingData?.scheduled_end_time) {
      warningDismissedDeadlineRef.current = meetingData.scheduled_end_time
    }
    setIsWarningModalOpen(false)
    showToast('Extension declined. The meeting will continue until the scheduled deadline.', 'info')
  }

  // Handle Host 3-minute warning response: Proceed to extension selector
  const handleOpenExtensionModal = () => {
    setIsWarningModalOpen(false)
    setSelectedExtension(null)
    setIsExtensionModalOpen(true)
  }

  // Handle Cancel Extension
  const handleCancelExtension = () => {
    setIsExtensionModalOpen(false)
  }

  // Handle Confirm Extension
  const handleConfirmExtension = async () => {
    if (!selectedExtension || ![5, 10, 15].includes(selectedExtension)) {
      showToast('Please select an extension duration (+5, +10, or +15 minutes)', 'error')
      return
    }
    if (isSubmittingExtension) return
    setIsSubmittingExtension(true)

    try {
      const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
      const headers = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/extend`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          meetingId: meetingData.meeting_id,
          extensionMinutes: selectedExtension
        }),
        credentials: 'include'
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.message || 'Failed to extend meeting')
      }

      setMeetingData((prev) => (prev ? {
        ...prev,
        scheduled_end_time: data.scheduledEndTime,
        extension_used: true,
        extension_count: 1
      } : null))
      setIsWarningModalOpen(false)
      setIsExtensionModalOpen(false)
      showToast(`Meeting time successfully extended by ${selectedExtension} minutes!`, 'success')
    } catch (err) {
      console.error('[MeetingRoom] Extension failed:', err)
      showToast(err.message || 'Failed to extend meeting', 'error')
    } finally {
      setIsSubmittingExtension(false)
    }
  }

  // Handle Mute All / Microphone Lock Toggle (Host Only)
  const handleToggleMuteAll = async () => {
    if (!isHost || !meetingData) return
    const nextState = !meetingData.mute_all_enabled

    try {
      const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
      const headers = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/security/toggle-mute-all`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          meetingCode: meetingData.meeting_code,
          muteAllEnabled: nextState
        }),
        credentials: 'include'
      })

      if (res.ok) {
        setMeetingData((prev) => (prev ? { ...prev, mute_all_enabled: nextState } : null))
        showToast(nextState ? 'Mute All / Microphone Lock enabled.' : 'Mute All / Microphone Lock disabled.', 'success')
      } else {
        const data = await res.json()
        showToast(data.message || 'Failed to toggle Mute All state.', 'error')
      }
    } catch (err) {
      console.error('[Toggle Mute All Error]', err)
      showToast('Error toggling Mute All status.', 'error')
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

  // Handle Auto Admit Toggle (Host Only)
  const handleToggleAutoAdmit = async () => {
    if (!isHost || !meetingData) return
    const nextState = meetingData.auto_admit === false ? true : false

    try {
      const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
      const headers = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/security/toggle-auto-admit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ meetingId: meetingData.meeting_id, autoAdmit: nextState }),
        credentials: 'include'
      })

      if (res.ok) {
        setMeetingData((prev) => (prev ? { ...prev, auto_admit: nextState } : null))
        showToast(`Auto Admit toggled ${nextState ? 'ON' : 'OFF'}`, 'success')
      } else {
        let errMsg = 'Failed to toggle Auto Admit'
        try {
          const data = await res.json()
          errMsg = data.message || errMsg
        } catch (e) {}
        showToast(errMsg, 'error')
      }
    } catch (err) {
      console.error('[Toggle Auto Admit Error]', err)
      showToast('Error toggling Auto Admit status.', 'error')
    }
  }
  // Auto-close expanded view if that participant disconnects
  useEffect(() => {
    if (expandedParticipantId) {
      const exists = allParticipants.some((p) => p.identity === expandedParticipantId || p.sid === expandedParticipantId || p.id === expandedParticipantId)
      if (!exists) {
        setExpandedParticipantId(null)
      }
    }
  }, [allParticipants, expandedParticipantId])

  const expandedParticipant = useMemo(() => {
    if (!expandedParticipantId) return null
    return allParticipants.find((p) => p.identity === expandedParticipantId || p.sid === expandedParticipantId || p.id === expandedParticipantId) || null
  }, [allParticipants, expandedParticipantId])

  // Participant search state & instant local filtering
  const [participantSearchQuery, setParticipantSearchQuery] = useState('')

  const filteredParticipants = useMemo(() => {
    if (!participantSearchQuery.trim()) return allParticipants
    const q = participantSearchQuery.toLowerCase().trim()
    return allParticipants.filter((p) => {
      let email = ''
      let username = ''
      try {
        const meta = JSON.parse(p?.metadata || '{}')
        email = meta.email || ''
        username = meta.username || ''
      } catch (e) {}

      const nameMatch = p.name ? p.name.toLowerCase().includes(q) : false
      const identityMatch = p.identity ? p.identity.toLowerCase().includes(q) : false
      const emailMatch = email ? email.toLowerCase().includes(q) : false
      const usernameMatch = username ? username.toLowerCase().includes(q) : false

      return nameMatch || identityMatch || emailMatch || usernameMatch
    })
  }, [allParticipants, participantSearchQuery])

  // Derive authoritative remaining seconds for the header countdown:
  // Uses remainingSeconds state (which ticks every second), with fallback to scheduled_end_time diff
  // or initial duration_minutes * 60 so newly started meetings immediately show 05:00 / 15:00 / 30:00 / 40:00.
  const displayRemainingSeconds = remainingSeconds !== null
    ? remainingSeconds
    : (meetingData?.scheduled_end_time
        ? Math.max(0, Math.floor((new Date(meetingData.scheduled_end_time).getTime() - Date.now()) / 1000))
        : (meetingData?.duration_minutes ? meetingData.duration_minutes * 60 : null))

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
      {/* ── Connection Reconnecting Banner ─────────────────────────────────────
          Shown only when LiveKit's DefaultReconnectPolicy is actively retrying
          (RoomEvent.Reconnecting fired). Dismissed on RoomEvent.Reconnected.
          NOT shown for intentional Leave/End actions (guarded by isIntentionalLeaveRef).
          Non-invasive: top bar only, does not block controls.                     */}
      {isReconnecting && !isIntentionalLeaveRef?.current && (
        <div
          role="status"
          aria-live="polite"
          className="absolute top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 px-4 py-2 bg-amber-500/90 backdrop-blur-sm text-slate-950 text-[11px] font-bold select-none"
        >
          <div className="w-3 h-3 border-2 border-slate-950/40 border-t-slate-950 rounded-full animate-spin shrink-0" />
          <span>Connection interrupted — reconnecting automatically…</span>
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
          {(isRecordingOrPaused || isRoomRecording) && (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  if (canManageMeeting) {
                    setRecordingPopoverAnchor((prev) => (prev === 'header' ? null : 'header'))
                  }
                }}
                disabled={!canManageMeeting}
                title={
                  canManageMeeting
                    ? 'Recording controls (Pause, Resume, Stop)'
                    : 'Screen recording in progress'
                }
                className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-xs font-semibold shadow-sm transition-all ${
                  canManageMeeting ? 'cursor-pointer hover:brightness-125' : 'cursor-default'
                } ${
                  isPaused
                    ? 'bg-amber-500/15 border-amber-500/30 text-amber-400 shadow-amber-500/20'
                    : 'bg-red-500/15 border-red-500/30 text-red-400 animate-pulse shadow-red-500/20'
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    isPaused ? 'bg-amber-400' : 'bg-red-500'
                  }`}
                />
                <span>{isPaused ? 'PAUSED' : 'REC'}</span>
                {isRecordingOrPaused && (
                  <span className="text-gray-300 font-mono text-[11px] ml-1">
                    {Math.floor(recordingDuration / 60)}:{(recordingDuration % 60).toString().padStart(2, '0')}
                  </span>
                )}
              </button>

              {/* Header recording popover */}
              {canManageMeeting && (
                <RecordingControlPopover
                  isOpen={recordingPopoverAnchor === 'header'}
                  onClose={() => setRecordingPopoverAnchor(null)}
                  isPaused={isPaused}
                  isRecording={isRecording}
                  recordingDuration={recordingDuration}
                  onPause={pauseRecording}
                  onResume={resumeRecording}
                  onStop={() => stopRecording('user_stop')}
                  position="top"
                />
              )}
            </div>
          )}
          <span className="flex items-center gap-1.5 text-emerald-400">
            <Radio size={14} className="animate-pulse" />
            <span>LIVE</span>
          </span>
          <span className="text-gray-400 font-mono" title="Time remaining until scheduled meeting end">{formatCountdown(displayRemainingSeconds)}</span>
          <span className="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-gray-400 text-[10px] font-mono">
            {allParticipants.length} In Call
          </span>
        </div>
      </header>

      {/* Main Grid + Drawer Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Video Grid Section */}
        <div className="flex-1 p-4 md:p-6 overflow-hidden flex items-center justify-center bg-[#05060b]">
          {expandedParticipant ? (
            <div className="w-full h-full max-w-6xl max-h-[640px] flex items-center justify-center">
              <ExpandedParticipantStage
                participant={expandedParticipant}
                allParticipants={allParticipants}
                localParticipant={localParticipant}
                user={user}
                localCamActive={camActive}
                onClose={() => setExpandedParticipantId(null)}
                onSelectParticipant={(id) => setExpandedParticipantId(id)}
                camInitializing={camInitializing}
                camError={camError}
                onRetryCam={handleToggleCam}
                raisedHandsMap={raisedHandsMap}
                participantStatusMap={participantStatusMap}
                activeReactionsMap={activeReactionsMap}
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-5xl h-full max-h-[560px] overflow-y-auto">
              {/* Screen share presentations first */}
              {(tracks || []).map((t) => (
                <div
                  key={t.publication?.trackSid || t.sid || Math.random()}
                  className="bg-slate-900/60 rounded-2xl border border-white/5 relative overflow-hidden flex flex-col justify-end items-center group shadow-xl col-span-2 min-h-[260px] md:min-h-[360px]"
                >
                  <ScreenShareView
                    trackRef={t}
                    participant={t.participant}
                    className="absolute inset-0 w-full h-full"
                  />
                </div>
              ))}

              {/* Video feeds for all participants */}
              {allParticipants.map((p) => (
                <ParticipantVideoTile
                  key={p.sid || p.identity || Math.random()}
                  participant={p}
                  localParticipant={localParticipant}
                  user={user}
                  localCamActive={camActive}
                  camInitializing={camInitializing}
                  camError={camError}
                  onRetryCam={handleToggleCam}
                  raisedHand={Boolean(raisedHandsMap[p.identity])}
                  status={participantStatusMap[p.identity]}
                  activeReaction={activeReactionsMap[p.identity]}
                  onExpand={(identity) => setExpandedParticipantId(identity)}
                />
              ))}
            </div>
          )}
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
            <div className={`flex-1 p-4 flex flex-col ${activeTab === 'chat' ? 'overflow-hidden min-h-0' : 'overflow-y-auto justify-between'}`}>
              {/* TAB: CHAT */}
              {activeTab === 'chat' && (
                <div className="h-full flex flex-col min-h-0">
                  <MeetingChat
                    meetingData={meetingData}
                    user={user}
                    localParticipant={localParticipant}
                    participants={participants}
                    dbParticipants={dbParticipants}
                    socket={socket}
                    socketReady={socketReady}
                    isHost={isHost}
                    showToast={showToast}
                    messages={ephemeralChatMessages}
                    setMessages={setEphemeralChatMessages}
                    policy={ephemeralChatPolicy}
                    setPolicy={setEphemeralChatPolicy}
                    activeChatTab={activeChatConvTab}
                    setActiveChatTab={setActiveChatConvTab}
                    selectedRecipient={selectedChatRecipient}
                    setSelectedRecipient={setSelectedChatRecipient}
                  />
                </div>
              )}

              {/* TAB: PARTICIPANTS */}
              {activeTab === 'participants' && (
                <div className="flex flex-col gap-3 h-full overflow-y-auto">
                  {/* Participant Search Bar */}
                  <div className="relative shrink-0 select-none">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                    <input
                      type="text"
                      placeholder="Search participants..."
                      value={participantSearchQuery}
                      onChange={(e) => setParticipantSearchQuery(e.target.value)}
                      className="w-full bg-slate-900/60 border border-white/10 rounded-xl pl-9 pr-8 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand-purple transition-all duration-200"
                    />
                    {participantSearchQuery && (
                      <button
                        onClick={() => setParticipantSearchQuery('')}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white p-0.5 rounded-md cursor-pointer text-xs"
                        title="Clear search"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {/* Participant List */}
                  {filteredParticipants.length === 0 ? (
                    <div className="py-8 text-center text-gray-400 text-xs select-none">
                      No participants found
                    </div>
                  ) : (
                    filteredParticipants.map((p) => {
                      let role = 'participant'
                      let pUserId = resolveParticipantUserId(p, dbParticipants) || p.identity
                      try {
                        const meta = JSON.parse(p?.metadata || '{}')
                        role = meta.role || 'participant'
                      } catch (e) {}

                      if (pUserId && originalHostId && String(pUserId).toLowerCase() === String(originalHostId).toLowerCase()) {
                        role = 'host'
                      } else if (pUserId && activeHostId && String(pUserId).toLowerCase() === String(activeHostId).toLowerCase()) {
                        role = 'active host'
                      } else if (pUserId && assignedHostId && String(pUserId).toLowerCase() === String(assignedHostId).toLowerCase()) {
                        role = 'assigned host'
                      }

                      const isCurrentUser = p.identity === localParticipant?.identity
                      const displayName = isCurrentUser ? (user?.name || user?.full_name || p.name) : p.name

                      return (
                        <div key={p.sid || p.identity} className="flex items-center gap-3 p-2 bg-white/2 border border-white/5 rounded-xl justify-between">
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-xs font-bold text-gray-300 shrink-0">
                              {displayName?.charAt(0).toUpperCase() || 'P'}
                            </div>
                            <div className="flex flex-col text-left min-w-0">
                              <span className="text-xs font-semibold text-white truncate flex items-center gap-1.5">
                                <span>{displayName} {isCurrentUser && ' (You)'}</span>
                                {raisedHandsMap[p.identity] && (
                                  <span className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[9px] font-bold shrink-0">
                                    ✋ Hand
                                  </span>
                                )}
                                {participantStatusMap[p.identity] === 'be_right_back' && (
                                  <span className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[9px] font-bold shrink-0">
                                    ⌛ BRB
                                  </span>
                                )}
                              </span>
                              <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mt-0.5">{role}</span>
                            </div>
                          </div>

                          {isHost && role !== 'host' && p.identity !== localParticipant?.identity && (() => {
                            const micPub = p.getTrackPublication ? p.getTrackPublication(TRACK_SOURCE_MICROPHONE) : null
                            const isMuted = p.isMicrophoneEnabled === false || (micPub && micPub.isMuted === true)

                            return (
                              <div className="flex items-center gap-1 shrink-0 select-none">
                                <button
                                  onClick={() => handleMuteParticipant(p)}
                                  className={`p-1.5 rounded-lg transition-all cursor-pointer ${
                                    isMuted
                                      ? 'bg-red-950/50 hover:bg-red-900/50 border border-red-500/20 text-red-400 hover:text-red-300'
                                      : 'bg-slate-800 hover:bg-slate-700 text-emerald-400 hover:text-emerald-300'
                                  }`}
                                  title={isMuted ? 'Request Unmute' : 'Mute Participant'}
                                >
                                  {isMuted ? '🚫' : '🎤'}
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
                            )
                          })()}
                        </div>
                      )
                    })
                  )}
                </div>
              )}

              {/* TAB: SECURITY */}
              {activeTab === 'security' && isHost && (
                <div className="flex flex-col gap-4 h-full justify-start text-left">
                  {/* Mute All / Microphone Lock Toggle */}
                  <div className="flex items-center justify-between p-3 bg-red-950/20 border border-red-500/20 rounded-xl">
                    <div className="flex flex-col text-left pr-2">
                      <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                        <span>🔒 Mute All Participants</span>
                      </span>
                      <span className="text-[10px] text-gray-400">Lock all participant microphones</span>
                    </div>
                    <button
                      onClick={handleToggleMuteAll}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                        meetingData?.mute_all_enabled ? 'bg-red-600' : 'bg-slate-700'
                      }`}
                      title={meetingData?.mute_all_enabled ? "Disable Mute All Lock" : "Enable Mute All Lock"}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        meetingData?.mute_all_enabled ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </button>
                  </div>

                  {/* Auto Admit Participants Toggle */}
                  <div className="flex items-center justify-between p-3 bg-white/2 border border-white/5 rounded-xl">
                    <div className="flex flex-col text-left pr-2">
                      <span className="text-xs font-semibold text-white">Auto Admit Participants</span>
                      <span className="text-[10px] text-gray-400">Automatically admit eligible participants</span>
                    </div>
                    <button
                      onClick={handleToggleAutoAdmit}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                        meetingData?.auto_admit !== false ? 'bg-purple-600' : 'bg-slate-700'
                      }`}
                      title={meetingData?.auto_admit !== false ? "Disable Auto Admit" : "Enable Auto Admit"}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        meetingData?.auto_admit !== false ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </button>
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

                  {/* ── HOST MANAGEMENT — visible only to Original Host ── */}
                  {canManageHostAssignment && (
                    <div className="flex flex-col gap-2 border-t border-white/5 pt-3 mt-1">
                      <h3 className="text-xs font-bold text-purple-300 select-none flex items-center gap-1.5">
                        <span>👑</span> Host Management
                      </h3>

                      {/* Active Host indicator */}
                      <div className="flex items-center justify-between p-2.5 bg-purple-950/20 border border-purple-500/20 rounded-xl">
                        <div className="flex flex-col">
                          <span className="text-[10px] text-gray-400">Active Host</span>
                          <span className="text-xs font-semibold text-white">
                            {(() => {
                              if (!activeHostId) return '—'
                              const activeIsCurrentUser = String(activeHostId).trim().toLowerCase() === String(currentUserId).trim().toLowerCase()
                              const activeIsOriginalHost = String(activeHostId).trim().toLowerCase() === String(originalHostId).trim().toLowerCase()
                              if (activeIsCurrentUser) {
                                return activeIsOriginalHost ? 'You (Original Host)' : 'You (Active Host)'
                              }
                              return getDisplayNameForUserId(activeHostId, participants, dbParticipants) || '—'
                            })()}
                          </span>
                        </div>
                        <span className="text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">Active</span>
                      </div>

                      {/* Assigned Host row */}
                      <div className="flex items-center justify-between p-2.5 bg-white/2 border border-white/5 rounded-xl gap-2">
                        <div className="flex flex-col min-w-0">
                          <span className="text-[10px] text-gray-400">Assigned Host</span>
                          <span className="text-xs font-semibold text-white truncate">
                            {assignedHostId
                              ? (getDisplayNameForUserId(assignedHostId, participants, dbParticipants) || assignedHostId)
                              : <span className="text-gray-500 font-normal italic">None designated</span>}
                          </span>
                        </div>
                        <div className="flex gap-1.5 shrink-0">
                          {assignedHostId ? (
                            <>
                              <button
                                onClick={() => setShowHostPicker(true)}
                                disabled={hostActionLoading}
                                className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded text-[10px] font-bold cursor-pointer transition-all disabled:opacity-50"
                              >
                                Change
                              </button>
                              <button
                                onClick={async () => {
                                  setHostActionLoading(true)
                                  try {
                                    const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
                                    const headers = { 'Content-Type': 'application/json' }
                                    if (token) headers['Authorization'] = `Bearer ${token}`
                                    const res = await fetch(
                                      `${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/${meetingData.meeting_id}/assigned-host`,
                                      { method: 'DELETE', headers, credentials: 'include' }
                                    )
                                    const data = await res.json()
                                    if (!res.ok) {
                                      showToast(data.message || 'Failed to remove assigned host.', 'error')
                                    } else {
                                      setMeetingData((prev) => {
                                        const next = prev ? {
                                          ...prev,
                                          assigned_host_id: null,
                                          active_host_id: data.active_host_id || prev.host_id
                                        } : null
                                        console.log(`[HOST UI STATE] immediately after removeAssignedHost click meetingData update\nhost_id: ${next?.host_id}\nassigned_host_id: ${next?.assigned_host_id}\nactive_host_id: ${next?.active_host_id}`)
                                        return next
                                      })
                                      showToast(data.message || 'Assigned Host designation has been removed.', 'success')
                                    }
                                  } catch {
                                    showToast('Error removing assigned host.', 'error')
                                  } finally {
                                    setHostActionLoading(false)
                                  }
                                }}
                                disabled={hostActionLoading}
                                className="px-2 py-1 bg-red-700 hover:bg-red-600 text-white rounded text-[10px] font-bold cursor-pointer transition-all disabled:opacity-50"
                              >
                                Remove
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setShowHostPicker(true)}
                              disabled={hostActionLoading}
                              className="px-2.5 py-1 bg-purple-700 hover:bg-purple-600 text-white rounded text-[10px] font-bold cursor-pointer transition-all disabled:opacity-50"
                            >
                              + Add Host
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Participant picker */}
                      {showHostPicker && (
                        <div className="flex flex-col gap-1.5 p-2.5 bg-slate-900/60 border border-purple-500/20 rounded-xl">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] text-gray-400 font-semibold">Select a participant as Assigned Host</span>
                            <button
                              onClick={() => setShowHostPicker(false)}
                              className="text-gray-500 hover:text-white text-[10px] cursor-pointer"
                            >
                              ✕
                            </button>
                          </div>
                          {(participants || [])
                            .filter(p => {
                              const pUserId = resolveParticipantUserId(p, dbParticipants)
                              const origHost = String(originalHostId || currentUserId || '').trim().toLowerCase()
                              return pUserId && pUserId.toLowerCase() !== origHost
                            })
                            .map((p) => {
                              const pUserId = resolveParticipantUserId(p, dbParticipants)
                              const isCurrentlyAssigned = Boolean(assignedHostId) && Boolean(pUserId) &&
                                String(pUserId).trim().toLowerCase() === String(assignedHostId).trim().toLowerCase()
                              return (
                                <button
                                  key={p.sid || p.identity || pUserId}
                                  onClick={async () => {
                                    const targetUserId = resolveParticipantUserId(p, dbParticipants)
                                    console.log('[ASSIGN HOST PARTICIPANT DEBUG]', {
                                      participant: p,
                                      resolvedUserId: targetUserId,
                                      userId: p?.userId,
                                      id: p?.id,
                                      identity: p?.identity,
                                      sid: p?.sid,
                                      name: p?.name,
                                      metadata: p?.metadata
                                    })
                                    if (!targetUserId || !isUuid(targetUserId)) {
                                      showToast('Could not resolve participant user ID (UUID).', 'error')
                                      return
                                    }
                                    setHostActionLoading(true)
                                    setShowHostPicker(false)
                                    try {
                                      const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
                                      const headers = { 'Content-Type': 'application/json' }
                                      if (token) headers['Authorization'] = `Bearer ${token}`
                                      const res = await fetch(
                                        `${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings/${meetingData.meeting_id}/assign-host`,
                                        {
                                          method: 'POST',
                                          headers,
                                          credentials: 'include',
                                          body: JSON.stringify({ userId: targetUserId })
                                        }
                                      )
                                      const data = await res.json()
                                      if (!res.ok) {
                                        showToast(data.message || 'Failed to assign host.', 'error')
                                      } else {
                                        showToast(data.message || 'Host assigned successfully.', 'success')
                                        // Update both assigned_host_id AND active_host_id immediately — assigning is an immediate transfer
                                        setMeetingData((prev) => {
                                          const next = prev ? {
                                            ...prev,
                                            assigned_host_id: targetUserId,
                                            active_host_id: data.active_host_id || targetUserId
                                          } : null
                                          console.log(`[HOST UI STATE] immediately after assignHost click meetingData update\nhost_id: ${next?.host_id}\nassigned_host_id: ${next?.assigned_host_id}\nactive_host_id: ${next?.active_host_id}`)
                                          return next
                                        })
                                      }
                                    } catch {
                                      showToast('Error assigning host.', 'error')
                                    } finally {
                                      setHostActionLoading(false)
                                    }
                                  }}
                                  disabled={hostActionLoading}
                                  className="flex items-center gap-2 p-2 bg-slate-800/60 hover:bg-slate-700/60 border border-white/5 rounded-lg text-left transition-all cursor-pointer disabled:opacity-50 w-full"
                                >
                                  <div className="w-6 h-6 rounded-full bg-purple-700 flex items-center justify-center text-[10px] font-bold text-white shrink-0">
                                    {(p.name || p.identity || '?')[0].toUpperCase()}
                                  </div>
                                  <span className="text-xs text-white font-medium truncate">{p.name || p.identity}</span>
                                  {isCurrentlyAssigned && (
                                    <span className="ml-auto text-[9px] text-purple-400 shrink-0">current</span>
                                  )}
                                </button>
                              )
                            })}
                          {(participants || []).filter(p => {
                            const pUserId = resolveParticipantUserId(p, dbParticipants)
                            const origHost = String(originalHostId || currentUserId || '').trim().toLowerCase()
                            return pUserId && pUserId.toLowerCase() !== origHost
                          }).length === 0 && (
                            <p className="text-[11px] text-gray-500 italic">No other participants in the meeting.</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* TAB: AI ASSISTANT */}
              {activeTab === 'ai' && (
                <AIChatPanel meetingId={meetingData?.meeting_id} />
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
            title="Toggle Right Panel"
          >
            <MessageSquare size={16} />
          </button>

          {meetingData?.enable_ai_attendance && attendanceConsent === 'Granted' && (
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

        {/* Core Media & Meeting Controls Toolbar */}
        <div className="flex items-center gap-2 md:gap-3 relative">
          {/* Microphone */}
          <button
            onClick={handleToggleMic}
            title={!isHost && meetingData?.mute_all_enabled ? "Microphones locked by host" : (micActive ? "Mute Microphone" : "Unmute Microphone")}
            className={`w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-200 cursor-pointer ${
              !isHost && meetingData?.mute_all_enabled
                ? 'bg-red-950/50 hover:bg-red-900/50 border-red-500/30 text-red-400'
                : micActive
                ? 'bg-[#0f1122]/60 hover:bg-[#141629] border-white/10 text-white'
                : 'bg-red-600 hover:bg-red-500 border-transparent text-white'
            }`}
          >
            {!isHost && meetingData?.mute_all_enabled ? (
              <span className="flex items-center text-xs font-bold gap-0.5 select-none">
                🔒 <MicOff size={14} />
              </span>
            ) : micActive ? (
              <Mic size={18} />
            ) : (
              <MicOff size={18} />
            )}
          </button>

          {/* Camera */}
          <button
            onClick={handleToggleCam}
            title={camActive ? "Turn off camera" : "Turn on camera"}
            className={`w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-200 cursor-pointer ${
              camActive ? 'bg-[#0f1122]/60 hover:bg-[#141629] border-white/10 text-white' : 'bg-red-600 hover:bg-red-500 border-transparent text-white'
            }`}
          >
            {camActive ? <Cam size={18} /> : <VideoOff size={18} />}
          </button>

          {/* Participants Button */}
          <button
            onClick={() => {
              setActiveTab('participants')
              setRightPanelOpen(true)
            }}
            title="Participants"
            className="px-3 py-2.5 rounded-xl bg-[#0f1122]/60 hover:bg-[#141629] border border-white/10 text-white flex items-center gap-1.5 text-xs font-semibold cursor-pointer transition-all"
          >
            <Users size={16} />
            <span className="hidden md:inline">Participants</span>
            <span className="px-1.5 py-0.5 rounded-full bg-purple-600/30 text-purple-300 text-[10px] font-bold">
              {allParticipants.length}
            </span>
          </button>

          {/* Chat Button */}
          <button
            onClick={() => {
              setActiveTab('chat')
              setRightPanelOpen(true)
            }}
            title="In-meeting Chat"
            className="px-3 py-2.5 rounded-xl bg-[#0f1122]/60 hover:bg-[#141629] border border-white/10 text-white flex items-center gap-1.5 text-xs font-semibold cursor-pointer transition-all"
          >
            <MessageSquare size={16} />
            <span className="hidden md:inline">Chat</span>
          </button>

          {/* Single React Button & Unified Reaction Panel */}
          <div className="relative">
            <button
              onClick={() => setActivePopup(activePopup === 'react' || activePopup === 'emoji' ? null : 'react')}
              aria-label="Open reactions"
              title="Reactions"
              className={`px-3 py-2.5 rounded-xl border transition-all duration-200 cursor-pointer flex items-center gap-1.5 text-xs font-semibold ${
                activePopup === 'react' || activePopup === 'emoji' || raisedHand || beRightBack
                  ? 'bg-purple-600 border-purple-500 text-white shadow-lg shadow-purple-600/30'
                  : 'bg-[#0f1122]/60 hover:bg-[#141629] border-white/10 text-white'
              }`}
            >
              <Smile size={16} />
              <span className="hidden md:inline">React</span>
            </button>

            {/* Unified React Panel */}
            {activePopup === 'react' && (
              <div className="absolute bottom-16 left-0 sm:left-1/2 sm:-translate-x-1/2 z-50 w-72 bg-[#0c0e1b] border border-white/10 rounded-2xl p-4 shadow-2xl backdrop-blur-xl flex flex-col gap-3.5 select-none text-left">
                {/* 1. SEND WITH EFFECT */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">SEND WITH EFFECT</span>
                  <div className="flex items-center justify-between bg-white/5 p-2 rounded-xl border border-white/5">
                    {['🎈', '🚀', '👍', '😂', '🎉', '❤️'].map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => {
                          handleSendReaction(emoji)
                          setActivePopup(null)
                        }}
                        title={`Send ${emoji} effect`}
                        aria-label={`Send ${emoji} effect`}
                        className="text-lg hover:scale-125 transition-transform cursor-pointer p-1 rounded hover:bg-white/10"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 2. REACTIONS */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">REACTIONS</span>
                  <div className="grid grid-cols-6 gap-1 bg-white/5 p-2 rounded-xl border border-white/5">
                    {['👋', '👍', '❤️', '😂', '😮', '🎉'].map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => {
                          handleSendReaction(emoji)
                          setActivePopup(null)
                        }}
                        title={`Send ${emoji}`}
                        aria-label={`Send ${emoji} reaction`}
                        className="text-lg hover:scale-125 transition-transform cursor-pointer p-1 rounded hover:bg-white/10 text-center"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 3. RAISE HAND */}
                <button
                  onClick={() => {
                    handleToggleRaiseHand()
                    setActivePopup(null)
                  }}
                  aria-label="Raise or lower hand"
                  title={raisedHand ? "Lower Hand" : "Raise Hand"}
                  className={`w-full py-2.5 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-2 border transition-all cursor-pointer ${
                    raisedHand
                      ? 'bg-amber-500 hover:bg-amber-400 border-amber-300 text-slate-950 shadow-lg shadow-amber-500/20'
                      : 'bg-purple-600 hover:bg-purple-500 border-purple-400/30 text-white'
                  }`}
                >
                  <span className="text-base">{raisedHand ? '👇' : '✋'}</span>
                  <span>{raisedHand ? 'Lower Hand' : 'Raise Hand'}</span>
                </button>

                {/* 4. BE RIGHT BACK */}
                <button
                  onClick={() => {
                    handleToggleBeRightBack()
                    setActivePopup(null)
                  }}
                  aria-label="Toggle Be Right Back status"
                  title={beRightBack ? "I'm Back" : "Be Right Back"}
                  className={`w-full py-2.5 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-2 border transition-all cursor-pointer ${
                    beRightBack
                      ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                      : 'bg-white/5 hover:bg-white/10 border-white/10 text-white'
                  }`}
                >
                  <span className="text-base">⌛</span>
                  <span>{beRightBack ? "I'm Back" : 'Be Right Back'}</span>
                </button>

                {/* 5. MORE EMOJI */}
                <button
                  onClick={() => setActivePopup('emoji')}
                  aria-label="Open full emoji picker"
                  title="More Emoji"
                  className="w-full py-2.5 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 text-white transition-all cursor-pointer"
                >
                  <span className="text-base">😀</span>
                  <span>More Emoji</span>
                </button>
              </div>
            )}

            {/* Full Emoji Picker Panel */}
            {activePopup === 'emoji' && (
              <div className="absolute bottom-16 left-0 sm:left-1/2 sm:-translate-x-1/2 z-50 w-80 bg-[#0c0e1b] border border-white/10 rounded-2xl p-4 shadow-2xl backdrop-blur-xl flex flex-col gap-3 select-none text-left max-h-[420px] overflow-hidden">
                {/* Header & Back Button */}
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setActivePopup('react')}
                      className="text-gray-400 hover:text-white text-xs font-bold px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
                      title="Back to React Panel"
                    >
                      ‹ Back
                    </button>
                    <span className="text-xs font-bold text-white">Emoji Picker</span>
                  </div>
                  <button
                    onClick={() => setActivePopup(null)}
                    className="text-gray-400 hover:text-white text-xs cursor-pointer p-1"
                    title="Close"
                  >
                    ✕
                  </button>
                </div>

                {/* Search Emoji */}
                <div className="relative flex items-center">
                  <Search size={14} className="absolute left-3 text-gray-400 pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search emoji..."
                    value={emojiSearchQuery}
                    onChange={(e) => setEmojiSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-7 py-1.5 bg-white/5 border border-white/10 rounded-xl text-xs text-white placeholder-gray-400 focus:outline-none focus:border-purple-500 transition-colors"
                  />
                  {emojiSearchQuery && (
                    <button
                      onClick={() => setEmojiSearchQuery('')}
                      className="absolute right-2.5 text-gray-400 hover:text-white text-xs"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* Category Navigation Tabs */}
                {!emojiSearchQuery && (
                  <div className="flex items-center gap-1 overflow-x-auto pb-1 border-b border-white/5">
                    {EMOJI_CATEGORIES.map((cat) => (
                      <button
                        key={cat.id}
                        onClick={() => setEmojiCategory(cat.id)}
                        title={cat.label}
                        className={`px-2 py-1 rounded-lg text-xs transition-colors cursor-pointer shrink-0 ${
                          emojiCategory === cat.id ? 'bg-purple-600 text-white font-bold' : 'text-gray-400 hover:text-white hover:bg-white/5'
                        }`}
                      >
                        {cat.icon}
                      </button>
                    ))}
                  </div>
                )}

                {/* Scrollable Emoji Grid */}
                <div className="flex-1 overflow-y-auto max-h-52 flex flex-col gap-2 pr-1">
                  {emojiSearchQuery ? (
                    <div className="grid grid-cols-7 gap-1">
                      {EMOJI_CATEGORIES.flatMap(c => c.emojis)
                        .filter((e, idx, arr) => arr.indexOf(e) === idx && e.includes(emojiSearchQuery))
                        .map((emoji) => (
                          <button
                            key={emoji}
                            onClick={() => {
                              handleSendReaction(emoji)
                              setActivePopup(null)
                            }}
                            className="text-lg hover:scale-125 transition-transform cursor-pointer p-1 rounded hover:bg-white/10 text-center"
                          >
                            {emoji}
                          </button>
                        ))}
                    </div>
                  ) : (
                    EMOJI_CATEGORIES.filter(c => emojiCategory === 'all' || emojiCategory === c.id).map((cat) => (
                      <div key={cat.id} className="flex flex-col gap-1">
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{cat.label}</span>
                        <div className="grid grid-cols-7 gap-1">
                          {cat.emojis.map((emoji) => (
                            <button
                              key={emoji}
                              onClick={() => {
                                handleSendReaction(emoji)
                                setActivePopup(null)
                              }}
                              className="text-lg hover:scale-125 transition-transform cursor-pointer p-1 rounded hover:bg-white/10 text-center"
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Screen Share */}
          <button
            onClick={handleToggleShare}
            title="Share Screen"
            className={`w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-200 cursor-pointer ${
              sharingActive ? 'bg-brand-blue hover:bg-brand-blue-hover border-transparent text-white shadow-lg shadow-brand-blue/20' : 'bg-[#0f1122]/60 hover:bg-[#141629] border-white/10 text-white'
            }`}
          >
            <Monitor size={18} />
          </button>

          {/* Screen Recording (Host / Active Host only) */}
          {canManageMeeting && (
            <div className="relative">
              <button
                onClick={
                  isRecordingOrPaused
                    ? () => setRecordingPopoverAnchor((prev) => (prev === 'bottom' ? null : 'bottom'))
                    : startRecording
                }
                disabled={recordingState === 'starting' || recordingState === 'finalizing'}
                title={
                  isRecordingOrPaused
                    ? 'Recording controls (Pause, Resume, Stop)'
                    : recordingState === 'starting'
                    ? 'Starting recording...'
                    : recordingState === 'finalizing'
                    ? 'Finalizing recording...'
                    : 'Start Screen Recording (Meeting Audio Included)'
                }
                className={`w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-200 cursor-pointer ${
                  isPaused
                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-400 shadow-lg shadow-amber-500/20'
                    : isRecording
                    ? 'bg-red-500/20 border-red-500/40 text-red-400 shadow-lg shadow-red-500/20 animate-pulse'
                    : recordingState === 'starting' || recordingState === 'finalizing'
                    ? 'bg-[#0f1122]/60 border-yellow-500/30 text-yellow-400 opacity-70 animate-pulse'
                    : 'bg-[#0f1122]/60 hover:bg-[#141629] border-white/10 text-white hover:text-red-400'
                }`}
              >
                <Radio
                  size={18}
                  className={
                    isPaused ? 'text-amber-400' : isRecording ? 'text-red-400' : ''
                  }
                />
              </button>

              {/* Bottom bar recording popover */}
              <RecordingControlPopover
                isOpen={recordingPopoverAnchor === 'bottom'}
                onClose={() => setRecordingPopoverAnchor(null)}
                isPaused={isPaused}
                isRecording={isRecording}
                recordingDuration={recordingDuration}
                onPause={pauseRecording}
                onResume={resumeRecording}
                onStop={() => stopRecording('user_stop')}
                position="bottom"
              />
            </div>
          )}
        </div>

        {/* End / Leave Meeting Button (Opens Confirmation Modal) */}
        {isHost ? (
          <div className="flex items-center gap-2">
            <button
              onClick={handleToggleLock}
              className="px-3.5 py-2 border border-[#8b5cf6]/20 hover:border-[#8b5cf6]/40 bg-[#8b5cf6]/5 hover:bg-[#8b5cf6]/10 text-[#c084fc] hover:text-[#d8b4fe] rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer flex items-center gap-1.5"
            >
              {meetingData?.meeting_status === 'Locked' ? <Unlock size={12} /> : <Lock size={12} />}
              <span className="hidden sm:inline">{meetingData?.meeting_status === 'Locked' ? 'Unlock Room' : 'Lock Room'}</span>
            </button>
            <button
              onClick={handleDeleteMeeting}
              className="px-3.5 py-2 border border-red-500/20 hover:border-red-500/40 bg-red-600/5 hover:bg-red-600/10 text-red-400 hover:text-red-300 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer"
            >
              Delete
            </button>
            <Button
              variant="danger"
              data-testid="leave-room-button"
              onClick={() => setShowEndConfirmModal(true)}
              aria-label="End meeting"
              className="px-5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-red-600/25 cursor-pointer"
            >
              <PhoneOff size={14} />
              <span>End Meeting</span>
            </Button>
          </div>
        ) : (
          <Button
            variant="danger"
            data-testid="leave-room-button"
            onClick={() => setShowEndConfirmModal(true)}
            aria-label="Leave meeting"
            className="px-5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-red-600/25 cursor-pointer"
          >
            <PhoneOff size={14} />
            <span>Leave Meeting</span>
          </Button>
        )}
      </footer>

      {/* END / LEAVE MEETING CONFIRMATION MODAL */}
      {showEndConfirmModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4 select-none">
          <div className="max-w-md w-full bg-[#0c0e1b] border border-white/10 rounded-2xl p-6 flex flex-col gap-5 shadow-2xl text-left">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-red-600/20 border border-red-500/30 flex items-center justify-center text-red-400 shrink-0">
                <PhoneOff size={20} />
              </div>
              <div className="flex flex-col">
                <h3 className="text-base font-bold text-white">
                  {isHost ? 'End meeting for all?' : 'Leave meeting?'}
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  {isHost
                    ? 'You will end the meeting for all participants. Existing attendance records will be preserved.'
                    : 'Are you sure you want to leave this meeting session?'}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2 pt-2 border-t border-white/5">
              {isHost ? (
                <>
                  <Button
                    variant="danger"
                    data-testid="end-confirm-button"
                    onClick={() => {
                      setShowEndConfirmModal(false)
                      handleEndWithAttendance()
                    }}
                    className="w-full py-2.5 rounded-xl text-xs font-bold shadow-lg shadow-red-600/30 cursor-pointer"
                  >
                    End meeting for all
                  </Button>
                  <button
                    data-testid="leave-confirm-button"
                    onClick={() => {
                      setShowEndConfirmModal(false)
                      handleLeaveWithAttendance().catch((err) => {
                        console.error('[Leave Modal] Unexpected error leaving meeting:', err)
                        navigate('/')
                      })
                    }}
                    className="w-full py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white text-xs font-semibold transition-all cursor-pointer"
                  >
                    Leave meeting
                  </button>
                </>
              ) : (
                <Button
                  variant="danger"
                  data-testid="leave-confirm-button"
                  onClick={() => {
                    setShowEndConfirmModal(false)
                    handleLeaveWithAttendance().catch((err) => {
                      console.error('[Leave Modal] Unexpected error leaving meeting:', err)
                      navigate('/')
                    })
                  }}
                  className="w-full py-2.5 rounded-xl text-xs font-bold shadow-lg shadow-red-600/30 cursor-pointer"
                >
                  Leave meeting
                </Button>
              )}
              <button
                onClick={() => setShowEndConfirmModal(false)}
                className="w-full py-2 text-xs font-semibold text-gray-400 hover:text-white transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3-MINUTE WARNING MODAL (Host Only — Strict Rule: Display only once, never if already extended) */}
      <Modal
        isOpen={isWarningModalOpen && canManageMeeting && !isExtensionUsed}
        onClose={handleDeclineExtension}
        title="Meeting Ending Soon"
      >
        <div className="flex flex-col gap-4 text-center py-2 select-none">
          <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 mx-auto">
            <AlertTriangle size={24} />
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-bold text-white">Your meeting will end in 3 minutes</h3>
            <p className="text-xs text-gray-400">
              Do you want to extend the meeting? Time remaining:{' '}
              <span className="font-mono text-amber-400 font-bold">
                {formatCountdown(remainingSeconds)}
              </span>
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <button
              type="button"
              onClick={handleDeclineExtension}
              className="py-2.5 px-4 rounded-xl text-xs font-bold bg-white/5 border border-white/10 text-gray-300 hover:text-white hover:bg-white/10 transition-all cursor-pointer"
            >
              No, Don't Extend
            </button>
            <button
              type="button"
              onClick={handleOpenExtensionModal}
              className="py-2.5 px-4 rounded-xl text-xs font-bold bg-[#7c3aed] hover:bg-[#8b5cf6] text-white shadow-md shadow-purple-900/30 transition-all cursor-pointer"
            >
              Yes, Extend Meeting
            </button>
          </div>
        </div>
      </Modal>

      {/* HOST EXTEND MEETING TIME MODAL */}
      <Modal
        isOpen={isExtensionModalOpen && canManageMeeting && !isExtensionUsed}
        onClose={handleCancelExtension}
        title="Extend Meeting Time"
      >
        <div className="flex flex-col gap-4 text-left py-2 select-none">
          <p className="text-xs text-gray-400">
            Select additional time to add to the current scheduled deadline:
          </p>
          <div className="grid grid-cols-3 gap-2.5">
            {[5, 10, 15].map((mins) => (
              <button
                key={mins}
                type="button"
                onClick={() => setSelectedExtension(mins)}
                className={`py-3 px-3 rounded-xl text-xs font-bold border transition-all cursor-pointer flex flex-col items-center justify-center gap-1.5 ${
                  selectedExtension === mins
                    ? 'bg-[#7c3aed]/25 border-[#8b5cf6] text-white shadow-md shadow-purple-900/30'
                    : 'bg-white/2 border-white/5 text-gray-400 hover:text-white hover:border-white/20'
                }`}
              >
                <Clock size={16} className={selectedExtension === mins ? 'text-[#a78bfa]' : 'text-gray-500'} />
                <span>+{mins} min</span>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <button
              type="button"
              onClick={handleCancelExtension}
              disabled={isSubmittingExtension}
              className="py-2.5 px-4 rounded-xl text-xs font-bold bg-white/5 border border-white/10 text-gray-300 hover:text-white hover:bg-white/10 transition-all cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmExtension}
              disabled={!selectedExtension || isSubmittingExtension}
              className={`py-2.5 px-4 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                selectedExtension && !isSubmittingExtension
                  ? 'bg-[#7c3aed] hover:bg-[#8b5cf6] text-white shadow-md shadow-purple-900/30 cursor-pointer'
                  : 'bg-white/5 border border-white/5 text-gray-500 cursor-not-allowed'
              }`}
            >
              {isSubmittingExtension ? 'Extending...' : 'Extend Meeting'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}