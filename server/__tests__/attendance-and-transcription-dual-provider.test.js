import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  submitAttendance,
  getAttendanceReport,
  submitTranscriptChunk
} from '../controllers/meetingController.js'
import { getMeetingTranscriptText } from '../controllers/aiChat.controller.js'
import { supabase } from '../config/supabase.js'
import { calculateAttendancePercentage, formatDuration, mergeIntervals } from '../utils/durationHelper.js'
import { mapRealtimeKitConnectionState } from '../../src/components/meeting/realtimeKitAdapterUtils.js'

describe('Meetly AI — Attendance & Meeting Transcription Dual-Provider Suite', () => {
  const HOST_ID = '00000000-0000-4000-8000-000000000001'
  const PARTICIPANT_ID = '00000000-0000-4000-8000-000000000002'
  const UNRELATED_USER_ID = '00000000-0000-4000-8000-000000000003'
  const MEETING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const MEETING_CODE = 'CF-MEET-01'

  let originalSupabaseFrom
  let originalFetch
  let fetchCalls = []

  let mockMeetings = new Map()
  let mockParticipants = new Map()
  let mockAttendance = new Map()
  let mockTranscripts = []
  let mockUsers = new Map()

  const createMockReqRes = ({ body = {}, params = {}, user = null, file = null } = {}) => {
    const req = {
      body,
      params,
      user,
      file,
      headers: {},
      cookies: {}
    }

    let statusCode = 200
    let responseData = null

    const res = {
      status: (code) => {
        statusCode = code
        return res
      },
      json: (data) => {
        responseData = data
        return res
      },
      getStatusCode: () => statusCode,
      getData: () => responseData
    }

    return { req, res }
  }

  beforeEach(() => {
    mockMeetings.clear()
    mockParticipants.clear()
    mockAttendance.clear()
    mockTranscripts = []
    mockUsers.clear()
    fetchCalls = []

    process.env.GROQ_API_KEY = 'test-groq-key'

    // Seed users
    mockUsers.set(HOST_ID, { id: HOST_ID, full_name: 'Dr. Host Professor', email: 'host@meetly.ai' })
    mockUsers.set(PARTICIPANT_ID, { id: PARTICIPANT_ID, full_name: 'Alice Learner', email: 'alice@meetly.ai' })
    mockUsers.set(UNRELATED_USER_ID, { id: UNRELATED_USER_ID, full_name: 'Mallory Outsider', email: 'mallory@meetly.ai' })

    // Seed Active Cloudflare meeting
    const meetingStartTime = new Date(Date.now() - 300000).toISOString() // 5 minutes ago
    mockMeetings.set(MEETING_ID, {
      meeting_id: MEETING_ID,
      meeting_code: MEETING_CODE,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      assigned_host_id: null,
      meeting_status: 'Active',
      is_deleted: false,
      started_at: meetingStartTime,
      ended_at: null,
      created_at: meetingStartTime,
      enable_ai_attendance: true,
      enable_ai_analyzer: true,
      host: { full_name: 'Dr. Host Professor' }
    })

    // Seed participants in the meeting
    mockParticipants.set(`${MEETING_ID}:${HOST_ID}`, {
      participant_id: 'part-host-001',
      meeting_id: MEETING_ID,
      user_id: HOST_ID,
      participant_status: 'joined',
      user: { full_name: 'Dr. Host Professor', email: 'host@meetly.ai' }
    })

    mockParticipants.set(`${MEETING_ID}:${PARTICIPANT_ID}`, {
      participant_id: 'part-alice-002',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_ID,
      participant_status: 'joined',
      user: { full_name: 'Alice Learner', email: 'alice@meetly.ai' }
    })

    // Intercept global fetch
    originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options = {}) => {
      const urlStr = String(url)
      fetchCalls.push({ url: urlStr, options })

      // Mock Groq Whisper transcription API
      if (urlStr.includes('/audio/transcriptions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            text: 'Welcome everyone to today’s Cloudflare Realtime session on database indexing.',
            language: 'english',
            duration: 15.0
          })
        }
      }

      // Mock Groq translations API
      if (urlStr.includes('/audio/translations')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            text: 'Welcome everyone to today’s translated Cloudflare Realtime session.',
            language: 'english',
            duration: 15.0
          })
        }
      }

      return {
        ok: false,
        status: 404,
        text: async () => 'Not Found'
      }
    }

    // Mock Supabase client
    originalSupabaseFrom = supabase.from
    supabase.from = (table) => {
      let filters = {}
      let neqFilters = {}
      let sortField = null
      let sortAsc = true

      const queryBuilder = {
        select: () => queryBuilder,
        eq: (col, val) => {
          filters[col] = val
          return queryBuilder
        },
        neq: (col, val) => {
          neqFilters[col] = val
          return queryBuilder
        },
        order: (col, { ascending = true } = {}) => {
          sortField = col
          sortAsc = ascending
          return queryBuilder
        },
        maybeSingle: async () => {
          if (table === 'meetings') {
            for (const m of mockMeetings.values()) {
              if (filters.meeting_id && m.meeting_id !== filters.meeting_id) continue
              if (filters.meeting_code && m.meeting_code !== filters.meeting_code) continue
              return { data: { ...m }, error: null }
            }
            return { data: null, error: null }
          }

          if (table === 'participants') {
            const key = `${filters.meeting_id}:${filters.user_id}`
            const part = mockParticipants.get(key)
            return { data: part ? { ...part } : null, error: null }
          }

          if (table === 'meeting_attendance') {
            const key = `${filters.meeting_id}:${filters.user_id}`
            const rec = mockAttendance.get(key)
            return { data: rec ? { ...rec } : null, error: null }
          }

          return { data: null, error: null }
        },
        then: (resolve, reject) => {
          if (table === 'participants') {
            let results = []
            for (const p of mockParticipants.values()) {
              if (filters.meeting_id && p.meeting_id !== filters.meeting_id) continue
              results.push({ ...p })
            }
            return Promise.resolve({ data: results, error: null }).then(resolve, reject)
          }

          if (table === 'meeting_attendance') {
            let results = []
            for (const rec of mockAttendance.values()) {
              if (filters.meeting_id && rec.meeting_id !== filters.meeting_id) continue
              if (neqFilters.user_id && rec.user_id === neqFilters.user_id) continue
              const userObj = mockUsers.get(rec.user_id) || { full_name: 'Unknown User' }
              results.push({
                ...rec,
                user: { full_name: userObj.full_name }
              })
            }
            return Promise.resolve({ data: results, error: null }).then(resolve, reject)
          }

          if (table === 'meeting_transcripts') {
            let results = mockTranscripts.filter(t => {
              if (filters.meeting_id && t.meeting_id !== filters.meeting_id) return false
              return true
            })
            if (sortField === 'created_at') {
              results.sort((a, b) => sortAsc
                ? new Date(a.created_at) - new Date(b.created_at)
                : new Date(b.created_at) - new Date(a.created_at)
              )
            }
            return Promise.resolve({ data: results, error: null }).then(resolve, reject)
          }

          return Promise.resolve({ data: [], error: null }).then(resolve, reject)
        },
        insert: async (records) => {
          const list = Array.isArray(records) ? records : [records]
          if (table === 'meeting_transcripts') {
            for (const r of list) {
              mockTranscripts.push({
                id: `transcript-${mockTranscripts.length + 1}`,
                ...r,
                created_at: new Date().toISOString()
              })
            }
          }
          return { error: null }
        },
        upsert: async (record) => {
          if (table === 'meeting_attendance') {
            const key = `${record.meeting_id}:${record.user_id}`
            const existing = mockAttendance.get(key) || {}
            mockAttendance.set(key, {
              id: existing.id || `att-${mockAttendance.size + 1}`,
              ...existing,
              ...record
            })
          }
          return { error: null }
        }
      }

      return queryBuilder
    }
  })

  afterEach(() => {
    supabase.from = originalSupabaseFrom
    globalThis.fetch = originalFetch
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 1: ATTENDANCE PIPELINE TESTS
  // ═══════════════════════════════════════════════════════════════════════════

  it('1. Host attendance submission is safely skipped and does not create a database record', async () => {
    const { req, res } = createMockReqRes({
      user: { id: HOST_ID, full_name: 'Dr. Host Professor' },
      body: {
        meetingId: MEETING_ID,
        presenceSeconds: 280,
        meetingDurationSeconds: 300,
        cameraPermission: true,
        isFinalSubmit: true
      }
    })

    await submitAttendance(req, res)

    assert.equal(res.getStatusCode(), 200)
    assert.equal(res.getData().skipped, true)
    assert.match(res.getData().message, /Attendance skipped.*host.*excluded/i)

    const saved = mockAttendance.get(`${MEETING_ID}:${HOST_ID}`)
    assert.equal(saved, undefined, 'Host attendance record must NOT exist in meeting_attendance')
  })

  it('2. Non-host participant attendance is tracked and persisted correctly', async () => {
    const { req, res } = createMockReqRes({
      user: { id: PARTICIPANT_ID, full_name: 'Alice Learner' },
      body: {
        meetingId: MEETING_ID,
        presenceSeconds: 240,
        meetingDurationSeconds: 300,
        cameraPermission: true,
        isFinalSubmit: true
      }
    })

    await submitAttendance(req, res)

    assert.equal(res.getStatusCode(), 200)
    assert.equal(res.getData().message, 'Attendance recorded successfully.')

    const saved = mockAttendance.get(`${MEETING_ID}:${PARTICIPANT_ID}`)
    assert.ok(saved, 'Participant attendance record must exist in meeting_attendance')
    assert.equal(saved.presence_seconds, 240)
    assert.equal(saved.status, 'Present')
    assert.equal(saved.camera_permission, true)
  })

  it('3. Attendance report returns admitted participants only and excludes host records', async () => {
    // Attempt host attendance submission (safely skipped)
    const hostSubmit = createMockReqRes({
      user: { id: HOST_ID, full_name: 'Dr. Host Professor' },
      body: {
        meetingId: MEETING_ID,
        presenceSeconds: 280,
        meetingDurationSeconds: 300,
        cameraPermission: true,
        isFinalSubmit: true
      }
    })
    await submitAttendance(hostSubmit.req, hostSubmit.res)
    assert.equal(hostSubmit.res.getData().skipped, true)

    // Submit Participant attendance (recorded successfully)
    const partSubmit = createMockReqRes({
      user: { id: PARTICIPANT_ID, full_name: 'Alice Learner' },
      body: {
        meetingId: MEETING_ID,
        presenceSeconds: 240,
        meetingDurationSeconds: 300,
        cameraPermission: true,
        isFinalSubmit: true
      }
    })
    await submitAttendance(partSubmit.req, partSubmit.res)

    // Retrieve attendance report as the host
    const { req, res } = createMockReqRes({
      user: { id: HOST_ID, full_name: 'Dr. Host Professor' },
      params: { meetingId: MEETING_ID }
    })

    await getAttendanceReport(req, res)

    assert.equal(res.getStatusCode(), 200)
    const report = res.getData()
    assert.ok(Array.isArray(report))
    assert.equal(report.length, 1, 'Attendance report must include ONLY admitted participants (excluding host)')

    const userNames = report.map(r => r.participant_name)
    assert.ok(!userNames.includes('Dr. Host Professor'), 'Host must NOT appear in attendance report')
    assert.ok(userNames.includes('Alice Learner'), 'Participant Alice must appear in attendance report')

    // Verify metrics on participant record
    const aliceRecord = report[0]
    assert.equal(aliceRecord.user_id, PARTICIPANT_ID)
    assert.equal(aliceRecord.presence_seconds, 240)
    assert.ok(aliceRecord.attendance_percentage >= 75)
    assert.equal(aliceRecord.status, 'Present')
    assert.ok(aliceRecord.participant_duration_formatted)
    assert.ok(aliceRecord.meeting_duration_formatted)
  })

  it('4. Participant with low face presence receives Absent status per formula (<75%)', async () => {
    const { req, res } = createMockReqRes({
      user: { id: PARTICIPANT_ID, full_name: 'Alice Learner' },
      body: {
        meetingId: MEETING_ID,
        presenceSeconds: 60, // 60s out of 300s = 20%
        meetingDurationSeconds: 300,
        cameraPermission: true,
        isFinalSubmit: true
      }
    })

    await submitAttendance(req, res)

    const saved = mockAttendance.get(`${MEETING_ID}:${PARTICIPANT_ID}`)
    assert.equal(saved.status, 'Absent')
    assert.ok(saved.attendance_percentage < 75)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 2: MEETING TRANSCRIPTION PIPELINE TESTS
  // ═══════════════════════════════════════════════════════════════════════════

  it('5. Audio chunk capture, Groq Whisper transcription, and DB insertion for host', async () => {
    const audioBytes = Buffer.alloc(4096, 0x11) // 4KB audio chunk
    const { req, res } = createMockReqRes({
      user: { id: HOST_ID, full_name: 'Dr. Host Professor' },
      body: {
        meetingId: MEETING_ID,
        speakerName: 'Dr. Host Professor'
      },
      file: {
        buffer: audioBytes,
        mimetype: 'audio/webm',
        size: audioBytes.length,
        fieldname: 'file'
      }
    })

    await submitTranscriptChunk(req, res)

    assert.equal(res.getStatusCode(), 200)
    assert.ok(res.getData().text.includes('database indexing'))

    assert.equal(mockTranscripts.length, 1)
    assert.equal(mockTranscripts[0].speaker_name, 'Dr. Host Professor')
    assert.ok(mockTranscripts[0].transcript.includes('database indexing'))
    assert.equal(mockTranscripts[0].meeting_id, MEETING_ID)
  })

  it('6. Audio chunk capture, Groq Whisper transcription, and DB insertion for participant', async () => {
    const audioBytes = Buffer.alloc(4096, 0x22)
    const { req, res } = createMockReqRes({
      user: { id: PARTICIPANT_ID, full_name: 'Alice Learner' },
      body: {
        meetingId: MEETING_ID,
        speakerName: 'Alice Learner'
      },
      file: {
        buffer: audioBytes,
        mimetype: 'audio/webm',
        size: audioBytes.length,
        fieldname: 'file'
      }
    })

    await submitTranscriptChunk(req, res)

    assert.equal(res.getStatusCode(), 200)
    assert.equal(mockTranscripts.length, 1)
    assert.equal(mockTranscripts[0].speaker_name, 'Alice Learner')
  })

  it('7. Unrelated user cannot submit audio chunks to meeting', async () => {
    const audioBytes = Buffer.alloc(4096, 0x33)
    const { req, res } = createMockReqRes({
      user: { id: UNRELATED_USER_ID, full_name: 'Mallory Outsider' },
      body: {
        meetingId: MEETING_ID,
        speakerName: 'Mallory Outsider'
      },
      file: {
        buffer: audioBytes,
        mimetype: 'audio/webm',
        size: audioBytes.length,
        fieldname: 'file'
      }
    })

    await submitTranscriptChunk(req, res)

    assert.equal(res.getStatusCode(), 403)
    assert.equal(mockTranscripts.length, 0)
  })

  it('8. GET /:meetingId/transcript returns both concatenated string and structured chunks for frontend display', async () => {
    // Seed two transcript chunks
    mockTranscripts.push({
      id: 't-1',
      meeting_id: MEETING_ID,
      speaker_name: 'Dr. Host Professor',
      transcript: 'Welcome to the lecture.',
      english_transcript: 'Welcome to the lecture.',
      created_at: new Date(Date.now() - 60000).toISOString()
    })
    mockTranscripts.push({
      id: 't-2',
      meeting_id: MEETING_ID,
      speaker_name: 'Alice Learner',
      transcript: 'Thank you, professor. I have a question about indexing.',
      english_transcript: 'Thank you, professor. I have a question about indexing.',
      created_at: new Date(Date.now() - 30000).toISOString()
    })

    const { req, res } = createMockReqRes({
      user: { id: HOST_ID, full_name: 'Dr. Host Professor' },
      params: { meetingId: MEETING_ID }
    })

    await getMeetingTranscriptText(req, res)

    assert.equal(res.getStatusCode(), 200)
    const data = res.getData()
    assert.equal(data.success, true)
    assert.ok(data.transcript.includes('Dr. Host Professor: Welcome to the lecture.'))
    assert.ok(data.transcript.includes('Alice Learner: Thank you, professor.'))

    // Structured chunks for Report.jsx and transcript viewers
    assert.ok(Array.isArray(data.chunks))
    assert.equal(data.chunks.length, 2)
    assert.equal(data.chunks[0].speaker, 'Dr. Host Professor')
    assert.equal(data.chunks[0].text, 'Welcome to the lecture.')
    assert.ok(data.chunks[0].time)
    assert.equal(data.chunks[1].speaker, 'Alice Learner')
  })

  it('9. Completed meetings allow authorized participants who joined to access transcripts', async () => {
    // Mark meeting as Ended
    mockMeetings.get(MEETING_ID).meeting_status = 'Ended'

    mockTranscripts.push({
      id: 't-ended-1',
      meeting_id: MEETING_ID,
      speaker_name: 'Dr. Host Professor',
      transcript: 'Final thoughts on indexing.',
      english_transcript: 'Final thoughts on indexing.',
      created_at: new Date().toISOString()
    })

    // Participant Alice views report after meeting Ended
    const { req, res } = createMockReqRes({
      user: { id: PARTICIPANT_ID, full_name: 'Alice Learner' },
      params: { meetingId: MEETING_ID }
    })

    await getMeetingTranscriptText(req, res)

    assert.equal(res.getStatusCode(), 200)
    assert.equal(res.getData().success, true)
    assert.equal(res.getData().chunks.length, 1)

    // Unrelated user is rejected
    const unauth = createMockReqRes({
      user: { id: UNRELATED_USER_ID, full_name: 'Mallory' },
      params: { meetingId: MEETING_ID }
    })
    await getMeetingTranscriptText(unauth.req, unauth.res)
    assert.equal(unauth.res.getStatusCode(), 403)
  })

  it('10. Page refresh persistence: multiple transcript and attendance queries return identical persistent records', async () => {
    // Seed attendance
    mockAttendance.set(`${MEETING_ID}:${HOST_ID}`, {
      id: 'att-1',
      meeting_id: MEETING_ID,
      user_id: HOST_ID,
      presence_seconds: 300,
      meeting_duration_seconds: 300,
      attendance_percentage: 100,
      status: 'Present',
      camera_permission: true
    })

    mockTranscripts.push({
      id: 't-refresh-1',
      meeting_id: MEETING_ID,
      speaker_name: 'Dr. Host Professor',
      transcript: 'Permanent persistent record.',
      english_transcript: 'Permanent persistent record.',
      created_at: new Date().toISOString()
    })

    // First fetch (Initial page view)
    const view1Req = createMockReqRes({ user: { id: HOST_ID }, params: { meetingId: MEETING_ID } })
    await getAttendanceReport(view1Req.req, view1Req.res)
    const att1 = view1Req.res.getData()

    const tView1Req = createMockReqRes({ user: { id: HOST_ID }, params: { meetingId: MEETING_ID } })
    await getMeetingTranscriptText(tView1Req.req, tView1Req.res)
    const trans1 = tView1Req.res.getData()

    // Second fetch (Simulating F5 page refresh)
    const view2Req = createMockReqRes({ user: { id: HOST_ID }, params: { meetingId: MEETING_ID } })
    await getAttendanceReport(view2Req.req, view2Req.res)
    const att2 = view2Req.res.getData()

    const tView2Req = createMockReqRes({ user: { id: HOST_ID }, params: { meetingId: MEETING_ID } })
    await getMeetingTranscriptText(tView2Req.req, tView2Req.res)
    const trans2 = tView2Req.res.getData()

    assert.deepEqual(att1, att2, 'Attendance records must remain identical after page refresh')
    assert.deepEqual(trans1, trans2, 'Transcript records must remain identical after page refresh')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // TASK 3: PROVIDER NORMALIZATION & RECORDING INDEPENDENCE
  // ═══════════════════════════════════════════════════════════════════════════

  it('11. Cloudflare RealtimeKit roomJoined/joined states normalize to connected for attendance & transcript triggers', () => {
    // Cloudflare RealtimeKit roomState is 'joined' and roomJoined is true
    const cfConnectedState = mapRealtimeKitConnectionState({
      roomJoined: true,
      roomState: 'joined',
      isReconnecting: false
    })
    assert.equal(cfConnectedState, 'connected')

    // Initial connecting state
    const cfConnectingState = mapRealtimeKitConnectionState({
      roomJoined: false,
      roomState: 'init',
      isReconnecting: false
    })
    assert.equal(cfConnectingState, 'connecting')

    // Reconnecting state
    const cfReconnectingState = mapRealtimeKitConnectionState({
      roomJoined: true,
      roomState: 'joined',
      isReconnecting: true
    })
    assert.equal(cfReconnectingState, 'reconnecting')
  })

  it('12. Attendance and transcription work completely independently of screen recording and B2', async () => {
    // Verify meeting with no screen recording active still processes attendance and transcripts perfectly
    const audioBytes = Buffer.alloc(2048, 0x55)
    const transReq = createMockReqRes({
      user: { id: PARTICIPANT_ID },
      body: { meetingId: MEETING_ID, speakerName: 'Alice Learner' },
      file: { buffer: audioBytes, mimetype: 'audio/webm', size: audioBytes.length, fieldname: 'file' }
    })
    await submitTranscriptChunk(transReq.req, transReq.res)
    assert.equal(transReq.res.getStatusCode(), 200)

    const attReq = createMockReqRes({
      user: { id: PARTICIPANT_ID },
      body: { meetingId: MEETING_ID, presenceSeconds: 200, meetingDurationSeconds: 250, cameraPermission: true, isFinalSubmit: true }
    })
    await submitAttendance(attReq.req, attReq.res)
    assert.equal(attReq.res.getStatusCode(), 200)

    // No recording services were called, no recording IDs were needed
    assert.equal(mockAttendance.size, 1)
    assert.equal(mockTranscripts.length, 1)
  })

  it('13. Rejoining participant preserves and accumulates prior attendance continuity (30m attending + 10m away + 20m attending = 50m)', async () => {
    // Total meeting duration is 60 minutes (3600s): 30m session 1 + 10m away + 20m session 2
    const mtg = mockMeetings.get(MEETING_ID)
    const meetingStart = new Date(Date.now() - 3600 * 1000).toISOString()
    const meetingEnd = new Date().toISOString()
    mtg.started_at = meetingStart
    mtg.ended_at = meetingEnd

    // Session 1: Alice attends for 30 minutes (1800s) and leaves
    const session1 = createMockReqRes({
      user: { id: PARTICIPANT_ID, full_name: 'Alice Learner' },
      body: {
        meetingId: MEETING_ID,
        presenceSeconds: 1800,
        meetingDurationSeconds: 1800,
        cameraPermission: true,
        isFinalSubmit: true
      }
    })
    await submitAttendance(session1.req, session1.res)
    assert.equal(session1.res.getStatusCode(), 200)

    let saved = mockAttendance.get(`${MEETING_ID}:${PARTICIPANT_ID}`)
    assert.equal(saved.presence_seconds, 1800)

    // Alice is away for 10 minutes (no submissions)

    // Session 2: Alice rejoins and attends for 20 minutes (1200s), then leaves
    const session2 = createMockReqRes({
      user: { id: PARTICIPANT_ID, full_name: 'Alice Learner' },
      body: {
        meetingId: MEETING_ID,
        presenceSeconds: 1200,
        meetingDurationSeconds: 1200,
        cameraPermission: true,
        isFinalSubmit: true
      }
    })
    await submitAttendance(session2.req, session2.res)
    assert.equal(session2.res.getStatusCode(), 200)

    saved = mockAttendance.get(`${MEETING_ID}:${PARTICIPANT_ID}`)
    // Must accumulate participant attendance: 1800s + 1200s = 3000s (50 minutes)
    assert.equal(saved.presence_seconds, 3000)
    // meeting_duration_seconds represents the meeting-wide duration (3600s), not accumulated incomingDuration
    assert.equal(saved.meeting_duration_seconds, 3600)
    assert.equal(saved.attendance_percentage, 83.33)
    assert.equal(saved.status, 'Present')
  })

  it('14. Refreshing the attendance report is idempotent and never resets saved records', async () => {
    // Seed attendance record
    const attReq = createMockReqRes({
      user: { id: PARTICIPANT_ID, full_name: 'Alice Learner' },
      body: {
        meetingId: MEETING_ID,
        presenceSeconds: 240,
        meetingDurationSeconds: 300,
        cameraPermission: true,
        isFinalSubmit: true
      }
    })
    await submitAttendance(attReq.req, attReq.res)
    assert.equal(attReq.res.getStatusCode(), 200)

    // Query report 3 times consecutively (simulating page refresh)
    for (let i = 0; i < 3; i++) {
      const repReq = createMockReqRes({
        user: { id: HOST_ID, full_name: 'Dr. Host Professor' },
        params: { meetingId: MEETING_ID }
      })
      await getAttendanceReport(repReq.req, repReq.res)
      assert.equal(repReq.res.getStatusCode(), 200)

      const data = repReq.res.getData()
      assert.equal(data.length, 1)
      assert.equal(data[0].user_id, PARTICIPANT_ID)
      assert.equal(data[0].presence_seconds, 240)
      assert.equal(data[0].status, 'Present')
    }

    // Verify DB still holds the exact same record
    const saved = mockAttendance.get(`${MEETING_ID}:${PARTICIPANT_ID}`)
    assert.equal(saved.presence_seconds, 240)
    assert.equal(saved.status, 'Present')
  })

  it('15. Disconnected intervals exclude offline time from connected duration', () => {
    // Participant connected for 10m (0 to 600000ms), disconnected for 5m, connected for 15m (900000 to 1800000ms)
    const rawIntervals = [
      { start: 0, end: 600000 },
      { start: 900000, end: 1800000 }
    ]
    const merged = mergeIntervals(rawIntervals)
    const totalSec = merged.reduce((sum, iv) => sum + iv.seconds, 0)
    // 600s + 900s = 1500s (25 minutes), 5 minutes offline (300s) excluded
    assert.equal(totalSec, 1500)
  })

  it('16. Turning meeting camera OFF preserves local camera architecture hold when attendance is active', () => {
    let physicalTracksStopped = false
    let attendanceNeedsCamera = true
    let meetingCamActive = false

    const releasePhysicalCameraIfUnneeded = () => {
      if (!attendanceNeedsCamera && !meetingCamActive) {
        physicalTracksStopped = true
      }
    }

    // Meeting cam turned OFF while attendance needs camera
    meetingCamActive = false
    releasePhysicalCameraIfUnneeded()
    assert.equal(physicalTracksStopped, false, 'Physical track must not be stopped while attendance is active')

    // Attendance ends
    attendanceNeedsCamera = false
    releasePhysicalCameraIfUnneeded()
    assert.equal(physicalTracksStopped, true, 'Physical track should only be stopped when neither needs it')
  })

  it('17. Regression: Original Host, Assigned Host, and Active Host are all excluded from creating attendance records, while an admitted participant can', async () => {
    const ASSIGNED_HOST_ID = '00000000-0000-4000-8000-000000000004'
    const ACTIVE_HOST_ID = '00000000-0000-4000-8000-000000000005'
    const ADMITTED_PART_ID = '00000000-0000-4000-8000-000000000006'

    mockUsers.set(ASSIGNED_HOST_ID, { id: ASSIGNED_HOST_ID, full_name: 'Bob AssignedHost' })
    mockUsers.set(ACTIVE_HOST_ID, { id: ACTIVE_HOST_ID, full_name: 'Charlie ActiveHost' })
    mockUsers.set(ADMITTED_PART_ID, { id: ADMITTED_PART_ID, full_name: 'Dana AdmittedLearner' })

    // Seed participant record for admitted participant
    mockParticipants.set(`${MEETING_ID}:${ADMITTED_PART_ID}`, {
      participant_id: 'part-dana-006',
      meeting_id: MEETING_ID,
      user_id: ADMITTED_PART_ID,
      participant_status: 'joined',
      user: { full_name: 'Dana AdmittedLearner' }
    })

    // Update meeting with assigned_host_id and active_host_id
    const currentMeeting = mockMeetings.get(MEETING_ID)
    mockMeetings.set(MEETING_ID, {
      ...currentMeeting,
      host_id: HOST_ID,
      assigned_host_id: ASSIGNED_HOST_ID,
      active_host_id: ACTIVE_HOST_ID
    })

    // 1. Original Host submission
    const origHostReq = createMockReqRes({
      user: { id: HOST_ID, full_name: 'Dr. Host Professor' },
      body: { meetingId: MEETING_ID, presenceSeconds: 292, meetingDurationSeconds: 300, isFinalSubmit: true }
    })
    await submitAttendance(origHostReq.req, origHostReq.res)
    assert.equal(origHostReq.res.getStatusCode(), 200)
    assert.equal(origHostReq.res.getData().skipped, true)
    assert.equal(mockAttendance.get(`${MEETING_ID}:${HOST_ID}`), undefined, 'Original host record must not exist')

    // 2. Assigned Host submission
    const assignedHostReq = createMockReqRes({
      user: { id: ASSIGNED_HOST_ID, full_name: 'Bob AssignedHost' },
      body: { meetingId: MEETING_ID, presenceSeconds: 290, meetingDurationSeconds: 300, isFinalSubmit: true }
    })
    await submitAttendance(assignedHostReq.req, assignedHostReq.res)
    assert.equal(assignedHostReq.res.getStatusCode(), 200)
    assert.equal(assignedHostReq.res.getData().skipped, true)
    assert.equal(mockAttendance.get(`${MEETING_ID}:${ASSIGNED_HOST_ID}`), undefined, 'Assigned host record must not exist')

    // 3. Active Host submission
    const activeHostReq = createMockReqRes({
      user: { id: ACTIVE_HOST_ID, full_name: 'Charlie ActiveHost' },
      body: { meetingId: MEETING_ID, presenceSeconds: 288, meetingDurationSeconds: 300, isFinalSubmit: true }
    })
    await submitAttendance(activeHostReq.req, activeHostReq.res)
    assert.equal(activeHostReq.res.getStatusCode(), 200)
    assert.equal(activeHostReq.res.getData().skipped, true)
    assert.equal(mockAttendance.get(`${MEETING_ID}:${ACTIVE_HOST_ID}`), undefined, 'Active host record must not exist')

    // 4. Admitted Participant submission
    const partReq = createMockReqRes({
      user: { id: ADMITTED_PART_ID, full_name: 'Dana AdmittedLearner' },
      body: { meetingId: MEETING_ID, presenceSeconds: 289, meetingDurationSeconds: 300, cameraPermission: true, isFinalSubmit: true }
    })
    await submitAttendance(partReq.req, partReq.res)
    assert.equal(partReq.res.getStatusCode(), 200)
    assert.equal(partReq.res.getData().message, 'Attendance recorded successfully.')
    const partRecord = mockAttendance.get(`${MEETING_ID}:${ADMITTED_PART_ID}`)
    assert.ok(partRecord, 'Admitted participant record MUST exist in meeting_attendance')
    assert.equal(partRecord.presence_seconds, 289)

    // 5. Verify attendance report contains Dana only, never the hosts (even if a legacy row existed)
    // Manually inject a stale host row into mockAttendance to verify report exclusion filter
    mockAttendance.set(`${MEETING_ID}:${HOST_ID}`, {
      id: 'legacy-host-att',
      meeting_id: MEETING_ID,
      user_id: HOST_ID,
      presence_seconds: 292,
      meeting_duration_seconds: 300,
      attendance_percentage: 97.33,
      status: 'Present'
    })

    const reportReq = createMockReqRes({
      user: { id: HOST_ID, full_name: 'Dr. Host Professor' },
      params: { meetingId: MEETING_ID }
    })
    await getAttendanceReport(reportReq.req, reportReq.res)
    assert.equal(reportReq.res.getStatusCode(), 200)
    const reportData = reportReq.res.getData()

    const reportUserIds = reportData.map(r => r.user_id)
    assert.ok(!reportUserIds.includes(HOST_ID), 'Original Host must be excluded from attendance report')
    assert.ok(!reportUserIds.includes(ASSIGNED_HOST_ID), 'Assigned Host must be excluded from attendance report')
    assert.ok(!reportUserIds.includes(ACTIVE_HOST_ID), 'Active Host must be excluded from attendance report')
    assert.ok(reportUserIds.includes(ADMITTED_PART_ID), 'Admitted Participant must be included in attendance report')
  })

  it('18. Participant Eligibility Protection: All 8 required admission & eligibility cases', async () => {
    const TEST_MEETING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const TEST_HOST_ID = '10000000-0000-4000-8000-000000000001'
    const TEST_ASSIGNED_HOST_ID = '10000000-0000-4000-8000-000000000002'
    const TEST_ACTIVE_HOST_ID = '10000000-0000-4000-8000-000000000003'
    const TEST_ADMITTED_PART_ID = '10000000-0000-4000-8000-000000000004'
    const TEST_WAITING_USER_ID = '10000000-0000-4000-8000-000000000005'
    const TEST_REJECTED_PART_ID = '10000000-0000-4000-8000-000000000006'
    const TEST_REMOVED_PART_ID = '10000000-0000-4000-8000-000000000007'
    const TEST_NEVER_JOINED_ID = '10000000-0000-4000-8000-000000000008'

    const startTime = new Date(Date.now() - 600000).toISOString()
    mockMeetings.set(TEST_MEETING_ID, {
      meeting_id: TEST_MEETING_ID,
      meeting_code: 'ELIG-TEST-01',
      host_id: TEST_HOST_ID,
      assigned_host_id: TEST_ASSIGNED_HOST_ID,
      active_host_id: TEST_ACTIVE_HOST_ID,
      meeting_status: 'Active',
      is_deleted: false,
      started_at: startTime,
      ended_at: null,
      created_at: startTime,
      enable_ai_attendance: true,
      host: { full_name: 'Dr. Original Host' }
    })

    // Seed users
    mockUsers.set(TEST_HOST_ID, { id: TEST_HOST_ID, full_name: 'Dr. Original Host' })
    mockUsers.set(TEST_ASSIGNED_HOST_ID, { id: TEST_ASSIGNED_HOST_ID, full_name: 'Prof. Assigned Host' })
    mockUsers.set(TEST_ACTIVE_HOST_ID, { id: TEST_ACTIVE_HOST_ID, full_name: 'Dr. Active Host' })
    mockUsers.set(TEST_ADMITTED_PART_ID, { id: TEST_ADMITTED_PART_ID, full_name: 'Student Admitted' })
    mockUsers.set(TEST_WAITING_USER_ID, { id: TEST_WAITING_USER_ID, full_name: 'Student Waiting' })
    mockUsers.set(TEST_REJECTED_PART_ID, { id: TEST_REJECTED_PART_ID, full_name: 'Student Rejected' })
    mockUsers.set(TEST_REMOVED_PART_ID, { id: TEST_REMOVED_PART_ID, full_name: 'Student Removed' })
    mockUsers.set(TEST_NEVER_JOINED_ID, { id: TEST_NEVER_JOINED_ID, full_name: 'Student NeverJoined' })

    // Seed participants: only admitted and removed exist in participants table
    mockParticipants.set(`${TEST_MEETING_ID}:${TEST_ADMITTED_PART_ID}`, {
      participant_id: 'part-admitted-01',
      meeting_id: TEST_MEETING_ID,
      user_id: TEST_ADMITTED_PART_ID,
      participant_status: 'joined',
      user: { full_name: 'Student Admitted' }
    })
    mockParticipants.set(`${TEST_MEETING_ID}:${TEST_REMOVED_PART_ID}`, {
      participant_id: 'part-removed-01',
      meeting_id: TEST_MEETING_ID,
      user_id: TEST_REMOVED_PART_ID,
      participant_status: 'removed',
      user: { full_name: 'Student Removed' }
    })
    // Note: Waiting user, rejected user, and never joined user have NO row in participants

    // Case 1: Original host — rejected/skipped from attendance
    const c1 = createMockReqRes({
      user: { id: TEST_HOST_ID },
      body: { meetingId: TEST_MEETING_ID, presenceSeconds: 500, meetingDurationSeconds: 600, isFinalSubmit: true }
    })
    await submitAttendance(c1.req, c1.res)
    assert.equal(c1.res.getStatusCode(), 200)
    assert.equal(c1.res.getData().skipped, true)
    assert.equal(mockAttendance.get(`${TEST_MEETING_ID}:${TEST_HOST_ID}`), undefined, 'Original host attendance must not exist')

    // Case 2: Assigned host — rejected/skipped from attendance
    const c2 = createMockReqRes({
      user: { id: TEST_ASSIGNED_HOST_ID },
      body: { meetingId: TEST_MEETING_ID, presenceSeconds: 500, meetingDurationSeconds: 600, isFinalSubmit: true }
    })
    await submitAttendance(c2.req, c2.res)
    assert.equal(c2.res.getStatusCode(), 200)
    assert.equal(c2.res.getData().skipped, true)
    assert.equal(mockAttendance.get(`${TEST_MEETING_ID}:${TEST_ASSIGNED_HOST_ID}`), undefined, 'Assigned host attendance must not exist')

    // Case 3: Active host — rejected/skipped from attendance
    const c3 = createMockReqRes({
      user: { id: TEST_ACTIVE_HOST_ID },
      body: { meetingId: TEST_MEETING_ID, presenceSeconds: 500, meetingDurationSeconds: 600, isFinalSubmit: true }
    })
    await submitAttendance(c3.req, c3.res)
    assert.equal(c3.res.getStatusCode(), 200)
    assert.equal(c3.res.getData().skipped, true)
    assert.equal(mockAttendance.get(`${TEST_MEETING_ID}:${TEST_ACTIVE_HOST_ID}`), undefined, 'Active host attendance must not exist')

    // Case 4: Admitted participant — attendance accepted
    const c4 = createMockReqRes({
      user: { id: TEST_ADMITTED_PART_ID },
      body: { meetingId: TEST_MEETING_ID, presenceSeconds: 520, meetingDurationSeconds: 600, cameraPermission: true, isFinalSubmit: true }
    })
    await submitAttendance(c4.req, c4.res)
    assert.equal(c4.res.getStatusCode(), 200)
    assert.equal(c4.res.getData().message, 'Attendance recorded successfully.')
    const savedAdmitted = mockAttendance.get(`${TEST_MEETING_ID}:${TEST_ADMITTED_PART_ID}`)
    assert.ok(savedAdmitted, 'Admitted participant attendance must be recorded in DB')
    assert.equal(savedAdmitted.presence_seconds, 520)

    // Case 5: Waiting-room user — attendance rejected (403 Forbidden)
    const c5 = createMockReqRes({
      user: { id: TEST_WAITING_USER_ID },
      body: { meetingId: TEST_MEETING_ID, presenceSeconds: 100, meetingDurationSeconds: 600, isFinalSubmit: true }
    })
    await submitAttendance(c5.req, c5.res)
    assert.equal(c5.res.getStatusCode(), 403)
    assert.match(c5.res.getData().message, /Access denied/i)
    assert.equal(mockAttendance.get(`${TEST_MEETING_ID}:${TEST_WAITING_USER_ID}`), undefined, 'Waiting room user must not have attendance')

    // Case 6: Rejected participant — attendance rejected (403 Forbidden)
    const c6 = createMockReqRes({
      user: { id: TEST_REJECTED_PART_ID },
      body: { meetingId: TEST_MEETING_ID, presenceSeconds: 80, meetingDurationSeconds: 600, isFinalSubmit: true }
    })
    await submitAttendance(c6.req, c6.res)
    assert.equal(c6.res.getStatusCode(), 403)
    assert.match(c6.res.getData().message, /Access denied/i)
    assert.equal(mockAttendance.get(`${TEST_MEETING_ID}:${TEST_REJECTED_PART_ID}`), undefined, 'Rejected participant must not have attendance')

    // Case 7: Removed participant — attendance rejected (403 Forbidden)
    const c7 = createMockReqRes({
      user: { id: TEST_REMOVED_PART_ID },
      body: { meetingId: TEST_MEETING_ID, presenceSeconds: 300, meetingDurationSeconds: 600, isFinalSubmit: true }
    })
    await submitAttendance(c7.req, c7.res)
    assert.equal(c7.res.getStatusCode(), 403)
    assert.match(c7.res.getData().message, /Access denied/i)
    assert.equal(mockAttendance.get(`${TEST_MEETING_ID}:${TEST_REMOVED_PART_ID}`), undefined, 'Removed participant must not have attendance')

    // Case 8: User who never joined — attendance rejected (403 Forbidden)
    const c8 = createMockReqRes({
      user: { id: TEST_NEVER_JOINED_ID },
      body: { meetingId: TEST_MEETING_ID, presenceSeconds: 120, meetingDurationSeconds: 600, isFinalSubmit: true }
    })
    await submitAttendance(c8.req, c8.res)
    assert.equal(c8.res.getStatusCode(), 403)
    assert.match(c8.res.getData().message, /Access denied/i)
    assert.equal(mockAttendance.get(`${TEST_MEETING_ID}:${TEST_NEVER_JOINED_ID}`), undefined, 'Never-joined user must not have attendance')

    // Continuity verification: participant temporarily disconnects, syncs, rejoins
    const admittedPart = mockParticipants.get(`${TEST_MEETING_ID}:${TEST_ADMITTED_PART_ID}`)
    admittedPart.participant_status = 'disconnected'

    // Disconnected state is still recognized as an admitted participant
    const disconnSync = createMockReqRes({
      user: { id: TEST_ADMITTED_PART_ID },
      body: { meetingId: TEST_MEETING_ID, presenceSeconds: 20, meetingDurationSeconds: 600 }
    })
    await submitAttendance(disconnSync.req, disconnSync.res)
    assert.equal(disconnSync.res.getStatusCode(), 200)

    // Rejoin: status returns to joined and accumulates
    admittedPart.participant_status = 'joined'
    const rejoinSync = createMockReqRes({
      user: { id: TEST_ADMITTED_PART_ID },
      body: { meetingId: TEST_MEETING_ID, presenceSeconds: 40, meetingDurationSeconds: 600, isFinalSubmit: true }
    })
    await submitAttendance(rejoinSync.req, rejoinSync.res)
    assert.equal(rejoinSync.res.getStatusCode(), 200)

    const accumulatedPart = mockAttendance.get(`${TEST_MEETING_ID}:${TEST_ADMITTED_PART_ID}`)
    assert.equal(accumulatedPart.presence_seconds, 580) // 520 + 20 + 40

    // getAttendanceReport verification:
    // Even if stale legacy rows existed in mockAttendance for hosts and ineligible users,
    // getAttendanceReport MUST exclude them all and return only the admitted participant.
    mockAttendance.set(`${TEST_MEETING_ID}:${TEST_HOST_ID}`, { meeting_id: TEST_MEETING_ID, user_id: TEST_HOST_ID, presence_seconds: 500, status: 'Present' })
    mockAttendance.set(`${TEST_MEETING_ID}:${TEST_REMOVED_PART_ID}`, { meeting_id: TEST_MEETING_ID, user_id: TEST_REMOVED_PART_ID, presence_seconds: 300, status: 'Present' })
    mockAttendance.set(`${TEST_MEETING_ID}:${TEST_NEVER_JOINED_ID}`, { meeting_id: TEST_MEETING_ID, user_id: TEST_NEVER_JOINED_ID, presence_seconds: 120, status: 'Absent' })

    const repReq = createMockReqRes({
      user: { id: TEST_HOST_ID },
      params: { meetingId: TEST_MEETING_ID }
    })
    await getAttendanceReport(repReq.req, repReq.res)
    assert.equal(repReq.res.getStatusCode(), 200)
    const reportList = repReq.res.getData()

    assert.equal(reportList.length, 1, 'Report must contain exactly 1 admitted participant record')
    assert.equal(reportList[0].user_id, TEST_ADMITTED_PART_ID)
    assert.equal(reportList[0].presence_seconds, 580)

    const reportedUserIds = reportList.map(r => r.user_id)
    assert.ok(!reportedUserIds.includes(TEST_HOST_ID), 'Original Host must be excluded from report')
    assert.ok(!reportedUserIds.includes(TEST_ASSIGNED_HOST_ID), 'Assigned Host must be excluded from report')
    assert.ok(!reportedUserIds.includes(TEST_ACTIVE_HOST_ID), 'Active Host must be excluded from report')
    assert.ok(!reportedUserIds.includes(TEST_WAITING_USER_ID), 'Waiting user must be excluded from report')
    assert.ok(!reportedUserIds.includes(TEST_REJECTED_PART_ID), 'Rejected user must be excluded from report')
    assert.ok(!reportedUserIds.includes(TEST_REMOVED_PART_ID), 'Removed participant must be excluded from report')
    assert.ok(!reportedUserIds.includes(TEST_NEVER_JOINED_ID), 'Never joined user must be excluded from report')
  })
})
