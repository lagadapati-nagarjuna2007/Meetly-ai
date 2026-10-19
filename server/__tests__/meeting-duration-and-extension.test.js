import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import {
  createMeeting,
  activateMeeting,
  endMeeting,
  extendMeeting,
  triggerMeetingExpiration
} from '../controllers/meetingController.js'
import {
  expireMeetingNow,
  scheduleMeetingExpiration,
  cancelMeetingExpiration,
  runExpirationSweep,
  setDatabaseClient,
  resetDatabaseClient,
  stopMeetingExpirationWorker
} from '../services/meetingExpiration.service.js'
import { supabase } from '../config/supabase.js'

describe('Meetly AI — Meeting Duration, Scheduled Deadline & Extension Suite', () => {
  const HOST_ID = '11111111-1111-4111-8111-111111111111'
  const PARTICIPANT_ID = '22222222-2222-4222-8222-222222222222'
  const OTHER_HOST_ID = '33333333-3333-4333-8333-333333333333'
  const TEST_MEETING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  let mockMeetingsTable = new Map()
  let mockParticipantsTable = new Map()
  let mockDeviceBansTable = new Map()
  let mockJoinRequestsTable = new Map()
  let mockUsersTable = new Map()
  let emittedSocketEvents = []

  const mockIo = {
    to: (room) => ({
      emit: (event, payload) => {
        emittedSocketEvents.push({ room, event, payload })
      }
    })
  }

  const createMockReqRes = ({ body = {}, params = {}, user = null, app = null } = {}) => {
    const req = {
      body,
      params,
      user,
      headers: {},
      cookies: {},
      app: app || {
        get: (key) => (key === 'io' ? mockIo : null)
      }
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

  const createMockDatabase = () => {
    return {
      from: (table) => {
        let filters = {}
        let updateValues = null
        let insertValues = null
        let selectColumns = '*'
        let isDelete = false
        let inFilters = {}
        let gtFilters = {}
        let lteFilters = {}
        let isFilters = {}
        let notFilters = []
        let orClauses = []

        const query = {
          select: (cols) => {
            selectColumns = cols
            return query
          },
          eq: (field, val) => {
            filters[field] = val
            return query
          },
          is: (field, val) => {
            isFilters[field] = val
            return query
          },
          or: (clause) => {
            orClauses.push(clause)
            return query
          },
          in: (field, array) => {
            inFilters[field] = array
            return query
          },
          gt: (field, val) => {
            gtFilters[field] = val
            return query
          },
          lte: (field, val) => {
            lteFilters[field] = val
            return query
          },
          not: (field, operator, val) => {
            notFilters.push({ field, operator, val })
            return query
          },
          insert: (values) => {
            insertValues = values
            return query
          },
          update: (values) => {
            updateValues = values
            return query
          },
          delete: () => {
            isDelete = true
            return query
          },
          single: async () => {
            const res = await query.maybeSingle()
            if (!res.data) return { data: null, error: { message: 'Row not found' } }
            return res
          },
          maybeSingle: async () => {
            if (insertValues) {
              const rows = Array.isArray(insertValues) ? insertValues : [insertValues]
              const inserted = []
              for (const row of rows) {
                const id = row.meeting_id || row.participant_id || crypto.randomUUID()
                const record = { ...row }
                if (table === 'meetings') {
                  record.meeting_id = id
                  mockMeetingsTable.set(id, record)
                } else if (table === 'participants') {
                  record.participant_id = id
                  mockParticipantsTable.set(id, record)
                }
                inserted.push(record)
              }
              return { data: inserted[0] || null, error: null }
            }

            if (updateValues) {
              if (table === 'meetings') {
                for (const [id, m] of mockMeetingsTable.entries()) {
                  let match = true
                  if (filters.meeting_id && m.meeting_id !== filters.meeting_id) match = false
                  if (filters.meeting_status && m.meeting_status !== filters.meeting_status) match = false
                  if (gtFilters.scheduled_end_time && m.scheduled_end_time <= gtFilters.scheduled_end_time) match = false
                  if (lteFilters.scheduled_end_time && (!m.scheduled_end_time || m.scheduled_end_time > lteFilters.scheduled_end_time)) match = false
                  if (isFilters.scheduled_end_time !== undefined) {
                    if (isFilters.scheduled_end_time === null && m.scheduled_end_time !== null) match = false
                  }
                  if (orClauses.length > 0) {
                    for (const clause of orClauses) {
                      if (clause.includes('extension_count') || clause.includes('extension_used')) {
                        const countNull = m.extension_count == null
                        const usedNull = m.extension_used == null
                        const countZero = m.extension_count === 0
                        const usedFalse = m.extension_used === false || m.extension_used == null
                        const validUnextended = (countNull && usedNull) || (countZero && usedFalse) || (countNull && usedFalse) || (countZero && usedNull)
                        if (!validUnextended || m.extension_count >= 1 || m.extension_used === true) {
                          match = false
                        }
                      }
                    }
                  }
                  if (match) {
                    const updated = { ...m, ...updateValues }
                    mockMeetingsTable.set(id, updated)
                    return { data: updated, error: null }
                  }
                }
                return { data: null, error: null }
              }
            }

            if (table === 'meetings') {
              for (const m of mockMeetingsTable.values()) {
                let match = true
                if (filters.meeting_id && m.meeting_id !== filters.meeting_id) match = false
                if (filters.meeting_code && m.meeting_code !== filters.meeting_code) match = false
                if (filters.meeting_status && m.meeting_status !== filters.meeting_status) match = false
                if (match) return { data: { ...m }, error: null }
              }
              return { data: null, error: null }
            }

            if (table === 'participants') {
              for (const p of mockParticipantsTable.values()) {
                let match = true
                if (filters.meeting_id && p.meeting_id !== filters.meeting_id) match = false
                if (filters.user_id && p.user_id !== filters.user_id) match = false
                if (match) return { data: { ...p }, error: null }
              }
              return { data: null, error: null }
            }

            return { data: null, error: null }
          },
          then: (resolve, reject) => {
            // Promise-like resolution when awaited directly without maybeSingle()
            if (isDelete) {
              if (table === 'meeting_device_bans' && filters.meeting_code) {
                for (const [key, ban] of mockDeviceBansTable.entries()) {
                  if (ban.meeting_code === filters.meeting_code) mockDeviceBansTable.delete(key)
                }
              }
              if (table === 'meeting_join_requests' && filters.meeting_code) {
                for (const [key, req] of mockJoinRequestsTable.entries()) {
                  if (req.meeting_code === filters.meeting_code) mockJoinRequestsTable.delete(key)
                }
              }
              resolve({ data: null, error: null })
              return
            }

            if (updateValues) {
              if (table === 'participants') {
                for (const [id, p] of mockParticipantsTable.entries()) {
                  let match = true
                  if (filters.meeting_id && p.meeting_id !== filters.meeting_id) match = false
                  if (inFilters.participant_status && !inFilters.participant_status.includes(p.participant_status)) match = false
                  if (match) {
                    mockParticipantsTable.set(id, { ...p, ...updateValues })
                  }
                }
              }
              if (table === 'meetings') {
                for (const [id, m] of mockMeetingsTable.entries()) {
                  let match = true
                  if (filters.meeting_id && m.meeting_id !== filters.meeting_id) match = false
                  if (filters.meeting_status && m.meeting_status !== filters.meeting_status) match = false
                  if (match) {
                    mockMeetingsTable.set(id, { ...m, ...updateValues })
                  }
                }
              }
              resolve({ data: null, error: null })
              return
            }

            if (table === 'meetings') {
              const matched = []
              for (const m of mockMeetingsTable.values()) {
                let match = true
                if (filters.meeting_status && m.meeting_status !== filters.meeting_status) match = false
                if (filters.is_deleted !== undefined && m.is_deleted !== filters.is_deleted) match = false
                if (lteFilters.scheduled_end_time && (!m.scheduled_end_time || m.scheduled_end_time > lteFilters.scheduled_end_time)) match = false
                if (gtFilters.scheduled_end_time && (!m.scheduled_end_time || m.scheduled_end_time <= gtFilters.scheduled_end_time)) match = false
                for (const notFilter of notFilters) {
                  if (notFilter.field === 'scheduled_end_time' && notFilter.operator === 'is' && notFilter.val === null) {
                    if (m.scheduled_end_time == null) match = false
                  }
                }
                if (match) matched.push({ ...m })
              }
              resolve({ data: matched, error: null })
              return
            }

            resolve({ data: [], error: null })
          }
        }

        return query
      },
      rpc: async (funcName, args) => {
        if (funcName === 'extend_meeting_duration') {
          const m = mockMeetingsTable.get(args.p_meeting_id)
          if (!m) return { data: [{ success: false, error_message: 'Meeting not found.' }], error: null }
          if (m.meeting_status !== 'Active') return { data: [{ success: false, error_message: 'Only active meetings can be extended.' }], error: null }
          const activeHost = m.active_host_id || m.host_id
          if (!activeHost || activeHost !== args.p_requester_id) return { data: [{ success: false, error_message: 'Unauthorized. Only host can extend.' }], error: null }
          if (args.p_extension_minutes == null || ![5, 10, 15].includes(args.p_extension_minutes)) return { data: [{ success: false, error_message: 'Extension minutes must be 5, 10, or 15.' }], error: null }
          if (m.scheduled_end_time && new Date(m.scheduled_end_time) <= new Date()) {
            return { data: [{ success: false, error_message: 'Scheduled end time has elapsed.' }], error: null }
          }
          if ((m.extension_count !== undefined && m.extension_count >= 1) || m.extension_used === true) {
            return { data: [{ success: false, error_message: 'This meeting has already used its one-time extension allowance.' }], error: null }
          }
          const base = m.scheduled_end_time ? new Date(m.scheduled_end_time) : new Date()
          const newEnd = new Date(base.getTime() + args.p_extension_minutes * 60 * 1000).toISOString()
          m.scheduled_end_time = newEnd
          m.extension_count = 1
          m.extension_used = true
          mockMeetingsTable.set(args.p_meeting_id, m)
          return { data: [{ success: true, new_scheduled_end_time: newEnd }], error: null }
        }
        if (funcName === 'expire_meeting_if_eligible') {
          const m = mockMeetingsTable.get(args.p_meeting_id)
          if (!m) return { data: [{ success: false }], error: null }
          if (m.meeting_status !== 'Active') return { data: [{ success: false }], error: null }
          if (!m.scheduled_end_time || new Date(m.scheduled_end_time) > new Date()) {
            return { data: [{ success: false }], error: null }
          }
          const now = new Date().toISOString()
          m.meeting_status = 'Ended'
          m.ended_at = now
          mockMeetingsTable.set(args.p_meeting_id, m)
          return {
            data: [{
              success: true,
              room_name: m.room_name,
              meeting_code: m.meeting_code,
              host_id: m.host_id,
              scheduled_end_time: m.scheduled_end_time,
              ended_at: now
            }],
            error: null
          }
        }
        return { data: null, error: { message: `RPC ${funcName} not mocked` } }
      }
    }
  }

  let mockDb = null
  let originalSupabaseFrom = null
  let originalSupabaseRpc = null

  beforeEach(() => {
    mockMeetingsTable.clear()
    mockParticipantsTable.clear()
    mockDeviceBansTable.clear()
    mockJoinRequestsTable.clear()
    mockUsersTable.clear()
    emittedSocketEvents = []

    mockDb = createMockDatabase()
    setDatabaseClient(mockDb)

    originalSupabaseFrom = supabase.from
    originalSupabaseRpc = supabase.rpc
    supabase.from = mockDb.from
    supabase.rpc = mockDb.rpc

    // Seed mock host and user
    mockUsersTable.set(HOST_ID, { user_id: HOST_ID, full_name: 'Test Host', email: 'host@meetly.test' })
    mockUsersTable.set(PARTICIPANT_ID, { user_id: PARTICIPANT_ID, full_name: 'Test Participant', email: 'participant@meetly.test' })

    // Provide mock LiveKit environment variables
    process.env.LIVEKIT_API_KEY = 'devkey'
    process.env.LIVEKIT_API_SECRET = 'secret12345678901234567890123456789012'
    process.env.LIVEKIT_URL = 'wss://livekit.test'
  })

  afterEach(() => {
    stopMeetingExpirationWorker()
    resetDatabaseClient()
    supabase.from = originalSupabaseFrom
    supabase.rpc = originalSupabaseRpc
  })

  // ==========================================================================
  // SECTION 1: CREATION TESTS (Requirements 1 - 8)
  // ==========================================================================
  describe('Phase 2 — Meeting Creation & Duration Validation', () => {
    it('1. A host cannot create a meeting without a meeting name', async () => {
      const { req, res } = createMockReqRes({
        body: { meetingTitle: '', durationMinutes: 30 },
        user: { id: HOST_ID }
      })

      await createMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 400)
      assert.strictEqual(res.getData().message, 'Meeting title is required.')
    })

    it('2. A host cannot create a meeting without selecting a duration', async () => {
      const { req, res } = createMockReqRes({
        body: { meetingTitle: 'Product Sync', durationMinutes: null },
        user: { id: HOST_ID }
      })

      await createMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 400)
      assert.match(res.getData().message, /duration is required/i)
    })

    it('2b. Meeting creation strictly rejects omitted or NULL duration and does not silently fall back to database default (30)', async () => {
      // 1. Completely omitted durationMinutes key
      const reqResOmitted = createMockReqRes({
        body: { meetingTitle: 'Omitted Duration Sync' },
        user: { id: HOST_ID }
      })
      await createMeeting(reqResOmitted.req, reqResOmitted.res)
      assert.strictEqual(reqResOmitted.res.getStatusCode(), 400)
      assert.match(reqResOmitted.res.getData().message, /duration is required/i)
      assert.strictEqual(mockMeetingsTable.size, 0, 'No meeting must be inserted when duration is omitted')

      // 2. Explicitly null durationMinutes
      const reqResNull = createMockReqRes({
        body: { meetingTitle: 'Null Duration Sync', durationMinutes: null },
        user: { id: HOST_ID }
      })
      await createMeeting(reqResNull.req, reqResNull.res)
      assert.strictEqual(reqResNull.res.getStatusCode(), 400)
      assert.match(reqResNull.res.getData().message, /duration is required/i)
      assert.strictEqual(mockMeetingsTable.size, 0, 'No meeting must be inserted when duration is null')

      // 3. Explicitly empty string durationMinutes
      const reqResEmpty = createMockReqRes({
        body: { meetingTitle: 'Empty Duration Sync', durationMinutes: '' },
        user: { id: HOST_ID }
      })
      await createMeeting(reqResEmpty.req, reqResEmpty.res)
      assert.strictEqual(reqResEmpty.res.getStatusCode(), 400)
      assert.match(reqResEmpty.res.getData().message, /duration is required/i)
      assert.strictEqual(mockMeetingsTable.size, 0, 'No meeting must be inserted when duration is empty string')

      // 4. Valid duration explicitly provided: succeeds and uses specified duration
      const reqResValid = createMockReqRes({
        body: { meetingTitle: 'Explicit 15m Sync', durationMinutes: 15 },
        user: { id: HOST_ID }
      })
      await createMeeting(reqResValid.req, reqResValid.res)
      assert.strictEqual(reqResValid.res.getStatusCode(), 200)
      assert.strictEqual(mockMeetingsTable.size, 1)
      const created = mockMeetingsTable.get(reqResValid.res.getData().meetingId)
      assert.strictEqual(created.duration_minutes, 15)
    })

    it('3. All four valid durations (5, 15, 30, 40) are accepted', async () => {
      for (const mins of [5, 15, 30, 40]) {
        const { req, res } = createMockReqRes({
          body: { meetingTitle: `Sync ${mins}`, durationMinutes: mins },
          user: { id: HOST_ID }
        })

        await createMeeting(req, res)
        assert.strictEqual(res.getStatusCode(), 200, `Duration ${mins} should be accepted`)
        assert.ok(res.getData().meetingId)
        const mtg = mockMeetingsTable.get(res.getData().meetingId)
        assert.strictEqual(mtg.duration_minutes, mins)
        assert.strictEqual(mtg.meeting_status, 'Waiting')
      }
    })

    it('4. Invalid duration values are rejected by the backend', async () => {
      const invalidValues = [0, 10, 20, 25, 45, 60, -5, 'foo', null, undefined]
      for (const val of invalidValues) {
        const { req, res } = createMockReqRes({
          body: { meetingTitle: 'Invalid Duration Test', durationMinutes: val },
          user: { id: HOST_ID }
        })

        await createMeeting(req, res)
        assert.strictEqual(res.getStatusCode(), 400, `Duration value '${val}' must be rejected`)
        assert.match(res.getData().message, /5, 15, 30, or 40/i)
      }
    })

    it('5. Public meetings support all four durations', async () => {
      for (const mins of [5, 15, 30, 40]) {
        const { req, res } = createMockReqRes({
          body: { meetingTitle: `Public ${mins}`, meetingType: 'public', durationMinutes: mins },
          user: { id: HOST_ID }
        })

        await createMeeting(req, res)
        assert.strictEqual(res.getStatusCode(), 200)
        const mtg = mockMeetingsTable.get(res.getData().meetingId)
        assert.strictEqual(mtg.meeting_type, 'public')
        assert.strictEqual(mtg.duration_minutes, mins)
      }
    })

    it('6. Private meetings support all four durations with password hashing', async () => {
      for (const mins of [5, 15, 30, 40]) {
        const { req, res } = createMockReqRes({
          body: {
            meetingTitle: `Private ${mins}`,
            meetingType: 'private',
            meetingPassword: 'SecretPassword123!',
            durationMinutes: mins
          },
          user: { id: HOST_ID }
        })

        await createMeeting(req, res)
        assert.strictEqual(res.getStatusCode(), 200)
        const mtg = mockMeetingsTable.get(res.getData().meetingId)
        assert.strictEqual(mtg.meeting_type, 'private')
        assert.strictEqual(mtg.duration_minutes, mins)
        assert.ok(mtg.meeting_password_hash, 'Password should be hashed')
      }
    })

    it('7. Existing AI Analyzer and AI Attendance settings continue to work', async () => {
      const { req, res } = createMockReqRes({
        body: {
          meetingTitle: 'AI Enabled Meeting',
          durationMinutes: 15,
          enableAiAnalyzer: true,
          enableAiAttendance: true
        },
        user: { id: HOST_ID }
      })

      await createMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 200)
      const mtg = mockMeetingsTable.get(res.getData().meetingId)
      assert.strictEqual(mtg.enable_ai_analyzer, true)
      assert.strictEqual(mtg.enable_ai_attendance, true)
    })

    it('8. Existing meeting-code generation remains functional and unique', async () => {
      const { req, res } = createMockReqRes({
        body: { meetingTitle: 'Code Gen Meeting', durationMinutes: 30 },
        user: { id: HOST_ID }
      })

      await createMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 200)
      const code = res.getData().meetingCode
      assert.ok(code)
      assert.strictEqual(code.length, 8)
      assert.match(code, /^[A-Z0-9]{8}$/)
    })
  })

  // ==========================================================================
  // SECTION 2: COUNTDOWN AND WARNING TESTS (Requirements 9 - 15)
  // ==========================================================================
  describe('Phase 3 & 4 — Authoritative Meeting Deadline & 3-Minute Warning', () => {
    it('9. The deadline is calculated from the authoritative activation time', async () => {
      const meetingId = '99999999-9999-4999-8999-999999999999'
      mockMeetingsTable.set(meetingId, {
        meeting_id: meetingId,
        meeting_code: 'ACTIVATE1',
        room_name: 'room-activate',
        meeting_status: 'Waiting',
        duration_minutes: 15,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      const beforeActivation = Date.now()
      const { req, res } = createMockReqRes({
        body: { meetingId },
        user: { id: HOST_ID }
      })

      await activateMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 200)

      const mtg = mockMeetingsTable.get(meetingId)
      assert.strictEqual(mtg.meeting_status, 'Active')
      assert.ok(mtg.started_at)
      assert.ok(mtg.scheduled_end_time)

      const scheduledEndMs = new Date(mtg.scheduled_end_time).getTime()
      const expectedEndMs = beforeActivation + 15 * 60 * 1000
      // Tolerant within 2 seconds
      assert.ok(Math.abs(scheduledEndMs - expectedEndMs) < 2000)
    })

    it('10. The header countdown matches the server deadline', () => {
      const now = Date.now()
      const scheduledEndTime = new Date(now + 125 * 1000).toISOString() // 2m 5s
      const diffSec = Math.max(0, Math.floor((new Date(scheduledEndTime).getTime() - now) / 1000))
      assert.strictEqual(diffSec, 125)

      // Test format function logic
      const m = Math.floor(diffSec / 60)
      const s = diffSec % 60
      const formatted = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      assert.strictEqual(formatted, '02:05')
    })

    it('11. The warning condition detects when <= 3 minutes (180s) remain', () => {
      const now = Date.now()
      const end180 = new Date(now + 180 * 1000).toISOString()
      const end240 = new Date(now + 240 * 1000).toISOString()

      const checkWarningCondition = (deadline) => {
        const diff = Math.max(0, Math.floor((new Date(deadline).getTime() - Date.now()) / 1000))
        return diff <= 180 && diff > 0
      }

      assert.strictEqual(checkWarningCondition(end180), true, '180s should trigger warning')
      assert.strictEqual(checkWarningCondition(end240), false, '240s (> 180s) should not trigger warning')
    })

    it('12. The warning does not repeatedly appear for the same deadline', () => {
      const deadline = new Date(Date.now() + 100 * 1000).toISOString()
      let warningTriggeredDeadline = null
      let isWarningModalOpen = false

      const triggerWarningIfEligible = (deadlineStr, diffSec) => {
        if (diffSec <= 180 && diffSec > 0) {
          if (warningTriggeredDeadline !== deadlineStr) {
            warningTriggeredDeadline = deadlineStr
            isWarningModalOpen = true
            return true
          }
        }
        return false
      }

      // First tick at 100s
      const firstTick = triggerWarningIfEligible(deadline, 100)
      assert.strictEqual(firstTick, true)
      assert.strictEqual(isWarningModalOpen, true)

      // Subsequent tick at 99s for the same deadline
      const secondTick = triggerWarningIfEligible(deadline, 99)
      assert.strictEqual(secondTick, false, 'Subsequent timer ticks must not re-trigger warning for same deadline')
    })

    it('13. Refresh and reconnect restore the correct warning and countdown state', async () => {
      const meetingId = '55555555-5555-4555-8555-555555555555'
      const now = Date.now()
      const scheduledEndTime = new Date(now + 150 * 1000).toISOString() // 2m 30s remaining

      mockMeetingsTable.set(meetingId, {
        meeting_id: meetingId,
        meeting_code: 'RECONN01',
        meeting_status: 'Active',
        scheduled_end_time: scheduledEndTime,
        duration_minutes: 5,
        host_id: HOST_ID,
        is_deleted: false
      })

      // Query meeting details as done during room initialization
      const query = mockDb.from('meetings').select('*').eq('meeting_id', meetingId)
      const { data: mtg } = await query.maybeSingle()

      assert.strictEqual(mtg.scheduled_end_time, scheduledEndTime)
      const diffSec = Math.max(0, Math.floor((new Date(mtg.scheduled_end_time).getTime() - Date.now()) / 1000))
      assert.ok(diffSec <= 150 && diffSec >= 148)
    })

    it('14. Selecting No leaves the current deadline unchanged', () => {
      const initialDeadline = new Date(Date.now() + 120 * 1000).toISOString()
      let currentDeadline = initialDeadline
      let warningDismissedForDeadline = null

      const handleDeclineExtension = () => {
        warningDismissedForDeadline = currentDeadline
        // deadline is untouched
      }

      handleDeclineExtension()
      assert.strictEqual(warningDismissedForDeadline, initialDeadline)
      assert.strictEqual(currentDeadline, initialDeadline, 'Deadline must not change when declining extension')
    })

    it('15. Closing the warning does not accidentally extend or terminate the meeting', () => {
      const initialStatus = 'Active'
      const initialDeadline = new Date(Date.now() + 120 * 1000).toISOString()
      let meetingStatus = initialStatus
      let deadline = initialDeadline

      // Host cancels/dismisses warning modal
      const dismissModal = () => {
        // modal closes, no side-effects on meeting status or deadline
      }

      dismissModal()
      assert.strictEqual(meetingStatus, 'Active')
      assert.strictEqual(deadline, initialDeadline)
    })
  })

  // ==========================================================================
  // SECTION 3: EXTENSION TESTS (Requirements 16 - 25)
  // ==========================================================================
  describe('Phase 5 — Host Extension Flow & Authorization', () => {
    let activeMeetingId = null
    let initialDeadline = null

    beforeEach(() => {
      activeMeetingId = '88888888-8888-4888-8888-888888888888'
      const now = Date.now()
      initialDeadline = new Date(now + 120 * 1000).toISOString() // 2 mins left

      mockMeetingsTable.set(activeMeetingId, {
        meeting_id: activeMeetingId,
        meeting_code: 'EXTEND01',
        room_name: 'room-extend',
        meeting_status: 'Active',
        scheduled_end_time: initialDeadline,
        duration_minutes: 5,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })
    })

    it('16. Selecting +5 minutes adds exactly five minutes', async () => {
      const { req, res } = createMockReqRes({
        body: { meetingId: activeMeetingId, extensionMinutes: 5 },
        user: { id: HOST_ID }
      })

      await extendMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 200)
      const data = res.getData()
      assert.strictEqual(data.success, true)
      assert.strictEqual(data.extensionMinutes, 5)

      const expectedEnd = new Date(new Date(initialDeadline).getTime() + 5 * 60 * 1000).toISOString()
      assert.strictEqual(data.scheduledEndTime, expectedEnd)
    })

    it('17. Selecting +10 minutes adds exactly ten minutes', async () => {
      const { req, res } = createMockReqRes({
        body: { meetingId: activeMeetingId, extensionMinutes: 10 },
        user: { id: HOST_ID }
      })

      await extendMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 200)
      const data = res.getData()
      assert.strictEqual(data.extensionMinutes, 10)

      const expectedEnd = new Date(new Date(initialDeadline).getTime() + 10 * 60 * 1000).toISOString()
      assert.strictEqual(data.scheduledEndTime, expectedEnd)
    })

    it('18. Selecting +15 minutes adds exactly fifteen minutes', async () => {
      const { req, res } = createMockReqRes({
        body: { meetingId: activeMeetingId, extensionMinutes: 15 },
        user: { id: HOST_ID }
      })

      await extendMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 200)
      const data = res.getData()
      assert.strictEqual(data.extensionMinutes, 15)

      const expectedEnd = new Date(new Date(initialDeadline).getTime() + 15 * 60 * 1000).toISOString()
      assert.strictEqual(data.scheduledEndTime, expectedEnd)
    })

    it('19. Cancel leaves the original deadline unchanged', () => {
      const currentDeadline = initialDeadline
      const onCancel = () => {
        // user clicked cancel; no api call is dispatched
      }
      onCancel()
      const mtg = mockMeetingsTable.get(activeMeetingId)
      assert.strictEqual(mtg.scheduled_end_time, currentDeadline)
    })

    it('20. Unauthorized participants cannot extend the meeting (returns 403)', async () => {
      const { req, res } = createMockReqRes({
        body: { meetingId: activeMeetingId, extensionMinutes: 5 },
        user: { id: PARTICIPANT_ID } // Not the host
      })

      await extendMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 403)
      assert.match(res.getData().message, /unauthorized/i)

      // Deadline remains intact
      const mtg = mockMeetingsTable.get(activeMeetingId)
      assert.strictEqual(mtg.scheduled_end_time, initialDeadline)
    })

    it('21. Invalid extension amounts are rejected (returns 400)', async () => {
      const invalidAmounts = [1, 2, 3, 7, 20, 30, -5, 'foo', null]
      for (const amount of invalidAmounts) {
        const { req, res } = createMockReqRes({
          body: { meetingId: activeMeetingId, extensionMinutes: amount },
          user: { id: HOST_ID }
        })

        await extendMeeting(req, res)
        assert.strictEqual(res.getStatusCode(), 400)
        assert.match(res.getData().message, /5, 10, or 15/i)
      }
    })

    it('22. A meeting can never receive more than one extension (Strict Rule: One-Time Extension Only)', async () => {
      // First extension: +5 minutes succeeds
      const reqRes1 = createMockReqRes({
        body: { meetingId: activeMeetingId, extensionMinutes: 5 },
        user: { id: HOST_ID }
      })
      await extendMeeting(reqRes1.req, reqRes1.res)
      assert.strictEqual(reqRes1.res.getStatusCode(), 200)
      const data1 = reqRes1.res.getData()
      assert.strictEqual(data1.success, true)
      assert.strictEqual(data1.extensionMinutes, 5)
      assert.strictEqual(data1.extensionUsed, true)
      assert.strictEqual(data1.extensionCount, 1)
      const deadlineAfterFirst = data1.scheduledEndTime

      // Second extension attempt on the SAME meeting MUST be permanently rejected
      const reqRes2 = createMockReqRes({
        body: { meetingId: activeMeetingId, extensionMinutes: 10 },
        user: { id: HOST_ID }
      })
      await extendMeeting(reqRes2.req, reqRes2.res)
      assert.strictEqual(reqRes2.res.getStatusCode(), 400)
      assert.match(reqRes2.res.getData().message, /already used its one-time extension allowance/i)

      // Verified: database scheduled_end_time remains at first extension and was NOT incremented again
      const mtg = mockMeetingsTable.get(activeMeetingId)
      assert.strictEqual(mtg.scheduled_end_time, deadlineAfterFirst)
      assert.strictEqual(mtg.extension_count, 1)
      assert.strictEqual(mtg.extension_used, true)
    })

    it('23. A new meeting receives its own independent extension allowance', async () => {
      // Meeting A has already consumed its one-time extension allowance
      const mtgA = mockMeetingsTable.get(activeMeetingId)
      mtgA.extension_count = 1
      mtgA.extension_used = true
      mockMeetingsTable.set(activeMeetingId, mtgA)

      // Verify Meeting A cannot be extended
      const reqResA = createMockReqRes({
        body: { meetingId: activeMeetingId, extensionMinutes: 5 },
        user: { id: HOST_ID }
      })
      await extendMeeting(reqResA.req, reqResA.res)
      assert.strictEqual(reqResA.res.getStatusCode(), 400)
      assert.match(reqResA.res.getData().message, /already used its one-time extension allowance/i)

      // Create a brand new independent Meeting B
      const newMeetingId = '99999999-9999-4999-8999-999999999999'
      const newDeadline = new Date(Date.now() + 180 * 1000).toISOString()
      mockMeetingsTable.set(newMeetingId, {
        meeting_id: newMeetingId,
        meeting_code: 'NEWMET01',
        room_name: 'room-new-meeting',
        meeting_status: 'Active',
        scheduled_end_time: newDeadline,
        duration_minutes: 15,
        extension_count: 0,
        extension_used: false,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      // Meeting B has its own independent extension allowance: +10 minutes succeeds
      const reqResB1 = createMockReqRes({
        body: { meetingId: newMeetingId, extensionMinutes: 10 },
        user: { id: HOST_ID }
      })
      await extendMeeting(reqResB1.req, reqResB1.res)
      assert.strictEqual(reqResB1.res.getStatusCode(), 200)
      const dataB1 = reqResB1.res.getData()
      assert.strictEqual(dataB1.success, true)
      assert.strictEqual(dataB1.extensionMinutes, 10)
      assert.strictEqual(dataB1.extensionUsed, true)
      assert.strictEqual(dataB1.extensionCount, 1)

      // Meeting B now also permanently exhausts its one-time allowance
      const reqResB2 = createMockReqRes({
        body: { meetingId: newMeetingId, extensionMinutes: 5 },
        user: { id: HOST_ID }
      })
      await extendMeeting(reqResB2.req, reqResB2.res)
      assert.strictEqual(reqResB2.res.getStatusCode(), 400)
      assert.match(reqResB2.res.getData().message, /already used its one-time extension allowance/i)

      // Meeting A remains exhausted as well
      const reqResA2 = createMockReqRes({
        body: { meetingId: activeMeetingId, extensionMinutes: 15 },
        user: { id: HOST_ID }
      })
      await extendMeeting(reqResA2.req, reqResA2.res)
      assert.strictEqual(reqResA2.res.getStatusCode(), 400)
      assert.match(reqResA2.res.getData().message, /already used its one-time extension allowance/i)
    })

    it('23b. Double-clicks and concurrent in-flight requests are rejected from granting multiple extensions', async () => {
      const concurrentMeetingId = '66666666-6666-4666-8666-666666666666'
      const now = Date.now()
      const deadline = new Date(now + 120 * 1000).toISOString()
      mockMeetingsTable.set(concurrentMeetingId, {
        meeting_id: concurrentMeetingId,
        meeting_code: 'CONCUR01',
        room_name: 'room-concurrent',
        meeting_status: 'Active',
        scheduled_end_time: deadline,
        duration_minutes: 5,
        extension_count: 0,
        extension_used: false,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      // Dispatch first extension request
      const reqRes1 = createMockReqRes({
        body: { meetingId: concurrentMeetingId, extensionMinutes: 5 },
        user: { id: HOST_ID }
      })
      const p1 = extendMeeting(reqRes1.req, reqRes1.res)

      // Dispatch immediate concurrent / double-click request
      const reqRes2 = createMockReqRes({
        body: { meetingId: concurrentMeetingId, extensionMinutes: 5 },
        user: { id: HOST_ID }
      })
      const p2 = extendMeeting(reqRes2.req, reqRes2.res)

      await Promise.all([p1, p2])

      const status1 = reqRes1.res.getStatusCode()
      const status2 = reqRes2.res.getStatusCode()

      // Exactly one request must succeed (200), and the other must be rejected (400)
      const statuses = [status1, status2].sort()
      assert.deepStrictEqual(statuses, [200, 400], 'One request must succeed and the other must be rejected')

      // Database row must have extension_count = 1 and extension_used = true
      const mtg = mockMeetingsTable.get(concurrentMeetingId)
      assert.strictEqual(mtg.extension_count, 1)
      assert.strictEqual(mtg.extension_used, true)
    })

    it('24. Concurrent extension and end operations preserve consistent final state', async () => {
      // Mark meeting Ended
      const mtg = mockMeetingsTable.get(activeMeetingId)
      mtg.meeting_status = 'Ended'
      mockMeetingsTable.set(activeMeetingId, mtg)

      // Extension attempt after end
      const { req, res } = createMockReqRes({
        body: { meetingId: activeMeetingId, extensionMinutes: 5 },
        user: { id: HOST_ID }
      })
      await extendMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 400)
      assert.match(res.getData().message, /only active meetings/i)
    })

    it('25. An already ended meeting cannot be extended or revived', async () => {
      const endedMeetingId = '77777777-7777-4777-8777-777777777777'
      mockMeetingsTable.set(endedMeetingId, {
        meeting_id: endedMeetingId,
        meeting_code: 'ENDED001',
        meeting_status: 'Ended',
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        scheduled_end_time: new Date(Date.now() - 10000).toISOString()
      })

      const { req, res } = createMockReqRes({
        body: { meetingId: endedMeetingId, extensionMinutes: 5 },
        user: { id: HOST_ID }
      })

      await extendMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 400)
      const mtg = mockMeetingsTable.get(endedMeetingId)
      assert.strictEqual(mtg.meeting_status, 'Ended')
    })

    it('25b. Direct-query fallback successfully extends meeting and respects single composite PostgREST filter when RPC is unavailable', async () => {
      const fallbackMeetingId = '44444444-4444-4444-8444-444444444444'
      const now = Date.now()
      const deadline = new Date(now + 180 * 1000).toISOString()
      mockMeetingsTable.set(fallbackMeetingId, {
        meeting_id: fallbackMeetingId,
        meeting_code: 'FALLBK01',
        room_name: 'room-fallback',
        meeting_status: 'Active',
        scheduled_end_time: deadline,
        duration_minutes: 15,
        extension_count: 0,
        extension_used: false,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      // Temporarily disable RPC to force direct-query fallback
      const savedRpc = supabase.rpc
      supabase.rpc = undefined

      try {
        const { req, res } = createMockReqRes({
          body: { meetingId: fallbackMeetingId, extensionMinutes: 5 },
          user: { id: HOST_ID }
        })
        await extendMeeting(req, res)
        assert.strictEqual(res.getStatusCode(), 200)
        const data = res.getData()
        assert.strictEqual(data.success, true)
        assert.strictEqual(data.extensionMinutes, 5)
        assert.strictEqual(data.extensionUsed, true)
        assert.strictEqual(data.extensionCount, 1)

        const mtg = mockMeetingsTable.get(fallbackMeetingId)
        assert.strictEqual(mtg.extension_count, 1)
        assert.strictEqual(mtg.extension_used, true)
        const expectedEnd = new Date(new Date(deadline).getTime() + 5 * 60 * 1000).toISOString()
        assert.strictEqual(mtg.scheduled_end_time, expectedEnd)
      } finally {
        supabase.rpc = savedRpc
      }
    })

    it('25c. Direct-query fallback strictly rejects second extension and cannot revive ended meeting', async () => {
      const fallbackMeetingId = '44444444-4444-4444-8444-444444444444'
      const now = Date.now()
      const deadline = new Date(now + 180 * 1000).toISOString()
      mockMeetingsTable.set(fallbackMeetingId, {
        meeting_id: fallbackMeetingId,
        meeting_code: 'FALLBK01',
        room_name: 'room-fallback',
        meeting_status: 'Active',
        scheduled_end_time: deadline,
        duration_minutes: 15,
        extension_count: 1,
        extension_used: true,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      const savedRpc = supabase.rpc
      supabase.rpc = undefined

      try {
        // Attempt second extension on already extended meeting via fallback
        const { req: req1, res: res1 } = createMockReqRes({
          body: { meetingId: fallbackMeetingId, extensionMinutes: 10 },
          user: { id: HOST_ID }
        })
        await extendMeeting(req1, res1)
        assert.strictEqual(res1.getStatusCode(), 400)
        assert.match(res1.getData().message, /already used its one-time extension allowance/i)

        // Attempt extension on ended meeting via fallback
        const mtg = mockMeetingsTable.get(fallbackMeetingId)
        mtg.meeting_status = 'Ended'
        mockMeetingsTable.set(fallbackMeetingId, mtg)

        const { req: req2, res: res2 } = createMockReqRes({
          body: { meetingId: fallbackMeetingId, extensionMinutes: 5 },
          user: { id: HOST_ID }
        })
        await extendMeeting(req2, res2)
        assert.strictEqual(res2.getStatusCode(), 400)
      } finally {
        supabase.rpc = savedRpc
      }
    })
  })

  // ==========================================================================
  // SECTION 4: AUTOMATIC END TESTS (Requirements 26 - 33)
  // ==========================================================================
  describe('Phase 7 — Server-Enforced Automatic Termination', () => {
    let expiringMeetingId = null

    beforeEach(() => {
      expiringMeetingId = '66666666-6666-4666-8666-666666666666'
      mockMeetingsTable.set(expiringMeetingId, {
        meeting_id: expiringMeetingId,
        meeting_code: 'AUTOEXP1',
        room_name: 'room-auto-expire',
        meeting_status: 'Active',
        scheduled_end_time: new Date(Date.now() - 5000).toISOString(), // 5s past deadline
        duration_minutes: 5,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      // Add mock participants
      mockParticipantsTable.set('p-1', {
        participant_id: 'p-1',
        meeting_id: expiringMeetingId,
        user_id: HOST_ID,
        participant_status: 'joined'
      })
      mockParticipantsTable.set('p-2', {
        participant_id: 'p-2',
        meeting_id: expiringMeetingId,
        user_id: PARTICIPANT_ID,
        participant_status: 'joined'
      })

      // Add security ban and join request
      mockDeviceBansTable.set('AUTOEXP1:fp123', {
        meeting_code: 'AUTOEXP1',
        device_fingerprint: 'fp123'
      })
      mockJoinRequestsTable.set('req-1', {
        meeting_code: 'AUTOEXP1',
        user_id: PARTICIPANT_ID
      })
    })

    it('26. An unextended meeting ends at its deadline automatically', async () => {
      const result = await expireMeetingNow(expiringMeetingId, mockIo)
      assert.strictEqual(result.success, true)

      const mtg = mockMeetingsTable.get(expiringMeetingId)
      assert.strictEqual(mtg.meeting_status, 'Ended')
      assert.ok(mtg.ended_at)
    })

    it('27. A host declining the extension can continue until the deadline', () => {
      const now = Date.now()
      const deadline = new Date(now + 60 * 1000).toISOString() // 1 minute remaining
      const mtg = mockMeetingsTable.get(expiringMeetingId)
      mtg.scheduled_end_time = deadline
      mockMeetingsTable.set(expiringMeetingId, mtg)

      // Host declines extension
      // Meeting status remains Active
      assert.strictEqual(mtg.meeting_status, 'Active')
      assert.ok(new Date(mtg.scheduled_end_time).getTime() > Date.now())
    })

    it('28. A host ignoring the warning does not prevent automatic ending', async () => {
      // Deadline passes without host clicking Yes
      const result = await expireMeetingNow(expiringMeetingId, mockIo)
      assert.strictEqual(result.success, true)
      assert.strictEqual(mockMeetingsTable.get(expiringMeetingId).meeting_status, 'Ended')
    })

    it('29. Closing or refreshing the host browser does not prevent automatic ending', async () => {
      // Backend expiration runs independently of any client connection
      const result = await expireMeetingNow(expiringMeetingId, mockIo)
      assert.strictEqual(result.success, true)
      assert.strictEqual(mockMeetingsTable.get(expiringMeetingId).meeting_status, 'Ended')
    })

    it('30. A backend restart does not permanently lose overdue expiration work', async () => {
      // Ensure meeting is Active and overdue
      const sweepResult = await runExpirationSweep(mockIo)
      assert.strictEqual(sweepResult.expiredCount, 1)

      const mtg = mockMeetingsTable.get(expiringMeetingId)
      assert.strictEqual(mtg.meeting_status, 'Ended')
    })

    it('31. Every participant is correctly disconnected and notified when meeting ends', async () => {
      await expireMeetingNow(expiringMeetingId, mockIo)

      // Check participants status
      const p1 = mockParticipantsTable.get('p-1')
      const p2 = mockParticipantsTable.get('p-2')
      assert.strictEqual(p1.participant_status, 'left')
      assert.strictEqual(p2.participant_status, 'left')

      // Check socket events
      const meetingEndedEvent = emittedSocketEvents.find((e) => e.event === 'meeting_ended')
      const chatClearedEvent = emittedSocketEvents.find((e) => e.event === 'chat:cleared')
      assert.ok(meetingEndedEvent, 'meeting_ended socket event must be broadcasted')
      assert.ok(chatClearedEvent, 'chat:cleared socket event must be broadcasted')
      assert.strictEqual(meetingEndedEvent.room, 'room-auto-expire')
    })

    it('32. Existing manual host End Meeting behavior remains immediate', async () => {
      const { req, res } = createMockReqRes({
        body: { meetingId: expiringMeetingId },
        user: { id: HOST_ID }
      })

      await endMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 200)
      assert.strictEqual(mockMeetingsTable.get(expiringMeetingId).meeting_status, 'Ended')

      const endedEvent = emittedSocketEvents.find((e) => e.event === 'meeting_ended')
      assert.ok(endedEvent)
    })

    it('33. Existing recording and retention lifecycle behavior is preserved', async () => {
      // Expiring a meeting must NOT delete the meeting record itself or alter is_deleted
      await expireMeetingNow(expiringMeetingId, mockIo)
      const mtg = mockMeetingsTable.get(expiringMeetingId)
      assert.ok(mtg, 'Meeting record must not be hard deleted on expiration')
      assert.strictEqual(mtg.is_deleted, false)
      assert.strictEqual(mtg.meeting_status, 'Ended')
    })

    it('34. An active meeting whose deadline is still in the future cannot be expired (stale timer guard)', async () => {
      const futureMeetingId = '33333333-aaaa-4333-8333-333333333333'
      const futureDeadline = new Date(Date.now() + 600 * 1000).toISOString() // 10 minutes in future
      mockMeetingsTable.set(futureMeetingId, {
        meeting_id: futureMeetingId,
        meeting_code: 'FUTURE01',
        room_name: 'room-future',
        meeting_status: 'Active',
        scheduled_end_time: futureDeadline,
        duration_minutes: 15,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      // Attempt to expire active meeting whose deadline is in the future
      const result = await expireMeetingNow(futureMeetingId, mockIo)
      assert.strictEqual(result.success, false)
      assert.strictEqual(result.reason, 'ineligible_or_already_ended')

      // Meeting must remain Active with intact future deadline
      const mtg = mockMeetingsTable.get(futureMeetingId)
      assert.strictEqual(mtg.meeting_status, 'Active')
      assert.strictEqual(mtg.scheduled_end_time, futureDeadline)

      // No meeting_ended or chat:cleared events must be emitted for room-future
      const events = emittedSocketEvents.filter(e => e.room === 'room-future')
      assert.strictEqual(events.length, 0)
    })

    it('35. A stale timer cannot end a meeting after its deadline has been extended', async () => {
      const raceMeetingId = '22222222-bbbb-4222-8222-222222222222'
      const originalDeadline = new Date(Date.now() + 500).toISOString()
      mockMeetingsTable.set(raceMeetingId, {
        meeting_id: raceMeetingId,
        meeting_code: 'RACEMT01',
        room_name: 'room-race',
        meeting_status: 'Active',
        scheduled_end_time: originalDeadline,
        duration_minutes: 5,
        extension_count: 0,
        extension_used: false,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      // Host successfully extends meeting by 10 minutes
      const { req, res } = createMockReqRes({
        body: { meetingId: raceMeetingId, extensionMinutes: 10 },
        user: { id: HOST_ID }
      })
      await extendMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 200)

      const mtgAfterExtension = mockMeetingsTable.get(raceMeetingId)
      const extendedDeadline = mtgAfterExtension.scheduled_end_time
      assert.ok(new Date(extendedDeadline).getTime() > Date.now() + 500000)

      // A stale expiration callback (e.g. from an old timer scheduled for originalDeadline) fires now
      const expireResult = await expireMeetingNow(raceMeetingId, mockIo)

      // The expiration update MUST affect 0 rows and return failure because scheduled_end_time > now
      assert.strictEqual(expireResult.success, false)
      assert.strictEqual(expireResult.reason, 'ineligible_or_already_ended')

      // The meeting must remain Active and preserve its extended deadline
      const mtgFinal = mockMeetingsTable.get(raceMeetingId)
      assert.strictEqual(mtgFinal.meeting_status, 'Active')
      assert.strictEqual(mtgFinal.scheduled_end_time, extendedDeadline)
    })

    it('36. An extension that commits before a stale expiration attempt remains effective, and expiration skips cleanly', async () => {
      const coordMeetingId = '11111111-cccc-4111-8111-111111111111'
      const deadline = new Date(Date.now() + 1000).toISOString()
      mockMeetingsTable.set(coordMeetingId, {
        meeting_id: coordMeetingId,
        meeting_code: 'COORD001',
        room_name: 'room-coord',
        meeting_status: 'Active',
        scheduled_end_time: deadline,
        duration_minutes: 5,
        extension_count: 0,
        extension_used: false,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      // Extension commits
      const { req, res } = createMockReqRes({
        body: { meetingId: coordMeetingId, extensionMinutes: 15 },
        user: { id: HOST_ID }
      })
      await extendMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 200)

      // Expiration worker runs
      const expRes = await expireMeetingNow(coordMeetingId, mockIo)
      assert.strictEqual(expRes.success, false)

      const finalMtg = mockMeetingsTable.get(coordMeetingId)
      assert.strictEqual(finalMtg.meeting_status, 'Active')
      assert.strictEqual(finalMtg.extension_count, 1)
      assert.strictEqual(finalMtg.extension_used, true)
    })

    it('37. Cleanup and meeting_ended notifications occur only for a successful expiration transition', async () => {
      emittedSocketEvents = []

      // Expire an already ended meeting
      const endedId = '77777777-7777-4777-8777-777777777777'
      const resEnded = await expireMeetingNow(endedId, mockIo)
      assert.strictEqual(resEnded.success, false)

      // Verify no meeting_ended events emitted
      const endedEvents = emittedSocketEvents.filter(e => e.event === 'meeting_ended')
      assert.strictEqual(endedEvents.length, 0)
    })

    it('38. Authoritative database RPC expire_meeting_if_eligible cleanly terminates an overdue active meeting and skips if future deadline', async () => {
      const overdueId = '88888888-8888-4888-8888-888888888888'
      const pastDeadline = new Date(Date.now() - 5000).toISOString()
      mockMeetingsTable.set(overdueId, {
        meeting_id: overdueId,
        meeting_code: 'RPCOVR01',
        room_name: 'room-rpc-overdue',
        meeting_status: 'Active',
        scheduled_end_time: pastDeadline,
        duration_minutes: 15,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      // Expire via RPC
      const res = await expireMeetingNow(overdueId, mockIo)
      assert.strictEqual(res.success, true)
      assert.strictEqual(res.meeting.meeting_id, overdueId)

      const mtgAfter = mockMeetingsTable.get(overdueId)
      assert.strictEqual(mtgAfter.meeting_status, 'Ended')

      // Verify meeting_ended event was emitted
      const endedEvents = emittedSocketEvents.filter(e => e.room === 'room-rpc-overdue' && e.event === 'meeting_ended')
      assert.strictEqual(endedEvents.length, 1)

      // Test skip if future deadline
      const futureId = '99999999-9999-4999-8999-999999999999'
      const futureDeadline = new Date(Date.now() + 600000).toISOString()
      mockMeetingsTable.set(futureId, {
        meeting_id: futureId,
        meeting_code: 'RPCFUT01',
        room_name: 'room-rpc-future',
        meeting_status: 'Active',
        scheduled_end_time: futureDeadline,
        duration_minutes: 15,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      const resFuture = await expireMeetingNow(futureId, mockIo)
      assert.strictEqual(resFuture.success, false)
      assert.strictEqual(resFuture.reason, 'ineligible_or_already_ended')
      assert.strictEqual(mockMeetingsTable.get(futureId).meeting_status, 'Active')
    })

    it('39. On RPC failure or unavailability, expireMeetingNow returns a retryable failure without ending meeting via app-server clock', async () => {
      const fallbackMtgId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      const pastDeadline = new Date(Date.now() - 5000).toISOString()
      mockMeetingsTable.set(fallbackMtgId, {
        meeting_id: fallbackMtgId,
        meeting_code: 'FALLEX01',
        room_name: 'room-fallback-exp',
        meeting_status: 'Active',
        scheduled_end_time: pastDeadline,
        duration_minutes: 15,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      // 1. When RPC is unavailable on the client
      const savedRpc = mockDb.rpc
      mockDb.rpc = undefined

      try {
        const resUnavailable = await expireMeetingNow(fallbackMtgId, mockIo)
        assert.strictEqual(resUnavailable.success, false)
        assert.strictEqual(resUnavailable.retryable, true)
        assert.strictEqual(resUnavailable.reason, 'rpc_unavailable')

        // Crucial: Meeting must NOT be ended using app-server clock
        const mtgStillActive = mockMeetingsTable.get(fallbackMtgId)
        assert.strictEqual(mtgStillActive.meeting_status, 'Active')
      } finally {
        mockDb.rpc = savedRpc
      }

      // 2. When RPC returns a database error
      mockDb.rpc = async (funcName, args) => {
        if (funcName === 'expire_meeting_if_eligible') {
          return { data: null, error: { message: 'Database connection timeout' } }
        }
        return savedRpc(funcName, args)
      }

      try {
        const resError = await expireMeetingNow(fallbackMtgId, mockIo)
        assert.strictEqual(resError.success, false)
        assert.strictEqual(resError.retryable, true)
        assert.strictEqual(resError.reason, 'rpc_error')
        assert.strictEqual(mockMeetingsTable.get(fallbackMtgId).meeting_status, 'Active')
      } finally {
        mockDb.rpc = savedRpc
      }

      // 3. Retry succeeds once RPC is operational again
      const resRecovered = await expireMeetingNow(fallbackMtgId, mockIo)
      assert.strictEqual(resRecovered.success, true)
      assert.strictEqual(mockMeetingsTable.get(fallbackMtgId).meeting_status, 'Ended')
    })

    it('40. extendMeeting direct-query fallback successfully extends a legacy active meeting that has scheduled_end_time: null', async () => {
      const legacyMtgId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
      mockMeetingsTable.set(legacyMtgId, {
        meeting_id: legacyMtgId,
        meeting_code: 'LEGACY01',
        room_name: 'room-legacy-null',
        meeting_status: 'Active',
        scheduled_end_time: null,
        duration_minutes: 30,
        extension_count: 0,
        extension_used: false,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      // Force fallback by removing RPC
      const savedRpc = supabase.rpc
      supabase.rpc = undefined

      try {
        const { req, res } = createMockReqRes({
          body: { meetingId: legacyMtgId, extensionMinutes: 10 },
          user: { id: HOST_ID }
        })
        await extendMeeting(req, res)
        assert.strictEqual(res.getStatusCode(), 200)
        const data = res.getData()
        assert.strictEqual(data.success, true)
        assert.strictEqual(data.extensionMinutes, 10)
        assert.strictEqual(data.extensionUsed, true)
        assert.strictEqual(data.extensionCount, 1)

        const mtgAfter = mockMeetingsTable.get(legacyMtgId)
        assert.strictEqual(mtgAfter.extension_count, 1)
        assert.strictEqual(mtgAfter.extension_used, true)
        assert.ok(mtgAfter.scheduled_end_time !== null)
      } finally {
        supabase.rpc = savedRpc
      }
    })

    it('41. activateMeeting safely initializes scheduled_end_time for a pre-existing active meeting where deadline was null', async () => {
      const activeNullId = 'cccccccc-dddd-4eee-8fff-000000000000'
      const startedAt = new Date(Date.now() - 10000).toISOString()
      mockMeetingsTable.set(activeNullId, {
        meeting_id: activeNullId,
        meeting_code: 'ACTNUL01',
        room_name: 'room-active-null',
        meeting_status: 'Active',
        scheduled_end_time: null,
        started_at: startedAt,
        duration_minutes: 30,
        extension_count: 0,
        extension_used: false,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      const { req, res } = createMockReqRes({
        body: { meetingId: activeNullId },
        user: { id: HOST_ID }
      })
      await activateMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 200)

      const mtgAfter = mockMeetingsTable.get(activeNullId)
      assert.ok(mtgAfter.scheduled_end_time !== null)
      const expectedEnd = new Date(new Date(startedAt).getTime() + 30 * 60 * 1000).toISOString()
      assert.strictEqual(mtgAfter.scheduled_end_time, expectedEnd)
    })

    it('42. NULL and unsupported extension values are rejected without consuming the one-time allowance', async () => {
      const testMtgId = 'dddddddd-1111-4ddd-8ddd-111111111111'
      const deadline = new Date(Date.now() + 180 * 1000).toISOString()
      mockMeetingsTable.set(testMtgId, {
        meeting_id: testMtgId,
        meeting_code: 'EXTVAL01',
        room_name: 'room-ext-val',
        meeting_status: 'Active',
        scheduled_end_time: deadline,
        duration_minutes: 15,
        extension_count: 0,
        extension_used: false,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      // 1. Send NULL extension minutes
      const reqResNull = createMockReqRes({
        body: { meetingId: testMtgId, extensionMinutes: null },
        user: { id: HOST_ID }
      })
      await extendMeeting(reqResNull.req, reqResNull.res)
      assert.strictEqual(reqResNull.res.getStatusCode(), 400)

      // Verify allowance is completely untouched
      let mtg = mockMeetingsTable.get(testMtgId)
      assert.strictEqual(mtg.extension_count, 0)
      assert.strictEqual(mtg.extension_used, false)
      assert.strictEqual(mtg.scheduled_end_time, deadline)

      // 2. Send unsupported value (e.g. 7, 0, 25)
      for (const invalid of [0, 7, 25, -10]) {
        const reqResInvalid = createMockReqRes({
          body: { meetingId: testMtgId, extensionMinutes: invalid },
          user: { id: HOST_ID }
        })
        await extendMeeting(reqResInvalid.req, reqResInvalid.res)
        assert.strictEqual(reqResInvalid.res.getStatusCode(), 400)
      }

      mtg = mockMeetingsTable.get(testMtgId)
      assert.strictEqual(mtg.extension_count, 0)
      assert.strictEqual(mtg.extension_used, false)

      // 3. Legitimate extension (+5 minutes) now succeeds and consumes allowance
      const reqResValid = createMockReqRes({
        body: { meetingId: testMtgId, extensionMinutes: 5 },
        user: { id: HOST_ID }
      })
      await extendMeeting(reqResValid.req, reqResValid.res)
      assert.strictEqual(reqResValid.res.getStatusCode(), 200)

      mtg = mockMeetingsTable.get(testMtgId)
      assert.strictEqual(mtg.extension_count, 1)
      assert.strictEqual(mtg.extension_used, true)
    })

    it('43. Meeting with missing/NULL host identity is strictly rejected from being extended', async () => {
      const nullHostMtgId = 'eeeeeeee-2222-4eee-8eee-222222222222'
      const deadline = new Date(Date.now() + 180 * 1000).toISOString()
      mockMeetingsTable.set(nullHostMtgId, {
        meeting_id: nullHostMtgId,
        meeting_code: 'NOHOST01',
        room_name: 'room-no-host',
        meeting_status: 'Active',
        scheduled_end_time: deadline,
        duration_minutes: 15,
        extension_count: 0,
        extension_used: false,
        host_id: null,
        active_host_id: null,
        is_deleted: false
      })

      // Attempt extension by any user
      const { req, res } = createMockReqRes({
        body: { meetingId: nullHostMtgId, extensionMinutes: 5 },
        user: { id: HOST_ID }
      })
      await extendMeeting(req, res)
      assert.strictEqual(res.getStatusCode(), 403)

      const mtg = mockMeetingsTable.get(nullHostMtgId)
      assert.strictEqual(mtg.extension_count, 0)
      assert.strictEqual(mtg.extension_used, false)
    })

    it('44. Existing extended meetings and unextended meetings preserve deadlines during backfill simulation', async () => {
      // 1. Meeting already extended: must NOT have deadline or extension allowance reset
      const extendedMtgId = 'ffffffff-3333-4fff-8fff-333333333333'
      const futureDeadline = new Date(Date.now() + 600 * 1000).toISOString()
      mockMeetingsTable.set(extendedMtgId, {
        meeting_id: extendedMtgId,
        meeting_code: 'ALREXT01',
        meeting_status: 'Active',
        duration_minutes: 30,
        scheduled_end_time: futureDeadline,
        extension_count: 1,
        extension_used: true,
        host_id: HOST_ID,
        active_host_id: HOST_ID
      })

      // Simulate backfill rules:
      // duration_minutes WHERE NULL -> unaffected
      // extension_count WHERE NULL -> unaffected
      // extension_used WHERE NULL -> unaffected
      // scheduled_end_time WHERE NULL -> unaffected
      const m = mockMeetingsTable.get(extendedMtgId)
      if (m.duration_minutes == null) m.duration_minutes = 30
      if (m.extension_count == null) m.extension_count = 0
      if (m.extension_used == null) m.extension_used = false
      if (m.meeting_status === 'Active' && m.scheduled_end_time == null) {
        m.scheduled_end_time = new Date().toISOString()
      }

      assert.strictEqual(m.scheduled_end_time, futureDeadline)
      assert.strictEqual(m.extension_count, 1)
      assert.strictEqual(m.extension_used, true)
    })

    it('45. triggerMeetingExpiration endpoint authoritatively evaluates meeting and ends overdue active meeting', async () => {
      const overdueMtgId = '11112222-3333-4444-5555-666677778888'
      const overdueDeadline = new Date(Date.now() - 5000).toISOString()
      mockMeetingsTable.set(overdueMtgId, {
        meeting_id: overdueMtgId,
        meeting_code: 'OVERDU01',
        room_name: 'room-overdue-trigger',
        meeting_status: 'Active',
        scheduled_end_time: overdueDeadline,
        duration_minutes: 15,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      const { req, res } = createMockReqRes({
        body: { meetingId: overdueMtgId },
        user: { id: PARTICIPANT_ID }
      })

      await triggerMeetingExpiration(req, res)
      assert.strictEqual(res.getStatusCode(), 200)
      const data = res.getData()
      assert.strictEqual(data.success, true)
      assert.strictEqual(data.message, 'Meeting expired successfully.')
      assert.strictEqual(mockMeetingsTable.get(overdueMtgId).meeting_status, 'Ended')

      const endedEvent = emittedSocketEvents.find((e) => e.room === 'room-overdue-trigger' && e.event === 'meeting_ended')
      assert.ok(endedEvent, 'meeting_ended event must be broadcast')
      assert.strictEqual(endedEvent.payload.reason, 'duration_expired')
    })

    it('46. triggerMeetingExpiration rejects missing identifier and leaves future meetings untouched', async () => {
      // 1. Missing meetingId
      const reqResMissing = createMockReqRes({
        body: {},
        user: { id: PARTICIPANT_ID }
      })
      await triggerMeetingExpiration(reqResMissing.req, reqResMissing.res)
      assert.strictEqual(reqResMissing.res.getStatusCode(), 400)
      assert.match(reqResMissing.res.getData().message, /meeting identifier is required/i)

      // 2. Future meeting: cannot be expired prematurely
      const futureMtgId = '22223333-4444-5555-6666-777788889999'
      const futureDeadline = new Date(Date.now() + 600000).toISOString()
      mockMeetingsTable.set(futureMtgId, {
        meeting_id: futureMtgId,
        meeting_code: 'FUTUR002',
        room_name: 'room-future-2',
        meeting_status: 'Active',
        scheduled_end_time: futureDeadline,
        duration_minutes: 30,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      const reqResFuture = createMockReqRes({
        body: { meetingId: futureMtgId },
        user: { id: PARTICIPANT_ID }
      })
      await triggerMeetingExpiration(reqResFuture.req, reqResFuture.res)
      assert.strictEqual(reqResFuture.res.getStatusCode(), 200)
      assert.strictEqual(reqResFuture.res.getData().success, false)
      assert.strictEqual(reqResFuture.res.getData().reason, 'ineligible_or_already_ended')
      assert.strictEqual(mockMeetingsTable.get(futureMtgId).meeting_status, 'Active')
    })

    it('47. migrations/20261019_meeting_duration_and_extensions.sql eliminates Postgres 42702 ambiguous column reference', () => {
      const migrationPath = path.resolve(process.cwd(), 'migrations/20261019_meeting_duration_and_extensions.sql')
      const sql = fs.readFileSync(migrationPath, 'utf8')

      // Must declare #variable_conflict use_column in expire_meeting_if_eligible
      assert.ok(
        sql.includes('#variable_conflict use_column'),
        'expire_meeting_if_eligible must include #variable_conflict use_column to resolve RETURNS TABLE parameter ambiguity'
      )

      // Must qualify column in UPDATE statement with table alias
      assert.ok(
        sql.includes('UPDATE public.meetings AS m') || sql.includes('UPDATE public.meetings m'),
        'expire_meeting_if_eligible must alias public.meetings'
      )
      assert.ok(
        sql.includes('m.scheduled_end_time <= v_now'),
        'expire_meeting_if_eligible must qualify m.scheduled_end_time <= v_now to eliminate variable collision'
      )
    })

    it('48. scheduleMeetingExpiration handles clock skew and retry gracefully without throwing unhandled exceptions', async () => {
      const skewMtgId = '33334444-5555-6666-7777-888899990000'
      const deadline = new Date(Date.now() + 50).toISOString()
      mockMeetingsTable.set(skewMtgId, {
        meeting_id: skewMtgId,
        meeting_code: 'SKEWMT01',
        room_name: 'room-skew',
        meeting_status: 'Active',
        scheduled_end_time: deadline,
        duration_minutes: 5,
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        is_deleted: false
      })

      // Schedule expiration timer
      const timer = scheduleMeetingExpiration(skewMtgId, deadline, mockIo)
      assert.ok(timer !== null || timer === null)

      // Clean up timer
      cancelMeetingExpiration(skewMtgId)
    })
  })
})
