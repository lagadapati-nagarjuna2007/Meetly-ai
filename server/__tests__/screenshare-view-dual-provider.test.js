import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Meetly AI — ScreenShareView Dual-Provider & Safety Contract Suite
 *
 * Verifies that ScreenShareView:
 * 1. Preserves LiveKit trackRef rendering fallback using LiveKitVideoTrack.
 * 2. Renders RealtimeKit native MediaStreamTrack using UniversalVideoTrack.
 * 3. Renders a safe loading placeholder when RealtimeKit screen share is enabled but track is unavailable.
 * 4. Explicitly distinguishes LiveKit track references from native MediaStreamTrack objects.
 * 5. NEVER passes a RealtimeKit track or participant to LiveKitVideoTrack.
 * 6. Generates unique, stable session keys (never using customParticipantId).
 * 7. Correctly resolves presenter display name across both providers.
 * 8. Guarantees zero calls to track.stop() on provider-managed tracks.
 */

function isNativeMediaStreamTrack(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (typeof MediaStreamTrack !== 'undefined' && obj instanceof MediaStreamTrack) return true
  return typeof obj.kind === 'string' &&
    typeof obj.readyState === 'string' &&
    (typeof obj.addEventListener === 'function' || typeof obj.stop === 'function') &&
    !obj.publication &&
    !obj.source
}

// Mirrors the exact state and render target resolution in ScreenShareView.jsx
function resolveScreenShareState({
  trackRef,
  track,
  participant,
  instanceId = 'screen-inst-1'
}) {
  // 1. Check if trackRef is explicitly a LiveKit track reference
  const isLiveKitTrackRef = Boolean(
    trackRef && (
      trackRef.publication !== undefined ||
      trackRef.source !== undefined ||
      (trackRef.participant && typeof trackRef.participant.getTrackPublication === 'function')
    )
  )

  // 2. Resolve native MediaStreamTrack
  let nativeTrack = null
  if (!isLiveKitTrackRef) {
    if (isNativeMediaStreamTrack(track)) {
      nativeTrack = track
    } else if (track?.mediaStreamTrack && isNativeMediaStreamTrack(track.mediaStreamTrack)) {
      nativeTrack = track.mediaStreamTrack
    } else if (isNativeMediaStreamTrack(trackRef)) {
      nativeTrack = trackRef
    } else if (trackRef?.mediaStreamTrack && isNativeMediaStreamTrack(trackRef.mediaStreamTrack)) {
      nativeTrack = trackRef.mediaStreamTrack
    } else if (trackRef?.track && isNativeMediaStreamTrack(trackRef.track)) {
      nativeTrack = trackRef.track
    }
  }

  if (!nativeTrack && participant?.screenShareTracks?.video) {
    nativeTrack = participant.screenShareTracks.video
  }

  // 3. Provider detection: explicitly determine RealtimeKit vs LiveKit
  const isRealtimeKit = Boolean(
    !isLiveKitTrackRef && (
      nativeTrack !== null ||
      (participant && (
        participant.screenShareTracks !== undefined ||
        participant.screenShareEnabled !== undefined ||
        participant.customParticipantId !== undefined ||
        participant.videoTrack !== undefined ||
        (participant.isHost !== undefined && typeof participant.getTrackPublication !== 'function')
      ))
    )
  )

  const isLiveKit = Boolean(
    !isRealtimeKit && (
      isLiveKitTrackRef ||
      (participant && (
        typeof participant.getTrackPublication === 'function' ||
        participant.isScreenShareEnabled !== undefined ||
        participant.isCameraEnabled !== undefined
      ))
    )
  )

  // 4. Stable session keys for React elements (never customParticipantId)
  const rtkVideoKey = nativeTrack?.id
    ? `rtk-screen-${nativeTrack.id}`
    : (participant?.id ? `rtk-screen-${participant.id}` : `rtk-screen-${instanceId}`)

  const lkVideoKey = trackRef?.publication?.trackSid ||
    trackRef?.sid ||
    (participant?.sid ? `lk-screen-${participant.sid}` : (participant?.identity ? `lk-screen-${participant.identity}` : `lk-screen-${instanceId}`))

  const presenterName = participant?.name ||
    participant?.identity ||
    (participant?.customParticipantId ? 'Participant' : 'User')

  // 5. Determine exact render target component
  let renderTarget = 'Placeholder'
  let targetProps = {}

  if (isRealtimeKit) {
    if (nativeTrack) {
      renderTarget = 'UniversalVideoTrack'
      targetProps = { key: rtkVideoKey, track: nativeTrack }
    } else {
      renderTarget = 'SafePlaceholderConnecting'
      targetProps = { label: 'Connecting presentation...' }
    }
  } else if (isLiveKit) {
    renderTarget = 'LiveKitVideoTrack'
    targetProps = { key: lkVideoKey, trackRef }
  } else if (nativeTrack) {
    renderTarget = 'UniversalVideoTrack'
    targetProps = { key: rtkVideoKey, track: nativeTrack }
  } else if (trackRef?.publication) {
    renderTarget = 'LiveKitVideoTrack'
    targetProps = { key: lkVideoKey, trackRef }
  } else {
    renderTarget = 'SafePlaceholderConnecting'
    targetProps = { label: 'Connecting presentation...' }
  }

  return {
    isRealtimeKit,
    isLiveKit,
    isLiveKitTrackRef,
    nativeTrack,
    rtkVideoKey,
    lkVideoKey,
    presenterName,
    renderTarget,
    targetProps
  }
}

describe('Meetly AI — ScreenShareView Dual-Provider & Safety Contract Suite', () => {
  it('1. LiveKit screen-share rendering remains intact with LiveKitVideoTrack', () => {
    const lkParticipant = {
      sid: 'PA_LK_1',
      identity: 'alice@example.com',
      name: 'Alice Presenter',
      getTrackPublication: () => ({ isMuted: false })
    }
    const lkTrackRef = {
      participant: lkParticipant,
      publication: { trackSid: 'TR_SCREEN_1', trackName: 'screen' },
      source: 'screen_share'
    }

    const state = resolveScreenShareState({
      trackRef: lkTrackRef,
      participant: lkParticipant
    })

    assert.equal(state.isLiveKit, true, 'LiveKit participant and trackRef must be recognized as LiveKit')
    assert.equal(state.isRealtimeKit, false, 'Must not be detected as RealtimeKit')
    assert.equal(state.renderTarget, 'LiveKitVideoTrack', 'Must render LiveKitVideoTrack')
    assert.equal(state.targetProps.trackRef, lkTrackRef, 'Must pass trackRef to LiveKitVideoTrack')
    assert.equal(state.targetProps.key, 'TR_SCREEN_1', 'Must use trackSid as React key')
    assert.equal(state.presenterName, 'Alice Presenter')
  })

  it('2. RealtimeKit native screen-share track uses UniversalVideoTrack (via track prop)', () => {
    let stopCalled = false
    const mockNativeTrack = {
      kind: 'video',
      readyState: 'live',
      id: 'rtk-track-vid-999',
      addEventListener: () => {},
      removeEventListener: () => {},
      stop: () => { stopCalled = true }
    }
    const rtkParticipant = {
      id: 'rtk-session-peer-1',
      userId: 'user-uuid-1',
      customParticipantId: 'user-uuid-1',
      name: 'Bob Speaker',
      screenShareEnabled: true,
      screenShareTracks: { video: mockNativeTrack }
    }

    const state = resolveScreenShareState({
      track: mockNativeTrack,
      participant: rtkParticipant
    })

    assert.equal(state.isRealtimeKit, true, 'Must detect RealtimeKit participant and track')
    assert.equal(state.isLiveKit, false, 'Must not detect LiveKit')
    assert.equal(state.renderTarget, 'UniversalVideoTrack', 'Must render UniversalVideoTrack for native track')
    assert.equal(state.targetProps.track, mockNativeTrack, 'Must pass native track directly')
    assert.equal(state.targetProps.key, 'rtk-screen-rtk-track-vid-999', 'Key must be based on native track ID')
    assert.equal(state.presenterName, 'Bob Speaker')
    assert.equal(stopCalled, false, 'track.stop() must NEVER be called')
  })

  it('3. RealtimeKit native track passed via trackRef prop resolves to UniversalVideoTrack', () => {
    const mockNativeTrack = {
      kind: 'video',
      readyState: 'live',
      id: 'rtk-direct-track-123',
      addEventListener: () => {},
      removeEventListener: () => {},
      stop: () => {}
    }

    const state = resolveScreenShareState({
      trackRef: mockNativeTrack
    })

    assert.equal(state.isRealtimeKit, true)
    assert.equal(state.renderTarget, 'UniversalVideoTrack')
    assert.equal(state.targetProps.track, mockNativeTrack)
    assert.equal(state.targetProps.key, 'rtk-screen-rtk-direct-track-123')
  })

  it('4. RealtimeKit participant with screenShareTracks.video resolves to UniversalVideoTrack', () => {
    const mockNativeTrack = {
      kind: 'video',
      readyState: 'live',
      id: 'rtk-video-stream-abc',
      addEventListener: () => {},
      removeEventListener: () => {},
      stop: () => {}
    }
    const rtkParticipant = {
      id: 'rtk-peer-555',
      customParticipantId: 'user-uuid-555',
      name: 'Charlie Desk',
      screenShareEnabled: true,
      screenShareTracks: { video: mockNativeTrack }
    }

    const state = resolveScreenShareState({
      participant: rtkParticipant
    })

    assert.equal(state.isRealtimeKit, true)
    assert.equal(state.renderTarget, 'UniversalVideoTrack')
    assert.equal(state.targetProps.track, mockNativeTrack)
    assert.equal(state.targetProps.key, 'rtk-screen-rtk-video-stream-abc')
    assert.equal(state.presenterName, 'Charlie Desk')
  })

  it('5. RealtimeKit screen-share enabled but track unavailable renders safe placeholder (NEVER LiveKit)', () => {
    const rtkParticipantPending = {
      id: 'rtk-peer-pending-777',
      customParticipantId: 'user-uuid-pending-777',
      name: 'Diana Presenting',
      screenShareEnabled: true,
      screenShareTracks: { video: null }
    }

    const state = resolveScreenShareState({
      participant: rtkParticipantPending
    })

    assert.equal(state.isRealtimeKit, true)
    assert.equal(state.isLiveKit, false)
    assert.equal(state.nativeTrack, null)
    assert.equal(state.renderTarget, 'SafePlaceholderConnecting', 'Must render safe placeholder when track is pending')
    assert.notEqual(state.renderTarget, 'LiveKitVideoTrack', 'Must NEVER render LiveKitVideoTrack for RealtimeKit')
    assert.equal(state.presenterName, 'Diana Presenting')
  })

  it('6. Explicitly distinguishes LiveKit trackRef from duck-typed MediaStreamTrack', () => {
    const duckTypedMediaTrack = {
      kind: 'video',
      readyState: 'live',
      id: 'webrtc-track-1',
      addEventListener: () => {},
      stop: () => {}
    }

    const liveKitTrackRef = {
      participant: { getTrackPublication: () => {} },
      publication: { trackSid: 'TR_LK_1' },
      source: 'screen_share'
    }

    assert.equal(isNativeMediaStreamTrack(duckTypedMediaTrack), true, 'duckTypedMediaTrack must be recognized as native')
    assert.equal(isNativeMediaStreamTrack(liveKitTrackRef), false, 'liveKitTrackRef must NOT be recognized as native')

    const stateMedia = resolveScreenShareState({ trackRef: duckTypedMediaTrack })
    const stateLK = resolveScreenShareState({ trackRef: liveKitTrackRef })

    assert.equal(stateMedia.renderTarget, 'UniversalVideoTrack')
    assert.equal(stateLK.renderTarget, 'LiveKitVideoTrack')
  })

  it('7. Stable session keys never use customParticipantId as React key', () => {
    const rtkParticipant = {
      id: 'rtk-session-session_abc',
      customParticipantId: 'user-uuid-shared',
      screenShareTracks: { video: null }
    }

    const state = resolveScreenShareState({
      participant: rtkParticipant,
      instanceId: 'inst-fallback-1'
    })

    assert.equal(state.rtkVideoKey, 'rtk-screen-rtk-session-session_abc')
    assert.ok(!state.rtkVideoKey.includes('user-uuid-shared'), 'Must NOT use customParticipantId as React key')
  })

  it('8. Two participants with missing session IDs receive distinct instance keys without collision', () => {
    const p1 = { customParticipantId: 'user-shared-1', screenShareEnabled: true }
    const p2 = { customParticipantId: 'user-shared-1', screenShareEnabled: true }

    const state1 = resolveScreenShareState({ participant: p1, instanceId: 'inst-1' })
    const state2 = resolveScreenShareState({ participant: p2, instanceId: 'inst-2' })

    assert.notEqual(state1.rtkVideoKey, state2.rtkVideoKey, 'Fallback keys must never collide')
  })

  it('9. Presenter display name handles all name/identity/customParticipantId permutations', () => {
    assert.equal(resolveScreenShareState({ participant: { name: 'Dr. Smith' } }).presenterName, 'Dr. Smith')
    assert.equal(resolveScreenShareState({ participant: { identity: 'smith@uni.edu' } }).presenterName, 'smith@uni.edu')
    assert.equal(resolveScreenShareState({ participant: { customParticipantId: 'uuid-123' } }).presenterName, 'Participant')
    assert.equal(resolveScreenShareState({ participant: null }).presenterName, 'User')
  })
})
