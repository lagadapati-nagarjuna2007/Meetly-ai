import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createTranscriptUploadQueue,
  executeMeetingEndSequence
} from '../../src/components/meeting/meetingEndLifecycleUtils.js'
import {
  endMeeting,
  submitTranscriptChunk,
  setCloudflareService,
  resetCloudflareService
} from '../controllers/meetingController.js'
import { supabase } from '../config/supabase.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const meetingControllerPath = path.resolve(__dirname, '../controllers/meetingController.js')

/**
 * Meetly AI — Phase 4, Step 6.7.3.2: Meeting End Finalization Hang Fix Suite
 *
 * Verifies all 9 mandatory requirements:
 * 1. Meeting end succeeds when transcript uploads remain pending beyond 1.5 seconds.
 * 2. Host socket remains connected until the end-meeting API request completes.
 * 3. Socket cleanup happens after successful backend termination.
 * 4. HTTP 403 does not trigger navigation or premature cleanup.
 * 5. Backend failure does not trigger false success navigation.
 * 6. isShuttingDown resets after both success and failure.
 * 7. Transcript upload counters remain correct after timeout or abort.
 * 8. Groq timeout (8s) is handled without an unhandled rejection, returning 504.
 * 9. Existing LiveKit meeting termination behavior remains unchanged.
 */

describe('Meetly AI — Phase 4, Step 6.7.3.2: Meeting End Finalization Suite', () => {

  // =========================================================================
  // REQUIREMENT 1: Meeting end succeeds when transcript uploads exceed 1.5s
  // =========================================================================
  it('1. Meeting end succeeds when transcript uploads remain pending beyond grace period', async () => {
    const queue = createTranscriptUploadQueue({ defaultMaxWaitMs: 1500, pollIntervalMs: 20 })

    // Simulate 2 uploads that hang indefinitely
    const upload1 = queue.startUpload()
    const upload2 = queue.startUpload()

    assert.strictEqual(queue.getActiveCount(), 2, 'Two uploads should be in flight')
    assert.strictEqual(upload1.signal.aborted, false)
    assert.strictEqual(upload2.signal.aborted, false)

    let endMeetingCalled = false
    let isShuttingDownStates = []
    let navigatedTo = null

    // Run meeting end sequence with 100ms grace period for fast test execution
    const result = await executeMeetingEndSequence({
      isHost: true,
      meetingId: 'mtg-uuid-test-1',
      roomName: 'room-test-1',
      stopTranscriptCapture: () => {},
      waitPendingTranscriptUploads: (maxWait) => queue.waitPending(maxWait),
      maxTranscriptWaitMs: 100,
      endMeeting: async (id) => {
        endMeetingCalled = true
        assert.strictEqual(id, 'mtg-uuid-test-1')
        return { success: true }
      },
      cleanupResources: () => {},
      setIsShuttingDown: (val) => isShuttingDownStates.push(val),
      navigate: (dest) => { navigatedTo = dest }
    })

    assert.strictEqual(result.success, true, 'Meeting end must succeed despite stuck uploads')
    assert.strictEqual(endMeetingCalled, true, 'endMeeting API must be called')
    assert.strictEqual(navigatedTo, '/', 'Must navigate to dashboard')
    assert.strictEqual(queue.getActiveCount(), 0, 'Active uploads must be drained/aborted')
    assert.strictEqual(upload1.signal.aborted, true, 'Hanging upload 1 must be aborted')
    assert.strictEqual(upload2.signal.aborted, true, 'Hanging upload 2 must be aborted')
  })

  // =========================================================================
  // REQUIREMENT 2: Host socket remains connected until endMeeting API completes
  // =========================================================================
  it('2. Host socket remains connected until the end-meeting API request completes', async () => {
    const mockSocket = {
      connected: true,
      disconnectCalled: false,
      disconnect: function () {
        this.connected = false
        this.disconnectCalled = true
      },
      emit: () => {}
    }

    const socketRef = { current: mockSocket }
    let socketStateDuringEndMeeting = null

    await executeMeetingEndSequence({
      isHost: true,
      meetingId: 'mtg-uuid-test-2',
      roomName: 'room-test-2',
      socketRef,
      endMeeting: async () => {
        // Capture socket state right in the middle of endMeeting execution
        socketStateDuringEndMeeting = {
          connected: socketRef.current.connected,
          disconnectCalled: socketRef.current.disconnectCalled
        }
      },
      cleanupResources: () => {
        socketRef.current.disconnect()
      },
      navigate: () => {}
    })

    assert.ok(socketStateDuringEndMeeting, 'endMeeting should have executed')
    assert.strictEqual(
      socketStateDuringEndMeeting.connected,
      true,
      'Host socket must remain connected while endMeeting API is in flight'
    )
    assert.strictEqual(
      socketStateDuringEndMeeting.disconnectCalled,
      false,
      'Host socket must NOT be disconnected prior to endMeeting completion'
    )
    assert.strictEqual(
      mockSocket.connected,
      false,
      'Host socket is disconnected during post-success cleanup'
    )
  })

  // =========================================================================
  // REQUIREMENT 3: Socket cleanup happens after successful backend termination
  // =========================================================================
  it('3. Socket and resource cleanup happens strictly after successful backend termination', async () => {
    const callOrder = []

    const mockSocket = {
      emit: (evt) => callOrder.push(`socket:emit:${evt}`)
    }

    await executeMeetingEndSequence({
      isHost: true,
      meetingId: 'mtg-uuid-test-3',
      roomName: 'room-test-3',
      socketRef: { current: mockSocket },
      stopTranscriptCapture: () => {
        callOrder.push('stopTranscriptCapture')
      },
      waitPendingTranscriptUploads: async () => {
        callOrder.push('waitPendingTranscriptUploads')
      },
      endMeeting: async () => {
        callOrder.push('endMeeting:call')
      },
      cleanupResources: () => {
        callOrder.push('cleanupResources')
      },
      navigate: (path) => {
        callOrder.push(`navigate:${path}`)
      }
    })

    assert.deepStrictEqual(callOrder, [
      'stopTranscriptCapture',
      'waitPendingTranscriptUploads',
      'endMeeting:call',
      'socket:emit:end_meeting',
      'cleanupResources',
      'navigate:/'
    ], 'Cleanup and navigation must only execute after endMeeting resolves successfully')
  })

  // =========================================================================
  // REQUIREMENT 4: HTTP 403 does not trigger navigation or premature cleanup
  // =========================================================================
  it('4. HTTP 403 does not trigger navigation or premature cleanup', async () => {
    let cleanupCalled = false
    let navigateCalled = false
    let toastMessage = null
    let toastType = null

    const mockSocket = {
      connected: true,
      disconnect: () => { mockSocket.connected = false }
    }

    const forbiddenError = new Error('Access denied. Only the active host can end this meeting.')
    forbiddenError.status = 403

    const result = await executeMeetingEndSequence({
      isHost: true,
      meetingId: 'mtg-uuid-test-4',
      roomName: 'room-test-4',
      socketRef: { current: mockSocket },
      endMeeting: async () => {
        throw forbiddenError
      },
      cleanupResources: () => {
        cleanupCalled = true
        mockSocket.disconnect()
      },
      navigate: () => {
        navigateCalled = true
      },
      showToast: (msg, type) => {
        toastMessage = msg
        toastType = type
      }
    })

    assert.strictEqual(result.success, false, 'Execution must fail on HTTP 403')
    assert.strictEqual(cleanupCalled, false, 'cleanupResources must NOT be called on 403')
    assert.strictEqual(navigateCalled, false, 'navigate must NOT be called on 403')
    assert.strictEqual(mockSocket.connected, true, 'Host socket must NOT be disconnected on 403')
    assert.strictEqual(toastType, 'error', 'Error toast must be presented to user')
    assert.ok(toastMessage.includes('Access denied'), 'Toast must indicate access denial')
  })

  // =========================================================================
  // REQUIREMENT 5: Backend failure does not trigger false success navigation
  // =========================================================================
  it('5. Backend failure does not trigger false success navigation', async () => {
    let cleanupCalled = false
    let navigateCalled = false
    let toastType = null

    const serverError = new Error('Internal Server Error 500')

    const result = await executeMeetingEndSequence({
      isHost: true,
      meetingId: 'mtg-uuid-test-5',
      endMeeting: async () => {
        throw serverError
      },
      cleanupResources: () => { cleanupCalled = true },
      navigate: () => { navigateCalled = true },
      showToast: (_msg, type) => { toastType = type }
    })

    assert.strictEqual(result.success, false)
    assert.strictEqual(cleanupCalled, false, 'Must not clean up on backend failure')
    assert.strictEqual(navigateCalled, false, 'Must not navigate on backend failure')
    assert.strictEqual(toastType, 'error')
  })

  // =========================================================================
  // REQUIREMENT 6: isShuttingDown resets after both success and failure
  // =========================================================================
  it('6. isShuttingDown resets to false after both success and failure', async () => {
    // 6a. Success path
    const statesSuccess = []
    await executeMeetingEndSequence({
      isHost: true,
      meetingId: 'mtg-uuid-test-6a',
      endMeeting: async () => {},
      setIsShuttingDown: (val) => statesSuccess.push(val)
    })

    assert.deepStrictEqual(
      statesSuccess,
      [true, false],
      'isShuttingDown must transition true -> false on success'
    )

    // 6b. Failure path
    const statesFailure = []
    await executeMeetingEndSequence({
      isHost: true,
      meetingId: 'mtg-uuid-test-6b',
      endMeeting: async () => {
        throw new Error('Network timeout')
      },
      setIsShuttingDown: (val) => statesFailure.push(val)
    })

    assert.deepStrictEqual(
      statesFailure,
      [true, false],
      'isShuttingDown must transition true -> false in finally block on failure'
    )
  })

  // =========================================================================
  // REQUIREMENT 7: Transcript upload counters remain correct after timeout or abort
  // =========================================================================
  it('7. Transcript upload counters remain strictly correct through start, finish, timeout, and abort', async () => {
    const queue = createTranscriptUploadQueue({ defaultMaxWaitMs: 1500, pollIntervalMs: 20 })

    assert.strictEqual(queue.getActiveCount(), 0, 'Initial active count is 0')

    // Start 3 uploads
    const u1 = queue.startUpload()
    const u2 = queue.startUpload()
    const u3 = queue.startUpload()
    assert.strictEqual(queue.getActiveCount(), 3, 'Active count should be 3')

    // Finish upload 1 normally
    queue.finishUpload(u1.id)
    assert.strictEqual(queue.getActiveCount(), 2, 'Active count should be 2 after finishing u1')

    // Abort upload 2 specifically
    queue.abortUpload(u2.id)
    assert.strictEqual(queue.getActiveCount(), 1, 'Active count should be 1 after aborting u2')
    assert.strictEqual(u2.signal.aborted, true, 'u2 AbortSignal must be aborted')

    // Idempotency: repeated finish calls must not underflow counter
    queue.finishUpload(u1.id)
    queue.finishUpload(u2.id)
    assert.strictEqual(queue.getActiveCount(), 1, 'Count should not underflow below actual active')

    // Abort all remaining
    queue.abortAll()
    assert.strictEqual(queue.getActiveCount(), 0, 'abortAll must reset count to 0')
    assert.strictEqual(u3.signal.aborted, true, 'u3 AbortSignal must be aborted')

    // Calling waitPending with count 0 resolves immediately
    const immediateWait = await queue.waitPending(500)
    assert.strictEqual(immediateWait.finished, true)
    assert.strictEqual(immediateWait.timedOut, false)
  })

  // =========================================================================
  // REQUIREMENT 8: Groq timeout (8s) is handled without an unhandled rejection, returning 504
  // =========================================================================
  describe('8. Groq Whisper / Translation timeout handling', () => {
    let originalFetch = null

    beforeEach(() => {
      originalFetch = globalThis.fetch
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    it('8a. submitTranscriptChunk returns 504 on Groq transcription timeout', async () => {
      // Mock global fetch to simulate AbortSignal.timeout
      globalThis.fetch = async () => {
        const timeoutErr = new Error('The operation was aborted due to timeout')
        timeoutErr.name = 'TimeoutError'
        throw timeoutErr
      }

      // Mock database for authorization check
      const originalFrom = supabase.from
      supabase.from = (table) => {
        if (table === 'meetings') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    meeting_id: '11111111-1111-4111-8111-111111111111',
                    meeting_code: 'TIMEOUT1',
                    host_id: 'user-host-1',
                    meeting_status: 'Active',
                    is_deleted: false
                  },
                  error: null
                })
              })
            })
          }
        }
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { participant_id: 'part-1', participant_status: 'joined' },
                  error: null
                })
              })
            })
          })
        }
      }

      const origApiKey = process.env.GROQ_API_KEY
      process.env.GROQ_API_KEY = 'mock-groq-key'

      let statusCode = 200
      let responseBody = null

      const req = {
        user: { id: 'user-host-1', name: 'Host User' },
        body: { meetingId: '11111111-1111-4111-8111-111111111111', speakerName: 'Host User' },
        file: {
          fieldname: 'file',
          mimetype: 'audio/webm',
          size: 1024,
          buffer: Buffer.from('mock-audio-bytes')
        }
      }

      const res = {
        status: (code) => {
          statusCode = code
          return res
        },
        json: (data) => {
          responseBody = data
          return res
        }
      }

      try {
        await submitTranscriptChunk(req, res)
        assert.strictEqual(statusCode, 504, 'Groq timeout must respond with HTTP 504 Gateway Timeout')
        assert.deepStrictEqual(responseBody, { message: 'Transcription request timed out.' })
      } finally {
        supabase.from = originalFrom
        if (origApiKey !== undefined) {
          process.env.GROQ_API_KEY = origApiKey
        } else {
          delete process.env.GROQ_API_KEY
        }
      }
    })

    it('8b. Code inspection confirms 8s AbortSignal timeout on Groq Whisper and Translation fetch calls', () => {
      const code = fs.readFileSync(meetingControllerPath, 'utf8')

      // Verify Groq Whisper timeout
      assert.ok(
        code.includes('signal: AbortSignal.timeout(8000)'),
        'meetingController must configure AbortSignal.timeout(8000) on Groq fetch requests'
      )

      // Verify Groq transcriptions 504 response
      assert.ok(
        code.includes("return res.status(504).json({ message: 'Transcription request timed out.' })"),
        'meetingController must return 504 on Groq transcription timeout'
      )

      // Verify Groq translations timeout fallback
      assert.ok(
        code.includes('Translation call timed out after 8s'),
        'meetingController must log and safely fall back when translation times out'
      )
    })
  })

  // =========================================================================
  // REQUIREMENT 9: Existing LiveKit meeting termination behavior remains unchanged
  // =========================================================================
  describe('9. Existing LiveKit meeting termination compatibility', () => {
    let mockMeetings = new Map()
    let mockParticipants = new Map()
    let cfServiceCalls = []
    let originalFrom = null

    beforeEach(() => {
      mockMeetings.clear()
      mockParticipants.clear()
      cfServiceCalls = []
      originalFrom = supabase.from
    })

    afterEach(() => {
      supabase.from = originalFrom
      resetCloudflareService()
    })

    it('9a. LiveKit meeting (no cloudflare_meeting_id) terminates cleanly without Cloudflare calls', async () => {
      const LIVEKIT_MTG_ID = '33333333-3333-4333-8333-333333333333'
      const HOST_USER_ID = 'host-user-livekit-1'

      mockMeetings.set(LIVEKIT_MTG_ID, {
        meeting_id: LIVEKIT_MTG_ID,
        meeting_code: 'LIVEKIT1',
        host_id: HOST_USER_ID,
        active_host_id: HOST_USER_ID,
        assigned_host_id: null,
        meeting_status: 'Active',
        room_name: 'meetly-livekit-room',
        cloudflare_meeting_id: null // Standard LiveKit meeting
      })

      // Setup Cloudflare mock service to ensure it is NOT called
      setCloudflareService({
        isConfigured: () => true,
        endMeeting: async (id) => {
          cfServiceCalls.push(id)
          return { success: true }
        }
      })

      // Supabase mock
      supabase.from = (table) => {
        if (table === 'meetings') {
          return {
            select: () => ({
              eq: (_col, val) => ({
                maybeSingle: async () => ({
                  data: mockMeetings.get(val) || null,
                  error: null
                })
              })
            }),
            update: (updates) => ({
              eq: (_col, val) => {
                const mtg = mockMeetings.get(val)
                if (mtg) Object.assign(mtg, updates)
                return { error: null }
              }
            })
          }
        }
        if (table === 'participants') {
          return {
            update: () => ({
              eq: () => ({
                in: () => ({ error: null })
              })
            })
          }
        }
        if (table === 'meeting_device_bans' || table === 'meeting_join_requests') {
          return {
            delete: () => ({
              eq: () => ({ error: null })
            })
          }
        }
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) })
        }
      }

      const emittedEvents = []
      const mockIo = {
        to: (_room) => ({
          emit: (event, ...args) => emittedEvents.push({ event, args })
        })
      }

      let statusCode = 200
      let responseBody = null

      const req = {
        user: { id: HOST_USER_ID },
        body: { meetingId: LIVEKIT_MTG_ID },
        app: {
          get: (key) => (key === 'io' ? mockIo : null)
        }
      }

      const res = {
        status: (code) => {
          statusCode = code
          return res
        },
        json: (data) => {
          responseBody = data
          return res
        }
      }

      await endMeeting(req, res)

      assert.strictEqual(statusCode, 200)
      assert.deepStrictEqual(responseBody, { message: 'Meeting ended successfully.' })
      assert.strictEqual(mockMeetings.get(LIVEKIT_MTG_ID).meeting_status, 'Ended')
      assert.strictEqual(
        cfServiceCalls.length,
        0,
        'Cloudflare deactivation must NOT be invoked for LiveKit meetings'
      )
      assert.ok(
        emittedEvents.some((e) => e.event === 'meeting_ended'),
        'meeting_ended must be emitted to Socket.IO room for LiveKit participants'
      )
    })

    it('9b. Cloudflare meeting (with cloudflare_meeting_id) deactivates Cloudflare session on end', async () => {
      const CF_MTG_ID = '44444444-4444-4444-8444-444444444444'
      const CF_SESSION_ID = 'cf-session-uuid-9999'
      const HOST_USER_ID = 'host-user-cf-1'

      mockMeetings.set(CF_MTG_ID, {
        meeting_id: CF_MTG_ID,
        meeting_code: 'CFMTG1',
        host_id: HOST_USER_ID,
        active_host_id: HOST_USER_ID,
        assigned_host_id: null,
        meeting_status: 'Active',
        room_name: 'meetly-cf-room',
        cloudflare_meeting_id: CF_SESSION_ID
      })

      setCloudflareService({
        isConfigured: () => true,
        endMeeting: async (id) => {
          cfServiceCalls.push(id)
          return { success: true }
        }
      })

      supabase.from = (table) => {
        if (table === 'meetings') {
          return {
            select: () => ({
              eq: (_col, val) => ({
                maybeSingle: async () => ({
                  data: mockMeetings.get(val) || null,
                  error: null
                })
              })
            }),
            update: (updates) => ({
              eq: (_col, val) => {
                const mtg = mockMeetings.get(val)
                if (mtg) Object.assign(mtg, updates)
                return { error: null }
              }
            })
          }
        }
        if (table === 'participants') {
          return {
            update: () => ({
              eq: () => ({
                in: () => ({ error: null })
              })
            })
          }
        }
        if (table === 'meeting_device_bans' || table === 'meeting_join_requests') {
          return {
            delete: () => ({
              eq: () => ({ error: null })
            })
          }
        }
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) })
        }
      }

      let statusCode = 200
      const req = {
        user: { id: HOST_USER_ID },
        body: { meetingId: CF_MTG_ID },
        app: { get: () => null }
      }
      const res = {
        status: (code) => {
          statusCode = code
          return res
        },
        json: () => res
      }

      await endMeeting(req, res)

      assert.strictEqual(statusCode, 200)
      assert.strictEqual(mockMeetings.get(CF_MTG_ID).meeting_status, 'Ended')
      assert.strictEqual(cfServiceCalls.length, 1)
      assert.strictEqual(cfServiceCalls[0], CF_SESSION_ID)
    })
  })
})
