import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  RealtimeKitProvider,
  useRealtimeKitClient,
  useRealtimeKitMeeting,
  useRealtimeKitSelector
} from '@cloudflare/realtimekit-react'
import { AlertTriangle } from 'lucide-react'
import { useMeetings } from '../../context/MeetingContext'
import {
  resolveMediaUserId,
  resolveInitialMediaState,
  saveMediaPreference
} from '../../utils/mediaPreferences'
import { resolveParticipantUserId } from './MeetingRoomView'
import MeetingRoomView from './MeetingRoomView'
import {
  getCameraErrorMessage,
  buildRealtimeKitClientOptions,
  shouldInitializeClient,
  shouldJoinRoom,
  deactivateCameraTrack,
  mapRealtimeKitConnectionState,
  normalizeRemoteParticipant,
  normalizeLocalParticipant,
  normalizeScreenShareTracks,
  isMediaActionPermitted,
  createParticipantListenerManager,
  leaveRealtimeKitSession
} from './realtimeKitAdapterUtils'

export {
  getCameraErrorMessage,
  buildRealtimeKitClientOptions,
  shouldInitializeClient,
  shouldJoinRoom,
  deactivateCameraTrack,
  mapRealtimeKitConnectionState,
  normalizeRemoteParticipant,
  normalizeLocalParticipant,
  normalizeScreenShareTracks,
  isMediaActionPermitted,
  createParticipantListenerManager,
  leaveRealtimeKitSession
}

// Safely access MeetingContext without throwing outside MeetingProvider
function useOptionalMeetingContext() {
  try {
    return useMeetings()
  } catch (_) {
    return null
  }
}

/**
 * Inner coordinator component that resides inside <RealtimeKitProvider>.
 * Directly connects to RealtimeKit hooks and provides normalized props to MeetingRoomView.
 */
export function RealtimeKitInner({
  meeting: meetingProp,
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
  const hookMeeting = useRealtimeKitMeeting()?.meeting
  const meeting = meetingProp || hookMeeting

  const [trackTick, setTrackTick] = useState(0)
  const forceTrackUpdate = useCallback(() => setTrackTick((t) => t + 1), [])

  const mediaInitRef = useRef(false)
  const mediaInitDoneRef = useRef(false)
  const micActionInFlightRef = useRef(false)
  const camActionInFlightRef = useRef(false)
  const activatedRef = useRef(false)
  const wasMutedByHostRef = useRef(false)

  // Track component mount state to protect against async lifecycle races (StrictMode-safe)
  const isMountedRef = useRef(true)

  // Track cloned camera MediaStreamTrack passed into RealtimeKit
  const clonedTrackRef = useRef(null)

  // Manager for remote participant event listeners (screenShareUpdate, videoUpdate, audioUpdate)
  const listenerManagerRef = useRef(null)
  if (!listenerManagerRef.current) {
    listenerManagerRef.current = createParticipantListenerManager({
      onUpdate: forceTrackUpdate
    })
  }

  const [micActive, setMicActive] = useState(() => {
    const resolved = resolveInitialMediaState({
      userId: user?.id,
      isHost: isHostProp,
      muteAllEnabled: Boolean(meetingData?.mute_all_enabled)
    })
    return resolved.shouldEnableMic
  })
  const [camActive, setCamActive] = useState(() => {
    const resolved = resolveInitialMediaState({
      userId: user?.id,
      isHost: isHostProp,
      muteAllEnabled: Boolean(meetingData?.mute_all_enabled)
    })
    return resolved.shouldEnableCam
  })
  const [sharingActive, setSharingActive] = useState(false)
  const [camError, setCamError] = useState(null)
  const [camInitializing, setCamInitializing] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)

  // Host role calculations
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

  const canManageMeeting = isOriginalHost || isActiveHost
  const canManageHostAssignment = isOriginalHost
  const isHost = canManageMeeting

  // Subscribe to RealtimeKit reactive state slices
  const roomJoined = useRealtimeKitSelector((m) => m?.self?.roomJoined)
  const roomState = useRealtimeKitSelector((m) => m?.self?.roomState)
  const selfObj = useRealtimeKitSelector((m) => m?.self)
  const joinedParticipantsMap = useRealtimeKitSelector((m) => m?.participants?.joined)

  const effectiveMediaUserId = useMemo(
    () => resolveMediaUserId(user, selfObj, resolveParticipantUserId, dbParticipants),
    [user, selfObj, dbParticipants]
  )

  // Physical camera management (shared between MeetingRoom and MediaPipe Attendance)
  const physicalCameraStreamRef = useRef(null)
  const physicalCameraTrackRef = useRef(null)
  const acquiringCameraPromiseRef = useRef(null)
  const attendanceNeedsCameraRef = useRef(Boolean(meetingData?.enable_ai_attendance && attendanceConsent === 'Granted'))
  const meetingCamActiveRef = useRef(false)
  const meetingDataRef = useRef(meetingData)
  const attendanceConsentRef = useRef(attendanceConsent)

  useEffect(() => {
    meetingDataRef.current = meetingData
  }, [meetingData])

  useEffect(() => {
    attendanceConsentRef.current = attendanceConsent
  }, [attendanceConsent])

  useEffect(() => {
    if (meetingData?.enable_ai_attendance && attendanceConsent === 'Granted') {
      attendanceNeedsCameraRef.current = true
    }
  }, [meetingData?.enable_ai_attendance, attendanceConsent])

  const getOrCreatePhysicalTrack = useCallback(async () => {
    if (physicalCameraTrackRef.current && physicalCameraTrackRef.current.readyState === 'live') {
      return physicalCameraTrackRef.current
    }
    if (physicalCameraTrackRef.current && physicalCameraTrackRef.current.readyState === 'ended') {
      physicalCameraTrackRef.current = null
      physicalCameraStreamRef.current = null
    }
    if (acquiringCameraPromiseRef.current) {
      const pendingTrack = await acquiringCameraPromiseRef.current
      if (pendingTrack && pendingTrack.readyState === 'live') {
        return pendingTrack
      }
      physicalCameraTrackRef.current = null
      physicalCameraStreamRef.current = null
    }

    acquiringCameraPromiseRef.current = (async () => {
      try {
        console.log('[Camera Architecture] Acquiring single physical camera stream via getUserMedia...')
        let stream
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
            audio: false
          })
        } catch (firstErr) {
          const isBusyError = firstErr.name === 'NotReadableError' ||
                              firstErr.name === 'TrackStartError' ||
                              (firstErr.message && firstErr.message.toLowerCase().includes('could not start video source'))
          if (isBusyError) {
            console.warn('[Camera Architecture] Camera hardware transiently busy, retrying in 400ms...')
            await new Promise((r) => setTimeout(r, 400))
            stream = await navigator.mediaDevices.getUserMedia({
              video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
              audio: false
            })
          } else {
            throw firstErr
          }
        }

        physicalCameraStreamRef.current = stream
        const track = stream.getVideoTracks()[0]
        physicalCameraTrackRef.current = track

        track.onended = () => {
          console.warn('[Camera Architecture] Physical camera track ended by hardware/OS')
          physicalCameraTrackRef.current = null
          physicalCameraStreamRef.current = null
        }
        return track
      } finally {
        acquiringCameraPromiseRef.current = null
      }
    })()

    const liveTrack = await acquiringCameraPromiseRef.current
    return liveTrack
  }, [])

  const releasePhysicalCameraIfUnneeded = useCallback(() => {
    const isConsentGranted = attendanceConsentRef.current === 'Granted' || attendanceConsent === 'Granted'
    const isAttendanceMeeting = Boolean(meetingDataRef.current?.enable_ai_attendance || meetingData?.enable_ai_attendance)
    const isLeaving = Boolean(isIntentionalLeaveRef?.current)

    const attendanceNeeds = (isAttendanceMeeting && isConsentGranted && !isLeaving) || Boolean(attendanceNeedsCameraRef.current && !isLeaving)
    const meetingNeeds = Boolean(meetingCamActiveRef.current && !isLeaving)
    console.log(`[Camera Architecture] Check release: attendanceNeeds=${attendanceNeeds}, meetingNeeds=${meetingNeeds}, isConsentGranted=${isConsentGranted}`)
    if (!attendanceNeeds && !meetingNeeds) {
      if (physicalCameraStreamRef.current) {
        console.log('[Camera Architecture] Neither Attendance nor Meeting Room need camera. Stopping physical tracks.')
        try {
          physicalCameraStreamRef.current.getTracks().forEach((track) => track.stop())
        } catch (e) {
          console.error('[Camera Architecture] Error stopping physical stream tracks:', e)
        }
        physicalCameraStreamRef.current = null
      }
      if (physicalCameraTrackRef.current) {
        try {
          physicalCameraTrackRef.current.stop()
        } catch (_) {}
        physicalCameraTrackRef.current = null
      }
    }
  }, [attendanceConsent, meetingData?.enable_ai_attendance, isIntentionalLeaveRef])

  // Mount/unmount lifecycle guard: restores isMountedRef on mount/remount and cleans up adapter-owned clones
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      deactivateCameraTrack({
        clonedTrackRef,
        meetingCamActiveRef,
        releasePhysicalCameraIfUnneeded
      })
    }
  }, [releasePhysicalCameraIfUnneeded])

  // Resume remote audio playback if browser blocked initial autoplay before user interaction
  useEffect(() => {
    if (!meeting?.audio) return

    const handleUserGesture = () => {
      if (typeof meeting.audio?.play === 'function') {
        meeting.audio.play().catch((err) => {
          if (err?.name !== 'NotAllowedError') {
            console.warn('[RealtimeKit Audio] Playback resume warning:', err)
          }
        })
      }
    }

    window.addEventListener('click', handleUserGesture, { passive: true })
    window.addEventListener('keydown', handleUserGesture, { passive: true })

    return () => {
      window.removeEventListener('click', handleUserGesture)
      window.removeEventListener('keydown', handleUserGesture)
    }
  }, [meeting?.audio])

  // Keep initial UI button states aligned with saved preferences before media initializes
  useEffect(() => {
    if (mediaInitRef.current) return
    const resolved = resolveInitialMediaState({
      userId: effectiveMediaUserId,
      isHost,
      muteAllEnabled: Boolean(meetingData?.mute_all_enabled)
    })
    setMicActive(resolved.shouldEnableMic)
    setCamActive(resolved.shouldEnableCam)
  }, [effectiveMediaUserId, isHost, meetingData?.mute_all_enabled])

  // RealtimeKit event listeners for track updates, participant updates, and room lifecycle
  useEffect(() => {
    if (!meeting) return

    const handleUpdate = () => {
      forceTrackUpdate()
    }

    const onRoomJoined = ({ reconnected } = {}) => {
      console.log('[RealtimeKit] Room joined! reconnected:', reconnected)
      if (reconnected) {
        setIsReconnecting(false)
      }
      forceTrackUpdate()
    }

    const onRoomLeft = ({ state } = {}) => {
      console.log('[RealtimeKit] Room left, state:', state)
      forceTrackUpdate()
    }

    const onWaitlisted = () => {
      console.log('[RealtimeKit] Participant is waitlisted')
      forceTrackUpdate()
    }

    const onParticipantJoined = (p) => {
      listenerManagerRef.current?.attach(p)
      forceTrackUpdate()
    }

    const onParticipantLeft = (p) => {
      if (p?.id) {
        listenerManagerRef.current?.detach(p.id)
      }
      forceTrackUpdate()
    }

    const onParticipantsUpdate = () => {
      if (meeting.participants?.joined) {
        listenerManagerRef.current?.reconcile(meeting.participants.joined)
      }
      forceTrackUpdate()
    }

    meeting.self?.on?.('roomJoined', onRoomJoined)
    meeting.self?.on?.('roomLeft', onRoomLeft)
    meeting.self?.on?.('waitlisted', onWaitlisted)
    meeting.self?.on?.('videoUpdate', handleUpdate)
    meeting.self?.on?.('audioUpdate', handleUpdate)
    meeting.self?.on?.('screenShareUpdate', handleUpdate)

    meeting.participants?.joined?.on?.('participantJoined', onParticipantJoined)
    meeting.participants?.joined?.on?.('participantLeft', onParticipantLeft)
    meeting.participants?.joined?.on?.('participantsUpdate', onParticipantsUpdate)

    // Reconcile listeners for any participants already present when mounting
    if (meeting.participants?.joined) {
      listenerManagerRef.current?.reconcile(meeting.participants.joined)
    }

    return () => {
      meeting.self?.removeListener?.('roomJoined', onRoomJoined)
      meeting.self?.removeListener?.('roomLeft', onRoomLeft)
      meeting.self?.removeListener?.('waitlisted', onWaitlisted)
      meeting.self?.removeListener?.('videoUpdate', handleUpdate)
      meeting.self?.removeListener?.('audioUpdate', handleUpdate)
      meeting.self?.removeListener?.('screenShareUpdate', handleUpdate)

      meeting.participants?.joined?.removeListener?.('participantJoined', onParticipantJoined)
      meeting.participants?.joined?.removeListener?.('participantLeft', onParticipantLeft)
      meeting.participants?.joined?.removeListener?.('participantsUpdate', onParticipantsUpdate)

      // Clean up all participant listeners on unmount
      listenerManagerRef.current?.cleanupAll()
    }
  }, [meeting, forceTrackUpdate])

  // Reconcile listeners whenever joinedParticipantsMap updates
  useEffect(() => {
    if (joinedParticipantsMap && listenerManagerRef.current) {
      listenerManagerRef.current.reconcile(joinedParticipantsMap)
    }
  }, [joinedParticipantsMap])

  // Socket.IO listener for host_mute_toggle
  useEffect(() => {
    const currentSocket = socket?.current
    if (!currentSocket) return

    const handleHostMuteToggle = async ({ userId, participantIdentity, mute }) => {
      const currentUid = user?.id
      const localIdentity = selfObj?.customParticipantId || selfObj?.id
      const isMe = (currentUid && userId === currentUid) ||
                   (localIdentity && participantIdentity === localIdentity) ||
                   (currentUid && participantIdentity === currentUid)

      console.log(`[Host Mute Event] Received host_mute_toggle for isMe=${isMe}, mute=${mute}, localIdentity=${localIdentity}, participantIdentity=${participantIdentity}`)

      if (isMe && meeting?.self && isMediaActionPermitted(meeting.self)) {
        if (mute) {
          try {
            wasMutedByHostRef.current = true
            console.log('[Host Remote Mute] Disabling local microphone via disableAudio()...')
            await meeting.self.disableAudio()
            setMicActive(false)
            showToast('The host muted your microphone.', 'info')
          } catch (err) {
            console.error('[Host Remote Mute Error] Failed to disable microphone:', err)
          }
        } else {
          if (wasMutedByHostRef.current) {
            try {
              wasMutedByHostRef.current = false
              console.log('[Host Remote Unmute] Restoring local microphone via enableAudio()...')
              await meeting.self.enableAudio()
              setMicActive(true)
              showToast('Microphone unmuted.', 'success')
            } catch (err) {
              console.error('[Host Remote Unmute Error] Failed to enable microphone:', err)
            }
          } else {
            console.log('[Host Remote Unmute] Ignoring host unmute because microphone was not muted by host.')
          }
        }
      }
    }

    currentSocket.on('host_mute_toggle', handleHostMuteToggle)

    return () => {
      currentSocket.off('host_mute_toggle', handleHostMuteToggle)
    }
  }, [socket, user, selfObj, meeting?.self, showToast])

  // Socket.IO listener for meeting_mute_all_changed
  useEffect(() => {
    const currentSocket = socket?.current
    if (!currentSocket) return

    const handleMuteAllChanged = async ({ muteAllEnabled }) => {
      console.log('[Security Socket] meeting_mute_all_changed received:', muteAllEnabled)
      setMeetingData((prev) => (prev ? { ...prev, mute_all_enabled: !!muteAllEnabled } : null))

      if (muteAllEnabled && !isHost && meeting?.self && isMediaActionPermitted(meeting.self)) {
        try {
          wasMutedByHostRef.current = true
          console.log('[Mute All Socket] Host enabled Mute All. Disabling local microphone...')
          await meeting.self.disableAudio()
          setMicActive(false)
          showToast('The host has locked all participant microphones.', 'info')
        } catch (err) {
          console.error('[Mute All Socket Error] Failed to disable microphone:', err)
        }
      } else if (!muteAllEnabled && !isHost) {
        showToast('Microphones are no longer locked by the host.', 'info')
      }
    }

    currentSocket.on('meeting_mute_all_changed', handleMuteAllChanged)

    return () => {
      currentSocket.off('meeting_mute_all_changed', handleMuteAllChanged)
    }
  }, [socket, isHost, meeting?.self, setMeetingData, showToast])

  // Synchronize local participant name with profile
  useEffect(() => {
    if (!meeting?.self || !isMediaActionPermitted(meeting.self)) return
    const currentName = (user?.name || user?.full_name || '').trim()
    if (currentName && meeting.self.name !== currentName) {
      console.log(`[Participant Sync] Updating RealtimeKit self name from "${meeting.self.name}" to "${currentName}"`)
      try {
        meeting.self.setName(currentName)
      } catch (err) {
        console.warn('[Participant Sync] Failed to update self name via RealtimeKit:', err)
      }
    }
  }, [meeting?.self, user?.name, user?.full_name])

  // Transition meeting to ACTIVE and initialize media ONLY when room is connected
  useEffect(() => {
    const initRoomSession = async () => {
      try {
        const isJoined = Boolean(meeting?.self?.roomJoined || meeting?.self?.roomState === 'joined')
        if (!meeting || !isJoined) {
          return
        }

        if (!activatedRef.current && meetingData?.meeting_id) {
          activatedRef.current = true
          console.log('[Activate] Cloudflare RealtimeKit connected! Activating meeting:', meetingData.meeting_id)
          activateMeeting(meetingData.meeting_id).then((res) => {
            if (res?.scheduledEndTime) {
              setMeetingData((prev) => (prev ? {
                ...prev,
                scheduled_end_time: res.scheduledEndTime,
                meeting_status: 'Active'
              } : null))
            }
          }).catch(console.error)
        }

        if (mediaInitRef.current) return
        mediaInitRef.current = true
        micActionInFlightRef.current = true
        camActionInFlightRef.current = true

        console.log('[Media Init] RealtimeKit connected! Restoring saved media preferences for user:', effectiveMediaUserId)

        try {
          const { shouldEnableMic, shouldEnableCam } = resolveInitialMediaState({
            userId: effectiveMediaUserId,
            isHost,
            muteAllEnabled: Boolean(meetingData?.mute_all_enabled)
          })

          // 1. Microphone initialization
          if (shouldEnableMic) {
            try {
              await meeting.self.enableAudio()
              if (isMountedRef.current) {
                setMicActive(true)
              }
            } catch (micErr) {
              console.warn('[RealtimeKit Media Init] enableAudio failed:', micErr)
              if (isMountedRef.current) {
                setMicActive(false)
              }
            }
          } else {
            try {
              await meeting.self.disableAudio()
              if (isMountedRef.current) {
                setMicActive(false)
              }
            } catch (_) {}
          }

          // 2. Camera initialization (cloning physical track)
          if (isMountedRef.current) {
            setCamError(null)
          }
          if (shouldEnableCam) {
            if (isMountedRef.current) {
              setCamInitializing(true)
            }
            try {
              meetingCamActiveRef.current = true
              const physicalTrack = await getOrCreatePhysicalTrack()
              if (!isMountedRef.current) {
                meetingCamActiveRef.current = false
                releasePhysicalCameraIfUnneeded()
                return
              }
              const clonedTrack = physicalTrack.clone()
              if (!isMountedRef.current) {
                clonedTrack.stop()
                meetingCamActiveRef.current = false
                releasePhysicalCameraIfUnneeded()
                return
              }
              clonedTrackRef.current = clonedTrack
              await meeting.self.enableVideo(clonedTrack)
              if (!isMountedRef.current) {
                deactivateCameraTrack({
                  clonedTrackRef,
                  meetingCamActiveRef,
                  releasePhysicalCameraIfUnneeded
                })
                return
              }
              setCamActive(true)
            } catch (camErr) {
              meetingCamActiveRef.current = false
              if (clonedTrackRef.current) {
                try {
                  clonedTrackRef.current.stop()
                } catch (_) {}
                clonedTrackRef.current = null
              }
              releasePhysicalCameraIfUnneeded()
              const msg = getCameraErrorMessage(camErr)
              if (isMountedRef.current) {
                setCamError(msg)
                showToast?.(msg, 'error')
                setCamActive(false)
              }
            } finally {
              if (isMountedRef.current) {
                setCamInitializing(false)
              }
            }
          } else {
            meetingCamActiveRef.current = false
            try {
              await meeting.self.disableVideo()
            } catch (_) {}
            if (clonedTrackRef.current) {
              try {
                clonedTrackRef.current.stop()
              } catch (_) {}
              clonedTrackRef.current = null
            }
            releasePhysicalCameraIfUnneeded()
            if (isMountedRef.current) {
              setCamActive(false)
            }
          }
        } finally {
          mediaInitDoneRef.current = true
          micActionInFlightRef.current = false
          camActionInFlightRef.current = false
          if (isMountedRef.current) {
            forceTrackUpdate()
          }
        }
      } catch (globalErr) {
        mediaInitDoneRef.current = true
        micActionInFlightRef.current = false
        camActionInFlightRef.current = false
        console.error('[Media Init] Unhandled error during RealtimeKit media initialization:', globalErr)
      }
    }

    initRoomSession()
  }, [
    meeting,
    meeting?.self?.roomJoined,
    meeting?.self?.roomState,
    effectiveMediaUserId,
    isHost,
    meetingData?.meeting_id,
    meetingData?.mute_all_enabled,
    activateMeeting,
    showToast,
    getOrCreatePhysicalTrack,
    releasePhysicalCameraIfUnneeded,
    forceTrackUpdate,
    setMeetingData
  ])

  // Handle microphone toggle
  const handleToggleMic = async () => {
    if (!meeting?.self || !isMediaActionPermitted(meeting.self) || micActionInFlightRef.current) return
    if (!isHost && meetingData?.mute_all_enabled) {
      showToast('The host has locked all participant microphones.', 'info')
      return
    }
    micActionInFlightRef.current = true
    try {
      if (micActive) {
        saveMediaPreference(effectiveMediaUserId, { micEnabled: false })
        await meeting.self.disableAudio()
        if (isMountedRef.current) {
          setMicActive(false)
        }
        showToast('Microphone muted', 'info')
      } else {
        wasMutedByHostRef.current = false
        await meeting.self.enableAudio()
        saveMediaPreference(effectiveMediaUserId, { micEnabled: true })
        if (isMountedRef.current) {
          setMicActive(true)
        }
        showToast('Microphone unmuted', 'success')
      }
    } catch (err) {
      console.error('[RealtimeKit Mic Toggle] Failed:', err)
      showToast('Failed to toggle microphone.', 'error')
    } finally {
      micActionInFlightRef.current = false
      if (isMountedRef.current) {
        forceTrackUpdate()
      }
    }
  }

  // Handle camera toggle with strict lifecycle and cloning guards
  const handleToggleCam = async () => {
    if (!meeting?.self || !isMediaActionPermitted(meeting.self) || camActionInFlightRef.current) return
    camActionInFlightRef.current = true
    try {
      if (isMountedRef.current) {
        setCamError(null)
      }
      if (camActive) {
        // Turning camera OFF
        saveMediaPreference(effectiveMediaUserId, { camEnabled: false })
        meetingCamActiveRef.current = false
        try {
          await meeting.self.disableVideo()
        } catch (err) {
          console.warn('[RealtimeKit Camera Toggle] Failed to disable video:', err)
        }
        if (clonedTrackRef.current) {
          try {
            clonedTrackRef.current.stop()
          } catch (_) {}
          clonedTrackRef.current = null
        }
        releasePhysicalCameraIfUnneeded()
        if (isMountedRef.current) {
          setCamActive(false)
        }
        showToast('Camera turned off', 'info')
      } else {
        // Turning camera ON
        if (isMountedRef.current) {
          setCamInitializing(true)
        }
        try {
          meetingCamActiveRef.current = true
          const physicalTrack = await getOrCreatePhysicalTrack()
          if (!isMountedRef.current) {
            meetingCamActiveRef.current = false
            releasePhysicalCameraIfUnneeded()
            return
          }
          const clonedTrack = physicalTrack.clone()
          if (!isMountedRef.current) {
            clonedTrack.stop()
            meetingCamActiveRef.current = false
            releasePhysicalCameraIfUnneeded()
            return
          }
          clonedTrackRef.current = clonedTrack
          await meeting.self.enableVideo(clonedTrack)
          if (!isMountedRef.current) {
            deactivateCameraTrack({
              clonedTrackRef,
              meetingCamActiveRef,
              releasePhysicalCameraIfUnneeded
            })
            return
          }
          saveMediaPreference(effectiveMediaUserId, { camEnabled: true })
          setCamActive(true)
          showToast('Camera turned on', 'success')
        } catch (err) {
          meetingCamActiveRef.current = false
          if (clonedTrackRef.current) {
            try {
              clonedTrackRef.current.stop()
            } catch (_) {}
            clonedTrackRef.current = null
          }
          releasePhysicalCameraIfUnneeded()
          const msg = getCameraErrorMessage(err)
          if (isMountedRef.current) {
            setCamError(msg)
            showToast(msg, 'error')
            setCamActive(false)
          }
        } finally {
          if (isMountedRef.current) {
            setCamInitializing(false)
          }
        }
      }
    } finally {
      camActionInFlightRef.current = false
      if (isMountedRef.current) {
        forceTrackUpdate()
      }
    }
  }

  // Handle screen share toggle
  const handleToggleShare = async () => {
    if (!meeting?.self || !isMediaActionPermitted(meeting.self)) return
    try {
      const nextState = !sharingActive
      console.log(`[RealtimeKit ScreenShare Toggle] Setting screen share to ${nextState ? 'ON' : 'OFF'}...`)
      if (nextState) {
        await meeting.self.enableScreenShare()
        if (isMountedRef.current) {
          setSharingActive(true)
        }
        showToast('Screen sharing started', 'info')
      } else {
        await meeting.self.disableScreenShare()
        if (isMountedRef.current) {
          setSharingActive(false)
        }
        showToast('Screen sharing stopped', 'info')
      }
    } catch (err) {
      console.error('[RealtimeKit ScreenShare Toggle] Failed:', err)
      showToast('Failed to toggle screen sharing.', 'error')
    }
  }

  // Normalize participants
  const localParticipant = useMemo(() => {
    if (!meeting?.self) return null
    return normalizeLocalParticipant({
      self: meeting.self,
      user,
      isHost
    })
  }, [meeting?.self, user, isHost, trackTick])

  const rawJoinedArray = useMemo(() => {
    if (!joinedParticipantsMap) return []
    if (typeof joinedParticipantsMap.toArray === 'function') {
      return joinedParticipantsMap.toArray()
    }
    return Array.from(joinedParticipantsMap.values())
  }, [joinedParticipantsMap, trackTick])

  const participants = useMemo(() => {
    return rawJoinedArray.map((p) => normalizeRemoteParticipant(p)).filter(Boolean)
  }, [rawJoinedArray])

  const allParticipants = useMemo(() => {
    const raw = [localParticipant, ...(participants || [])].filter(Boolean)
    const pMap = new Map()
    raw.forEach((p) => {
      const key = p.id || p.identity || p.sid
      if (key && !pMap.has(key)) {
        pMap.set(key, p)
      }
    })
    return Array.from(pMap.values())
  }, [localParticipant, participants])

  // Screen share tracks compatible with ScreenShareView.jsx
  const tracks = useMemo(() => {
    return normalizeScreenShareTracks({
      self: meeting?.self,
      remoteParticipants: participants
    })
  }, [meeting?.self, participants, sharingActive, trackTick])

  // Connection state
  const connectionState = useMemo(() => {
    return mapRealtimeKitConnectionState({
      roomJoined,
      roomState,
      isReconnecting
    })
  }, [roomJoined, roomState, isReconnecting])

  // Single-flight guard and comprehensive participant leave handler
  const isLeavingRef = useRef(false)

  const handleAdapterLeave = useCallback(async () => {
    if (isLeavingRef.current) {
      console.log('[RealtimeKitAdapter] Leave already in-flight, skipping duplicate call.')
      return
    }
    isLeavingRef.current = true
    if (isIntentionalLeaveRef) {
      isIntentionalLeaveRef.current = true
    }
    console.log('[RealtimeKitAdapter] Executing participant leave and session cleanup...')

    try {
      await leaveRealtimeKitSession({
        meeting,
        clonedTrackRef,
        meetingCamActiveRef,
        releasePhysicalCameraIfUnneeded,
        listenerManager: listenerManagerRef.current
      })
    } catch (err) {
      console.warn('[RealtimeKitAdapter] Error during leaveRealtimeKitSession:', err)
    }

    if (typeof handleLeave === 'function') {
      try {
        await handleLeave()
      } catch (err) {
        console.error('[RealtimeKitAdapter] Upstream handleLeave error:', err)
      }
    }
  }, [meeting, handleLeave, isIntentionalLeaveRef, releasePhysicalCameraIfUnneeded])

  return (
    <MeetingRoomView
      room={meeting}
      localParticipant={localParticipant}
      participants={participants}
      allParticipants={allParticipants}
      tracks={tracks}
      connectionState={connectionState}
      isReconnecting={isReconnecting}
      roomState={roomJoined || roomState === 'joined' ? 'connected' : (roomState || 'init')}
      micActive={micActive}
      camActive={camActive}
      sharingActive={sharingActive}
      camInitializing={camInitializing}
      camError={camError}
      onToggleMic={handleToggleMic}
      onToggleCam={handleToggleCam}
      onToggleShare={handleToggleShare}
      getOrCreatePhysicalTrack={getOrCreatePhysicalTrack}
      releasePhysicalCameraIfUnneeded={releasePhysicalCameraIfUnneeded}
      attendanceNeedsCameraRef={attendanceNeedsCameraRef}
      meetingCamActiveRef={meetingCamActiveRef}
      physicalCameraStreamRef={physicalCameraStreamRef}
      meetingData={meetingData}
      setMeetingData={setMeetingData}
      isHost={isHost}
      canManageMeeting={canManageMeeting}
      canManageHostAssignment={canManageHostAssignment}
      isOriginalHost={isOriginalHost}
      isAssignedHost={isAssignedHost}
      isActiveHost={isActiveHost}
      handleLeave={handleAdapterLeave}
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
      expireMeeting={expireMeeting}
      socket={socket}
      socketReady={socketReady}
      chatMessages={chatMessages}
      setChatMessages={setChatMessages}
      ephemeralChatMessages={ephemeralChatMessages}
      setEphemeralChatMessages={setEphemeralChatMessages}
      ephemeralChatPolicy={ephemeralChatPolicy}
      setEphemeralChatPolicy={setEphemeralChatPolicy}
      activeChatConvTab={activeChatConvTab}
      setActiveChatConvTab={setActiveChatConvTab}
      selectedChatRecipient={selectedChatRecipient}
      setSelectedChatRecipient={setSelectedChatRecipient}
      typingUsers={typingUsers}
      setTypingUsers={setTypingUsers}
      handleLeaveWithAttendanceRef={handleLeaveWithAttendanceRef}
      waitingRequests={waitingRequests}
      fetchWaitingRequests={fetchWaitingRequests}
      isIntentionalLeaveRef={isIntentionalLeaveRef}
      dbParticipants={dbParticipants}
    />
  )
}

/**
 * RealtimeKitAdapter
 *
 * Provider adapter for Cloudflare RealtimeKit SDK v2.0.4.
 * Wraps meeting room presentation with RealtimeKitProvider and maps
 * SDK state and methods to the shared MeetingRoomView interface.
 */
export default function RealtimeKitAdapter(props) {
  const meetingContext = useOptionalMeetingContext()
  const effectiveToken = props.cloudflareToken || props.token || meetingContext?.cloudflareToken

  const [client, initClient] = useRealtimeKitClient({ resetOnLeave: true })
  const [initError, setInitError] = useState(null)
  const [, setRetryCount] = useState(0)

  const clientRef = useRef(null)
  const lastInitializedTokenRef = useRef(null)
  const isInitializingRef = useRef(false)
  const isJoiningRef = useRef(false)
  const unmountTimerRef = useRef(null)

  // Allow passing an already-initialized client (for testing or external management)
  const effectiveClient = props.client || props.meeting || client

  useEffect(() => {
    clientRef.current = effectiveClient
  }, [effectiveClient])

  // Lifecycle-safe client initialization with duplicate, retry, and token-refresh protection
  useEffect(() => {
    if (props.client || props.meeting) return

    const canInit = shouldInitializeClient({
      effectiveToken,
      lastInitializedToken: lastInitializedTokenRef.current,
      isInitializing: isInitializingRef.current,
      hasError: Boolean(initError),
      hasClient: Boolean(client)
    })

    if (!canInit) return

    isInitializingRef.current = true
    setInitError(null)

    const clientOptions = buildRealtimeKitClientOptions(effectiveToken)
    console.log('[RealtimeKitAdapter] Initializing RealtimeKit client with options (experimentalAudioPlayback enabled)...')

    initClient(clientOptions)
      .then((createdClient) => {
        if (createdClient) {
          lastInitializedTokenRef.current = effectiveToken
          console.log('[RealtimeKitAdapter] RealtimeKit client initialized successfully')
        }
      })
      .catch((err) => {
        console.error('[RealtimeKitAdapter] Failed to initialize RealtimeKit client:', err)
        lastInitializedTokenRef.current = null
        setInitError(err)
      })
      .finally(() => {
        isInitializingRef.current = false
      })
  }, [effectiveToken, props.client, props.meeting, initClient, initError, client])

  // Automatically join room session if roomJoined is false with single-flight guard
  useEffect(() => {
    if (!effectiveClient) return

    const canJoin = shouldJoinRoom({
      client: effectiveClient,
      isJoining: isJoiningRef.current
    })

    if (!canJoin) return

    isJoiningRef.current = true
    console.log('[RealtimeKitAdapter] Auto-joining room session...')
    effectiveClient
      .join()
      .catch((err) => {
        console.error('[RealtimeKitAdapter] Failed to join room:', err)
      })
      .finally(() => {
        isJoiningRef.current = false
      })
  }, [effectiveClient])

  // Meeting leave and unmount orchestration:
  // Immediately leaves if marked intentional; slightly defers cleanup otherwise to protect React Strict Mode
  useEffect(() => {
    if (unmountTimerRef.current) {
      clearTimeout(unmountTimerRef.current)
      unmountTimerRef.current = null
    }

    return () => {
      // Immediate leave if explicitly marked intentional
      if (props.isIntentionalLeaveRef?.current) {
        if (clientRef.current && typeof clientRef.current.leave === 'function') {
          try {
            clientRef.current.leave('left').catch(() => {})
          } catch (_) {}
        }
        return
      }

      // Deferred leave for genuine navigation/unmount (protects React Strict Mode's synchronous remount)
      unmountTimerRef.current = setTimeout(() => {
        if (clientRef.current && typeof clientRef.current.leave === 'function') {
          try {
            console.log('[RealtimeKitAdapter] Genuine unmount detected. Leaving room session.')
            clientRef.current.leave('left').catch(() => {})
          } catch (_) {}
        }
      }, 150)
    }
  }, [props.isIntentionalLeaveRef])

  // Browser closing / refresh termination listener
  useEffect(() => {
    const handleWindowLeave = () => {
      if (clientRef.current && typeof clientRef.current.leave === 'function') {
        try {
          clientRef.current.leave('left').catch(() => {})
        } catch (_) {}
      }
    }
    window.addEventListener('beforeunload', handleWindowLeave)
    window.addEventListener('pagehide', handleWindowLeave)
    return () => {
      window.removeEventListener('beforeunload', handleWindowLeave)
      window.removeEventListener('pagehide', handleWindowLeave)
    }
  }, [])

  if (initError) {
    return (
      <div className="fixed inset-0 z-50 bg-[#04050b] flex flex-col items-center justify-center p-6 text-center select-none">
        <div className="max-w-md w-full bg-slate-900/90 border border-red-500/20 rounded-2xl p-6 flex flex-col items-center gap-4 shadow-2xl">
          <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 font-bold text-xl">
            <AlertTriangle size={24} />
          </div>
          <h2 className="text-base font-bold text-white">Cloudflare RealtimeKit Error</h2>
          <p className="text-xs text-red-300 bg-red-950/40 border border-red-900/50 p-3 rounded-xl w-full text-left font-mono break-words">
            {initError?.message || String(initError)}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setInitError(null)
                lastInitializedTokenRef.current = null
                isInitializingRef.current = false
                setRetryCount((c) => c + 1)
              }}
              className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold cursor-pointer"
            >
              Retry Connection
            </button>
            <button
              type="button"
              onClick={() => (props.handleLeave ? props.handleLeave() : window.location.reload())}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold cursor-pointer"
            >
              Return to Dashboard
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!effectiveClient) {
    return (
      <div className="fixed inset-0 z-50 bg-[#04050b] flex flex-col items-center justify-center p-6 text-center select-none">
        <div className="w-8 h-8 rounded-full border-2 border-white/10 border-t-purple-500 animate-spin mb-3" />
        <span className="text-xs font-semibold text-gray-300">Connecting to Cloudflare RealtimeKit...</span>
      </div>
    )
  }

  return (
    <RealtimeKitProvider value={effectiveClient}>
      <RealtimeKitInner {...props} meeting={effectiveClient} />
    </RealtimeKitProvider>
  )
}
