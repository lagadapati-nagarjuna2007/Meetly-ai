import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Meetly AI — Universal VideoTrack Component Contract Test Suite
 *
 * Verifies that the universal VideoTrack lifecycle adheres strictly to the
 * Track Ownership contract:
 * 1. NEVER calls track.stop().
 * 2. Detaches video.srcObject cleanly without terminating underlying tracks.
 * 3. Handles track replacement, null tracks, and ended tracks.
 * 4. Tolerates playback errors and ignores AbortErrors during rapid switches.
 * 5. Resolves both direct MediaStreamTrack and wrapped publication objects.
 */

// Helper to create a realistic mock MediaStreamTrack
function createMockTrack({ id = 'track-1', kind = 'video', readyState = 'live' } = {}) {
  let stopCalled = false
  const listeners = new Map()

  return {
    id,
    kind,
    readyState,
    get stopCalled() {
      return stopCalled
    },
    stop() {
      stopCalled = true
      this.readyState = 'ended'
      const endedListeners = listeners.get('ended') || []
      endedListeners.forEach((fn) => fn())
    },
    addEventListener(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
    },
    removeEventListener(event, fn) {
      const arr = listeners.get(event) || []
      listeners.set(event, arr.filter((cb) => cb !== fn))
    },
    clone() {
      return createMockTrack({ id: `${id}-clone`, kind, readyState: this.readyState })
    }
  }
}

// Helper to create a realistic mock HTMLVideoElement
function createMockVideoElement() {
  let srcObj = null
  let isPlaying = false
  let shouldFailPlay = null

  return {
    get srcObject() {
      return srcObj
    },
    set srcObject(val) {
      srcObj = val
      if (!val) isPlaying = false
    },
    get isPlaying() {
      return isPlaying
    },
    setPlayFailure(err) {
      shouldFailPlay = err
    },
    async play() {
      if (shouldFailPlay) {
        throw shouldFailPlay
      }
      isPlaying = true
    },
    pause() {
      isPlaying = false
    }
  }
}

// Helper simulating VideoTrack lifecycle logic (mirroring useEffect in VideoTrack.jsx)
function simulateVideoTrackLifecycle({
  videoEl,
  track,
  autoPlay = true,
  onPlaybackError = null
}) {
  const resolvedTrack = track && typeof track === 'object'
    ? (track.mediaStreamTrack || track)
    : null

  if (!resolvedTrack || resolvedTrack.readyState === 'ended') {
    if (videoEl.srcObject) {
      videoEl.srcObject = null
    }
    return () => {}
  }

  let isCurrent = true
  // In browser, this creates new MediaStream([resolvedTrack])
  // We represent the stream holding the track reference
  const stream = { tracks: [resolvedTrack] }
  videoEl.srcObject = stream

  if (autoPlay) {
    videoEl.play().catch((err) => {
      if (err.name !== 'AbortError' && isCurrent) {
        if (typeof onPlaybackError === 'function') {
          onPlaybackError(err)
        }
      }
    })
  }

  const handleTrackEnded = () => {
    if (videoEl && videoEl.srcObject === stream) {
      videoEl.srcObject = null
    }
  }

  resolvedTrack.addEventListener('ended', handleTrackEnded)

  // Cleanup on unmount or track replacement
  return () => {
    isCurrent = false
    resolvedTrack.removeEventListener('ended', handleTrackEnded)
    if (videoEl && videoEl.srcObject === stream) {
      videoEl.srcObject = null
    }
    // CRITICAL: NEVER call resolvedTrack.stop()
  }
}

describe('Meetly AI — Universal VideoTrack Lifecycle & Contract Suite', () => {
  it('1. Successfully attaches a valid MediaStreamTrack to video.srcObject', () => {
    const video = createMockVideoElement()
    const track = createMockTrack({ id: 'camera-track-1' })

    const cleanup = simulateVideoTrackLifecycle({ videoEl: video, track })

    assert.ok(video.srcObject, 'video.srcObject must be set')
    assert.strictEqual(video.srcObject.tracks[0], track)
    assert.strictEqual(video.isPlaying, true, 'Autoplay must trigger play()')
    assert.strictEqual(track.stopCalled, false, 'Track must not be stopped on attachment')

    cleanup()
  })

  it('2. CRITICAL TRACK OWNERSHIP: Unmounting detaches video.srcObject but NEVER calls track.stop()', () => {
    const video = createMockVideoElement()
    const physicalTrack = createMockTrack({ id: 'physical-webcam-mediapipe' })

    const cleanup = simulateVideoTrackLifecycle({ videoEl: video, track: physicalTrack })
    assert.ok(video.srcObject)
    assert.strictEqual(physicalTrack.stopCalled, false)

    // Component unmounts
    cleanup()

    assert.strictEqual(video.srcObject, null, 'srcObject must be detached on unmount')
    assert.strictEqual(physicalTrack.stopCalled, false, 'physicalTrack.stop() MUST NEVER be called on unmount!')
    assert.strictEqual(physicalTrack.readyState, 'live', 'Track must remain live for MediaPipe / RealtimeKit')
  })

  it('3. Track Replacement: Replaces track A with track B without stopping track A', () => {
    const video = createMockVideoElement()
    const trackA = createMockTrack({ id: 'camera-track-A' })
    const trackB = createMockTrack({ id: 'camera-track-B' })

    // Mount with Track A
    let cleanup = simulateVideoTrackLifecycle({ videoEl: video, track: trackA })
    assert.strictEqual(video.srcObject.tracks[0], trackA)

    // Replace with Track B (unmount previous, mount next)
    cleanup()
    assert.strictEqual(trackA.stopCalled, false, 'Track A must not be stopped on replacement')

    cleanup = simulateVideoTrackLifecycle({ videoEl: video, track: trackB })
    assert.strictEqual(video.srcObject.tracks[0], trackB)
    assert.strictEqual(trackB.stopCalled, false, 'Track B must be live and unstopped')

    cleanup()
    assert.strictEqual(trackA.stopCalled, false)
    assert.strictEqual(trackB.stopCalled, false)
  })

  it('4. Handles null or undefined track gracefully by clearing srcObject', () => {
    const video = createMockVideoElement()
    video.srcObject = { tracks: [] } // pre-existing stream

    const cleanup = simulateVideoTrackLifecycle({ videoEl: video, track: null })

    assert.strictEqual(video.srcObject, null, 'srcObject must be cleared when track is null')
    cleanup()
  })

  it('5. Does not attach track if readyState is already "ended"', () => {
    const video = createMockVideoElement()
    const endedTrack = createMockTrack({ id: 'ended-track', readyState: 'ended' })

    const cleanup = simulateVideoTrackLifecycle({ videoEl: video, track: endedTrack })

    assert.strictEqual(video.srcObject, null, 'Ended track must not be attached')
    cleanup()
  })

  it('6. Automatically detaches srcObject when track emits "ended" event (hardware unplug)', () => {
    const video = createMockVideoElement()
    const track = createMockTrack({ id: 'usb-cam-track' })

    const cleanup = simulateVideoTrackLifecycle({ videoEl: video, track })
    assert.ok(video.srcObject)

    // Hardware or OS ends the track
    track.stop()
    assert.strictEqual(video.srcObject, null, 'srcObject must be detached when track ends externally')

    cleanup()
  })

  it('7. Handles autoplay rejection (NotAllowedError) and reports to onPlaybackError', async () => {
    const video = createMockVideoElement()
    const notAllowedErr = new Error('Play permission denied')
    notAllowedErr.name = 'NotAllowedError'
    video.setPlayFailure(notAllowedErr)

    let capturedErr = null
    const track = createMockTrack({ id: 'track-autoplay-test' })

    const cleanup = simulateVideoTrackLifecycle({
      videoEl: video,
      track,
      autoPlay: true,
      onPlaybackError: (err) => {
        capturedErr = err
      }
    })

    // Allow promise microtask to resolve
    await new Promise((r) => setTimeout(r, 10))

    assert.ok(capturedErr, 'onPlaybackError must receive the playback failure')
    assert.strictEqual(capturedErr.name, 'NotAllowedError')
    assert.strictEqual(track.stopCalled, false, 'Playback failure must not stop track')

    cleanup()
  })

  it('8. Silently ignores AbortError caused by rapid track switching', async () => {
    const video = createMockVideoElement()
    const abortErr = new Error('The play() request was interrupted by a new load request')
    abortErr.name = 'AbortError'
    video.setPlayFailure(abortErr)

    let capturedErr = null
    const track = createMockTrack({ id: 'track-rapid-switch' })

    const cleanup = simulateVideoTrackLifecycle({
      videoEl: video,
      track,
      autoPlay: true,
      onPlaybackError: (err) => {
        capturedErr = err
      }
    })

    await new Promise((r) => setTimeout(r, 10))

    assert.strictEqual(capturedErr, null, 'AbortError must be suppressed cleanly without error callback')
    cleanup()
  })

  it('9. Resolves wrapped track publication objects (e.g. { mediaStreamTrack })', () => {
    const video = createMockVideoElement()
    const innerTrack = createMockTrack({ id: 'inner-track-uuid' })
    const wrappedPub = { mediaStreamTrack: innerTrack, isMuted: false }

    const cleanup = simulateVideoTrackLifecycle({ videoEl: video, track: wrappedPub })

    assert.ok(video.srcObject)
    assert.strictEqual(video.srcObject.tracks[0], innerTrack, 'Inner track must be extracted and attached')

    cleanup()
    assert.strictEqual(innerTrack.stopCalled, false)
  })
})
