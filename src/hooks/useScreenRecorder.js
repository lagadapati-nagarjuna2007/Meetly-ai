import { useState, useRef, useEffect, useCallback } from 'react'
import { RoomEvent, Track } from 'livekit-client'

const API_BASE = `${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/meetings`

const getAuthHeaders = () => {
  const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
  const headers = { 'Content-Type': 'application/json' }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

/**
 * Negotiates best supported video MIME type for MediaRecorder.
 */
const getSupportedMimeType = () => {
  if (typeof window === 'undefined' || !window.MediaRecorder) return ''
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4'
  ]
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate
    }
  }
  return ''
}

/**
 * Sanitizes URLs for diagnostic logs to prevent leaking signature or auth parameters.
 */
const sanitizeUrlForLog = (url) => {
  try {
    const parsed = new URL(url)
    const partNum = parsed.searchParams.get('partNumber') || ''
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${partNum ? `?partNumber=${partNum}` : ''}&[signature_redacted]`
  } catch (_) {
    return '[url_redacted]'
  }
}

export function useScreenRecorder({
  meetingId,
  room,
  localParticipant,
  participants = [],
  socket,
  showToast = () => {}
}) {
  const [recordingState, setRecordingState] = useState('idle') // idle | starting | recording | finalizing | ready | failed
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [isRoomRecording, setIsRoomRecording] = useState(false)
  const [includeTabAudio, setIncludeTabAudio] = useState(false)
  const [errorMessage, setErrorMessage] = useState(null)

  // Dedicated refs isolated from AI Analyzer
  const screenMediaRecorderRef = useRef(null)
  const screenCaptureStreamRef = useRef(null)
  const screenAudioContextRef = useRef(null)
  const screenMixDestRef = useRef(null)
  const remoteAudioNodesMapRef = useRef(new Map())
  const recordingTimerRef = useRef(null)
  const recordingIdRef = useRef(null)

  // Multipart buffer queue
  const bufferRef = useRef({
    queue: [],
    queuedBytes: 0,
    partNumber: 1,
    manifest: [],
    totalUploadedBytes: 0,
    isFinalizing: false,
    inFlightUploads: [],
    uploadErrors: []
  })

  // 1. Listen for room recording status broadcast from Socket.IO
  useEffect(() => {
    const currentSocket = socket?.current
    if (!currentSocket) return

    const handleRecordingStatusChanged = (data) => {
      console.log('[Socket REC EVENT]', data)
      if (data.status === 'recording') {
        setIsRoomRecording(true)
      } else if (data.status === 'stopped' || data.status === 'ready' || data.status === 'failed') {
        setIsRoomRecording(false)
      }
    }

    currentSocket.on('recording_status_changed', handleRecordingStatusChanged)
    return () => {
      currentSocket.off('recording_status_changed', handleRecordingStatusChanged)
    }
  }, [socket])

  // Helper to upload a single buffered multipart part to Backblaze B2 with automatic retries and server fallback
  const uploadPartToB2 = async (partBlob, partNum, recId, maxRetries = 2) => {
    let lastErr = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Stage 1: Request presigned URL from backend
        console.log(`[Screen Recording Upload] Stage: request_part_url | Part #${partNum} | Attempt ${attempt + 1}/${maxRetries + 1}`)
        const res = await fetch(`${API_BASE}/${meetingId}/recording/part-url`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ recordingId: recId, partNumber: partNum })
        })

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}))
          console.warn(`[Screen Recording Upload] Stage: part_url_failed | Part #${partNum} | HTTP ${res.status}`)
          throw new Error(errData.message || `Failed to obtain part URL for part ${partNum} (HTTP ${res.status})`)
        }

        const { presignedUrl } = await res.json()
        console.log(`[Screen Recording Upload] Stage: part_url_received | Part #${partNum} | Destination: ${sanitizeUrlForLog(presignedUrl)}`)

        // Stage 2: Direct PUT upload to Backblaze B2
        try {
          console.log(`[Screen Recording Upload] Stage: direct_b2_put_start | Part #${partNum} (${partBlob.size} bytes)`)
          const putRes = await fetch(presignedUrl, {
            method: 'PUT',
            body: partBlob
          })

          if (!putRes.ok) {
            console.warn(`[Screen Recording Upload] Stage: direct_b2_put_failed | Part #${partNum} | HTTP ${putRes.status}`)
            throw new Error(`Direct B2 upload returned HTTP ${putRes.status} for part ${partNum}`)
          }

          const rawEtag = putRes.headers.get('etag') || putRes.headers.get('ETag') || ''
          const etag = rawEtag.trim()
          console.log(`[Screen Recording Upload] Stage: direct_b2_put_success | Part #${partNum} | ETag: ${etag ? '[captured]' : '[not_exposed]'}`)

          return { partNumber: partNum, etag }
        } catch (directPutErr) {
          // If direct PUT failed (e.g. TypeError: Failed to fetch due to CORS preflight, or network error),
          // seamlessly fall back to server-side upload route to guarantee recording completes.
          console.warn(`[Screen Recording Upload] Stage: direct_b2_put_fallback | Part #${partNum} | Direct upload failed (${directPutErr.name}: ${directPutErr.message}). Falling back to backend upload route...`)

          const fallbackRes = await fetch(`${API_BASE}/${meetingId}/recording/upload-part?recordingId=${encodeURIComponent(recId)}&partNumber=${partNum}`, {
            method: 'POST',
            headers: {
              ...getAuthHeaders(),
              'Content-Type': 'application/octet-stream'
            },
            body: partBlob
          })

          if (!fallbackRes.ok) {
            const fbErrData = await fallbackRes.json().catch(() => ({}))
            console.error(`[Screen Recording Upload] Stage: server_fallback_failed | Part #${partNum} | HTTP ${fallbackRes.status}`)
            throw new Error(fbErrData.message || `Server upload fallback failed with HTTP ${fallbackRes.status} for part ${partNum}`)
          }

          const fbData = await fallbackRes.json()
          console.log(`[Screen Recording Upload] Stage: server_fallback_success | Part #${partNum} | ETag: ${fbData.etag ? '[captured]' : '[none]'}`)
          return { partNumber: partNum, etag: fbData.etag }
        }
      } catch (err) {
        lastErr = err
        console.warn(`[Screen Recording Upload Retry] Stage: attempt_failed | Part #${partNum} | Attempt ${attempt + 1}/${maxRetries + 1}: ${err.message}`)
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
        }
      }
    }
    console.error(`[Screen Recording Upload Error] Stage: part_permanently_failed | Part #${partNum}: ${lastErr?.message}`)
    throw lastErr
  }

  // 2. Stop capture & finalize multipart upload
  const stopRecording = useCallback(async (triggerReason = 'user_stop') => {
    if (bufferRef.current.isFinalizing) return
    bufferRef.current.isFinalizing = true

    console.log(`[Screen Recording] Stopping recording. Reason: ${triggerReason}`)
    setRecordingState('finalizing')
    showToast('Finalizing screen recording, please wait...', 'info')

    // Stop duration timer
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current)
      recordingTimerRef.current = null
    }

    const recId = recordingIdRef.current
    const recorder = screenMediaRecorderRef.current
    let completionDispatched = false

    try {
      // 1. Await MediaRecorder stop event to guarantee final ondataavailable has fired
      if (recorder && recorder.state !== 'inactive') {
        console.log('[Screen Recording] Awaiting MediaRecorder stop event for final data chunks...')
        await new Promise((resolve) => {
          let timeoutId = null
          const handleStop = () => {
            if (timeoutId) clearTimeout(timeoutId)
            recorder.removeEventListener('stop', handleStop)
            resolve()
          }
          recorder.addEventListener('stop', handleStop)
          timeoutId = setTimeout(() => {
            recorder.removeEventListener('stop', handleStop)
            resolve()
          }, 5000)

          try {
            recorder.stop()
          } catch (stopErr) {
            console.warn('[Screen Recording] Error stopping recorder:', stopErr.message)
            handleStop()
          }
        })
        console.log('[Screen Recording] MediaRecorder successfully stopped.')
      }

      // 2. Await all in-flight 5 MiB part uploads to settle
      if (bufferRef.current.inFlightUploads.length > 0) {
        console.log(`[Screen Recording] Awaiting ${bufferRef.current.inFlightUploads.length} in-flight part upload(s)...`)
        await Promise.all(bufferRef.current.inFlightUploads)
      }

      if (bufferRef.current.uploadErrors.length > 0) {
        throw new Error(`Upload failed for buffered parts: ${bufferRef.current.uploadErrors[0].message}`)
      }

      // 3. Flush the final part if data remains in queue
      if (bufferRef.current.queue.length > 0) {
        const finalBlob = new Blob(bufferRef.current.queue, { type: recorder?.mimeType || 'video/webm' })
        const finalPartNum = bufferRef.current.partNumber
        bufferRef.current.partNumber += 1
        bufferRef.current.queue = []
        bufferRef.current.queuedBytes = 0

        console.log(`[Screen Recording Upload] Stage: final_part | Part #${finalPartNum} (${finalBlob.size} bytes)...`)
        const finalPart = await uploadPartToB2(finalBlob, finalPartNum, recId)
        bufferRef.current.manifest.push(finalPart)
      }

      const manifest = bufferRef.current.manifest
      if (manifest.length === 0) {
        throw new Error('No video chunks were successfully recorded.')
      }

      // Ensure manifest is sorted ascending by partNumber
      manifest.sort((a, b) => a.partNumber - b.partNumber)

      // 4. Complete multipart upload on backend
      completionDispatched = true
      console.log(`[Screen Recording Upload] Stage: complete_request | Submitting manifest with ${manifest.length} part(s)...`)
      const completeRes = await fetch(`${API_BASE}/${meetingId}/recording/complete`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          recordingId: recId,
          durationSeconds: recordingDuration,
          parts: manifest
        })
      })

      const completeData = await completeRes.json().catch(() => ({}))

      if (!completeRes.ok) {
        throw new Error(completeData.message || `Server finalization failed with HTTP ${completeRes.status}`)
      }

      console.log('[Screen Recording Upload] Stage: complete_success | Recording ready:', completeData)
      setRecordingState('ready')
      showToast('Screen recording saved and ready for playback!', 'success')
    } catch (err) {
      console.error('[Screen Recording Error] Finalization failed:', err.message)
      setRecordingState('failed')
      setErrorMessage(err.message)
      showToast(`Recording failed: ${err.message}`, 'error')

      // Only notify backend about abort if completion was NOT dispatched, to avoid conflicting with active completion
      if (recId && !completionDispatched) {
        console.log('[Screen Recording Upload] Stage: abort_request | Notifying server of abort...')
        fetch(`${API_BASE}/${meetingId}/recording/abort`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ recordingId: recId, reason: err.message })
        }).catch(() => {})
      }
    } finally {
      // Clean up recording-owned tracks only
      if (screenCaptureStreamRef.current) {
        screenCaptureStreamRef.current.getTracks().forEach(t => t.stop())
        screenCaptureStreamRef.current = null
      }

      // Close AudioContext
      if (screenAudioContextRef.current && screenAudioContextRef.current.state !== 'closed') {
        screenAudioContextRef.current.close().catch(() => {})
        screenAudioContextRef.current = null
      }

      screenMixDestRef.current = null
      remoteAudioNodesMapRef.current.clear()
      screenMediaRecorderRef.current = null
      bufferRef.current.isFinalizing = false
    }
  }, [meetingId, recordingDuration, showToast])

  // Pause active recording safely without disrupting session or chunks
  const pauseRecording = useCallback(() => {
    const recorder = screenMediaRecorderRef.current
    if (!recorder) {
      console.warn('[Screen Recording] Cannot pause: recorder instance not found.')
      return
    }

    if (recorder.state !== 'recording') {
      console.warn('[Screen Recording] Cannot pause: recorder state is not "recording" (current state:', recorder.state, ')')
      return
    }

    try {
      recorder.pause()
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current)
        recordingTimerRef.current = null
      }
      setRecordingState('paused')
      showToast('Screen recording paused.', 'info')
      console.log('[Screen Recording] Recording paused successfully.')
    } catch (err) {
      console.error('[Screen Recording Error] Failed to pause recorder:', err)
      showToast(`Could not pause recording: ${err.message}`, 'error')
    }
  }, [showToast])

  // Resume paused recording
  const resumeRecording = useCallback(() => {
    const recorder = screenMediaRecorderRef.current
    if (!recorder) {
      console.warn('[Screen Recording] Cannot resume: recorder instance not found.')
      return
    }

    if (recorder.state !== 'paused') {
      console.warn('[Screen Recording] Cannot resume: recorder state is not "paused" (current state:', recorder.state, ')')
      return
    }

    try {
      recorder.resume()
      if (!recordingTimerRef.current) {
        recordingTimerRef.current = setInterval(() => {
          setRecordingDuration(prev => {
            const nextSec = prev + 1
            if (nextSec >= 7200) {
              console.warn('[Screen Recording] Reached maximum duration limit of 120 minutes.')
              stopRecording('max_duration_reached')
            }
            return nextSec
          })
        }, 1000)
      }
      setRecordingState('recording')
      showToast('Screen recording resumed.', 'info')
      console.log('[Screen Recording] Recording resumed successfully.')
    } catch (err) {
      console.error('[Screen Recording Error] Failed to resume recorder:', err)
      showToast(`Could not resume recording: ${err.message}`, 'error')
    }
  }, [showToast, stopRecording])

  // 3. Start screen recording
  const startRecording = useCallback(async () => {
    if (recordingState === 'recording' || recordingState === 'starting') return

    setRecordingState('starting')
    setErrorMessage(null)
    setRecordingDuration(0)

    // Reset multipart buffer
    bufferRef.current = {
      queue: [],
      queuedBytes: 0,
      partNumber: 1,
      manifest: [],
      totalUploadedBytes: 0,
      isFinalizing: false,
      inFlightUploads: [],
      uploadErrors: []
    }

    let displayStream = null

    try {
      // Step 1: Prompt user for screen/tab capture immediately during the user gesture
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 30, max: 30 },
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 }
        },
        audio: includeTabAudio
      })

      screenCaptureStreamRef.current = displayStream

      // Handle user clicking floating "Stop Sharing" browser bar
      const videoTrack = displayStream.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.onended = () => {
          stopRecording('browser_capture_ended')
        }
      }

      // Step 2: Negotiate supported MIME type
      const mimeType = getSupportedMimeType() || 'video/webm'

      // Step 3: Initialize recording session in Meetly backend
      const initRes = await fetch(`${API_BASE}/${meetingId}/recording/start`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ mimeType })
      })

      const initData = await initRes.json().catch(() => ({}))
      if (!initRes.ok) {
        throw new Error(initData.message || 'Failed to initialize recording session on server.')
      }

      const recId = initData.recordingId
      recordingIdRef.current = recId

      // Step 4: Build Web Audio API Mixer for LiveKit room conversation
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      const audioCtx = new AudioCtx()
      screenAudioContextRef.current = audioCtx
      const mixDest = audioCtx.createMediaStreamDestination()
      screenMixDestRef.current = mixDest

      // 4a. Connect local microphone track from LiveKit without re-requesting mic permissions
      const localMicPub = localParticipant?.getTrackPublication(Track.Source.Microphone)
      if (localMicPub?.track?.mediaStreamTrack) {
        try {
          const localMicSource = audioCtx.createMediaStreamSource(new MediaStream([localMicPub.track.mediaStreamTrack]))
          localMicSource.connect(mixDest)
          console.log('[Screen Recording Mixer] Connected local microphone track.')
        } catch (e) {
          console.warn('[Screen Recording Mixer] Error connecting local mic:', e)
        }
      }

      // 4b. Connect subscribed remote participant audio tracks
      if (participants && participants.length > 0) {
        participants.forEach(p => {
          p.audioTrackPublications?.forEach(pub => {
            if (pub.track?.mediaStreamTrack) {
              try {
                const remoteSource = audioCtx.createMediaStreamSource(new MediaStream([pub.track.mediaStreamTrack]))
                remoteSource.connect(mixDest)
                remoteAudioNodesMapRef.current.set(pub.track.sid, remoteSource)
              } catch (e) {
                console.warn('[Screen Recording Mixer] Error connecting remote track:', e)
              }
            }
          })
        })
      }

      // 4c. Dynamically attach/detach LiveKit audio tracks as participants join/leave
      if (room) {
        const handleTrackSubscribed = (track) => {
          if (track.kind === 'audio' && track.mediaStreamTrack && screenAudioContextRef.current) {
            try {
              const src = screenAudioContextRef.current.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]))
              src.connect(screenMixDestRef.current)
              remoteAudioNodesMapRef.current.set(track.sid, src)
              console.log('[Screen Recording Mixer] Connected newly subscribed remote audio track:', track.sid)
            } catch (err) {
              console.warn('[Screen Recording Mixer] Error subscribing remote track:', err)
            }
          }
        }

        const handleTrackUnsubscribed = (track) => {
          if (track.kind === 'audio') {
            const node = remoteAudioNodesMapRef.current.get(track.sid)
            if (node) {
              try { node.disconnect() } catch (_) {}
              remoteAudioNodesMapRef.current.delete(track.sid)
            }
          }
        }

        room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
        room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
      }

      // 4d. Optional browser tab audio (if user checked and browser returned track)
      if (includeTabAudio) {
        const displayAudioTracks = displayStream.getAudioTracks()
        if (displayAudioTracks.length > 0) {
          try {
            const tabAudioSource = audioCtx.createMediaStreamSource(new MediaStream([displayAudioTracks[0]]))
            tabAudioSource.connect(mixDest)
            console.log('[Screen Recording Mixer] Connected optional browser tab audio track.')
          } catch (e) {
            console.warn('[Screen Recording Mixer] Error connecting tab audio:', e)
          }
        }
      }

      // Step 5: Merge display video track with mixed audio track
      const combinedTracks = [
        ...displayStream.getVideoTracks(),
        ...mixDest.stream.getAudioTracks()
      ]
      const recordingStream = new MediaStream(combinedTracks)

      // Step 6: Create dedicated MediaRecorder instance
      const recorder = new MediaRecorder(recordingStream, {
        mimeType,
        videoBitsPerSecond: 1800000, // 1.8 Mbps target
        audioBitsPerSecond: 128000   // 128 kbps audio
      })
      screenMediaRecorderRef.current = recorder

      // Step 7: Handle chunk accumulation and multipart upload threshold (>= 5 MiB)
      recorder.ondataavailable = (e) => {
        if (!e.data || e.data.size === 0) return

        bufferRef.current.queue.push(e.data)
        bufferRef.current.queuedBytes += e.data.size

        // If buffered size exceeds 5 MiB (5,242,880 bytes), slice and upload part
        if (bufferRef.current.queuedBytes >= 5242880 && !bufferRef.current.isFinalizing) {
          const partBlob = new Blob(bufferRef.current.queue, { type: mimeType })
          const currentPartNum = bufferRef.current.partNumber
          bufferRef.current.partNumber += 1
          bufferRef.current.queue = []
          bufferRef.current.queuedBytes = 0

          const uploadTask = (async () => {
            try {
              console.log(`[Screen Recording Upload] Stage: start_buffered_part | Part #${currentPartNum} (${partBlob.size} bytes)`)
              const partInfo = await uploadPartToB2(partBlob, currentPartNum, recId)
              bufferRef.current.manifest.push(partInfo)
              bufferRef.current.totalUploadedBytes += partBlob.size

              // Soft threshold: Stop recording before reaching 2,000,000,000 bytes
              if (bufferRef.current.totalUploadedBytes >= 1950000000) {
                console.warn('[Screen Recording] Approaching 1.95 GB ceiling. Triggering safe stop.')
                stopRecording('soft_limit_reached')
              }
            } catch (upErr) {
              console.error(`[Screen Recording Error] Part #${currentPartNum} failed:`, upErr.message)
              bufferRef.current.uploadErrors.push(upErr)
            }
          })()

          bufferRef.current.inFlightUploads.push(uploadTask)
        }
      }

      // Start recorder with 1-second timeslice
      recorder.start(1000)
      setRecordingState('recording')
      showToast('Screen recording active. Meeting conversation audio is being captured.', 'info')

      // Step 8: Start duration timer with 120-minute hard stop
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration(prev => {
          const nextSec = prev + 1
          if (nextSec >= 7200) { // 120 minutes (2 hours)
            console.warn('[Screen Recording] Reached maximum duration limit of 120 minutes.')
            stopRecording('max_duration_reached')
          }
          return nextSec
        })
      }, 1000)
    } catch (err) {
      console.error('[Screen Recording Error] Start failed:', err)
      if (displayStream) {
        displayStream.getTracks().forEach(t => t.stop())
      }
      setRecordingState('idle')
      if (err.name !== 'NotAllowedError') {
        setErrorMessage(err.message)
        showToast(`Could not start recording: ${err.message}`, 'error')
      }
    }
  }, [recordingState, includeTabAudio, meetingId, localParticipant, participants, room, showToast, stopRecording])

  return {
    recordingState,
    isRecording: recordingState === 'recording',
    isPaused: recordingState === 'paused',
    isRecordingOrPaused: recordingState === 'recording' || recordingState === 'paused',
    recordingDuration,
    isRoomRecording,
    includeTabAudio,
    setIncludeTabAudio,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    errorMessage
  }
}
