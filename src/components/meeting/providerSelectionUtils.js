/**
 * Meetly AI — Provider Selection Utilities
 * Pure decision and validation functions for Cloudflare RealtimeKit meeting room coordination.
 * Cloudflare RealtimeKit is the sole supported meeting provider.
 */

/**
 * Resolves the effective media provider ('cloudflare' | null).
 * Ensures that:
 * 1. Cloudflare RealtimeKit is selected when a valid cloudflareToken exists.
 * 2. Returns null if cloudflareToken is missing or empty.
 */
export function resolveEffectiveProvider({
  activeProvider = null,
  cloudflareToken = null
} = {}) {
  const hasCfToken = Boolean(typeof cloudflareToken === 'string' && cloudflareToken.trim())

  if (hasCfToken) {
    return 'cloudflare'
  }

  return null
}

/**
 * Determines mounting decision for the meeting provider.
 * Cloudflare RealtimeKit is the sole supported provider. LiveKit is permanently disabled.
 */
export function shouldMountProvider({
  effectiveProvider,
  cloudflareToken
} = {}) {
  const hasCfToken = Boolean(typeof cloudflareToken === 'string' && cloudflareToken.trim())
  const mountCloudflare = (effectiveProvider === 'cloudflare' || !effectiveProvider) && hasCfToken

  return {
    mountCloudflare,
    mountLiveKit: false,
    hasUsableCredentials: mountCloudflare,
    selectedProvider: mountCloudflare ? 'cloudflare' : null
  }
}

/**
 * Verifies that all required shared meeting adapter props are present.
 */
export function validateSharedAdapterProps(props) {
  const required = [
    'meetingData',
    'setMeetingData',
    'isHost',
    'handleLeave',
    'handleEndMeeting',
    'handleDeleteMeeting',
    'handleRename',
    'handleCopyCode',
    'handleCopyLink',
    'lockMeeting',
    'activateMeeting',
    'showToast',
    'user',
    'attendanceConsent',
    'endMeeting',
    'expireMeeting',
    'socket',
    'socketReady',
    'chatMessages',
    'setChatMessages',
    'ephemeralChatMessages',
    'setEphemeralChatMessages',
    'ephemeralChatPolicy',
    'setEphemeralChatPolicy',
    'activeChatConvTab',
    'setActiveChatConvTab',
    'selectedChatRecipient',
    'setSelectedChatRecipient',
    'typingUsers',
    'setTypingUsers',
    'handleLeaveWithAttendanceRef',
    'waitingRequests',
    'fetchWaitingRequests',
    'isIntentionalLeaveRef',
    'dbParticipants'
  ]

  const missing = required.filter((key) => !(key in props))
  return {
    isValid: missing.length === 0,
    missing
  }
}
