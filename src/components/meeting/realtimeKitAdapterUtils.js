/**
 * Pure normalization and utility functions for Cloudflare RealtimeKit adapter.
 * Extracted into a pure ES module so they can be consumed by both React components
 * and Node.js unit tests without requiring a JSX transpiler.
 */

// Helper: convert camera/getUserMedia errors into user-friendly messages
export function getCameraErrorMessage(err) {
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

/**
 * Builds the canonical client options for RealtimeKit SDK v2.0.4.
 * Explicitly enables the verified remote audio playback module:
 * modules: { experimentalAudioPlayback: true }
 */
export function buildRealtimeKitClientOptions(authToken) {
  return {
    authToken,
    defaults: {
      video: false,
      audio: false
    },
    modules: {
      experimentalAudioPlayback: true
    }
  }
}

/**
 * Determines whether client initialization should execute.
 * - Prevents duplicate concurrent in-flight initializations.
 * - Allows retry after failure with the same token.
 * - Allows re-initialization when a new token arrives (waiting-room admission or token refresh).
 * - Allows re-initialization if client reference was lost or reset.
 */
export function shouldInitializeClient({
  effectiveToken,
  lastInitializedToken,
  isInitializing = false,
  hasError = false,
  hasClient = false
}) {
  if (!effectiveToken || typeof effectiveToken !== 'string' || !effectiveToken.trim()) {
    return false
  }
  if (isInitializing) {
    return false
  }
  if (hasError && effectiveToken === lastInitializedToken) {
    return true
  }
  if (effectiveToken !== lastInitializedToken) {
    return true
  }
  if (!hasClient) {
    return true
  }
  return false
}

/**
 * Determines whether client.join() should execute.
 * - Prevents duplicate concurrent in-flight join attempts.
 * - Avoids calling join() if the room is already joined.
 */
export function shouldJoinRoom({ client, isJoining = false }) {
  if (!client || typeof client.join !== 'function') {
    return false
  }
  if (isJoining) {
    return false
  }
  const isJoined = Boolean(client.self?.roomJoined || client.self?.roomState === 'joined')
  if (isJoined) {
    return false
  }
  return true
}

/**
 * Safely deactivates adapter camera tracks and invokes shared camera release.
 * Idempotent: safe to invoke repeatedly without side-effects.
 */
export function deactivateCameraTrack({
  clonedTrackRef,
  meetingCamActiveRef,
  releasePhysicalCameraIfUnneeded
}) {
  if (meetingCamActiveRef) {
    meetingCamActiveRef.current = false
  }
  if (clonedTrackRef && clonedTrackRef.current) {
    try {
      if (typeof clonedTrackRef.current.stop === 'function') {
        clonedTrackRef.current.stop()
      }
    } catch (_) {}
    clonedTrackRef.current = null
  }
  if (typeof releasePhysicalCameraIfUnneeded === 'function') {
    releasePhysicalCameraIfUnneeded()
  }
}

/**
 * Maps RealtimeKit client room status to normalized connection state
 * ('connected' | 'connecting' | 'reconnecting' | 'disconnected')
 */
export function mapRealtimeKitConnectionState({ roomJoined, roomState, isReconnecting = false }) {
  if (isReconnecting) return 'reconnecting'
  if (roomJoined || roomState === 'joined') return 'connected'
  if (roomState === 'init' || roomState === 'waitlisted' || !roomState) return 'connecting'
  if (roomState === 'ended' || roomState === 'left' || roomState === 'disconnected') return 'disconnected'
  return 'disconnected'
}

/**
 * Normalizes a Cloudflare RealtimeKit remote participant into a provider-neutral interface.
 * Preserves session peer ID (p.id) as the unique session identifier and maps customParticipantId
 * to the authenticated user identity.
 */
export function normalizeRemoteParticipant(p) {
  if (!p) return null
  const identity = p.customParticipantId || p.userId || p.id
  return {
    ...p,
    id: p.id,
    sid: p.id, // For backward compatibility with LiveKit participant lookup (p.sid)
    identity,
    customParticipantId: p.customParticipantId,
    userId: p.userId || p.customParticipantId || p.id,
    name: p.name || 'Participant',
    isHost: Boolean(p.isHost),
    videoTrack: p.videoTrack || null,
    audioTrack: p.audioTrack || null,
    videoEnabled: Boolean(p.videoEnabled),
    audioEnabled: Boolean(p.audioEnabled),
    isCameraEnabled: Boolean(p.videoEnabled),
    isMicrophoneEnabled: Boolean(p.audioEnabled),
    screenShareEnabled: Boolean(p.screenShareEnabled),
    screenShareTracks: p.screenShareTracks || { video: null, audio: null },
    rawParticipant: p
  }
}

/**
 * Guards media actions (mic, camera, screenshare toggle) until the room is actually joined.
 * RealtimeKit SDK v2.0.4 throws an error if media APIs are invoked before roomJoined is true.
 */
export function isMediaActionPermitted(self) {
  if (!self) return false
  return Boolean(self.roomJoined === true || self.roomState === 'joined')
}

/**
 * Normalizes Cloudflare RealtimeKit local participant (meeting.self) into a provider-neutral interface.
 * Exposes async methods (setName, setMicrophoneEnabled, etc.) to match LiveKit component contracts.
 */
export function normalizeLocalParticipant({ self, user, isHost = false }) {
  if (!self) return null
  const customParticipantId = self.customParticipantId || user?.id || null
  const identity = customParticipantId || self.id
  const displayName = (user?.name || user?.full_name || self.name || 'You').trim()
  return {
    id: self.id,
    sid: self.id,
    identity,
    customParticipantId,
    userId: user?.id || customParticipantId || self.id,
    name: displayName,
    isHost: Boolean(isHost),
    videoTrack: self.videoTrack || null,
    audioTrack: self.audioTrack || null,
    videoEnabled: Boolean(self.videoEnabled),
    audioEnabled: Boolean(self.audioEnabled),
    isCameraEnabled: Boolean(self.videoEnabled),
    isMicrophoneEnabled: Boolean(self.audioEnabled),
    screenShareEnabled: Boolean(self.screenShareEnabled),
    screenShareTracks: self.screenShareTracks || { video: null, audio: null },
    setName: async (newName) => {
      try {
        if (!isMediaActionPermitted(self)) return
        if (typeof self.setName === 'function') {
          self.setName(newName)
        }
      } catch (err) {
        console.warn('[RealtimeKitAdapter] localParticipant.setName error:', err)
      }
    },
    setMicrophoneEnabled: async (enabled) => {
      if (!isMediaActionPermitted(self)) return
      if (enabled) {
        if (typeof self.enableAudio === 'function') await self.enableAudio()
      } else {
        if (typeof self.disableAudio === 'function') await self.disableAudio()
      }
    },
    setScreenShareEnabled: async (enabled) => {
      if (!isMediaActionPermitted(self)) return
      if (enabled) {
        if (typeof self.enableScreenShare === 'function') await self.enableScreenShare()
      } else {
        if (typeof self.disableScreenShare === 'function') await self.disableScreenShare()
      }
    }
  }
}

/**
 * Extracts and normalizes active screen-share tracks from local and remote RealtimeKit participants.
 * Each entry is formatted for consumption by ScreenShareView.jsx.
 */
export function normalizeScreenShareTracks({ self, remoteParticipants = [] }) {
  const tracks = []
  const selfVideoTrack = self?.screenShareTracks?.video || self?.screenShareTrack || null
  if (self?.screenShareEnabled && selfVideoTrack) {
    tracks.push({
      id: `${self.id}-screenshare`,
      sid: `${self.id}-screenshare`,
      track: selfVideoTrack,
      participant: self,
      isRealtimeKit: true
    })
  }
  for (const p of (remoteParticipants || [])) {
    const remoteVideoTrack = p?.screenShareTracks?.video || p?.screenShareTrack || null
    if (p && p.screenShareEnabled && remoteVideoTrack) {
      tracks.push({
        id: `${p.id}-screenshare`,
        sid: `${p.id}-screenshare`,
        track: remoteVideoTrack,
        participant: p,
        isRealtimeKit: true
      })
    }
  }
  return tracks
}

/**
 * Participant listener manager for Cloudflare RealtimeKit.
 * Dynamically binds and reconciles event listeners ('screenShareUpdate', 'videoUpdate', 'audioUpdate')
 * on each joined remote participant instance so that remote track changes immediately trigger UI refresh.
 *
 * Requirements:
 * 1. Attach screenShareUpdate, videoUpdate, and audioUpdate listeners to each remote participant.
 * 2. Reconcile listeners when participants join, leave, or the collection changes.
 * 3. Remove listeners when participants leave and when the adapter unmounts.
 * 4. Avoid duplicate listeners on repeated calls.
 * 5. Handle participants already present upon mount.
 */
export function createParticipantListenerManager({ onUpdate } = {}) {
  // Map of participantId -> { participant, handlers }
  const subscriptions = new Map()

  const detach = (participantId) => {
    const entry = subscriptions.get(participantId)
    if (!entry) return
    const { participant, handlers } = entry
    try {
      if (typeof participant.removeListener === 'function') {
        participant.removeListener('screenShareUpdate', handlers.screenShareUpdate)
        participant.removeListener('videoUpdate', handlers.videoUpdate)
        participant.removeListener('audioUpdate', handlers.audioUpdate)
      } else if (typeof participant.off === 'function') {
        participant.off('screenShareUpdate', handlers.screenShareUpdate)
        participant.off('videoUpdate', handlers.videoUpdate)
        participant.off('audioUpdate', handlers.audioUpdate)
      }
    } catch (_) {}
    subscriptions.delete(participantId)
  }

  const attach = (participant) => {
    if (!participant || !participant.id) return
    const id = participant.id

    // Prevent duplicate listeners on the same participant object
    if (subscriptions.has(id)) {
      const existing = subscriptions.get(id)
      if (existing.participant === participant) {
        return
      }
      // Detach listeners from previous participant instance before re-subscribing
      detach(id)
    }

    const handleUpdate = () => {
      if (typeof onUpdate === 'function') {
        onUpdate()
      }
    }

    const handlers = {
      screenShareUpdate: handleUpdate,
      videoUpdate: handleUpdate,
      audioUpdate: handleUpdate
    }

    try {
      if (typeof participant.on === 'function') {
        participant.on('screenShareUpdate', handlers.screenShareUpdate)
        participant.on('videoUpdate', handlers.videoUpdate)
        participant.on('audioUpdate', handlers.audioUpdate)
      } else if (typeof participant.addListener === 'function') {
        participant.addListener('screenShareUpdate', handlers.screenShareUpdate)
        participant.addListener('videoUpdate', handlers.videoUpdate)
        participant.addListener('audioUpdate', handlers.audioUpdate)
      }
    } catch (_) {}

    subscriptions.set(id, { participant, handlers })
  }

  const reconcile = (participants = []) => {
    let currentList = []
    if (Array.isArray(participants)) {
      currentList = participants
    } else if (typeof participants?.toArray === 'function') {
      currentList = participants.toArray()
    } else if (typeof participants?.values === 'function') {
      currentList = Array.from(participants.values())
    }

    const activeIds = new Set()

    for (const p of currentList) {
      if (p && p.id) {
        activeIds.add(p.id)
        attach(p)
      }
    }

    // Detach any participants no longer in the active list
    for (const id of Array.from(subscriptions.keys())) {
      if (!activeIds.has(id)) {
        detach(id)
      }
    }
  }

  const cleanupAll = () => {
    for (const id of Array.from(subscriptions.keys())) {
      detach(id)
    }
    subscriptions.clear()
  }

  return {
    attach,
    detach,
    reconcile,
    cleanupAll,
    getSubscribedCount: () => subscriptions.size,
    isSubscribed: (id) => subscriptions.has(id),
    getSubscriptions: () => subscriptions
  }
}

/**
 * Safely leaves a Cloudflare RealtimeKit room session with comprehensive resource cleanup:
 * 1. Disables all local media producers (screenshare, video, audio) on meeting.self.
 * 2. Deactivates cloned camera MediaStreamTrack and releases physical camera if unneeded.
 * 3. Removes all remote participant event listeners via listenerManager.
 * 4. Calls the official SDK leave API: meeting.leave('left') with parameter 'left'.
 * 5. Handles repeated calls idempotently and catches errors so upstream navigation is never blocked.
 *
 * @param {Object} params
 * @param {Object} [params.meeting] - RealtimeKit client/meeting instance
 * @param {Object} [params.clonedTrackRef] - Ref holding cloned video track
 * @param {Object} [params.meetingCamActiveRef] - Ref tracking meeting camera active state
 * @param {Function} [params.releasePhysicalCameraIfUnneeded] - Function to release physical camera
 * @param {Object} [params.listenerManager] - Participant listener manager instance
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function leaveRealtimeKitSession({
  meeting,
  clonedTrackRef,
  meetingCamActiveRef,
  releasePhysicalCameraIfUnneeded,
  listenerManager
} = {}) {
  // 1. Disable local media producers via RealtimeKit SDK
  if (meeting?.self && isMediaActionPermitted(meeting.self)) {
    try {
      if (typeof meeting.self.disableScreenShare === 'function') {
        await meeting.self.disableScreenShare().catch(() => {})
      }
    } catch (_) {}
    try {
      if (typeof meeting.self.disableVideo === 'function') {
        await meeting.self.disableVideo().catch(() => {})
      }
    } catch (_) {}
    try {
      if (typeof meeting.self.disableAudio === 'function') {
        await meeting.self.disableAudio().catch(() => {})
      }
    } catch (_) {}
  }

  // 2. Stop camera tracks & cloned track
  deactivateCameraTrack({
    clonedTrackRef,
    meetingCamActiveRef,
    releasePhysicalCameraIfUnneeded
  })

  // 3. Clean up all remote participant listeners
  if (listenerManager && typeof listenerManager.cleanupAll === 'function') {
    try {
      listenerManager.cleanupAll()
    } catch (_) {}
  }

  // 4. Call RealtimeKit SDK leave API with official state 'left'
  let leaveSuccess = true
  let leaveError = null
  if (meeting && typeof meeting.leave === 'function') {
    try {
      console.log("[RealtimeKit] Invoking meeting.leave('left')...")
      await meeting.leave('left')
      console.log('[RealtimeKit] meeting.leave finished successfully.')
    } catch (err) {
      leaveSuccess = false
      leaveError = err?.message || String(err)
      console.warn('[RealtimeKit] meeting.leave warning (continuing cleanup):', leaveError)
    }
  }

  return { success: leaveSuccess, error: leaveError }
}
