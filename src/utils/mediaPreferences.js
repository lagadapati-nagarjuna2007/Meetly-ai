/**
 * Media Preferences & LiveKit Track Synchronization Utilities
 *
 * Persists only boolean device preferences ({ micEnabled, camEnabled }) per authenticated
 * user in browser localStorage. Never stores audio or video data.
 */

export const MEDIA_PREFS_KEY_PREFIX = 'meetly_media_prefs:'
export const MEDIA_PREFS_LAST_USER_KEY = 'meetly_media_prefs:__last_user__'

export const DEFAULT_MEDIA_PREFERENCES = Object.freeze({
  micEnabled: true,
  camEnabled: true
})

function getDefaultStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage
    }
  } catch (_) {}
  return null
}

export function normalizeMediaUserId(userId) {
  if (!userId || typeof userId !== 'string') return ''
  return userId.trim().toLowerCase()
}

/**
 * Resolves the current authenticated user's ID from AuthContext user, LiveKit localParticipant
 * metadata/identity, or fallback participant resolver.
 */
export function resolveMediaUserId(user, localParticipant, resolveParticipantUserIdFn = null, dbParticipants = []) {
  if (user?.id && typeof user.id === 'string' && user.id.trim()) {
    return user.id.trim()
  }
  if (typeof resolveParticipantUserIdFn === 'function' && localParticipant) {
    const resolved = resolveParticipantUserIdFn(localParticipant, dbParticipants)
    if (resolved && typeof resolved === 'string' && resolved.trim()) {
      return resolved.trim()
    }
  }
  if (localParticipant?.metadata) {
    try {
      const meta = typeof localParticipant.metadata === 'string'
        ? JSON.parse(localParticipant.metadata)
        : localParticipant.metadata
      if (meta?.userId && typeof meta.userId === 'string' && meta.userId.trim()) {
        return meta.userId.trim()
      }
    } catch (_) {}
  }
  if (localParticipant?.identity && typeof localParticipant.identity === 'string' && localParticipant.identity.trim()) {
    return localParticipant.identity.trim()
  }
  return ''
}

export function getMediaStorageKey(userId, storage = getDefaultStorage()) {
  const normalized = normalizeMediaUserId(userId)
  if (normalized) {
    return `${MEDIA_PREFS_KEY_PREFIX}${normalized}`
  }
  // If userId is momentarily unavailable during early initial render, check the last active user key
  try {
    const lastUser = storage?.getItem(MEDIA_PREFS_LAST_USER_KEY)
    if (lastUser && typeof lastUser === 'string' && lastUser.trim()) {
      return `${MEDIA_PREFS_KEY_PREFIX}${lastUser.trim().toLowerCase()}`
    }
  } catch (_) {}
  return `${MEDIA_PREFS_KEY_PREFIX}default`
}

/**
 * Reads saved boolean media preferences for the given user.
 * Returns { micEnabled: boolean, camEnabled: boolean }.
 */
export function getSavedMediaPreferences(userId, storage = getDefaultStorage()) {
  if (!storage) {
    return { ...DEFAULT_MEDIA_PREFERENCES }
  }
  try {
    const key = getMediaStorageKey(userId, storage)
    const raw = storage.getItem(key)
    if (!raw) {
      return { ...DEFAULT_MEDIA_PREFERENCES }
    }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_MEDIA_PREFERENCES }
    }
    return {
      micEnabled: typeof parsed.micEnabled === 'boolean' ? parsed.micEnabled : DEFAULT_MEDIA_PREFERENCES.micEnabled,
      camEnabled: typeof parsed.camEnabled === 'boolean' ? parsed.camEnabled : DEFAULT_MEDIA_PREFERENCES.camEnabled
    }
  } catch (_) {
    return { ...DEFAULT_MEDIA_PREFERENCES }
  }
}

/**
 * Saves partial or full media preferences ({ micEnabled?, camEnabled? }) for the user
 * without overwriting the other device's saved state.
 */
export function saveMediaPreference(userId, partialPrefs, storage = getDefaultStorage()) {
  const current = getSavedMediaPreferences(userId, storage)
  const next = {
    micEnabled: typeof partialPrefs?.micEnabled === 'boolean' ? partialPrefs.micEnabled : current.micEnabled,
    camEnabled: typeof partialPrefs?.camEnabled === 'boolean' ? partialPrefs.camEnabled : current.camEnabled
  }
  if (!storage) {
    return next
  }
  try {
    const normalized = normalizeMediaUserId(userId)
    if (normalized) {
      storage.setItem(MEDIA_PREFS_LAST_USER_KEY, normalized)
    }
    const key = getMediaStorageKey(userId, storage)
    storage.setItem(key, JSON.stringify(next))
  } catch (_) {}
  return next
}

/**
 * Computes the intended initial microphone and camera states before any hardware or
 * LiveKit tracks are initialized.
 */
export function resolveInitialMediaState({
  userId,
  isHost = false,
  muteAllEnabled = false,
  storage = getDefaultStorage()
} = {}) {
  const savedPrefs = getSavedMediaPreferences(userId, storage)
  const mutedByHost = Boolean(muteAllEnabled && !isHost)
  const shouldEnableMic = mutedByHost ? false : Boolean(savedPrefs.micEnabled)
  const shouldEnableCam = Boolean(savedPrefs.camEnabled)

  return {
    shouldEnableMic,
    shouldEnableCam,
    mutedByHost,
    savedPrefs
  }
}

/**
 * Inspects the actual LiveKit localParticipant publications and flags to determine
 * whether the microphone and camera tracks are currently active and unmuted.
 */
export function readActualLiveKitMediaState(
  localParticipant,
  cameraSource = 'camera',
  micSource = 'microphone'
) {
  if (!localParticipant) {
    return { micActive: false, camActive: false }
  }

  let micActive = false
  if (typeof localParticipant.getTrackPublication === 'function') {
    const micPub = localParticipant.getTrackPublication(micSource)
    if (micPub) {
      const hasLiveTrack = Boolean(micPub.track) && micPub.track?.readyState !== 'ended'
      micActive = hasLiveTrack && !micPub.isMuted && Boolean(localParticipant.isMicrophoneEnabled ?? true)
    } else if (typeof localParticipant.isMicrophoneEnabled === 'boolean') {
      micActive = localParticipant.isMicrophoneEnabled
    }
  } else if (typeof localParticipant.isMicrophoneEnabled === 'boolean') {
    micActive = localParticipant.isMicrophoneEnabled
  }

  let camActive = false
  if (typeof localParticipant.getTrackPublication === 'function') {
    const camPub = localParticipant.getTrackPublication(cameraSource)
    if (camPub) {
      const hasLiveTrack = Boolean(camPub.track) && camPub.track?.readyState !== 'ended'
      camActive = hasLiveTrack && !camPub.isMuted
    } else if (typeof localParticipant.isCameraEnabled === 'boolean') {
      camActive = localParticipant.isCameraEnabled
    }
  } else if (typeof localParticipant.isCameraEnabled === 'boolean') {
    camActive = localParticipant.isCameraEnabled
  }

  return { micActive: Boolean(micActive), camActive: Boolean(camActive) }
}

/**
 * Safely unpublishes and stops any existing local camera track on localParticipant.
 */
export async function unpublishLocalCameraTrack(localParticipant, cameraSource = 'camera') {
  if (!localParticipant || typeof localParticipant.getTrackPublication !== 'function') {
    return false
  }
  const pub = localParticipant.getTrackPublication(cameraSource)
  if (pub && pub.track) {
    const trackToUnpublish = pub.track
    try {
      await localParticipant.unpublishTrack(trackToUnpublish, false)
    } catch (_) {}
    try {
      trackToUnpublish.stop?.()
    } catch (_) {}
    return true
  }
  return false
}

/**
 * Applies the saved initial media state to LiveKit before enabling local media.
 * Prevents any accidental hardware activation when a device's saved state is OFF.
 */
export async function applyInitialMediaState({
  localParticipant,
  userId,
  isHost = false,
  muteAllEnabled = false,
  storage = getDefaultStorage(),
  getOrCreatePhysicalTrack,
  releasePhysicalCameraIfUnneeded,
  setMeetingCamActive,
  setCamInitializing,
  setCamActive,
  setMicActive,
  setCamError,
  getCameraErrorMessage,
  showToast,
  wasMutedByHostRef,
  cameraSource = 'camera',
  micSource = 'microphone'
}) {
  if (!localParticipant) {
    return { shouldEnableMic: false, shouldEnableCam: false, micActive: false, camActive: false }
  }

  const { shouldEnableMic, shouldEnableCam, mutedByHost } = resolveInitialMediaState({
    userId,
    isHost,
    muteAllEnabled,
    storage
  })

  // 1. Camera initialization (strictly respect shouldEnableCam BEFORE touching hardware)
  setCamError?.(null)
  if (!shouldEnableCam) {
    setMeetingCamActive?.(false)
    setCamInitializing?.(false)
    await unpublishLocalCameraTrack(localParticipant, cameraSource)
    releasePhysicalCameraIfUnneeded?.()
    setCamActive?.(false)
  } else {
    setCamInitializing?.(true)
    try {
      setMeetingCamActive?.(true)
      await unpublishLocalCameraTrack(localParticipant, cameraSource)
      const physicalTrack = await getOrCreatePhysicalTrack()
      const livekitTrack = typeof physicalTrack.clone === 'function' ? physicalTrack.clone() : physicalTrack
      await localParticipant.publishTrack(livekitTrack, {
        source: cameraSource,
        simulcast: true
      })
      setCamActive?.(true)
      setCamInitializing?.(false)
    } catch (err) {
      setMeetingCamActive?.(false)
      releasePhysicalCameraIfUnneeded?.()
      setCamInitializing?.(false)
      setCamActive?.(false)
      const errorMsg = typeof getCameraErrorMessage === 'function'
        ? getCameraErrorMessage(err)
        : (err?.message || 'Camera error')
      setCamError?.(errorMsg)
      showToast?.(errorMsg, 'error')
    }
  }

  // 2. Microphone initialization (strictly respect shouldEnableMic BEFORE enabling audio)
  if (!shouldEnableMic) {
    if (wasMutedByHostRef) {
      wasMutedByHostRef.current = Boolean(mutedByHost)
    }
    setMicActive?.(false)
    try {
      const micPub = typeof localParticipant.getTrackPublication === 'function'
        ? localParticipant.getTrackPublication(micSource)
        : null
      if (localParticipant.isMicrophoneEnabled || (micPub && !micPub.isMuted)) {
        await localParticipant.setMicrophoneEnabled(false)
      }
    } catch (_) {}
  } else {
    if (wasMutedByHostRef) {
      wasMutedByHostRef.current = false
    }
    try {
      await localParticipant.setMicrophoneEnabled(true)
      setMicActive?.(true)
    } catch (_) {
      setMicActive?.(false)
      showToast?.('Microphone permission denied or unavailable.', 'error')
    }
  }

  const actual = readActualLiveKitMediaState(localParticipant, cameraSource, micSource)
  return {
    shouldEnableMic,
    shouldEnableCam,
    micActive: actual.micActive,
    camActive: actual.camActive
  }
}

/**
 * Toggles ONLY the microphone state and persists the user's microphone preference
 * without altering the camera state or camera preference.
 */
export async function toggleMicrophoneState({
  localParticipant,
  userId,
  isHost = false,
  muteAllEnabled = false,
  currentMicActive = false,
  storage = getDefaultStorage(),
  setMicActive,
  showToast,
  wasMutedByHostRef
}) {
  if (!localParticipant) return currentMicActive
  if (!isHost && muteAllEnabled) {
    showToast?.('Microphones are currently locked by the host.', 'warning')
    return currentMicActive
  }

  const nextState = !currentMicActive
  if (wasMutedByHostRef) {
    wasMutedByHostRef.current = false
  }
  saveMediaPreference(userId, { micEnabled: nextState }, storage)

  try {
    await localParticipant.setMicrophoneEnabled(nextState)
    setMicActive?.(nextState)
    showToast?.(nextState ? 'Microphone unmuted' : 'Microphone muted', 'info')
    return nextState
  } catch (err) {
    // Revert preference if enabling failed due to hardware/permission error
    if (nextState) {
      saveMediaPreference(userId, { micEnabled: false }, storage)
      setMicActive?.(false)
    }
    showToast?.('Failed to toggle microphone.', 'error')
    throw err
  }
}

/**
 * Toggles ONLY the camera state and persists the user's camera preference
 * without altering the microphone state or microphone preference.
 */
export async function toggleCameraState({
  localParticipant,
  userId,
  currentCamActive = false,
  storage = getDefaultStorage(),
  getOrCreatePhysicalTrack,
  releasePhysicalCameraIfUnneeded,
  setMeetingCamActive,
  setCamInitializing,
  setCamActive,
  setCamError,
  getCameraErrorMessage,
  showToast,
  cameraSource = 'camera'
}) {
  if (!localParticipant) return currentCamActive
  const nextState = !currentCamActive
  saveMediaPreference(userId, { camEnabled: nextState }, storage)
  setCamError?.(null)
  setCamInitializing?.(true)

  try {
    if (nextState) {
      setMeetingCamActive?.(true)
      await unpublishLocalCameraTrack(localParticipant, cameraSource)
      const physicalTrack = await getOrCreatePhysicalTrack()
      const livekitTrack = typeof physicalTrack.clone === 'function' ? physicalTrack.clone() : physicalTrack
      await localParticipant.publishTrack(livekitTrack, {
        source: cameraSource,
        simulcast: true
      })
      setCamActive?.(true)
      setCamInitializing?.(false)
      showToast?.('Camera enabled', 'info')
      return true
    } else {
      setMeetingCamActive?.(false)
      await unpublishLocalCameraTrack(localParticipant, cameraSource)
      releasePhysicalCameraIfUnneeded?.()
      setCamActive?.(false)
      setCamInitializing?.(false)
      showToast?.('Camera disabled', 'info')
      return false
    }
  } catch (err) {
    if (nextState) {
      setMeetingCamActive?.(false)
      releasePhysicalCameraIfUnneeded?.()
      saveMediaPreference(userId, { camEnabled: false }, storage)
      setCamActive?.(false)
    }
    setCamInitializing?.(false)
    const errorMsg = typeof getCameraErrorMessage === 'function'
      ? getCameraErrorMessage(err)
      : (err?.message || 'Camera error')
    setCamError?.(errorMsg)
    showToast?.(errorMsg, 'error')
    throw err
  }
}

/**
 * Synchronizes React UI states (micActive, camActive) with actual LiveKit localParticipant
 * track states, and optionally enforces saved OFF states (e.g., on RoomEvent.Reconnected).
 */
export async function syncAndEnforceMediaState({
  localParticipant,
  userId,
  isHost = false,
  muteAllEnabled = false,
  storage = getDefaultStorage(),
  enforceSavedOffState = false,
  releasePhysicalCameraIfUnneeded,
  setMeetingCamActive,
  setMicActive,
  setCamActive,
  cameraSource = 'camera',
  micSource = 'microphone'
}) {
  if (!localParticipant) {
    return { micActive: false, camActive: false }
  }

  if (enforceSavedOffState) {
    const { shouldEnableMic, shouldEnableCam } = resolveInitialMediaState({
      userId,
      isHost,
      muteAllEnabled,
      storage
    })

    if (!shouldEnableCam) {
      setMeetingCamActive?.(false)
      await unpublishLocalCameraTrack(localParticipant, cameraSource)
      releasePhysicalCameraIfUnneeded?.()
    }

    if (!shouldEnableMic) {
      const micPub = typeof localParticipant.getTrackPublication === 'function'
        ? localParticipant.getTrackPublication(micSource)
        : null
      if (localParticipant.isMicrophoneEnabled || (micPub && !micPub.isMuted)) {
        try {
          await localParticipant.setMicrophoneEnabled(false)
        } catch (_) {}
      }
    }
  }

  const actual = readActualLiveKitMediaState(localParticipant, cameraSource, micSource)
  setMicActive?.(actual.micActive)
  setCamActive?.(actual.camActive)
  return actual
}
