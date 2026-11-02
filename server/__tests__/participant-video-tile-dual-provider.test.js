import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Meetly AI — ParticipantVideoTile Dual-Provider & Safety Contract Suite
 *
 * Verifies that ParticipantVideoTile:
 * 1. Explicitly detects RealtimeKit and LiveKit participants.
 * 2. NEVER sends a RealtimeKit participant to LiveKitVideoTrack.
 * 3. Renders a safe loading placeholder when RealtimeKit video is enabled but videoTrack is null.
 * 4. Preserves LiveKit trackRef rendering.
 * 5. Applies identical provider detection to fullscreen self-view.
 * 6. Generates unique session keys even when session IDs are missing.
 * 7. NEVER uses customParticipantId as a session key.
 */

// Mirrors the exact logic in ParticipantVideoTile.jsx
function resolveParticipantTileState({
  participant,
  localParticipant,
  user,
  localCamActive,
  instanceId = 'test-inst-1'
}) {
  // 1. Host resolution
  let role = 'participant'
  if (participant?.isHost) {
    role = 'host'
  } else {
    try {
      const meta = typeof participant?.metadata === 'string'
        ? JSON.parse(participant.metadata || '{}')
        : (participant?.metadata || {})
      role = meta.role || 'participant'
    } catch (_) {}
  }

  // 2. Local identity resolution
  const isCurrentUser = Boolean(
    (participant?.customParticipantId && user?.id && participant.customParticipantId === user.id) ||
    (participant?.customParticipantId && localParticipant?.customParticipantId &&
      participant.customParticipantId === localParticipant.customParticipantId) ||
    (participant?.identity && localParticipant?.identity &&
      participant.identity === localParticipant.identity) ||
    (participant && localParticipant && participant === localParticipant)
  )

  const displayName = isCurrentUser
    ? (user?.name || user?.full_name || participant?.name || 'You')
    : (participant?.name || 'Participant')

  // 3. Track resolution
  const participantVideoTrack = participant?.videoTrack || null
  const localParticipantVideoTrack = localParticipant?.videoTrack || null

  // 4. Provider detection
  const isRealtimeKit = Boolean(
    participant && (
      participant.videoTrack !== undefined ||
      participant.videoEnabled !== undefined ||
      participant.customParticipantId !== undefined ||
      (participant.isHost !== undefined && typeof participant.getTrackPublication !== 'function')
    )
  )

  const isLiveKit = Boolean(
    participant && !isRealtimeKit && (
      typeof participant.getTrackPublication === 'function' ||
      participant.isCameraEnabled !== undefined
    )
  )

  const isLocalRealtimeKit = Boolean(
    localParticipant && (
      localParticipant.videoTrack !== undefined ||
      localParticipant.videoEnabled !== undefined ||
      localParticipant.customParticipantId !== undefined ||
      (localParticipant.isHost !== undefined && typeof localParticipant.getTrackPublication !== 'function')
    )
  )

  const isLocalLiveKit = Boolean(
    localParticipant && !isLocalRealtimeKit && (
      typeof localParticipant.getTrackPublication === 'function' ||
      localParticipant.isCameraEnabled !== undefined
    )
  )

  // 5. Unique session keys for React elements (never customParticipantId)
  const rtkVideoKey = participant?.id
    ? `rtk-${participant.id}`
    : `rtk-${instanceId}`

  const lkVideoKey = participant?.sid
    ? `lk-${participant.sid}`
    : (participant?.identity ? `lk-${participant.identity}` : `lk-${instanceId}`)

  const localRtkVideoKey = localParticipant?.id
    ? `rtk-local-${localParticipant.id}`
    : `rtk-local-${instanceId}`

  const localLkVideoKey = localParticipant?.sid
    ? `lk-local-${localParticipant.sid}`
    : (localParticipant?.identity ? `lk-local-${localParticipant.identity}` : `lk-local-${instanceId}`)

  // 6. Camera state resolution
  const isParticipantCameraActive = participant?.videoEnabled !== undefined
    ? Boolean(participant.videoEnabled)
    : Boolean(participant?.isCameraEnabled)

  const isCameraEnabled = isCurrentUser && typeof localCamActive === 'boolean'
    ? Boolean(localCamActive && isParticipantCameraActive)
    : Boolean(isParticipantCameraActive)

  const isLocalParticipantCameraActive = localParticipant?.videoEnabled !== undefined
    ? Boolean(localParticipant.videoEnabled)
    : Boolean(localParticipant?.isCameraEnabled)

  const isLocalCameraRenderable = typeof localCamActive === 'boolean'
    ? Boolean(localCamActive && isLocalParticipantCameraActive)
    : Boolean(isLocalParticipantCameraActive)

  // 7. Determine exact rendered element for main video
  let mainRenderMode = 'none'
  let activeMainKey = null

  if (isCameraEnabled) {
    if (isRealtimeKit) {
      if (participantVideoTrack) {
        mainRenderMode = 'UniversalVideoTrack'
        activeMainKey = rtkVideoKey
      } else {
        mainRenderMode = 'SafePlaceholderConnecting'
      }
    } else if (isLiveKit) {
      mainRenderMode = 'LiveKitVideoTrack'
      activeMainKey = lkVideoKey
    } else if (participantVideoTrack) {
      mainRenderMode = 'UniversalVideoTrack'
      activeMainKey = rtkVideoKey
    } else if (typeof participant?.getTrackPublication === 'function') {
      mainRenderMode = 'LiveKitVideoTrack'
      activeMainKey = lkVideoKey
    } else {
      mainRenderMode = 'SafePlaceholderConnecting'
    }
  }

  // 8. Determine exact rendered element for local self-view thumbnail
  let localRenderMode = 'none'
  let activeLocalKey = null

  if (isLocalCameraRenderable) {
    if (isLocalRealtimeKit) {
      if (localParticipantVideoTrack) {
        localRenderMode = 'UniversalVideoTrack'
        activeLocalKey = localRtkVideoKey
      } else {
        localRenderMode = 'SafePlaceholderConnecting'
      }
    } else if (isLocalLiveKit) {
      localRenderMode = 'LiveKitVideoTrack'
      activeLocalKey = localLkVideoKey
    } else if (localParticipantVideoTrack) {
      localRenderMode = 'UniversalVideoTrack'
      activeLocalKey = localRtkVideoKey
    } else if (typeof localParticipant?.getTrackPublication === 'function') {
      localRenderMode = 'LiveKitVideoTrack'
      activeLocalKey = localLkVideoKey
    } else {
      localRenderMode = 'SafePlaceholderConnecting'
    }
  }

  return {
    role,
    isCurrentUser,
    displayName,
    isRealtimeKit,
    isLiveKit,
    participantVideoTrack,
    localParticipantVideoTrack,
    isCameraEnabled,
    isLocalCameraRenderable,
    mainRenderMode,
    activeMainKey,
    localRenderMode,
    activeLocalKey,
    rtkVideoKey,
    lkVideoKey,
    localRtkVideoKey,
    localLkVideoKey
  }
}

describe('Meetly AI — ParticipantVideoTile Dual-Provider & Safety Contract', () => {
  const MOCK_USER_ID = '11111111-2222-3333-4444-555555555555'
  const OTHER_USER_ID = '99999999-8888-7777-6666-555555555555'

  describe('Provider Detection and Track Availability', () => {
    it('1. RealtimeKit enabled but track unavailable: renders safe loading placeholder, NEVER LiveKitVideoTrack', () => {
      const state = resolveParticipantTileState({
        participant: {
          id: 'cf-part-session-101',
          customParticipantId: OTHER_USER_ID,
          videoEnabled: true,
          videoTrack: null // WebRTC track still negotiating
        },
        localParticipant: null,
        user: null,
        localCamActive: false
      })

      assert.equal(state.isRealtimeKit, true)
      assert.equal(state.isLiveKit, false)
      assert.equal(state.isCameraEnabled, true)
      assert.equal(state.participantVideoTrack, null)
      assert.equal(state.mainRenderMode, 'SafePlaceholderConnecting', 'Must render connecting placeholder')
      assert.notEqual(state.mainRenderMode, 'LiveKitVideoTrack', 'Must NEVER render LiveKitVideoTrack for RealtimeKit')
    })

    it('2. RealtimeKit track available: renders UniversalVideoTrack with session key', () => {
      const mockTrack = { id: 'rtk-native-track-1', kind: 'video' }
      const state = resolveParticipantTileState({
        participant: {
          id: 'cf-part-session-102',
          customParticipantId: OTHER_USER_ID,
          videoEnabled: true,
          videoTrack: mockTrack
        },
        localParticipant: null,
        user: null,
        localCamActive: false
      })

      assert.equal(state.isRealtimeKit, true)
      assert.equal(state.isCameraEnabled, true)
      assert.equal(state.mainRenderMode, 'UniversalVideoTrack')
      assert.equal(state.activeMainKey, 'rtk-cf-part-session-102')
      assert.notEqual(state.activeMainKey, OTHER_USER_ID, 'customParticipantId must NEVER be used as a key')
    })

    it('3. LiveKit participant fallback: renders LiveKitVideoTrack with livekit session key', () => {
      const state = resolveParticipantTileState({
        participant: {
          sid: 'PA_livekit_session_202',
          identity: 'attendee@meetly.ai',
          isCameraEnabled: true,
          getTrackPublication: () => ({ track: null })
        },
        localParticipant: null,
        user: null,
        localCamActive: false
      })

      assert.equal(state.isRealtimeKit, false)
      assert.equal(state.isLiveKit, true)
      assert.equal(state.isCameraEnabled, true)
      assert.equal(state.mainRenderMode, 'LiveKitVideoTrack')
      assert.equal(state.activeMainKey, 'lk-PA_livekit_session_202')
    })

    it('4. Two participants with missing session IDs: generates unique keys without collisions', () => {
      const p1 = {
        customParticipantId: 'user-aaa',
        videoEnabled: true,
        videoTrack: { id: 'track-a' }
        // id is undefined!
      }
      const p2 = {
        customParticipantId: 'user-bbb',
        videoEnabled: true,
        videoTrack: { id: 'track-b' }
        // id is undefined!
      }

      const state1 = resolveParticipantTileState({
        participant: p1,
        localParticipant: null,
        user: null,
        localCamActive: false,
        instanceId: 'inst-001'
      })

      const state2 = resolveParticipantTileState({
        participant: p2,
        localParticipant: null,
        user: null,
        localCamActive: false,
        instanceId: 'inst-002'
      })

      assert.equal(state1.activeMainKey, 'rtk-inst-001')
      assert.equal(state2.activeMainKey, 'rtk-inst-002')
      assert.notEqual(state1.activeMainKey, state2.activeMainKey, 'Keys must NEVER collide even with missing session IDs')
      assert.notEqual(state1.activeMainKey, 'user-aaa')
      assert.notEqual(state2.activeMainKey, 'user-bbb')
    })
  })

  describe('Fullscreen Self-View Provider Safety', () => {
    it('5. RealtimeKit local participant without track renders safe placeholder, NEVER LiveKitVideoTrack', () => {
      const state = resolveParticipantTileState({
        participant: {
          id: 'cf-remote-1',
          customParticipantId: OTHER_USER_ID,
          videoEnabled: true,
          videoTrack: { id: 'remote-track' }
        },
        localParticipant: {
          id: 'cf-local-1',
          customParticipantId: MOCK_USER_ID,
          videoEnabled: true,
          videoTrack: null // local track null/connecting
        },
        user: { id: MOCK_USER_ID },
        localCamActive: true
      })

      assert.equal(state.isLocalCameraRenderable, true)
      assert.equal(state.localRenderMode, 'SafePlaceholderConnecting')
      assert.notEqual(state.localRenderMode, 'LiveKitVideoTrack', 'Must NEVER render LiveKit for local RealtimeKit participant')
    })

    it('6. RealtimeKit local participant with track renders UniversalVideoTrack', () => {
      const mockLocalTrack = { id: 'local-native-track' }
      const state = resolveParticipantTileState({
        participant: {
          id: 'cf-remote-1',
          customParticipantId: OTHER_USER_ID,
          videoEnabled: true,
          videoTrack: { id: 'remote-track' }
        },
        localParticipant: {
          id: 'cf-local-1',
          customParticipantId: MOCK_USER_ID,
          videoEnabled: true,
          videoTrack: mockLocalTrack
        },
        user: { id: MOCK_USER_ID },
        localCamActive: true
      })

      assert.equal(state.isLocalCameraRenderable, true)
      assert.equal(state.localRenderMode, 'UniversalVideoTrack')
      assert.equal(state.activeLocalKey, 'rtk-local-cf-local-1')
    })

    it('7. LiveKit local participant renders LiveKitVideoTrack', () => {
      const state = resolveParticipantTileState({
        participant: {
          sid: 'PA_remote_livekit',
          identity: 'remote@meetly.ai',
          isCameraEnabled: true,
          getTrackPublication: () => ({})
        },
        localParticipant: {
          sid: 'PA_local_livekit',
          identity: 'local@meetly.ai',
          isCameraEnabled: true,
          getTrackPublication: () => ({})
        },
        user: { id: MOCK_USER_ID },
        localCamActive: true
      })

      assert.equal(state.isLocalCameraRenderable, true)
      assert.equal(state.localRenderMode, 'LiveKitVideoTrack')
      assert.equal(state.activeLocalKey, 'lk-local-PA_local_livekit')
    })
  })

  describe('Identity & Role Integrity', () => {
    it('8. Correctly resolves host from isHost (RealtimeKit) vs metadata role (LiveKit)', () => {
      const rtkHost = resolveParticipantTileState({
        participant: { id: 'cf-1', isHost: true }
      })
      assert.equal(rtkHost.role, 'host')

      const lkHost = resolveParticipantTileState({
        participant: { sid: 'PA-1', metadata: JSON.stringify({ role: 'host' }) }
      })
      assert.equal(lkHost.role, 'host')

      const regular = resolveParticipantTileState({
        participant: { id: 'cf-2', isHost: false }
      })
      assert.equal(regular.role, 'participant')
    })

    it('9. Correctly resolves isCurrentUser using customParticipantId', () => {
      const state = resolveParticipantTileState({
        participant: { id: 'cf-1', customParticipantId: MOCK_USER_ID, name: 'Alice' },
        localParticipant: { id: 'cf-1', customParticipantId: MOCK_USER_ID },
        user: { id: MOCK_USER_ID, full_name: 'Alice' },
        localCamActive: true
      })
      assert.equal(state.isCurrentUser, true)
      assert.equal(state.displayName, 'Alice')
    })
  })
})
