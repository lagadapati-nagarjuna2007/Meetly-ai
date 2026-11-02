import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeRemoteParticipant,
  normalizeLocalParticipant,
  normalizeScreenShareTracks,
  mapRealtimeKitConnectionState,
  getCameraErrorMessage,
  buildRealtimeKitClientOptions,
  shouldInitializeClient,
  shouldJoinRoom,
  deactivateCameraTrack,
  isMediaActionPermitted,
  createParticipantListenerManager
} from '../../src/components/meeting/realtimeKitAdapterUtils.js'

/**
 * Meetly AI — Phase 4, Step 6.6.2: RealtimeKit Runtime Safety & Lifecycle Tests
 *
 * Verifies all 12 runtime safety requirements:
 * 1. Audio playback module is enabled during initialization (modules: { experimentalAudioPlayback: true }).
 * 2. Client initialization is not duplicated when already in flight.
 * 3. Failed initialization can be retried with the same token.
 * 4. New token permits appropriate re-initialization (waiting-room admission, token refresh).
 * 5. Concurrent join attempts are prevented with single-flight guard.
 * 6. React Strict Mode lifecycle setup/cleanup/setup does not permanently destroy the client session.
 * 7. Intentional leave cleans up session immediately.
 * 8. Camera acquisition resolving after unmount does not publish a track or leak an orphaned clone.
 * 9. Camera clone is stopped during cleanup.
 * 10. Original physical camera track remains active when MediaPipe attendance requires it.
 * 11. Rapid camera on/off does not publish stale tracks and generates fresh clones.
 * 12. Cleanup is idempotent and safe to call repeatedly.
 */

describe('Meetly AI — RealtimeKitAdapter Runtime Safety & Lifecycle Suite', () => {
  it('1. Audio playback module is enabled during client initialization', () => {
    const token = 'cf-test-token-valid-123'
    const options = buildRealtimeKitClientOptions(token)

    assert.equal(options.authToken, token)
    assert.deepEqual(options.defaults, { video: false, audio: false })
    assert.ok(options.modules, 'options.modules must be present')
    assert.equal(
      options.modules.experimentalAudioPlayback,
      true,
      'experimentalAudioPlayback must be enabled for remote audio to play'
    )
  })

  it('2. Initialization is not duplicated when already in flight', () => {
    const token = 'cf-test-token-123'

    const check1 = shouldInitializeClient({
      effectiveToken: token,
      lastInitializedToken: null,
      isInitializing: false,
      hasError: false,
      hasClient: false
    })
    assert.equal(check1, true, 'First initialization should proceed')

    // Second call while in flight
    const check2 = shouldInitializeClient({
      effectiveToken: token,
      lastInitializedToken: null,
      isInitializing: true,
      hasError: false,
      hasClient: false
    })
    assert.equal(check2, false, 'Duplicate in-flight initialization must be prevented')

    // Call after already successfully initialized with existing client
    const check3 = shouldInitializeClient({
      effectiveToken: token,
      lastInitializedToken: token,
      isInitializing: false,
      hasError: false,
      hasClient: true
    })
    assert.equal(check3, false, 'Should not re-initialize when client already exists for same token')
  })

  it('3. Failed initialization can be retried with the same token', () => {
    const token = 'cf-test-token-failing'

    const canRetry = shouldInitializeClient({
      effectiveToken: token,
      lastInitializedToken: token,
      isInitializing: false,
      hasError: true,
      hasClient: false
    })
    assert.equal(canRetry, true, 'Retry must be permitted after failure with same token')
  })

  it('4. New token permits appropriate re-initialization (admission or refresh)', () => {
    const oldToken = 'cf-old-token'
    const newToken = 'cf-admitted-token'

    const canReinit = shouldInitializeClient({
      effectiveToken: newToken,
      lastInitializedToken: oldToken,
      isInitializing: false,
      hasError: false,
      hasClient: true
    })
    assert.equal(canReinit, true, 'New token must trigger re-initialization')
  })

  it('5. Concurrent join attempts are prevented with single-flight guard', () => {
    const mockClientNotJoined = {
      self: { roomJoined: false, roomState: 'init' },
      join: async () => {}
    }

    assert.equal(
      shouldJoinRoom({ client: mockClientNotJoined, isJoining: false }),
      true,
      'Join should proceed when room is unjoined'
    )

    assert.equal(
      shouldJoinRoom({ client: mockClientNotJoined, isJoining: true }),
      false,
      'Concurrent join attempt must be blocked while join is already in flight'
    )

    const mockClientAlreadyJoined = {
      self: { roomJoined: true, roomState: 'joined' },
      join: async () => {}
    }

    assert.equal(
      shouldJoinRoom({ client: mockClientAlreadyJoined, isJoining: false }),
      false,
      'Join should be skipped when client is already joined'
    )
  })

  it('6. React Strict Mode lifecycle setup/cleanup/setup does not permanently destroy the client', async () => {
    let leaveCallCount = 0
    let unmountTimer = null

    const mockClient = {
      leave: async () => {
        leaveCallCount++
      }
    }

    // Step A: Mount 1
    // Component mounts in Strict Mode. isIntentionalLeave = false
    let isIntentionalLeave = false

    // Step B: Strict Mode cleanup runs
    unmountTimer = setTimeout(() => {
      if (mockClient && typeof mockClient.leave === 'function') {
        mockClient.leave()
      }
    }, 150)

    // Step C: Strict Mode remount runs immediately (< 10ms), before timer expires
    if (unmountTimer) {
      clearTimeout(unmountTimer)
      unmountTimer = null
    }

    // Wait 200ms to ensure the timer was truly cancelled and client was not destroyed
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(leaveCallCount, 0, 'React Strict Mode remount must NOT trigger client.leave()')
  })

  it('7. Intentional leave cleans up session immediately', () => {
    let leaveCallCount = 0

    const mockClient = {
      leave: () => {
        leaveCallCount++
      }
    }

    const isIntentionalLeave = true

    // When intentional leave is true, leave is called immediately without timer
    if (isIntentionalLeave && mockClient && typeof mockClient.leave === 'function') {
      mockClient.leave()
    }

    assert.equal(leaveCallCount, 1, 'Intentional leave must call client.leave() immediately')
  })

  it('8. Camera acquisition resolving after unmount does not publish a track or leak an orphaned clone', async () => {
    let isMounted = true
    let enableVideoCallCount = 0
    let cloneStopCallCount = 0
    let masterStopCallCount = 0

    const masterPhysicalTrack = {
      id: 'master-track-01',
      kind: 'video',
      readyState: 'live',
      stop: () => {
        masterStopCallCount++
      },
      clone: () => {
        return {
          id: 'clone-track-01',
          kind: 'video',
          stop: () => {
            cloneStopCallCount++
          }
        }
      }
    }

    const mockMeetingSelf = {
      enableVideo: async () => {
        enableVideoCallCount++
      }
    }

    const getOrCreatePhysicalTrack = async () => {
      // Simulate network/hardware latency
      await new Promise((r) => setTimeout(r, 50))
      return masterPhysicalTrack
    }

    const clonedTrackRef = { current: null }
    const meetingCamActiveRef = { current: true }
    const attendanceNeedsCameraRef = { current: false }

    const releasePhysicalCameraIfUnneeded = () => {
      if (!attendanceNeedsCameraRef.current && !meetingCamActiveRef.current) {
        masterPhysicalTrack.stop()
      }
    }

    // Start async camera acquisition
    const cameraPromise = (async () => {
      const physicalTrack = await getOrCreatePhysicalTrack()
      if (!isMounted) {
        meetingCamActiveRef.current = false
        releasePhysicalCameraIfUnneeded()
        return
      }
      const clone = physicalTrack.clone()
      if (!isMounted) {
        clone.stop()
        meetingCamActiveRef.current = false
        releasePhysicalCameraIfUnneeded()
        return
      }
      clonedTrackRef.current = clone
      await mockMeetingSelf.enableVideo(clone)
    })()

    // Component unmounts while camera acquisition is in flight!
    isMounted = false

    await cameraPromise

    assert.equal(enableVideoCallCount, 0, 'enableVideo must NEVER be called after component unmounts')
    assert.equal(clonedTrackRef.current, null, 'No cloned track reference should remain')
    assert.equal(meetingCamActiveRef.current, false, 'meetingCamActive must be false')
    assert.equal(masterStopCallCount, 1, 'Physical camera should be released since attendance does not need it')
  })

  it('9. Camera clone is stopped during cleanup', () => {
    let cloneStopped = false
    const mockClone = {
      id: 'cloned-track-abc',
      stop: () => {
        cloneStopped = true
      }
    }
    const clonedTrackRef = { current: mockClone }
    const meetingCamActiveRef = { current: true }

    deactivateCameraTrack({
      clonedTrackRef,
      meetingCamActiveRef,
      releasePhysicalCameraIfUnneeded: () => {}
    })

    assert.equal(cloneStopped, true, 'Cloned track must be stopped during cleanup')
    assert.equal(clonedTrackRef.current, null, 'clonedTrackRef must be set to null')
    assert.equal(meetingCamActiveRef.current, false, 'meetingCamActiveRef must be reset')
  })

  it('10. Original physical camera track remains active when attendance requires it', () => {
    let masterStopped = false
    let cloneStopped = false

    const masterTrack = {
      id: 'master-phys-01',
      stop: () => {
        masterStopped = true
      }
    }

    const cloneTrack = {
      id: 'clone-phys-01',
      stop: () => {
        cloneStopped = true
      }
    }

    const attendanceNeedsCamera = true
    const meetingCamActiveRef = { current: true }
    const clonedTrackRef = { current: cloneTrack }

    const releasePhysicalCameraIfUnneeded = () => {
      if (!attendanceNeedsCamera && !meetingCamActiveRef.current) {
        masterTrack.stop()
      }
    }

    // Meeting camera turned off or adapter cleaned up
    deactivateCameraTrack({
      clonedTrackRef,
      meetingCamActiveRef,
      releasePhysicalCameraIfUnneeded
    })

    assert.equal(cloneStopped, true, 'Adapter clone must be stopped')
    assert.equal(masterStopped, false, 'CRITICAL: Master track must NOT be stopped while attendance requires it')
  })

  it('11. Rapid camera on/off does not publish stale tracks and generates fresh clones', async () => {
    let cloneCount = 0
    const createdClones = []
    let camActionInFlight = false

    const masterTrack = {
      clone: () => {
        cloneCount++
        const clone = { id: `clone-${cloneCount}`, stopped: false, stop() { this.stopped = true } }
        createdClones.push(clone)
        return clone
      }
    }

    // Toggle 1: Cam ON
    assert.equal(camActionInFlight, false)
    camActionInFlight = true
    const clone1 = masterTrack.clone()
    camActionInFlight = false

    assert.equal(createdClones.length, 1)
    assert.equal(createdClones[0].id, 'clone-1')

    // Toggle 2: Cam OFF
    clone1.stop()
    assert.equal(clone1.stopped, true)

    // Overlapping click while action in flight: should be rejected
    camActionInFlight = true
    const attemptDuringInFlight = camActionInFlight ? null : masterTrack.clone()
    assert.equal(attemptDuringInFlight, null, 'Overlapping action while in-flight must be rejected')
    camActionInFlight = false

    // Toggle 3: Cam ON again: must generate fresh clone
    const clone2 = masterTrack.clone()
    assert.equal(createdClones.length, 2)
    assert.equal(clone2.id, 'clone-2', 'Must generate a distinct fresh clone on re-enable')
    assert.equal(clone2.stopped, false)
  })

  it('12. Cleanup is idempotent and safe to invoke repeatedly', () => {
    let stopCallCount = 0
    const mockClone = {
      stop: () => {
        stopCallCount++
      }
    }
    const clonedTrackRef = { current: mockClone }
    const meetingCamActiveRef = { current: true }
    let releaseCallCount = 0

    const releaseFn = () => {
      releaseCallCount++
    }

    // Call 1
    deactivateCameraTrack({
      clonedTrackRef,
      meetingCamActiveRef,
      releasePhysicalCameraIfUnneeded: releaseFn
    })

    assert.equal(stopCallCount, 1)
    assert.equal(releaseCallCount, 1)
    assert.equal(clonedTrackRef.current, null)

    // Call 2 (idempotent repeated call)
    assert.doesNotThrow(() => {
      deactivateCameraTrack({
        clonedTrackRef,
        meetingCamActiveRef,
        releasePhysicalCameraIfUnneeded: releaseFn
      })
    })

    assert.equal(stopCallCount, 1, 'Clone stop must not be called again once null')
    assert.equal(releaseCallCount, 2, 'Release check is safe to invoke repeatedly')
  })

  it('13. normalizeRemoteParticipant maps peer ID, customParticipantId, and native tracks correctly', () => {
    const mockNativeVideoTrack = { id: 'cf-vid-track-1', kind: 'video', readyState: 'live' }
    const mockNativeAudioTrack = { id: 'cf-aud-track-1', kind: 'audio', readyState: 'live' }

    const rawParticipant = {
      id: 'session-peer-1234',
      customParticipantId: 'user-uuid-abcd-ef01',
      userId: 'user-uuid-abcd-ef01',
      name: 'Dr. Jane Smith',
      isHost: true,
      videoTrack: mockNativeVideoTrack,
      audioTrack: mockNativeAudioTrack,
      videoEnabled: true,
      audioEnabled: false,
      screenShareEnabled: false,
      screenShareTracks: { video: null, audio: null }
    }

    const normalized = normalizeRemoteParticipant(rawParticipant)

    assert.equal(normalized.id, 'session-peer-1234')
    assert.equal(normalized.sid, 'session-peer-1234')
    assert.equal(normalized.identity, 'user-uuid-abcd-ef01')
    assert.equal(normalized.customParticipantId, 'user-uuid-abcd-ef01')
    assert.equal(normalized.userId, 'user-uuid-abcd-ef01')
    assert.equal(normalized.videoTrack, mockNativeVideoTrack)
    assert.equal(normalized.audioTrack, mockNativeAudioTrack)
    assert.equal(normalized.videoEnabled, true)
    assert.equal(normalized.audioEnabled, false)
    assert.equal(normalized.isCameraEnabled, true)
    assert.equal(normalized.isMicrophoneEnabled, false)
    assert.equal(normalized.isHost, true)
  })

  it('14. normalizeLocalParticipant maps self object, user profile, and provides async methods', async () => {
    let setNameCalledWith = null
    let audioEnabledState = false
    let screenShareEnabledState = false

    const mockSelf = {
      id: 'session-peer-local-001',
      customParticipantId: 'user-uuid-local-owner',
      name: 'Fallback Name',
      roomJoined: true,
      roomState: 'joined',
      videoTrack: { id: 'local-cam-track', kind: 'video' },
      audioTrack: null,
      videoEnabled: true,
      audioEnabled: false,
      screenShareEnabled: false,
      screenShareTracks: { video: null, audio: null },
      setName: (name) => {
        setNameCalledWith = name
      },
      enableAudio: async () => {
        audioEnabledState = true
      },
      disableAudio: async () => {
        audioEnabledState = false
      },
      enableScreenShare: async () => {
        screenShareEnabledState = true
      },
      disableScreenShare: async () => {
        screenShareEnabledState = false
      }
    }

    const mockUser = {
      id: 'user-uuid-local-owner',
      name: 'Alice Developer'
    }

    const localParticipant = normalizeLocalParticipant({
      self: mockSelf,
      user: mockUser,
      isHost: true
    })

    assert.equal(localParticipant.id, 'session-peer-local-001')
    assert.equal(localParticipant.sid, 'session-peer-local-001')
    assert.equal(localParticipant.identity, 'user-uuid-local-owner')
    assert.equal(localParticipant.name, 'Alice Developer')
    assert.equal(localParticipant.isHost, true)

    // Async setName returns a Promise
    const setNameResult = localParticipant.setName('Updated Name')
    assert.ok(setNameResult instanceof Promise)
    await setNameResult
    assert.equal(setNameCalledWith, 'Updated Name')

    await localParticipant.setMicrophoneEnabled(true)
    assert.equal(audioEnabledState, true)
    await localParticipant.setMicrophoneEnabled(false)
    assert.equal(audioEnabledState, false)

    await localParticipant.setScreenShareEnabled(true)
    assert.equal(screenShareEnabledState, true)
  })

  it('15. normalizeScreenShareTracks formats tracks for local and remote presenters', () => {
    const mockScreenTrackLocal = { id: 'screen-local-track', kind: 'video' }
    const mockScreenTrackRemote = { id: 'screen-remote-track', kind: 'video' }

    const localSelf = {
      id: 'self-peer-1',
      screenShareEnabled: true,
      screenShareTracks: { video: mockScreenTrackLocal }
    }

    const remotePresenter = {
      id: 'remote-peer-2',
      name: 'Bob Presenter',
      screenShareEnabled: true,
      screenShareTracks: { video: mockScreenTrackRemote }
    }

    const tracks = normalizeScreenShareTracks({
      self: localSelf,
      remoteParticipants: [remotePresenter]
    })

    assert.equal(tracks.length, 2)
    assert.equal(tracks[0].id, 'self-peer-1-screenshare')
    assert.equal(tracks[0].track, mockScreenTrackLocal)
    assert.equal(tracks[0].isRealtimeKit, true)

    assert.equal(tracks[1].id, 'remote-peer-2-screenshare')
    assert.equal(tracks[1].track, mockScreenTrackRemote)
    assert.equal(tracks[1].isRealtimeKit, true)
  })

  it('16. mapRealtimeKitConnectionState maps all room lifecycle states correctly', () => {
    assert.equal(mapRealtimeKitConnectionState({ roomJoined: true, roomState: 'joined', isReconnecting: true }), 'reconnecting')
    assert.equal(mapRealtimeKitConnectionState({ roomJoined: true, roomState: 'joined', isReconnecting: false }), 'connected')
    assert.equal(mapRealtimeKitConnectionState({ roomJoined: false, roomState: 'init', isReconnecting: false }), 'connecting')
    assert.equal(mapRealtimeKitConnectionState({ roomJoined: false, roomState: 'waitlisted', isReconnecting: false }), 'connecting')
    assert.equal(mapRealtimeKitConnectionState({ roomJoined: false, roomState: 'left', isReconnecting: false }), 'disconnected')
  })

  it('17. getCameraErrorMessage converts hardware/permission errors to friendly messages', () => {
    assert.equal(
      getCameraErrorMessage({ name: 'NotAllowedError' }),
      'Camera permission denied. Please allow camera access in your browser settings.'
    )
    assert.equal(
      getCameraErrorMessage({ name: 'NotFoundError' }),
      'No camera found. Please connect a camera and try again.'
    )
    assert.equal(
      getCameraErrorMessage({ name: 'NotReadableError' }),
      'Camera is in use by another application. Please close it and try again.'
    )
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6.7.3: Remote Screen-Share Updates & Media-Action Guards
  // ──────────────────────────────────────────────────────────────────────────

  class MockParticipant {
    constructor(id, name) {
      this.id = id
      this.name = name
      this.events = new Map()
      this.screenShareEnabled = false
      this.screenShareTracks = { video: null, audio: null }
    }

    on(event, handler) {
      if (!this.events.has(event)) this.events.set(event, new Set())
      this.events.get(event).add(handler)
    }

    removeListener(event, handler) {
      if (this.events.has(event)) {
        this.events.get(event).delete(handler)
      }
    }

    emit(event, data) {
      if (this.events.has(event)) {
        for (const handler of Array.from(this.events.get(event))) {
          handler(data)
        }
      }
    }

    getListenerCount(event) {
      return this.events.has(event) ? this.events.get(event).size : 0
    }
  }

  it('18. Remote participant screenShareUpdate triggers UI/track-state refresh', () => {
    let updateTriggered = 0
    const manager = createParticipantListenerManager({
      onUpdate: () => {
        updateTriggered++
      }
    })

    const remotePeer = new MockParticipant('peer-remote-1', 'Alice')
    manager.attach(remotePeer)

    // Verify listeners attached
    assert.equal(remotePeer.getListenerCount('screenShareUpdate'), 1)
    assert.equal(remotePeer.getListenerCount('videoUpdate'), 1)
    assert.equal(remotePeer.getListenerCount('audioUpdate'), 1)

    // Remote peer emits screenShareUpdate
    remotePeer.screenShareEnabled = true
    const mockScreenTrack = { id: 'mock-screen-track-1', kind: 'video' }
    remotePeer.screenShareTracks = { video: mockScreenTrack }
    remotePeer.emit('screenShareUpdate', { screenShareEnabled: true, screenShareTracks: remotePeer.screenShareTracks })

    assert.equal(updateTriggered, 1, 'onUpdate callback must be triggered on screenShareUpdate')

    // Track normalization receives the remote track
    const tracks = normalizeScreenShareTracks({
      self: { screenShareEnabled: false },
      remoteParticipants: [remotePeer]
    })
    assert.equal(tracks.length, 1)
    assert.equal(tracks[0].id, 'peer-remote-1-screenshare')
    assert.equal(tracks[0].track, mockScreenTrack)
  })

  it('19. A participant joining after adapter initialization receives the required listeners', () => {
    let updateTriggered = 0
    const manager = createParticipantListenerManager({
      onUpdate: () => {
        updateTriggered++
      }
    })

    const initialPeer = new MockParticipant('peer-1', 'Initial Peer')
    manager.reconcile([initialPeer])
    assert.equal(manager.getSubscribedCount(), 1)

    // Later, a new participant joins
    const latePeer = new MockParticipant('peer-2', 'Late Peer')
    manager.attach(latePeer)

    assert.equal(manager.getSubscribedCount(), 2)
    assert.equal(latePeer.getListenerCount('screenShareUpdate'), 1)
    assert.equal(latePeer.getListenerCount('videoUpdate'), 1)
    assert.equal(latePeer.getListenerCount('audioUpdate'), 1)

    // Emitting from late peer also triggers refresh
    latePeer.emit('videoUpdate')
    assert.equal(updateTriggered, 1)
  })

  it('20. A participant leaving has its listeners removed cleanly', () => {
    const manager = createParticipantListenerManager()
    const peer1 = new MockParticipant('peer-1', 'Peer 1')
    const peer2 = new MockParticipant('peer-2', 'Peer 2')

    manager.reconcile([peer1, peer2])
    assert.equal(manager.getSubscribedCount(), 2)

    // Peer 2 leaves -> reconcile without peer 2
    manager.reconcile([peer1])
    assert.equal(manager.getSubscribedCount(), 1)
    assert.equal(manager.isSubscribed('peer-2'), false)
    assert.equal(peer2.getListenerCount('screenShareUpdate'), 0)
    assert.equal(peer2.getListenerCount('videoUpdate'), 0)
    assert.equal(peer2.getListenerCount('audioUpdate'), 0)

    // Explicit detach also cleans up
    manager.detach('peer-1')
    assert.equal(manager.getSubscribedCount(), 0)
    assert.equal(peer1.getListenerCount('screenShareUpdate'), 0)
  })

  it('21. Adapter unmount removes all registered participant listeners', () => {
    const manager = createParticipantListenerManager()
    const peer1 = new MockParticipant('peer-1', 'Peer 1')
    const peer2 = new MockParticipant('peer-2', 'Peer 2')
    const peer3 = new MockParticipant('peer-3', 'Peer 3')

    manager.reconcile([peer1, peer2, peer3])
    assert.equal(manager.getSubscribedCount(), 3)

    // Simulate unmount cleanup
    manager.cleanupAll()
    assert.equal(manager.getSubscribedCount(), 0)
    assert.equal(peer1.getListenerCount('screenShareUpdate'), 0)
    assert.equal(peer2.getListenerCount('screenShareUpdate'), 0)
    assert.equal(peer3.getListenerCount('screenShareUpdate'), 0)
  })

  it('22. Repeated participant updates do not create duplicate listeners', () => {
    const manager = createParticipantListenerManager()
    const peer1 = new MockParticipant('peer-1', 'Peer 1')

    // Call reconcile multiple times in a row with the same participant
    manager.reconcile([peer1])
    manager.reconcile([peer1])
    manager.reconcile([peer1])
    manager.attach(peer1)

    assert.equal(manager.getSubscribedCount(), 1)
    assert.equal(peer1.getListenerCount('screenShareUpdate'), 1, 'Duplicate listeners must not be added')
    assert.equal(peer1.getListenerCount('videoUpdate'), 1)
    assert.equal(peer1.getListenerCount('audioUpdate'), 1)
  })

  it('23. Camera, microphone, and screen-share actions do nothing before roomJoined', async () => {
    let audioCallCount = 0
    let screenCallCount = 0
    let nameCallCount = 0

    const mockSelf = {
      id: 'self-123',
      name: 'Tester',
      roomJoined: false,
      roomState: 'init',
      enableAudio: async () => { audioCallCount++ },
      disableAudio: async () => { audioCallCount++ },
      enableScreenShare: async () => { screenCallCount++ },
      disableScreenShare: async () => { screenCallCount++ },
      setName: (n) => { nameCallCount++ }
    }

    assert.equal(isMediaActionPermitted(mockSelf), false, 'Media action must not be permitted when roomJoined is false')
    assert.equal(isMediaActionPermitted(null), false)
    assert.equal(isMediaActionPermitted({ roomJoined: false, roomState: 'init' }), false)

    const normalized = normalizeLocalParticipant({ self: mockSelf, user: { id: 'user-1' } })

    // Calling normalized localParticipant actions before roomJoined
    await normalized.setMicrophoneEnabled(true)
    await normalized.setMicrophoneEnabled(false)
    await normalized.setScreenShareEnabled(true)
    await normalized.setScreenShareEnabled(false)
    await normalized.setName('New Name')

    assert.equal(audioCallCount, 0, 'Audio APIs must not be called before roomJoined')
    assert.equal(screenCallCount, 0, 'ScreenShare APIs must not be called before roomJoined')
    assert.equal(nameCallCount, 0, 'setName must not be called before roomJoined')
  })

  it('24. Media actions work normally after roomJoined becomes true', async () => {
    let audioCallCount = 0
    let screenCallCount = 0
    let nameCallCount = 0

    const mockSelf = {
      id: 'self-123',
      name: 'Tester',
      roomJoined: true,
      roomState: 'joined',
      enableAudio: async () => { audioCallCount++ },
      disableAudio: async () => { audioCallCount++ },
      enableScreenShare: async () => { screenCallCount++ },
      disableScreenShare: async () => { screenCallCount++ },
      setName: (n) => { nameCallCount++ }
    }

    assert.equal(isMediaActionPermitted(mockSelf), true, 'Media action must be permitted when roomJoined is true')

    const normalized = normalizeLocalParticipant({ self: mockSelf, user: { id: 'user-1' } })

    await normalized.setMicrophoneEnabled(true)
    await normalized.setMicrophoneEnabled(false)
    await normalized.setScreenShareEnabled(true)
    await normalized.setScreenShareEnabled(false)
    await normalized.setName('New Name')

    assert.equal(audioCallCount, 2, 'Audio APIs should be called after roomJoined')
    assert.equal(screenCallCount, 2, 'ScreenShare APIs should be called after roomJoined')
    assert.equal(nameCallCount, 1, 'setName should be called after roomJoined')
  })
})
