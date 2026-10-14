import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveMediaUserId,
  getSavedMediaPreferences,
  saveMediaPreference,
  resolveInitialMediaState,
  readActualLiveKitMediaState,
  applyInitialMediaState,
  toggleMicrophoneState,
  toggleCameraState,
  syncAndEnforceMediaState
} from '../../src/utils/mediaPreferences.js'

function createMockStorage() {
  const store = new Map()
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null
    },
    setItem(key, value) {
      store.set(key, String(value))
    },
    removeItem(key) {
      store.delete(key)
    },
    clear() {
      store.clear()
    },
    _dump() {
      return Object.fromEntries(store.entries())
    }
  }
}

function createMockLiveKitParticipant({
  identity = '11111111-1111-4111-8111-111111111111',
  userId = '11111111-1111-4111-8111-111111111111'
} = {}) {
  const publications = new Map()
  const calls = {
    setMicrophoneEnabled: [],
    publishTrack: [],
    unpublishTrack: []
  }

  const participant = {
    identity,
    metadata: JSON.stringify({ userId, role: 'participant' }),
    isMicrophoneEnabled: false,
    isCameraEnabled: false,
    calls,
    getTrackPublication(source) {
      return publications.get(source) || undefined
    },
    async setMicrophoneEnabled(enabled) {
      calls.setMicrophoneEnabled.push(enabled)
      participant.isMicrophoneEnabled = Boolean(enabled)
      if (enabled) {
        publications.set('microphone', {
          source: 'microphone',
          isMuted: false,
          track: { readyState: 'live', stop() {} }
        })
      } else if (publications.has('microphone')) {
        const pub = publications.get('microphone')
        pub.isMuted = true
      }
      return publications.get('microphone')
    },
    async publishTrack(track, options = {}) {
      const source = options.source || 'camera'
      calls.publishTrack.push({ track, options })
      publications.set(source, {
        source,
        isMuted: false,
        track
      })
      if (source === 'camera') {
        participant.isCameraEnabled = true
      }
      return publications.get(source)
    },
    async unpublishTrack(track) {
      calls.unpublishTrack.push(track)
      for (const [source, pub] of publications.entries()) {
        if (pub.track === track) {
          publications.delete(source)
          if (source === 'camera') {
            participant.isCameraEnabled = false
          }
        }
      }
    }
  }

  return participant
}

function createMockCameraHardware() {
  let acquireCount = 0
  let releaseCheckCount = 0
  let stoppedCount = 0

  const getOrCreatePhysicalTrack = async () => {
    acquireCount++
    const makeTrack = () => ({
      readyState: 'live',
      stop() {
        this.readyState = 'ended'
        stoppedCount++
      },
      clone() {
        return makeTrack()
      }
    })
    return makeTrack()
  }

  const releasePhysicalCameraIfUnneeded = () => {
    releaseCheckCount++
  }

  return {
    getOrCreatePhysicalTrack,
    releasePhysicalCameraIfUnneeded,
    getStats() {
      return { acquireCount, releaseCheckCount, stoppedCount }
    }
  }
}

test('1. Sensible defaults for users without saved preferences & boolean-only storage', () => {
  const storage = createMockStorage()
  const userId = 'aaaaaaaa-1111-4111-8111-111111111111'

  const prefs = getSavedMediaPreferences(userId, storage)
  assert.deepEqual(prefs, { micEnabled: true, camEnabled: true })

  saveMediaPreference(userId, { micEnabled: false, camEnabled: false }, storage)
  const rawEntries = storage._dump()
  const userEntry = rawEntries[`meetly_media_prefs:${userId}`]
  assert.ok(userEntry)
  assert.deepEqual(JSON.parse(userEntry), { micEnabled: false, camEnabled: false })
})

test('2. Per-user isolation and independent device toggling without side effects', async () => {
  const storage = createMockStorage()
  const userA = 'aaaaaaaa-1111-4111-8111-111111111111'
  const userB = 'bbbbbbbb-2222-4222-8222-222222222222'

  // User A turns OFF only microphone
  saveMediaPreference(userA, { micEnabled: false }, storage)
  assert.deepEqual(getSavedMediaPreferences(userA, storage), {
    micEnabled: false,
    camEnabled: true
  })

  // User A turns OFF camera; microphone remains OFF
  saveMediaPreference(userA, { camEnabled: false }, storage)
  assert.deepEqual(getSavedMediaPreferences(userA, storage), {
    micEnabled: false,
    camEnabled: false
  })

  // User A turns ON microphone; camera remains OFF
  saveMediaPreference(userA, { micEnabled: true }, storage)
  assert.deepEqual(getSavedMediaPreferences(userA, storage), {
    micEnabled: true,
    camEnabled: false
  })

  // User B still has untouched defaults
  assert.deepEqual(getSavedMediaPreferences(userB, storage), {
    micEnabled: true,
    camEnabled: true
  })
})

test('3. Scenario: Both Mic and Camera turned OFF before refresh stay OFF after refresh without activating hardware', async () => {
  const storage = createMockStorage()
  const userId = '11111111-1111-4111-8111-111111111111'

  // Session 1: User joins with defaults (both ON), then turns OFF both Mic and Camera
  const participant1 = createMockLiveKitParticipant({ userId })
  const hw1 = createMockCameraHardware()
  let micUI1 = true
  let camUI1 = true

  await applyInitialMediaState({
    localParticipant: participant1,
    userId,
    storage,
    getOrCreatePhysicalTrack: hw1.getOrCreatePhysicalTrack,
    releasePhysicalCameraIfUnneeded: hw1.releasePhysicalCameraIfUnneeded,
    setMicActive: (v) => { micUI1 = v },
    setCamActive: (v) => { camUI1 = v }
  })
  assert.equal(micUI1, true)
  assert.equal(camUI1, true)
  assert.equal(participant1.isMicrophoneEnabled, true)
  assert.equal(participant1.isCameraEnabled, true)

  // User toggles Mic OFF
  await toggleMicrophoneState({
    localParticipant: participant1,
    userId,
    currentMicActive: micUI1,
    storage,
    setMicActive: (v) => { micUI1 = v }
  })
  assert.equal(micUI1, false)
  assert.equal(participant1.isMicrophoneEnabled, false)
  // Camera must still be ON after toggling only Mic
  assert.equal(camUI1, true)
  assert.equal(participant1.isCameraEnabled, true)

  // User toggles Camera OFF
  await toggleCameraState({
    localParticipant: participant1,
    userId,
    currentCamActive: camUI1,
    storage,
    getOrCreatePhysicalTrack: hw1.getOrCreatePhysicalTrack,
    releasePhysicalCameraIfUnneeded: hw1.releasePhysicalCameraIfUnneeded,
    setCamActive: (v) => { camUI1 = v }
  })
  assert.equal(camUI1, false)
  assert.equal(participant1.isCameraEnabled, false)
  assert.equal(participant1.getTrackPublication('camera'), undefined)

  // Session 2 (Browser Refresh): New LiveKit participant & fresh hardware spy
  const participantAfterRefresh = createMockLiveKitParticipant({ userId })
  const hwAfterRefresh = createMockCameraHardware()
  let micUIAfterRefresh = resolveInitialMediaState({ userId, storage }).shouldEnableMic
  let camUIAfterRefresh = resolveInitialMediaState({ userId, storage }).shouldEnableCam
  let meetingCamActive = false

  // UI state before connection is already OFF
  assert.equal(micUIAfterRefresh, false)
  assert.equal(camUIAfterRefresh, false)

  await applyInitialMediaState({
    localParticipant: participantAfterRefresh,
    userId,
    storage,
    getOrCreatePhysicalTrack: hwAfterRefresh.getOrCreatePhysicalTrack,
    releasePhysicalCameraIfUnneeded: hwAfterRefresh.releasePhysicalCameraIfUnneeded,
    setMeetingCamActive: (v) => { meetingCamActive = v },
    setMicActive: (v) => { micUIAfterRefresh = v },
    setCamActive: (v) => { camUIAfterRefresh = v }
  })

  // Verify zero accidental hardware activation and both tracks remain OFF
  assert.equal(hwAfterRefresh.getStats().acquireCount, 0, 'Camera hardware must never be acquired when saved state is OFF')
  assert.equal(participantAfterRefresh.calls.publishTrack.length, 0, 'No camera track may be published when saved state is OFF')
  assert.equal(participantAfterRefresh.calls.setMicrophoneEnabled.includes(true), false, 'Microphone must never be enabled when saved state is OFF')
  assert.equal(meetingCamActive, false)
  assert.equal(micUIAfterRefresh, false)
  assert.equal(camUIAfterRefresh, false)
  assert.equal(participantAfterRefresh.isMicrophoneEnabled, false)
  assert.equal(participantAfterRefresh.isCameraEnabled, false)
})

test('4. Scenario: Mic ON + Camera OFF and Mic OFF + Camera ON preserved accurately across refresh', async () => {
  const storage = createMockStorage()
  const userId = '22222222-2222-4222-8222-222222222222'

  // Case A: Mic ON, Camera OFF
  saveMediaPreference(userId, { micEnabled: true, camEnabled: false }, storage)
  const pCaseA = createMockLiveKitParticipant({ userId })
  const hwCaseA = createMockCameraHardware()
  let micA = false
  let camA = true

  await applyInitialMediaState({
    localParticipant: pCaseA,
    userId,
    storage,
    getOrCreatePhysicalTrack: hwCaseA.getOrCreatePhysicalTrack,
    releasePhysicalCameraIfUnneeded: hwCaseA.releasePhysicalCameraIfUnneeded,
    setMicActive: (v) => { micA = v },
    setCamActive: (v) => { camA = v }
  })

  assert.equal(micA, true)
  assert.equal(camA, false)
  assert.equal(pCaseA.isMicrophoneEnabled, true)
  assert.equal(pCaseA.isCameraEnabled, false)
  assert.equal(hwCaseA.getStats().acquireCount, 0, 'Camera must not be acquired when camEnabled is false')

  // Case B: Mic OFF, Camera ON
  saveMediaPreference(userId, { micEnabled: false, camEnabled: true }, storage)
  const pCaseB = createMockLiveKitParticipant({ userId })
  const hwCaseB = createMockCameraHardware()
  let micB = true
  let camB = false

  await applyInitialMediaState({
    localParticipant: pCaseB,
    userId,
    storage,
    getOrCreatePhysicalTrack: hwCaseB.getOrCreatePhysicalTrack,
    releasePhysicalCameraIfUnneeded: hwCaseB.releasePhysicalCameraIfUnneeded,
    setMicActive: (v) => { micB = v },
    setCamActive: (v) => { camB = v }
  })

  assert.equal(micB, false)
  assert.equal(camB, true)
  assert.equal(pCaseB.isMicrophoneEnabled, false)
  assert.equal(pCaseB.isCameraEnabled, true)
  assert.equal(hwCaseB.getStats().acquireCount, 1, 'Camera must be acquired once when camEnabled is true')
  assert.equal(pCaseB.calls.setMicrophoneEnabled.includes(true), false, 'Mic must not be enabled when micEnabled is false')
})

test('5. Host mute_all_enabled overrides participant mic ON at join without overwriting saved preference', async () => {
  const storage = createMockStorage()
  const userId = '33333333-3333-4333-8333-333333333333'
  saveMediaPreference(userId, { micEnabled: true, camEnabled: false }, storage)

  const participant = createMockLiveKitParticipant({ userId })
  const hw = createMockCameraHardware()
  const wasMutedByHostRef = { current: false }
  let micUI = true
  let camUI = false

  await applyInitialMediaState({
    localParticipant: participant,
    userId,
    isHost: false,
    muteAllEnabled: true,
    storage,
    getOrCreatePhysicalTrack: hw.getOrCreatePhysicalTrack,
    releasePhysicalCameraIfUnneeded: hw.releasePhysicalCameraIfUnneeded,
    setMicActive: (v) => { micUI = v },
    setCamActive: (v) => { camUI = v },
    wasMutedByHostRef
  })

  assert.equal(micUI, false)
  assert.equal(camUI, false)
  assert.equal(wasMutedByHostRef.current, true)
  assert.equal(participant.isMicrophoneEnabled, false)
  // Saved preference in storage remains micEnabled: true for other meetings
  assert.deepEqual(getSavedMediaPreferences(userId, storage), {
    micEnabled: true,
    camEnabled: false
  })
})

test('6. Reconnection synchronization enforces saved OFF states and keeps buttons aligned with LiveKit tracks', async () => {
  const storage = createMockStorage()
  const userId = '44444444-4444-4444-8444-444444444444'
  saveMediaPreference(userId, { micEnabled: false, camEnabled: false }, storage)

  const participant = createMockLiveKitParticipant({ userId })
  const hw = createMockCameraHardware()

  // Simulate accidental track republishing during a transport reconnect
  const strayTrack = await hw.getOrCreatePhysicalTrack()
  await participant.publishTrack(strayTrack, { source: 'camera' })
  await participant.setMicrophoneEnabled(true)
  assert.equal(participant.isCameraEnabled, true)
  assert.equal(participant.isMicrophoneEnabled, true)

  let micUI = true
  let camUI = true
  let meetingCamActive = true

  const synced = await syncAndEnforceMediaState({
    localParticipant: participant,
    userId,
    storage,
    enforceSavedOffState: true,
    releasePhysicalCameraIfUnneeded: hw.releasePhysicalCameraIfUnneeded,
    setMeetingCamActive: (v) => { meetingCamActive = v },
    setMicActive: (v) => { micUI = v },
    setCamActive: (v) => { camUI = v }
  })

  assert.deepEqual(synced, { micActive: false, camActive: false })
  assert.equal(micUI, false)
  assert.equal(camUI, false)
  assert.equal(meetingCamActive, false)
  assert.equal(participant.isCameraEnabled, false)
  assert.equal(participant.isMicrophoneEnabled, false)
  assert.deepEqual(readActualLiveKitMediaState(participant), { micActive: false, camActive: false })
})

test('7. resolveMediaUserId resolves user ID from AuthContext user or LiveKit metadata fallback', () => {
  const participant = createMockLiveKitParticipant({
    identity: '55555555-5555-4555-8555-555555555555',
    userId: '55555555-5555-4555-8555-555555555555'
  })

  assert.equal(
    resolveMediaUserId({ id: 'explicit-user-id' }, participant),
    'explicit-user-id'
  )
  assert.equal(
    resolveMediaUserId(null, participant),
    '55555555-5555-4555-8555-555555555555'
  )
})
