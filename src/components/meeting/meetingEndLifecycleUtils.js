/**
 * Meetly AI — Meeting End Lifecycle & Transcript Queue Utilities
 *
 * Encapsulates:
 * 1. Bounded transcript upload queue management with AbortController cancellation.
 * 2. Deterministic, safe meeting-end execution order protecting host Socket.IO authorization
 *    and guaranteeing that isShuttingDown resets in all success and error paths.
 */

/**
 * Creates a bounded queue for tracking and cancelling in-flight transcript uploads.
 *
 * @param {Object} [options]
 * @param {number} [options.defaultMaxWaitMs=1500] - Strict ceiling for meeting-end drain
 * @param {number} [options.pollIntervalMs=50] - Interval between active-count checks
 */
export function createTranscriptUploadQueue({
  defaultMaxWaitMs = 1500,
  pollIntervalMs = 50
} = {}) {
  let activeCount = 0
  const activeControllers = new Map()
  let nextId = 1

  /**
   * Starts tracking a new transcript chunk upload.
   * Returns a unique ID and an AbortSignal to pass to fetch.
   */
  const startUpload = () => {
    const id = nextId++
    const controller = new AbortController()
    activeControllers.set(id, controller)
    activeCount++
    return {
      id,
      signal: controller.signal
    }
  }

  /**
   * Marks an upload as finished (success or non-abort error).
   * Safe to call multiple times.
   */
  const finishUpload = (id) => {
    if (activeControllers.has(id)) {
      activeControllers.delete(id)
      activeCount = Math.max(0, activeCount - 1)
    }
  }

  /**
   * Aborts an individual upload by ID.
   */
  const abortUpload = (id) => {
    const controller = activeControllers.get(id)
    if (controller) {
      try {
        controller.abort()
      } catch (_) {}
      activeControllers.delete(id)
      activeCount = Math.max(0, activeCount - 1)
    }
  }

  /**
   * Immediately aborts all currently in-flight transcript uploads and resets count.
   */
  const abortAll = () => {
    for (const controller of activeControllers.values()) {
      try {
        controller.abort()
      } catch (_) {}
    }
    activeControllers.clear()
    activeCount = 0
  }

  /**
   * Returns current active in-flight count.
   */
  const getActiveCount = () => activeCount

  /**
   * Waits for active uploads to finish, bounded by maxWaitMs (default 1.5s).
   * If in-flight uploads do not complete within maxWaitMs, aborts all remaining
   * requests and resolves immediately so meeting termination is never blocked.
   *
   * @param {number} [maxWaitMs=1500]
   * @returns {Promise<{ finished: boolean, timedOut: boolean }>}
   */
  const waitPending = (maxWaitMs = defaultMaxWaitMs) => {
    return new Promise((resolve) => {
      if (activeCount === 0) {
        resolve({ finished: true, timedOut: false })
        return
      }

      const startTime = Date.now()
      const intervalId = setInterval(() => {
        const elapsed = Date.now() - startTime

        if (activeCount === 0) {
          clearInterval(intervalId)
          resolve({ finished: true, timedOut: false })
          return
        }

        if (elapsed >= maxWaitMs) {
          clearInterval(intervalId)
          abortAll()
          resolve({ finished: false, timedOut: true })
        }
      }, pollIntervalMs)
    })
  }

  return {
    startUpload,
    finishUpload,
    abortUpload,
    abortAll,
    getActiveCount,
    waitPending
  }
}

/**
 * Executes the safe End Meeting finalization sequence.
 *
 * Sequence:
 * 1. Set isShuttingDown = true.
 * 2. Stop transcript capture.
 * 3. Await pending transcript uploads for at most maxTranscriptWaitMs (default 1500ms).
 * 4. Process required attendance (host skips per contract).
 * 5. Call and await endMeeting(meetingId) WHILE host Socket.IO connection is STILL ACTIVE.
 * 6. Only after confirmed backend success, perform socket and media cleanup.
 * 7. Navigate to dashboard ('/') only on confirmed success.
 *
 * Guarantees:
 * - isShuttingDown is ALWAYS reset to false in the finally block.
 * - On backend rejection (e.g., HTTP 403), socket remains connected and navigation is blocked.
 * - Cleanup is executed only once upon confirmed success.
 *
 * @param {Object} params
 * @returns {Promise<{ success: boolean, error?: string, reason?: string }>}
 */
export async function executeMeetingEndSequence({
  isHost,
  meetingId,
  roomName = null,
  enableAiAttendance = false,
  stopTranscriptCapture = null,
  waitPendingTranscriptUploads = null,
  maxTranscriptWaitMs = 1500,
  uploadAttendance = null,
  endMeeting,
  cleanupResources = null,
  setIsShuttingDown = null,
  socketRef = null,
  navigate = null,
  showToast = null,
  isIntentionalLeaveRef = null
}) {
  if (!meetingId) {
    return { success: false, reason: 'missing_meeting_id' }
  }

  if (!isHost) {
    console.error('[Security Guard] Non-host attempted to call executeMeetingEndSequence.')
    return { success: false, reason: 'not_host' }
  }

  if (isIntentionalLeaveRef) {
    isIntentionalLeaveRef.current = true
  }

  if (typeof setIsShuttingDown === 'function') {
    setIsShuttingDown(true)
  }

  let endSucceeded = false
  let errorMessage = null

  try {
    // 1. Stop transcript capture
    if (typeof stopTranscriptCapture === 'function') {
      try {
        stopTranscriptCapture()
      } catch (e) {
        console.error('[MeetingEnd] Error stopping transcript capture:', e)
      }
    }

    // 2. Allow pending transcript uploads a strict maximum grace period (1.5s)
    if (typeof waitPendingTranscriptUploads === 'function') {
      try {
        await waitPendingTranscriptUploads(maxTranscriptWaitMs)
      } catch (e) {
        console.warn('[MeetingEnd] Error awaiting pending transcript uploads:', e)
      }
    }

    // 3. Attendance processing (host skips per existing contract)
    if (enableAiAttendance && typeof uploadAttendance === 'function') {
      try {
        await uploadAttendance()
      } catch (attErr) {
        console.error('[MeetingEnd] Final attendance upload error:', attErr)
      }
    }

    // 4. Call endMeeting API while host Socket.IO connection is STILL ACTIVE
    console.log('[MeetingEnd] Calling endMeeting API while host socket remains active...')
    await endMeeting(meetingId)

    // 5. Emit secondary socket event before socket disconnect
    if (socketRef?.current && roomName && typeof socketRef.current.emit === 'function') {
      try {
        socketRef.current.emit('end_meeting', roomName)
      } catch (emitErr) {
        console.warn('[MeetingEnd] Secondary socket emit error:', emitErr)
      }
    }

    endSucceeded = true
    if (typeof showToast === 'function') {
      showToast('Meeting ended successfully.', 'success')
    }
  } catch (err) {
    errorMessage = err?.message || 'Failed to end meeting'
    console.error('[MeetingEnd] Meeting end error:', err)
    if (typeof showToast === 'function') {
      showToast(errorMessage, 'error')
    }
  } finally {
    // Guaranteed reset of isShuttingDown in all paths
    if (typeof setIsShuttingDown === 'function') {
      setIsShuttingDown(false)
    }

    // Only clean up socket/media resources and navigate if termination succeeded
    if (endSucceeded) {
      if (typeof cleanupResources === 'function') {
        try {
          cleanupResources()
        } catch (cleanupErr) {
          console.error('[MeetingEnd] Error during final resource cleanup:', cleanupErr)
        }
      }
      if (typeof navigate === 'function') {
        navigate('/')
      }
    }
  }

  return { success: endSucceeded, error: errorMessage }
}
