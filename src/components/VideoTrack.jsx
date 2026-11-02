import React, { useEffect, useRef, forwardRef } from 'react'

/**
 * Universal VideoTrack Component
 *
 * Provider-independent React component that renders any standard W3C MediaStreamTrack
 * inside an HTML5 <video> element.
 *
 * CRITICAL TRACK OWNERSHIP CONTRACT:
 * - This component NEVER calls track.stop().
 * - It attaches tracks using `videoElement.srcObject = new MediaStream([track])`.
 * - On unmount, track replacement, or error, it detaches `srcObject = null`
 *   WITHOUT terminating the underlying MediaStreamTrack.
 * - This guarantees that shared camera streams (such as MediaPipe BlazeFace)
 *   and RealtimeKit-managed tracks are never prematurely terminated.
 */
const VideoTrack = forwardRef(function VideoTrack(
  {
    track = null,
    muted = true,
    autoPlay = true,
    playsInline = true,
    className = '',
    videoRef: videoRefProp = null,
    onPlaybackError = null,
    ...restProps
  },
  forwardedRef
) {
  const localVideoRef = useRef(null)

  // Synchronize forwarded ref and videoRef prop with local ref
  const setCombinedRef = (element) => {
    localVideoRef.current = element

    if (typeof forwardedRef === 'function') {
      forwardedRef(element)
    } else if (forwardedRef && typeof forwardedRef === 'object') {
      forwardedRef.current = element
    }

    if (typeof videoRefProp === 'function') {
      videoRefProp(element)
    } else if (videoRefProp && typeof videoRefProp === 'object') {
      videoRefProp.current = element
    }
  }

  // Resolve native MediaStreamTrack from input prop (supports direct track or wrapped objects)
  const resolvedTrack = track && typeof track === 'object'
    ? (track.mediaStreamTrack || track)
    : null

  useEffect(() => {
    const videoEl = localVideoRef.current
    if (!videoEl) return

    // 1. If no track or track has already ended, cleanly detach
    if (!resolvedTrack || resolvedTrack.readyState === 'ended') {
      if (videoEl.srcObject) {
        videoEl.srcObject = null
      }
      return
    }

    // 2. Attach track via MediaStream wrapper
    let isCurrent = true
    const stream = new MediaStream([resolvedTrack])
    videoEl.srcObject = stream

    // 3. Play if autoPlay is requested
    if (autoPlay) {
      videoEl.play().catch((err) => {
        // AbortError is normal when track/srcObject changes rapidly or unmounts during play()
        if (err.name !== 'AbortError' && isCurrent) {
          console.warn('[VideoTrack] Autoplay prevented or failed:', err.name, err.message)
          if (typeof onPlaybackError === 'function') {
            onPlaybackError(err)
          }
        }
      })
    }

    // 4. Handle track ending (e.g. OS/hardware unplug or external stop)
    const handleTrackEnded = () => {
      if (videoEl && videoEl.srcObject === stream) {
        videoEl.srcObject = null
      }
    }

    resolvedTrack.addEventListener('ended', handleTrackEnded)

    // 5. Cleanup on unmount or track change:
    // Detach srcObject WITHOUT calling resolvedTrack.stop()
    return () => {
      isCurrent = false
      resolvedTrack.removeEventListener('ended', handleTrackEnded)
      if (videoEl && videoEl.srcObject === stream) {
        videoEl.srcObject = null
      }
    }
  }, [resolvedTrack, autoPlay, onPlaybackError])

  return (
    <video
      ref={setCombinedRef}
      muted={muted}
      autoPlay={autoPlay}
      playsInline={playsInline}
      className={className}
      {...restProps}
    />
  )
})

export default VideoTrack
export { VideoTrack }
