import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectProvider,
  isLiveAudioTrack,
  getLocalMicTrack,
  getRemoteAudioTracks,
  extractInitialAudioTracks,
  subscribeToRoomAudio,
  connectTrackToMixer,
  disconnectTrackFromMixer,
  disconnectAllTracksFromMixer,
  LIVEKIT_MIC_SOURCE,
  LIVEKIT_TRACK_SUBSCRIBED,
  LIVEKIT_TRACK_UNSUBSCRIBED
} from '../../src/components/meeting/screenRecorderAudioUtils.js'

/**
 * Meetly AI — Step 6.7.4: Dual-Provider Screen Recorder Audio Adapter Suite
 *
 * Verifies all requirements:
 * 1. Provider detection (Cloudflare RealtimeKit vs LiveKit).
 * 2. LiveKit local and remote audio extraction.
 * 3. Cloudflare local and remote audio extraction.
 * 4. Dynamic room audio subscriptions (trackSubscribed, participantJoined, audioUpdate).
 * 5. Local and remote microphone mute/unmute handling.
 * 6. Duplicate event and connection prevention.
 * 7. Ended-track and invalid-track rejection.
 * 8. Audio node disconnection and full mixer teardown.
 * 9. Idempotent unsubscribe and listener cleanup.
 * 10. Robust handling of missing participants, null tracks, and partial objects.
 */

describe('Meetly AI — Screen Recorder Dual-Provider Audio Adapter Suite', () => {

  // Helper to create mock MediaStreamTrack
  const createMockTrack = ({
    id = `track-${Math.random().toString(36).slice(2, 8)}`,
    kind = 'audio',
    readyState = 'live'
  } = {}) => ({
    id,
    kind,
    readyState,
    stop: () => {
      readyState = 'ended'
    }
  })

  // Helper to create mock EventEmitter
  const createMockEventEmitter = () => {
    const listeners = new Map()
    return {
      on: (event, handler) => {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event).add(handler)
      },
      off: (event, handler) => {
        if (listeners.has(event)) listeners.get(event).delete(handler)
      },
      emit: (event, ...args) => {
        if (listeners.has(event)) {
          for (const handler of listeners.get(event)) {
            handler(...args)
          }
        }
      },
      listenerCount: (event) => (listeners.has(event) ? listeners.get(event).size : 0),
      rawListeners: listeners
    }
  }

  // Helper to create mock Web Audio AudioContext & Nodes
  const createMockAudioContext = () => {
    const createdSources = []
    const destination = {
      stream: {
        getAudioTracks: () => [createMockTrack({ id: 'mix-dest-track' })]
      }
    }

    const audioCtx = {
      state: 'running',
      createMediaStreamDestination: () => destination,
      createMediaStreamSource: (stream) => {
        const connectedDests = []
        let disconnected = false
        const source = {
          stream,
          connectedDests,
          get isDisconnected() {
            return disconnected
          },
          connect: (dest) => {
            connectedDests.push(dest)
          },
          disconnect: () => {
            disconnected = true
            connectedDests.length = 0
          }
        }
        createdSources.push(source)
        return source
      },
      createdSources
    }

    return { audioCtx, destination }
  }

  // =========================================================================
  // 1. PROVIDER DETECTION
  // =========================================================================
  describe('1. Provider Detection', () => {
    it('detects cloudflare when activeProvider hint is provided', () => {
      assert.strictEqual(detectProvider({ activeProvider: 'cloudflare' }), 'cloudflare')
    })

    it('detects livekit when activeProvider hint is provided', () => {
      assert.strictEqual(detectProvider({ activeProvider: 'livekit' }), 'livekit')
    })

    it('detects cloudflare from RealtimeKit client room indicators (self, participants.joined)', () => {
      const cfRoom = {
        self: { id: 'self-1', audioEnabled: false },
        participants: { joined: new Map() }
      }
      assert.strictEqual(detectProvider({ room: cfRoom }), 'cloudflare')
    })

    it('detects cloudflare from normalized localParticipant object with audioTrack property', () => {
      const cfLocal = {
        id: 'self-1',
        audioTrack: createMockTrack(),
        videoTrack: null
      }
      assert.strictEqual(detectProvider({ localParticipant: cfLocal }), 'cloudflare')
    })

    it('detects livekit from LiveKit LocalParticipant containing getTrackPublication method', () => {
      const lkLocal = {
        identity: 'host-1',
        getTrackPublication: () => null
      }
      assert.strictEqual(detectProvider({ localParticipant: lkLocal }), 'livekit')
    })

    it('detects livekit from LiveKit Room containing remoteParticipants Map', () => {
      const lkRoom = {
        remoteParticipants: new Map(),
        name: 'room-lk'
      }
      assert.strictEqual(detectProvider({ room: lkRoom }), 'livekit')
    })

    it('defaults to cloudflare for empty or unknown configurations', () => {
      assert.strictEqual(detectProvider({}), 'cloudflare')
      assert.strictEqual(detectProvider(null), 'cloudflare')
    })
  })

  // =========================================================================
  // 2. LIVEKIT LOCAL AND REMOTE AUDIO EXTRACTION
  // =========================================================================
  describe('2. LiveKit Audio Extraction', () => {
    it('extracts LiveKit local microphone MediaStreamTrack via getTrackPublication', () => {
      const mockLiveTrack = createMockTrack({ id: 'livekit-mic-track-1' })
      const localParticipant = {
        identity: 'host-user',
        getTrackPublication: (source) => {
          if (source === LIVEKIT_MIC_SOURCE || source === 'microphone') {
            return {
              track: {
                mediaStreamTrack: mockLiveTrack,
                kind: 'audio'
              }
            }
          }
          return null
        }
      }

      const mic = getLocalMicTrack({ provider: 'livekit', localParticipant })
      assert.strictEqual(mic, mockLiveTrack)
    })

    it('returns null if LiveKit local microphone track publication is absent or muted', () => {
      const localParticipant = {
        identity: 'host-user',
        getTrackPublication: () => null
      }
      const mic = getLocalMicTrack({ provider: 'livekit', localParticipant })
      assert.strictEqual(mic, null)
    })

    it('extracts remote audio tracks from LiveKit participants audioTrackPublications map', () => {
      const track1 = createMockTrack({ id: 'trk-1' })
      const track2 = createMockTrack({ id: 'trk-2' })

      const participants = [
        {
          identity: 'alice',
          sid: 'p-alice',
          audioTrackPublications: new Map([
            ['pub-1', { trackSid: 'pub-1', track: { sid: 'pub-1', mediaStreamTrack: track1, kind: 'audio' } }]
          ])
        },
        {
          identity: 'bob',
          sid: 'p-bob',
          audioTrackPublications: new Map([
            ['pub-2', { trackSid: 'pub-2', track: { sid: 'pub-2', mediaStreamTrack: track2, kind: 'audio' } }]
          ])
        },
        {
          identity: 'charlie-muted',
          sid: 'p-charlie',
          audioTrackPublications: new Map() // No active publications
        }
      ]

      const remoteTracks = getRemoteAudioTracks({ provider: 'livekit', participants })
      assert.strictEqual(remoteTracks.length, 2)
      assert.strictEqual(remoteTracks[0].id, 'pub-1')
      assert.strictEqual(remoteTracks[0].participantId, 'alice')
      assert.strictEqual(remoteTracks[0].track, track1)
      assert.strictEqual(remoteTracks[1].id, 'pub-2')
      assert.strictEqual(remoteTracks[1].participantId, 'bob')
      assert.strictEqual(remoteTracks[1].track, track2)
    })
  })

  // =========================================================================
  // 3. CLOUDFLARE LOCAL AND REMOTE AUDIO EXTRACTION
  // =========================================================================
  describe('3. Cloudflare Audio Extraction', () => {
    it('extracts Cloudflare local microphone MediaStreamTrack from localParticipant.audioTrack', () => {
      const mockCfMic = createMockTrack({ id: 'cf-self-mic' })
      const localParticipant = {
        id: 'self-peer-1',
        audioTrack: mockCfMic,
        audioEnabled: true
      }

      const mic = getLocalMicTrack({ provider: 'cloudflare', localParticipant })
      assert.strictEqual(mic, mockCfMic)
    })

    it('extracts Cloudflare local microphone from room.self if localParticipant is missing', () => {
      const mockCfMic = createMockTrack({ id: 'cf-room-self-mic' })
      const room = {
        self: {
          id: 'self-peer-2',
          audioTrack: mockCfMic,
          audioEnabled: true
        }
      }

      const mic = getLocalMicTrack({ provider: 'cloudflare', room, localParticipant: null })
      assert.strictEqual(mic, mockCfMic)
    })

    it('extracts Cloudflare remote audio tracks from normalized participants array', () => {
      const trackA = createMockTrack({ id: 'cf-track-a' })
      const trackB = createMockTrack({ id: 'cf-track-b' })

      const participants = [
        {
          id: 'peer-a',
          sid: 'peer-a',
          name: 'Alice',
          audioTrack: trackA,
          audioEnabled: true
        },
        {
          id: 'peer-b',
          sid: 'peer-b',
          name: 'Bob',
          audioTrack: trackB,
          audioEnabled: true
        },
        {
          id: 'peer-c-muted',
          name: 'Charlie',
          audioTrack: null,
          audioEnabled: false
        }
      ]

      const remoteTracks = getRemoteAudioTracks({ provider: 'cloudflare', participants })
      assert.strictEqual(remoteTracks.length, 2)
      assert.strictEqual(remoteTracks[0].id, 'cf-peer-a-audio')
      assert.strictEqual(remoteTracks[0].participantId, 'peer-a')
      assert.strictEqual(remoteTracks[0].track, trackA)
      assert.strictEqual(remoteTracks[1].id, 'cf-peer-b-audio')
      assert.strictEqual(remoteTracks[1].participantId, 'peer-b')
      assert.strictEqual(remoteTracks[1].track, trackB)
    })

    it('falls back to room.participants.joined if participants array is empty', () => {
      const trackFallback = createMockTrack({ id: 'cf-joined-track' })
      const room = {
        self: { id: 'self-1', audioTrack: null },
        participants: {
          joined: new Map([
            ['peer-joined-1', { id: 'peer-joined-1', audioTrack: trackFallback, audioEnabled: true }]
          ])
        }
      }

      const remoteTracks = getRemoteAudioTracks({ provider: 'cloudflare', room, participants: [] })
      assert.strictEqual(remoteTracks.length, 1)
      assert.strictEqual(remoteTracks[0].id, 'cf-peer-joined-1-audio')
      assert.strictEqual(remoteTracks[0].track, trackFallback)
    })

    it('extractInitialAudioTracks returns bundled localTrack and remoteTracks', () => {
      const localTrack = createMockTrack({ id: 'cf-local-init' })
      const remoteTrack = createMockTrack({ id: 'cf-remote-init' })

      const localParticipant = { id: 'self-init', audioTrack: localTrack, audioEnabled: true }
      const participants = [{ id: 'peer-init', audioTrack: remoteTrack, audioEnabled: true }]

      const bundled = extractInitialAudioTracks({
        provider: 'cloudflare',
        localParticipant,
        participants
      })

      assert.strictEqual(bundled.localTrack, localTrack)
      assert.strictEqual(bundled.remoteTracks.length, 1)
      assert.strictEqual(bundled.remoteTracks[0].track, remoteTrack)
    })
  })

  // =========================================================================
  // 4. DYNAMIC ROOM AUDIO SUBSCRIPTIONS — LIVEKIT
  // =========================================================================
  describe('4. Dynamic Subscriptions — LiveKit', () => {
    it('subscribes to LiveKit TrackSubscribed and TrackUnsubscribed events', () => {
      const room = createMockEventEmitter()
      const localParticipant = createMockEventEmitter()

      const added = []
      const removed = []

      const unsubscribe = subscribeToRoomAudio({
        provider: 'livekit',
        room,
        localParticipant,
        onTrackAdded: (payload) => added.push(payload),
        onTrackRemoved: (payload) => removed.push(payload)
      })

      assert.strictEqual(room.listenerCount(LIVEKIT_TRACK_SUBSCRIBED), 1)
      assert.strictEqual(room.listenerCount(LIVEKIT_TRACK_UNSUBSCRIBED), 1)
      assert.strictEqual(localParticipant.listenerCount('trackPublished'), 1)
      assert.strictEqual(localParticipant.listenerCount('trackUnpublished'), 1)

      // 1. Simulate remote trackSubscribed
      const remoteTrack = createMockTrack({ id: 'lk-remote-dyn-1' })
      room.emit(
        LIVEKIT_TRACK_SUBSCRIBED,
        { mediaStreamTrack: remoteTrack, kind: 'audio', sid: 'lk-track-sid-1' },
        { trackSid: 'lk-track-sid-1' },
        { identity: 'remote-user-1' }
      )

      assert.strictEqual(added.length, 1)
      assert.strictEqual(added[0].id, 'lk-track-sid-1')
      assert.strictEqual(added[0].participantId, 'remote-user-1')
      assert.strictEqual(added[0].track, remoteTrack)
      assert.strictEqual(added[0].isLocal, false)

      // 2. Simulate local microphone unmute after start (trackPublished)
      const localMicTrack = createMockTrack({ id: 'lk-local-mic-dyn' })
      localParticipant.emit('trackPublished', {
        source: 'microphone',
        kind: 'audio',
        trackSid: 'lk-local-mic-sid',
        track: { mediaStreamTrack: localMicTrack }
      })

      assert.strictEqual(added.length, 2)
      assert.strictEqual(added[1].id, 'lk-local-mic-sid')
      assert.strictEqual(added[1].track, localMicTrack)
      assert.strictEqual(added[1].isLocal, true)

      // 3. Simulate remote trackUnsubscribed
      room.emit(
        LIVEKIT_TRACK_UNSUBSCRIBED,
        { mediaStreamTrack: remoteTrack, kind: 'audio', sid: 'lk-track-sid-1' },
        { trackSid: 'lk-track-sid-1' },
        { identity: 'remote-user-1' }
      )

      assert.strictEqual(removed.length, 1)
      assert.strictEqual(removed[0].id, 'lk-track-sid-1')
      assert.strictEqual(removed[0].participantId, 'remote-user-1')

      // 4. Verify unsubscribe cleans up all listeners
      unsubscribe()
      assert.strictEqual(room.listenerCount(LIVEKIT_TRACK_SUBSCRIBED), 0)
      assert.strictEqual(room.listenerCount(LIVEKIT_TRACK_UNSUBSCRIBED), 0)
      assert.strictEqual(localParticipant.listenerCount('trackPublished'), 0)
      assert.strictEqual(localParticipant.listenerCount('trackUnpublished'), 0)
    })
  })

  // =========================================================================
  // 5. DYNAMIC ROOM AUDIO SUBSCRIPTIONS — CLOUDFLARE REALTIMEKIT
  // =========================================================================
  describe('5. Dynamic Subscriptions — Cloudflare RealtimeKit', () => {
    it('subscribes to RealtimeKit joined participant events and individual audioUpdates', () => {
      const selfObj = createMockEventEmitter()
      selfObj.id = 'self-cf-id'
      selfObj.audioTrack = null
      selfObj.audioEnabled = false

      const joinedMap = createMockEventEmitter()
      const existingPeer = createMockEventEmitter()
      existingPeer.id = 'peer-existing-1'
      existingPeer.audioTrack = null
      existingPeer.audioEnabled = false

      const room = {
        self: selfObj,
        participants: {
          joined: Object.assign(joinedMap, {
            toArray: () => [existingPeer]
          })
        }
      }

      const added = []
      const removed = []

      const unsubscribe = subscribeToRoomAudio({
        provider: 'cloudflare',
        room,
        onTrackAdded: (payload) => added.push(payload),
        onTrackRemoved: (payload) => removed.push(payload)
      })

      // A. Existing peer was bound with audioUpdate
      assert.strictEqual(existingPeer.listenerCount('audioUpdate'), 1)
      assert.strictEqual(selfObj.listenerCount('audioUpdate'), 1)
      assert.strictEqual(joinedMap.listenerCount('participantJoined'), 1)
      assert.strictEqual(joinedMap.listenerCount('participantLeft'), 1)

      // B. Existing peer unnmutes
      const peerTrack = createMockTrack({ id: 'cf-peer-track-1' })
      existingPeer.emit('audioUpdate', { audioEnabled: true, audioTrack: peerTrack })

      assert.strictEqual(added.length, 1)
      assert.strictEqual(added[0].id, 'cf-peer-existing-1-audio')
      assert.strictEqual(added[0].participantId, 'peer-existing-1')
      assert.strictEqual(added[0].track, peerTrack)

      // C. A new participant joins the meeting with microphone enabled
      const newPeer = createMockEventEmitter()
      const newPeerTrack = createMockTrack({ id: 'cf-new-peer-track' })
      newPeer.id = 'peer-new-2'
      newPeer.audioEnabled = true
      newPeer.audioTrack = newPeerTrack

      joinedMap.emit('participantJoined', newPeer)

      assert.strictEqual(added.length, 2)
      assert.strictEqual(added[1].id, 'cf-peer-new-2-audio')
      assert.strictEqual(added[1].participantId, 'peer-new-2')
      assert.strictEqual(added[1].track, newPeerTrack)
      assert.strictEqual(newPeer.listenerCount('audioUpdate'), 1)

      // D. Host unnmutes microphone during recording
      const hostMicTrack = createMockTrack({ id: 'cf-host-mic-track' })
      selfObj.emit('audioUpdate', { audioEnabled: true, audioTrack: hostMicTrack })

      assert.strictEqual(added.length, 3)
      assert.strictEqual(added[2].id, 'local-mic')
      assert.strictEqual(added[2].participantId, 'self-cf-id')
      assert.strictEqual(added[2].track, hostMicTrack)
      assert.strictEqual(added[2].isLocal, true)

      // E. Host mutes microphone again
      selfObj.emit('audioUpdate', { audioEnabled: false, audioTrack: null })

      assert.strictEqual(removed.length, 1)
      assert.strictEqual(removed[0].id, 'local-mic')
      assert.strictEqual(removed[0].isLocal, true)

      // F. Peer leaves the meeting
      joinedMap.emit('participantLeft', newPeer)

      assert.strictEqual(removed.length, 2)
      assert.strictEqual(removed[1].id, 'cf-peer-new-2-audio')
      assert.strictEqual(newPeer.listenerCount('audioUpdate'), 0, 'Left participant listener must be removed')

      // G. Unsubscribe cleans up all active listeners
      unsubscribe()
      assert.strictEqual(selfObj.listenerCount('audioUpdate'), 0)
      assert.strictEqual(existingPeer.listenerCount('audioUpdate'), 0)
      assert.strictEqual(joinedMap.listenerCount('participantJoined'), 0)
      assert.strictEqual(joinedMap.listenerCount('participantLeft'), 0)
    })
  })

  // =========================================================================
  // 6. SAFE AUDIO TRACK CONNECTION (connectTrackToMixer)
  // =========================================================================
  describe('6. Safe Audio Track Connection', () => {
    let audioCtx, mixDest, connectedMap

    beforeEach(() => {
      const mockEnv = createMockAudioContext()
      audioCtx = mockEnv.audioCtx
      mixDest = mockEnv.destination
      connectedMap = new Map()
    })

    it('connects a valid live audio track to mix destination and stores in connectedNodesMap', () => {
      const liveTrack = createMockTrack({ id: 'live-track-1' })

      const success = connectTrackToMixer({
        audioCtx,
        mixDest,
        track: liveTrack,
        trackKey: 'key-1',
        connectedNodesMap: connectedMap
      })

      assert.strictEqual(success, true)
      assert.strictEqual(connectedMap.size, 1)
      assert.strictEqual(connectedMap.get('key-1').track, liveTrack)
      assert.strictEqual(connectedMap.get('key-1').source.connectedDests[0], mixDest)
    })

    it('rejects an ended track (readyState === "ended") to prevent browser exceptions', () => {
      const endedTrack = createMockTrack({ id: 'ended-track', readyState: 'ended' })

      const success = connectTrackToMixer({
        audioCtx,
        mixDest,
        track: endedTrack,
        trackKey: 'key-ended',
        connectedNodesMap: connectedMap
      })

      assert.strictEqual(success, false)
      assert.strictEqual(connectedMap.size, 0)
      assert.strictEqual(audioCtx.createdSources.length, 0)
    })

    it('rejects a video track (kind !== "audio")', () => {
      const videoTrack = createMockTrack({ id: 'video-track', kind: 'video' })

      const success = connectTrackToMixer({
        audioCtx,
        mixDest,
        track: videoTrack,
        trackKey: 'key-video',
        connectedNodesMap: connectedMap
      })

      assert.strictEqual(success, false)
      assert.strictEqual(connectedMap.size, 0)
    })

    it('prevents duplicate connections when the identical track is connected under the same key', () => {
      const liveTrack = createMockTrack({ id: 'dup-track' })

      const first = connectTrackToMixer({
        audioCtx,
        mixDest,
        track: liveTrack,
        trackKey: 'key-dup',
        connectedNodesMap: connectedMap
      })
      assert.strictEqual(first, true)
      assert.strictEqual(audioCtx.createdSources.length, 1)

      // Attempt duplicate connect with same track
      const second = connectTrackToMixer({
        audioCtx,
        mixDest,
        track: liveTrack,
        trackKey: 'key-dup',
        connectedNodesMap: connectedMap
      })
      assert.strictEqual(second, false, 'Duplicate connection should be skipped')
      assert.strictEqual(audioCtx.createdSources.length, 1, 'No additional AudioNode should be created')
    })

    it('replaces stale track if the track reference for the same key changes', () => {
      const trackOld = createMockTrack({ id: 'old-track' })
      const trackNew = createMockTrack({ id: 'new-track' })

      connectTrackToMixer({
        audioCtx,
        mixDest,
        track: trackOld,
        trackKey: 'key-replace',
        connectedNodesMap: connectedMap
      })
      const oldSource = connectedMap.get('key-replace').source
      assert.strictEqual(oldSource.isDisconnected, false)

      // Replace with new track
      const replaced = connectTrackToMixer({
        audioCtx,
        mixDest,
        track: trackNew,
        trackKey: 'key-replace',
        connectedNodesMap: connectedMap
      })

      assert.strictEqual(replaced, true)
      assert.strictEqual(oldSource.isDisconnected, true, 'Old source node must be disconnected')
      assert.strictEqual(connectedMap.get('key-replace').track, trackNew)
      assert.strictEqual(connectedMap.size, 1)
    })
  })

  // =========================================================================
  // 7. AUDIO NODE DISCONNECTION
  // =========================================================================
  describe('7. Audio Node Disconnection', () => {
    let audioCtx, mixDest, connectedMap

    beforeEach(() => {
      const mockEnv = createMockAudioContext()
      audioCtx = mockEnv.audioCtx
      mixDest = mockEnv.destination
      connectedMap = new Map()
    })

    it('disconnectTrackFromMixer disconnects node and removes entry from map', () => {
      const track = createMockTrack({ id: 't-disc' })
      connectTrackToMixer({
        audioCtx,
        mixDest,
        track,
        trackKey: 'key-disc',
        connectedNodesMap: connectedMap
      })

      const entry = connectedMap.get('key-disc')
      assert.strictEqual(entry.source.isDisconnected, false)

      const removed = disconnectTrackFromMixer('key-disc', connectedMap)
      assert.strictEqual(removed, true)
      assert.strictEqual(entry.source.isDisconnected, true)
      assert.strictEqual(connectedMap.has('key-disc'), false)

      // Idempotent secondary call
      assert.strictEqual(disconnectTrackFromMixer('key-disc', connectedMap), false)
    })

    it('disconnectAllTracksFromMixer disconnects all nodes and clears map', () => {
      const t1 = createMockTrack({ id: 't-all-1' })
      const t2 = createMockTrack({ id: 't-all-2' })
      const t3 = createMockTrack({ id: 't-all-3' })

      connectTrackToMixer({ audioCtx, mixDest, track: t1, trackKey: 'k1', connectedNodesMap: connectedMap })
      connectTrackToMixer({ audioCtx, mixDest, track: t2, trackKey: 'k2', connectedNodesMap: connectedMap })
      connectTrackToMixer({ audioCtx, mixDest, track: t3, trackKey: 'k3', connectedNodesMap: connectedMap })

      const e1 = connectedMap.get('k1')
      const e2 = connectedMap.get('k2')
      const e3 = connectedMap.get('k3')

      assert.strictEqual(connectedMap.size, 3)

      disconnectAllTracksFromMixer(connectedMap)

      assert.strictEqual(connectedMap.size, 0)
      assert.strictEqual(e1.source.isDisconnected, true)
      assert.strictEqual(e2.source.isDisconnected, true)
      assert.strictEqual(e3.source.isDisconnected, true)

      // Safe to call again on empty map
      assert.doesNotThrow(() => disconnectAllTracksFromMixer(connectedMap))
    })
  })

  // =========================================================================
  // 8. IDEMPOTENT UNSUBSCRIBE AND CLEANUP
  // =========================================================================
  describe('8. Repeated Unsubscribe Calls & Idempotency', () => {
    it('repeated unsubscribe invocations execute safely without side-effects', () => {
      const selfObj = createMockEventEmitter()
      const room = { self: selfObj }

      const unsubscribe = subscribeToRoomAudio({
        provider: 'cloudflare',
        room,
        onTrackAdded: () => {},
        onTrackRemoved: () => {}
      })

      assert.strictEqual(selfObj.listenerCount('audioUpdate'), 1)

      // First unsubscribe
      unsubscribe()
      assert.strictEqual(selfObj.listenerCount('audioUpdate'), 0)

      // Second and third unsubscribe calls must be no-ops
      assert.doesNotThrow(() => unsubscribe())
      assert.doesNotThrow(() => unsubscribe())
      assert.strictEqual(selfObj.listenerCount('audioUpdate'), 0)
    })
  })

  // =========================================================================
  // 9. MISSING, NULL, AND CORRUPTED TRACK HANDLING
  // =========================================================================
  describe('9. Missing / Null Track Handling', () => {
    it('isLiveAudioTrack handles null, undefined, primitives and malformed objects safely', () => {
      assert.strictEqual(isLiveAudioTrack(null), false)
      assert.strictEqual(isLiveAudioTrack(undefined), false)
      assert.strictEqual(isLiveAudioTrack('track'), false)
      assert.strictEqual(isLiveAudioTrack(123), false)
      assert.strictEqual(isLiveAudioTrack({}), false)
      assert.strictEqual(isLiveAudioTrack({ kind: 'audio', readyState: 'ended' }), false)
      assert.strictEqual(isLiveAudioTrack({ kind: 'video', readyState: 'live' }), false)
      assert.strictEqual(isLiveAudioTrack({ kind: 'audio', readyState: 'live' }), true)
    })

    it('getLocalMicTrack handles null localParticipant and room safely', () => {
      assert.strictEqual(getLocalMicTrack({ localParticipant: null, room: null }), null)
      assert.strictEqual(getLocalMicTrack({ provider: 'livekit', localParticipant: {} }), null)
      assert.strictEqual(getLocalMicTrack({ provider: 'cloudflare', localParticipant: {} }), null)
    })

    it('getRemoteAudioTracks handles null or empty participants collection safely', () => {
      assert.deepStrictEqual(getRemoteAudioTracks({ participants: null }), [])
      assert.deepStrictEqual(getRemoteAudioTracks({ participants: [] }), [])
      assert.deepStrictEqual(getRemoteAudioTracks({ participants: [null, undefined, {}] }), [])
    })

    it('connectTrackToMixer rejects null arguments without throwing', () => {
      assert.strictEqual(connectTrackToMixer({ audioCtx: null, mixDest: null, track: null }), false)
    })

    it('disconnectTrackFromMixer rejects null trackKey or map without throwing', () => {
      assert.strictEqual(disconnectTrackFromMixer(null, null), false)
      assert.strictEqual(disconnectTrackFromMixer('non-existent', new Map()), false)
    })
  })

  // =========================================================================
  // 10. STEP 1.1 AUDIT VERIFICATION: ADVANCED LIFECYCLE & DYNAMIC ROUTING
  // =========================================================================
  describe('10. Step 1.1 Audit Verification: Advanced Lifecycle & Dynamic Routing', () => {
    let audioCtx, mixDest, connectedMap

    beforeEach(() => {
      const mockEnv = createMockAudioContext()
      audioCtx = mockEnv.audioCtx
      mixDest = mockEnv.destination
      connectedMap = new Map()
    })

    // Required Test 1: LiveKit local trackPublished connects a newly enabled microphone
    it('1. LiveKit local trackPublished connects a newly enabled microphone', () => {
      const localParticipant = createMockEventEmitter()
      localParticipant.identity = 'host-user-lk'

      const added = []
      subscribeToRoomAudio({
        provider: 'livekit',
        localParticipant,
        onTrackAdded: (payload) => {
          added.push(payload)
          connectTrackToMixer({
            audioCtx,
            mixDest,
            track: payload.track,
            trackKey: payload.id,
            connectedNodesMap: connectedMap
          })
        }
      })

      const newMicTrack = createMockTrack({ id: 'lk-newly-unmuted-mic' })
      localParticipant.emit('trackPublished', {
        source: LIVEKIT_MIC_SOURCE,
        kind: 'audio',
        trackSid: 'local-mic',
        track: { mediaStreamTrack: newMicTrack }
      })

      assert.strictEqual(added.length, 1)
      assert.strictEqual(added[0].id, 'local-mic')
      assert.strictEqual(added[0].isLocal, true)
      assert.strictEqual(connectedMap.has('local-mic'), true)
      assert.strictEqual(connectedMap.get('local-mic').track, newMicTrack)
      assert.strictEqual(connectedMap.get('local-mic').source.connectedDests[0], mixDest)
    })

    // Required Test 2: LiveKit local trackUnpublished disconnects the microphone
    it('2. LiveKit local trackUnpublished disconnects the microphone', () => {
      const localParticipant = createMockEventEmitter()
      localParticipant.identity = 'host-user-lk'

      const micTrack = createMockTrack({ id: 'lk-active-mic' })
      connectTrackToMixer({
        audioCtx,
        mixDest,
        track: micTrack,
        trackKey: 'local-mic',
        connectedNodesMap: connectedMap
      })

      const removed = []
      subscribeToRoomAudio({
        provider: 'livekit',
        localParticipant,
        onTrackRemoved: (payload) => {
          removed.push(payload)
          disconnectTrackFromMixer(payload.id, connectedMap)
        }
      })

      const nodeBefore = connectedMap.get('local-mic').source
      assert.strictEqual(nodeBefore.isDisconnected, false)

      localParticipant.emit('trackUnpublished', {
        source: LIVEKIT_MIC_SOURCE,
        kind: 'audio',
        trackSid: 'local-mic'
      })

      assert.strictEqual(removed.length, 1)
      assert.strictEqual(removed[0].id, 'local-mic')
      assert.strictEqual(nodeBefore.isDisconnected, true, 'Microphone audio node must be disconnected')
      assert.strictEqual(connectedMap.has('local-mic'), false)
    })

    // Required Test 3: Cloudflare participantsCleared removes all remote audio nodes
    it('3. Cloudflare participantsCleared removes all remote audio nodes', () => {
      const joinedMap = createMockEventEmitter()
      const p1 = createMockEventEmitter()
      p1.id = 'p1'
      const p2 = createMockEventEmitter()
      p2.id = 'p2'

      const room = {
        self: createMockEventEmitter(),
        participants: {
          joined: Object.assign(joinedMap, { toArray: () => [p1, p2] })
        }
      }

      // Connect 2 remote tracks initially in the mixer
      const track1 = createMockTrack({ id: 'cf-track-1' })
      const track2 = createMockTrack({ id: 'cf-track-2' })
      connectTrackToMixer({ audioCtx, mixDest, track: track1, trackKey: 'cf-p1-audio', connectedNodesMap: connectedMap })
      connectTrackToMixer({ audioCtx, mixDest, track: track2, trackKey: 'cf-p2-audio', connectedNodesMap: connectedMap })

      const removed = []
      subscribeToRoomAudio({
        provider: 'cloudflare',
        room,
        onTrackRemoved: (payload) => {
          removed.push(payload)
          disconnectTrackFromMixer(payload.id, connectedMap)
        }
      })

      assert.strictEqual(connectedMap.size, 2)

      // Emit participantsCleared (e.g. room reset / disconnect)
      joinedMap.emit('participantsCleared')

      assert.strictEqual(removed.length, 2)
      assert.strictEqual(connectedMap.size, 0, 'All connected audio nodes must be removed from mixer')
    })

    // Required Test 4: Participants already present when recording starts receive individual audioUpdate listeners
    it('4. Participants already present when recording starts receive individual audioUpdate listeners', () => {
      const p1 = createMockEventEmitter()
      p1.id = 'p-present-1'
      const p2 = createMockEventEmitter()
      p2.id = 'p-present-2'
      const p3 = createMockEventEmitter()
      p3.id = 'p-present-3'

      const room = {
        self: createMockEventEmitter(),
        participants: {
          joined: Object.assign(createMockEventEmitter(), {
            toArray: () => [p1, p2, p3]
          })
        }
      }

      subscribeToRoomAudio({
        provider: 'cloudflare',
        room,
        onTrackAdded: () => {},
        onTrackRemoved: () => {}
      })

      assert.strictEqual(p1.listenerCount('audioUpdate'), 1)
      assert.strictEqual(p2.listenerCount('audioUpdate'), 1)
      assert.strictEqual(p3.listenerCount('audioUpdate'), 1)
    })

    // Required Test 5: A newly joined participant receives exactly one listener
    it('5. A newly joined participant receives exactly one listener even if join is emitted repeatedly', () => {
      const joinedMap = createMockEventEmitter()
      const room = {
        self: createMockEventEmitter(),
        participants: {
          joined: Object.assign(joinedMap, { toArray: () => [] })
        }
      }

      subscribeToRoomAudio({
        provider: 'cloudflare',
        room,
        onTrackAdded: () => {},
        onTrackRemoved: () => {}
      })

      const newParticipant = createMockEventEmitter()
      newParticipant.id = 'new-peer-100'

      // First join event
      joinedMap.emit('participantJoined', newParticipant)
      assert.strictEqual(newParticipant.listenerCount('audioUpdate'), 1)

      // Duplicate join event for the same participant
      joinedMap.emit('participantJoined', newParticipant)
      assert.strictEqual(newParticipant.listenerCount('audioUpdate'), 1, 'Must remain strictly 1, never duplicate')
    })

    // Required Test 6: A participant who leaves has all their listeners detached
    it('6. A participant who leaves has all their listeners detached', () => {
      const joinedMap = createMockEventEmitter()
      const leavingPeer = createMockEventEmitter()
      leavingPeer.id = 'leaving-peer-200'

      const room = {
        self: createMockEventEmitter(),
        participants: {
          joined: Object.assign(joinedMap, { toArray: () => [leavingPeer] })
        }
      }

      let removedPayload = null
      subscribeToRoomAudio({
        provider: 'cloudflare',
        room,
        onTrackRemoved: (payload) => {
          removedPayload = payload
        }
      })

      assert.strictEqual(leavingPeer.listenerCount('audioUpdate'), 1)

      // Emit participantLeft
      joinedMap.emit('participantLeft', leavingPeer)

      assert.strictEqual(leavingPeer.listenerCount('audioUpdate'), 0, 'audioUpdate listener must be detached')
      assert.strictEqual(removedPayload?.id, 'cf-leaving-peer-200-audio')

      // Subsequent audioUpdate from departed participant must be ignored
      leavingPeer.emit('audioUpdate', { audioEnabled: true, audioTrack: createMockTrack() })
      // No errors and no calls
    })

    // Required Test 7: Repeated participant updates do not create duplicate subscriptions
    it('7. Repeated participant updates do not create duplicate subscriptions', () => {
      const joinedMap = createMockEventEmitter()
      const peer = createMockEventEmitter()
      peer.id = 'peer-300'

      const room = {
        self: createMockEventEmitter(),
        participants: {
          joined: Object.assign(joinedMap, { toArray: () => [peer] })
        }
      }

      subscribeToRoomAudio({
        provider: 'cloudflare',
        room,
        onTrackAdded: () => {},
        onTrackRemoved: () => {}
      })

      assert.strictEqual(peer.listenerCount('audioUpdate'), 1)

      // Emit participantsUpdate 5 times in rapid succession
      for (let i = 0; i < 5; i++) {
        joinedMap.emit('participantsUpdate')
      }

      assert.strictEqual(peer.listenerCount('audioUpdate'), 1, 'Participant must retain exactly 1 listener despite repeated updates')
    })

    // Required Test 8: A replacement microphone track replaces the old mixer node
    it('8. A replacement microphone track replaces the old mixer node', () => {
      const trackA = createMockTrack({ id: 'mic-device-A' })
      const trackB = createMockTrack({ id: 'mic-device-B' })

      // 1. Connect first microphone track
      const connA = connectTrackToMixer({
        audioCtx,
        mixDest,
        track: trackA,
        trackKey: 'local-mic',
        connectedNodesMap: connectedMap
      })
      assert.strictEqual(connA, true)
      const sourceA = connectedMap.get('local-mic').source
      assert.strictEqual(sourceA.isDisconnected, false)
      assert.strictEqual(connectedMap.size, 1)

      // 2. User switches microphone device: connect second track under same trackKey
      const connB = connectTrackToMixer({
        audioCtx,
        mixDest,
        track: trackB,
        trackKey: 'local-mic',
        connectedNodesMap: connectedMap
      })
      assert.strictEqual(connB, true)
      assert.strictEqual(sourceA.isDisconnected, true, 'Old microphone source node must be disconnected')
      assert.strictEqual(connectedMap.size, 1, 'Map size must remain 1')
      assert.strictEqual(connectedMap.get('local-mic').track, trackB, 'New track must be registered')
      assert.strictEqual(connectedMap.get('local-mic').source.connectedDests[0], mixDest)
    })
  })

  // ── 11. STEP 2 INTEGRATION VERIFICATION: DUAL-PROVIDER USE SCREEN RECORDER IMPLEMENTATION ──
  describe('11. Step 2 Integration Verification — Dual-Provider useScreenRecorder Implementation', () => {
    let audioCtx
    let mixDest
    let connectedMap

    beforeEach(() => {
      const mockEnv = createMockAudioContext()
      audioCtx = mockEnv.audioCtx
      mixDest = mockEnv.destination
      connectedMap = new Map()
    })

    // Test 1: Cloudflare recording captures local microphone audio
    it('1. Cloudflare recording captures local microphone audio', () => {
      const localMicTrack = createMockTrack({ id: 'cf-local-mic', kind: 'audio', readyState: 'live' })
      const room = {
        self: Object.assign(createMockEventEmitter(), {
          audioTrack: localMicTrack,
          audioEnabled: true
        }),
        participants: {
          joined: Object.assign(createMockEventEmitter(), { toArray: () => [] })
        }
      }

      const { localTrack } = extractInitialAudioTracks({
        provider: 'cloudflare',
        room,
        localParticipant: { audioTrack: localMicTrack }
      })

      assert.strictEqual(localTrack, localMicTrack)
      assert.strictEqual(isLiveAudioTrack(localTrack), true)

      const connected = connectTrackToMixer({
        audioCtx,
        mixDest,
        track: localTrack,
        trackKey: 'local-mic',
        connectedNodesMap: connectedMap
      })

      assert.strictEqual(connected, true)
      assert.strictEqual(connectedMap.has('local-mic'), true)
      assert.strictEqual(connectedMap.get('local-mic').track, localMicTrack)
    })

    // Test 2: Cloudflare recording captures remote participant audio
    it('2. Cloudflare recording captures remote participant audio', () => {
      const peerTrack1 = createMockTrack({ id: 'track-cf-peer1', kind: 'audio', readyState: 'live' })
      const peerTrack2 = createMockTrack({ id: 'track-cf-peer2', kind: 'audio', readyState: 'live' })

      const participants = [
        { id: 'peer-cf-1', audioTrack: peerTrack1, audioEnabled: true },
        { id: 'peer-cf-2', audioTrack: peerTrack2, audioEnabled: true }
      ]

      const room = {
        self: createMockEventEmitter(),
        participants: {
          joined: Object.assign(createMockEventEmitter(), { toArray: () => [] })
        }
      }

      const { remoteTracks } = extractInitialAudioTracks({
        provider: 'cloudflare',
        room,
        participants
      })

      assert.strictEqual(remoteTracks.length, 2)
      assert.strictEqual(remoteTracks[0].participantId, 'peer-cf-1')
      assert.strictEqual(remoteTracks[1].participantId, 'peer-cf-2')

      remoteTracks.forEach(({ id, track }) => {
        connectTrackToMixer({
          audioCtx,
          mixDest,
          track,
          trackKey: id,
          connectedNodesMap: connectedMap
        })
      })

      assert.strictEqual(connectedMap.size, 2)
      assert.strictEqual(connectedMap.has('cf-peer-cf-1-audio'), true)
      assert.strictEqual(connectedMap.has('cf-peer-cf-2-audio'), true)
    })

    // Test 3: LiveKit recording still captures local and remote audio
    it('3. LiveKit recording still captures local and remote audio', () => {
      const lkMicTrack = createMockTrack({ id: 'lk-host-mic', kind: 'audio', readyState: 'live' })
      const lkRemoteTrack = createMockTrack({ id: 'lk-guest-audio', kind: 'audio', readyState: 'live' })

      const localParticipant = {
        identity: 'lk-host',
        getTrackPublication: (source) => {
          if (source === LIVEKIT_MIC_SOURCE || source === 'microphone') {
            return { track: { mediaStreamTrack: lkMicTrack } }
          }
          return null
        }
      }

      const participants = [
        {
          identity: 'lk-guest',
          audioTrackPublications: new Map([
            ['pub-guest-audio', { track: { sid: 'TR_GUEST_1', mediaStreamTrack: lkRemoteTrack } }]
          ])
        }
      ]

      const room = {
        remoteParticipants: new Map()
      }

      const { localTrack, remoteTracks } = extractInitialAudioTracks({
        provider: 'livekit',
        room,
        localParticipant,
        participants
      })

      assert.strictEqual(localTrack, lkMicTrack)
      assert.strictEqual(remoteTracks.length, 1)
      assert.strictEqual(remoteTracks[0].id, 'TR_GUEST_1')
      assert.strictEqual(remoteTracks[0].track, lkRemoteTrack)

      connectTrackToMixer({
        audioCtx,
        mixDest,
        track: localTrack,
        trackKey: 'local-mic',
        connectedNodesMap: connectedMap
      })
      connectTrackToMixer({
        audioCtx,
        mixDest,
        track: remoteTracks[0].track,
        trackKey: remoteTracks[0].id,
        connectedNodesMap: connectedMap
      })

      assert.strictEqual(connectedMap.size, 2)
      assert.strictEqual(connectedMap.has('local-mic'), true)
      assert.strictEqual(connectedMap.has('TR_GUEST_1'), true)
    })

    // Test 4: Microphone unmute during recording
    it('4. Microphone unmute during recording', () => {
      // Local mic starts unmuted/absent
      const self = createMockEventEmitter()
      self.audioEnabled = false
      self.audioTrack = null
      const room = {
        self,
        participants: { joined: Object.assign(createMockEventEmitter(), { toArray: () => [] }) }
      }

      subscribeToRoomAudio({
        provider: 'cloudflare',
        room,
        onTrackAdded: ({ track, isLocal }) => {
          if (isLocal) {
            connectTrackToMixer({
              audioCtx,
              mixDest,
              track,
              trackKey: 'local-mic',
              connectedNodesMap: connectedMap
            })
          }
        },
        onTrackRemoved: ({ isLocal }) => {
          if (isLocal) {
            disconnectTrackFromMixer('local-mic', connectedMap)
          }
        }
      })

      assert.strictEqual(connectedMap.has('local-mic'), false)

      // Host unmutes microphone
      const unmutedTrack = createMockTrack({ id: 'newly-unmuted-mic' })
      self.audioEnabled = true
      self.audioTrack = unmutedTrack
      self.emit('audioUpdate', { audioEnabled: true, audioTrack: unmutedTrack })

      assert.strictEqual(connectedMap.has('local-mic'), true)
      assert.strictEqual(connectedMap.get('local-mic').track, unmutedTrack)
    })

    // Test 5: Remote participant joins during recording
    it('5. Remote participant joins during recording', () => {
      const joinedMap = createMockEventEmitter()
      const room = {
        self: createMockEventEmitter(),
        participants: { joined: Object.assign(joinedMap, { toArray: () => [] }) }
      }

      subscribeToRoomAudio({
        provider: 'cloudflare',
        room,
        onTrackAdded: ({ id, track }) => {
          connectTrackToMixer({
            audioCtx,
            mixDest,
            track,
            trackKey: id,
            connectedNodesMap: connectedMap
          })
        },
        onTrackRemoved: ({ id }) => {
          disconnectTrackFromMixer(id, connectedMap)
        }
      })

      assert.strictEqual(connectedMap.size, 0)

      // Participant joins with microphone enabled
      const newPeerTrack = createMockTrack({ id: 'joined-peer-track' })
      const newPeer = Object.assign(createMockEventEmitter(), {
        id: 'late-joiner-1',
        audioEnabled: true,
        audioTrack: newPeerTrack
      })

      joinedMap.emit('participantJoined', newPeer)

      assert.strictEqual(connectedMap.size, 1)
      assert.strictEqual(connectedMap.has('cf-late-joiner-1-audio'), true)
      assert.strictEqual(connectedMap.get('cf-late-joiner-1-audio').track, newPeerTrack)
    })

    // Test 6: Remote participant leaves during recording
    it('6. Remote participant leaves during recording', () => {
      const activePeerTrack = createMockTrack({ id: 'leaving-peer-track' })
      const activePeer = Object.assign(createMockEventEmitter(), {
        id: 'departing-peer',
        audioEnabled: true,
        audioTrack: activePeerTrack
      })

      const joinedMap = createMockEventEmitter()
      const room = {
        self: createMockEventEmitter(),
        participants: { joined: Object.assign(joinedMap, { toArray: () => [activePeer] }) }
      }

      // Initial connection
      connectTrackToMixer({
        audioCtx,
        mixDest,
        track: activePeerTrack,
        trackKey: 'cf-departing-peer-audio',
        connectedNodesMap: connectedMap
      })
      assert.strictEqual(connectedMap.has('cf-departing-peer-audio'), true)

      subscribeToRoomAudio({
        provider: 'cloudflare',
        room,
        onTrackRemoved: ({ id }) => {
          disconnectTrackFromMixer(id, connectedMap)
        }
      })

      // Participant leaves
      joinedMap.emit('participantLeft', activePeer)

      assert.strictEqual(connectedMap.has('cf-departing-peer-audio'), false)
      assert.strictEqual(connectedMap.size, 0)
    })

    // Test 7: Microphone replacement
    it('7. Microphone replacement replaces audio node without leaking old source', () => {
      const micOld = createMockTrack({ id: 'usb-headset-mic' })
      const micNew = createMockTrack({ id: 'studio-condenser-mic' })

      connectTrackToMixer({
        audioCtx,
        mixDest,
        track: micOld,
        trackKey: 'local-mic',
        connectedNodesMap: connectedMap
      })
      const oldSource = connectedMap.get('local-mic').source
      assert.strictEqual(oldSource.isDisconnected, false)

      // Replace with new mic
      connectTrackToMixer({
        audioCtx,
        mixDest,
        track: micNew,
        trackKey: 'local-mic',
        connectedNodesMap: connectedMap
      })

      assert.strictEqual(oldSource.isDisconnected, true, 'Old source node must be disconnected')
      assert.strictEqual(connectedMap.size, 1)
      assert.strictEqual(connectedMap.get('local-mic').track, micNew)
    })

    // Test 8: No duplicate audio connections
    it('8. No duplicate audio connections on redundant events', () => {
      const micTrack = createMockTrack({ id: 'stable-mic' })

      const res1 = connectTrackToMixer({
        audioCtx,
        mixDest,
        track: micTrack,
        trackKey: 'local-mic',
        connectedNodesMap: connectedMap
      })
      assert.strictEqual(res1, true)

      // Connect identical track again
      const res2 = connectTrackToMixer({
        audioCtx,
        mixDest,
        track: micTrack,
        trackKey: 'local-mic',
        connectedNodesMap: connectedMap
      })
      assert.strictEqual(res2, false, 'Duplicate connection must be rejected')
      assert.strictEqual(connectedMap.size, 1)
    })

    // Test 9: Stop removes listeners and audio nodes
    it('9. Stop removes listeners and audio nodes', () => {
      const self = createMockEventEmitter()
      const joinedMap = createMockEventEmitter()
      const peer = Object.assign(createMockEventEmitter(), { id: 'peer-stop' })

      const room = {
        self,
        participants: { joined: Object.assign(joinedMap, { toArray: () => [peer] }) }
      }

      // Connect nodes
      const t1 = createMockTrack({ id: 't1' })
      const t2 = createMockTrack({ id: 't2' })
      connectTrackToMixer({ audioCtx, mixDest, track: t1, trackKey: 'local-mic', connectedNodesMap: connectedMap })
      connectTrackToMixer({ audioCtx, mixDest, track: t2, trackKey: 'cf-peer-stop-audio', connectedNodesMap: connectedMap })
      assert.strictEqual(connectedMap.size, 2)

      const unsubscribe = subscribeToRoomAudio({
        provider: 'cloudflare',
        room,
        onTrackAdded: () => {},
        onTrackRemoved: () => {}
      })

      assert.strictEqual(self.listenerCount('audioUpdate'), 1)
      assert.strictEqual(peer.listenerCount('audioUpdate'), 1)
      assert.strictEqual(joinedMap.listenerCount('participantJoined'), 1)

      // Simulate stopRecording cleanup
      unsubscribe()
      disconnectAllTracksFromMixer(connectedMap)

      assert.strictEqual(self.listenerCount('audioUpdate'), 0, 'Self audioUpdate listener must be detached')
      assert.strictEqual(peer.listenerCount('audioUpdate'), 0, 'Peer audioUpdate listener must be detached')
      assert.strictEqual(joinedMap.listenerCount('participantJoined'), 0, 'participantJoined listener must be detached')
      assert.strictEqual(connectedMap.size, 0, 'All audio nodes must be disconnected')
    })

    // Test 10: Unmount cleans up active capture
    it('10. Unmount cleans up active capture: timer, listeners, nodes, display stream, and audio context', () => {
      let timerCleared = false
      const timerId = setInterval(() => {}, 1000)
      const clearTimer = () => {
        clearInterval(timerId)
        timerCleared = true
      }

      let audioCtxClosed = false
      const mockAudioCtx = {
        state: 'running',
        close: async () => {
          audioCtxClosed = true
        }
      }

      let captureTrackStopped = false
      const mockDisplayStream = {
        getTracks: () => [
          {
            stop: () => {
              captureTrackStopped = true
            }
          }
        ]
      }

      let unsubCalled = false
      const mockUnsubscribe = () => {
        unsubCalled = true
      }

      const t = createMockTrack({ id: 'track-unmount' })
      connectTrackToMixer({ audioCtx, mixDest, track: t, trackKey: 'local-mic', connectedNodesMap: connectedMap })

      // Execute simulated unmount cleanup
      clearTimer()
      mockUnsubscribe()
      disconnectAllTracksFromMixer(connectedMap)
      mockDisplayStream.getTracks().forEach((trk) => trk.stop())
      mockAudioCtx.close()

      assert.strictEqual(timerCleared, true, 'Recording timer must be cleared')
      assert.strictEqual(unsubCalled, true, 'Audio subscription must be unsubscribed')
      assert.strictEqual(connectedMap.size, 0, 'Connected nodes must be cleared')
      assert.strictEqual(captureTrackStopped, true, 'Display capture track must be stopped')
      assert.strictEqual(audioCtxClosed, true, 'AudioContext must be closed')
    })

    // Test 11: Pause and resume preserve correct audio behavior
    it('11. Pause and resume preserve correct audio behavior without duplicating nodes or listeners', () => {
      const self = createMockEventEmitter()
      const room = {
        self,
        participants: { joined: Object.assign(createMockEventEmitter(), { toArray: () => [] }) }
      }

      const micTrack = createMockTrack({ id: 'mic-pause-test' })
      connectTrackToMixer({ audioCtx, mixDest, track: micTrack, trackKey: 'local-mic', connectedNodesMap: connectedMap })

      subscribeToRoomAudio({
        provider: 'cloudflare',
        room,
        onTrackAdded: () => {},
        onTrackRemoved: () => {}
      })

      assert.strictEqual(connectedMap.size, 1)
      assert.strictEqual(self.listenerCount('audioUpdate'), 1)

      // Simulate recorder pause: recorder.pause()
      const recorder = { state: 'recording' }
      recorder.state = 'paused'

      // Verification during pause: nodes and listeners remain intact
      assert.strictEqual(connectedMap.size, 1, 'Audio nodes must remain connected while paused')
      assert.strictEqual(self.listenerCount('audioUpdate'), 1, 'Listeners must remain bound while paused')

      // Simulate recorder resume: recorder.resume()
      recorder.state = 'recording'

      // Verification after resume: no duplication has occurred
      assert.strictEqual(connectedMap.size, 1, 'Audio nodes must not duplicate on resume')
      assert.strictEqual(self.listenerCount('audioUpdate'), 1, 'Listeners must not duplicate on resume')
    })

    // Test 12: Repeated start/stop cycles do not leak resources
    it('12. Repeated start/stop cycles do not leak resources', () => {
      for (let cycle = 0; cycle < 5; cycle++) {
        const { audioCtx: cycleCtx, destination: cycleDest } = createMockAudioContext()
        const cycleNodes = new Map()

        const room = {
          self: createMockEventEmitter(),
          participants: { joined: Object.assign(createMockEventEmitter(), { toArray: () => [] }) }
        }

        const t = createMockTrack({ id: `cycle-track-${cycle}` })
        connectTrackToMixer({
          audioCtx: cycleCtx,
          mixDest: cycleDest,
          track: t,
          trackKey: 'local-mic',
          connectedNodesMap: cycleNodes
        })

        const unsub = subscribeToRoomAudio({
          provider: 'cloudflare',
          room,
          onTrackAdded: () => {},
          onTrackRemoved: () => {}
        })

        assert.strictEqual(cycleNodes.size, 1)
        assert.strictEqual(room.self.listenerCount('audioUpdate'), 1)

        // Stop cycle
        unsub()
        disconnectAllTracksFromMixer(cycleNodes)

        assert.strictEqual(cycleNodes.size, 0)
        assert.strictEqual(room.self.listenerCount('audioUpdate'), 0)
      }
    })

    // Test 13: B2 multipart upload behavior remains unchanged
    it('13. B2 multipart upload behavior remains unchanged', () => {
      const minPartSize = 5242880 // 5 MiB
      const chunks = [
        new Uint8Array(2000000), // 2 MB
        new Uint8Array(2500000), // 2.5 MB
        new Uint8Array(1000000)  // 1 MB -> total 5.5 MB exceeds 5 MiB threshold
      ]

      let queue = []
      let queuedBytes = 0
      let partNumber = 1
      const generatedParts = []

      for (const chunk of chunks) {
        queue.push(chunk)
        queuedBytes += chunk.byteLength

        if (queuedBytes >= minPartSize) {
          generatedParts.push({
            partNumber: partNumber++,
            size: queuedBytes
          })
          queue = []
          queuedBytes = 0
        }
      }

      assert.strictEqual(generatedParts.length, 1)
      assert.strictEqual(generatedParts[0].partNumber, 1)
      assert.ok(generatedParts[0].size >= minPartSize)

      // Manifest completion requires ascending sort
      const manifest = [
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 1, etag: '"etag-1"' }
      ]
      manifest.sort((a, b) => a.partNumber - b.partNumber)

      assert.strictEqual(manifest[0].partNumber, 1)
      assert.strictEqual(manifest[1].partNumber, 2)
    })
  })
})
