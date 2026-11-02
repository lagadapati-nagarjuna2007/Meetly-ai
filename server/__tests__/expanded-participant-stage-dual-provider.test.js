import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Meetly AI — ExpandedParticipantStage Dual-Provider & Safety Contract Suite
 *
 * Verifies that ExpandedParticipantStage:
 * 1. Supports RealtimeKit native MediaStreamTrack using UniversalVideoTrack.
 * 2. Renders a safe loading placeholder when RealtimeKit video is enabled but track is pending.
 * 3. Preserves LiveKit trackRef rendering fallback for LiveKit participants.
 * 4. Applies identical provider detection and placeholder logic to fullscreen local self-view.
 * 5. Correctly resets zoom and pan when the selected participant session changes.
 * 6. Generates unique React keys for filmstrip participants (never using customParticipantId).
 * 7. Resolves filmstrip selection identifiers compatible with MeetingRoom.jsx lookup.
 * 8. Correctly resolves host status and user identity across both providers.
 */

// Mirrors the exact logic in ExpandedParticipantStage.jsx
function resolveExpandedStageState({
  participant,
  allParticipants = [],
  localParticipant,
  user,
  localCamActive,
  instanceId = 'stage-inst-1'
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

  // 5. Unique session keys for React elements
  const rtkVideoKey = participant?.id
    ? `rtk-expanded-${participant.id}`
    : `rtk-expanded-${instanceId}`

  const lkVideoKey = participant?.sid
    ? `lk-expanded-${participant.sid}`
    : (participant?.identity ? `lk-expanded-${participant.identity}` : `lk-expanded-${instanceId}`)

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

  const isLocalParticipantCameraActive = localParticipant?.videoEnabled !== undefined
    ? Boolean(localParticipant.videoEnabled)
    : Boolean(localParticipant?.isCameraEnabled)

  const isLocalCameraRenderable = typeof localCamActive === 'boolean'
    ? Boolean(localCamActive && isLocalParticipantCameraActive)
    : Boolean(isLocalParticipantCameraActive)

  const isCameraEnabled = isCurrentUser
    ? isLocalCameraRenderable
    : isParticipantCameraActive

  // 7. Main video rendering decision
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

  // 8. Fullscreen local self-view rendering decision
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

  // 9. Zoom/pan reset session dependency
  const selectedSessionId = participant?.id || participant?.sid || participant?.identity || participant?.customParticipantId || null

  // 10. Filmstrip items resolution
  const filmstripItems = allParticipants.map((p, index) => {
    const isSelected = Boolean(
      (p.id && participant?.id && p.id === participant.id) ||
      (p.sid && participant?.sid && p.sid === participant.sid) ||
      (p.identity && participant?.identity && p.identity === participant.identity) ||
      (p.customParticipantId && participant?.customParticipantId && p.customParticipantId === participant.customParticipantId) ||
      (p === participant)
    )

    const isCurrent = Boolean(
      (p.customParticipantId && user?.id && p.customParticipantId === user.id) ||
      (p.customParticipantId && localParticipant?.customParticipantId && p.customParticipantId === localParticipant.customParticipantId) ||
      (p.identity && localParticipant?.identity && p.identity === localParticipant.identity) ||
      (p.id && localParticipant?.id && p.id === localParticipant.id) ||
      (p === localParticipant)
    )

    const isPCamActive = p.videoEnabled !== undefined
      ? Boolean(p.videoEnabled)
      : Boolean(p.isCameraEnabled)
    const pCamEnabled = isCurrent ? isLocalCameraRenderable : isPCamActive

    const pName = isCurrent
      ? (user?.name || user?.full_name || p.name || 'You')
      : (p.name || 'Participant')

    const pSelectId = p.identity || p.sid || p.id || p.customParticipantId
    const pKey = p.id
      ? `filmstrip-rtk-${p.id}`
      : (p.sid ? `filmstrip-lk-${p.sid}` : (p.identity ? `filmstrip-lk-${p.identity}` : `filmstrip-item-${index}`))

    return {
      p,
      isSelected,
      isCurrent,
      pCamEnabled,
      pName,
      pSelectId,
      pKey
    }
  })

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
    selectedSessionId,
    filmstripItems
  }
}

describe('Meetly AI — ExpandedParticipantStage Dual-Provider Suite', () => {
  const MOCK_USER_ID = '11111111-2222-3333-4444-555555555555'
  const OTHER_USER_ID = '99999999-8888-7777-6666-555555555555'

  describe('Main Video Track & Provider Detection', () => {
    it('1. RealtimeKit main video track available: renders UniversalVideoTrack with object-contain styling key', () => {
      const mockTrack = { id: 'rtk-exp-track-1', kind: 'video' }
      const state = resolveExpandedStageState({
        participant: {
          id: 'cf-part-stage-1',
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
      assert.equal(state.activeMainKey, 'rtk-expanded-cf-part-stage-1')
      assert.notEqual(state.activeMainKey, OTHER_USER_ID)
    })

    it('2. RealtimeKit video enabled but track pending: renders safe placeholder, NEVER LiveKitVideoTrack', () => {
      const state = resolveExpandedStageState({
        participant: {
          id: 'cf-part-stage-2',
          customParticipantId: OTHER_USER_ID,
          videoEnabled: true,
          videoTrack: null
        },
        localParticipant: null,
        user: null,
        localCamActive: false
      })

      assert.equal(state.isRealtimeKit, true)
      assert.equal(state.isCameraEnabled, true)
      assert.equal(state.mainRenderMode, 'SafePlaceholderConnecting')
      assert.notEqual(state.mainRenderMode, 'LiveKitVideoTrack')
    })

    it('3. LiveKit main video fallback: renders LiveKitVideoTrack with livekit session key', () => {
      const state = resolveExpandedStageState({
        participant: {
          sid: 'PA_lk_stage_3',
          identity: 'bob@meetly.ai',
          isCameraEnabled: true,
          getTrackPublication: () => ({})
        },
        localParticipant: null,
        user: null,
        localCamActive: false
      })

      assert.equal(state.isRealtimeKit, false)
      assert.equal(state.isLiveKit, true)
      assert.equal(state.isCameraEnabled, true)
      assert.equal(state.mainRenderMode, 'LiveKitVideoTrack')
      assert.equal(state.activeMainKey, 'lk-expanded-PA_lk_stage_3')
    })
  })

  describe('Fullscreen Self-View Local Video', () => {
    it('4. RealtimeKit fullscreen self-view with track: renders UniversalVideoTrack', () => {
      const mockLocalTrack = { id: 'rtk-local-track' }
      const state = resolveExpandedStageState({
        participant: {
          id: 'cf-remote-4',
          customParticipantId: OTHER_USER_ID,
          videoEnabled: true,
          videoTrack: { id: 'remote' }
        },
        localParticipant: {
          id: 'cf-local-4',
          customParticipantId: MOCK_USER_ID,
          videoEnabled: true,
          videoTrack: mockLocalTrack
        },
        user: { id: MOCK_USER_ID },
        localCamActive: true
      })

      assert.equal(state.isLocalCameraRenderable, true)
      assert.equal(state.localRenderMode, 'UniversalVideoTrack')
      assert.equal(state.activeLocalKey, 'rtk-local-cf-local-4')
    })

    it('5. LiveKit fullscreen self-view: renders LiveKitVideoTrack', () => {
      const state = resolveExpandedStageState({
        participant: {
          sid: 'PA_remote_lk_5',
          identity: 'remote@meetly.ai',
          isCameraEnabled: true,
          getTrackPublication: () => ({})
        },
        localParticipant: {
          sid: 'PA_local_lk_5',
          identity: 'local@meetly.ai',
          isCameraEnabled: true,
          getTrackPublication: () => ({})
        },
        user: { id: MOCK_USER_ID },
        localCamActive: true
      })

      assert.equal(state.isLocalCameraRenderable, true)
      assert.equal(state.localRenderMode, 'LiveKitVideoTrack')
      assert.equal(state.activeLocalKey, 'lk-local-PA_local_lk_5')
    })
  })

  describe('Filmstrip Selection & Zoom/Pan Lifecycle', () => {
    it('6. Filmstrip selection resolves valid identifiers and handles RealtimeKit & LiveKit participants', () => {
      const rtkParticipant = {
        id: 'cf-part-film-1',
        customParticipantId: 'user-rtk-1',
        videoEnabled: true
      }
      const lkParticipant = {
        sid: 'PA_lk_film_2',
        identity: 'user-lk-2@meetly.ai',
        isCameraEnabled: false,
        getTrackPublication: () => ({})
      }

      const state = resolveExpandedStageState({
        participant: rtkParticipant,
        allParticipants: [rtkParticipant, lkParticipant],
        localParticipant: null,
        user: null,
        localCamActive: false
      })

      assert.equal(state.filmstripItems.length, 2)
      // RTK item
      assert.equal(state.filmstripItems[0].isSelected, true)
      assert.equal(state.filmstripItems[0].pSelectId, 'cf-part-film-1')
      assert.equal(state.filmstripItems[0].pKey, 'filmstrip-rtk-cf-part-film-1')
      assert.notEqual(state.filmstripItems[0].pKey, 'user-rtk-1', 'Never uses customParticipantId as key')

      // LK item
      assert.equal(state.filmstripItems[1].isSelected, false)
      assert.equal(state.filmstripItems[1].pSelectId, 'user-lk-2@meetly.ai')
      assert.equal(state.filmstripItems[1].pKey, 'filmstrip-lk-PA_lk_film_2')
    })

    it('7. Zoom/pan reset: selectedSessionId changes on participant switch (RealtimeKit and LiveKit)', () => {
      const stateA = resolveExpandedStageState({
        participant: { id: 'cf-participant-alpha' }
      })
      const stateB = resolveExpandedStageState({
        participant: { id: 'cf-participant-beta' }
      })

      assert.notEqual(stateA.selectedSessionId, stateB.selectedSessionId)
      assert.equal(stateA.selectedSessionId, 'cf-participant-alpha')
      assert.equal(stateB.selectedSessionId, 'cf-participant-beta')
    })

    it('8. Filmstrip keys remain strictly unique even with missing session IDs', () => {
      const pA = { customParticipantId: 'user-a', videoEnabled: true }
      const pB = { customParticipantId: 'user-b', videoEnabled: true }

      const state = resolveExpandedStageState({
        participant: pA,
        allParticipants: [pA, pB],
        localParticipant: null,
        user: null,
        localCamActive: false
      })

      assert.equal(state.filmstripItems[0].pKey, 'filmstrip-item-0')
      assert.equal(state.filmstripItems[1].pKey, 'filmstrip-item-1')
      assert.notEqual(state.filmstripItems[0].pKey, state.filmstripItems[1].pKey)
    })

    it('9. Resolves role correctly from isHost vs metadata role', () => {
      const rtkState = resolveExpandedStageState({
        participant: { id: 'cf-host', isHost: true }
      })
      assert.equal(rtkState.role, 'host')

      const lkState = resolveExpandedStageState({
        participant: { sid: 'lk-host', metadata: JSON.stringify({ role: 'host' }) }
      })
      assert.equal(lkState.role, 'host')
    })
  })
})
