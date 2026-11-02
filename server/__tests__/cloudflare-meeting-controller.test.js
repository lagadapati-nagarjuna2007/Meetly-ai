import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import {
  createMeeting,
  joinMeeting,
  endMeeting,
  setCloudflareService,
  resetCloudflareService
} from '../controllers/meetingController.js'
import { supabase } from '../config/supabase.js'

describe('Meetly AI — Phase 2: Cloudflare RealtimeKit Controller Integration Suite', () => {
  const HOST_ID = '11111111-1111-4111-8111-111111111111'
  const PARTICIPANT_ID = '22222222-2222-4222-8222-222222222222'
  const MOCK_CF_MEETING_ID = 'cf-mtg-uuid-12345'
  const MOCK_CF_PARTICIPANT_ID = 'cf-part-uuid-67890'
  const MOCK_CF_TOKEN = 'cf-client-jwt-token-abcdef.123456.mock'
  const SECRET_API_TOKEN = 'super-secret-cloudflare-api-token-should-never-leak'

  let mockMeetingsTable = new Map()
  let mockParticipantsTable = new Map()
  let mockDeviceBansTable = new Map()
  let mockJoinRequestsTable = new Map()
  let mockUsersTable = new Map()
  let originalSupabaseFrom = null
  let originalSupabaseRpc = null
  let origHostPreset = undefined
  let origParticipantPreset = undefined

  // Tracking Cloudflare calls
  let cloudflareCalls = {
    createMeeting: [],
    addParticipant: [],
    endMeeting: [],
    refreshToken: []
  }

  const createMockReqRes = ({ body = {}, params = {}, user = null, app = null } = {}) => {
    const req = {
      body,
      params,
      user,
      headers: {},
      cookies: {},
      app: app || {
        get: (_key) => null
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

  const createMockDatabase = (options = {}) => {
    return {
      from: (table) => {
        let filters = {}
        let updateValues = null
        let insertValues = null
        let inFilters = {}

        const executeInsert = async () => {
          if (options.failDbInsert) {
            return { data: null, error: { code: '500', message: 'Database failure' } }
          }
          if (table === 'participants' && options.failPartInsert) {
            return { data: null, error: { message: 'Database connection failed during participant insert' } }
          }

          const rows = Array.isArray(insertValues) ? insertValues : [insertValues]
          const inserted = []

          for (const row of rows) {
            if (table === 'meetings' && options.missingMeetingCfColumn && row.cloudflare_meeting_id) {
              return {
                data: null,
                error: {
                  code: 'PGRST204',
                  message: "Could not find the 'cloudflare_meeting_id' column of 'meetings' in schema cache"
                }
              }
            }
            if (table === 'participants' && options.missingPartCfColumn && row.cloudflare_participant_id) {
              return {
                data: null,
                error: {
                  code: 'PGRST204',
                  message: "Could not find the 'cloudflare_participant_id' column of 'participants' in schema cache"
                }
              }
            }

            const id = row.meeting_id || row.participant_id || crypto.randomUUID()
            const record = { ...row }
            if (table === 'meetings') {
              record.meeting_id = id
              mockMeetingsTable.set(id, record)
            } else if (table === 'participants') {
              record.participant_id = id
              mockParticipantsTable.set(id, record)
            } else if (table === 'meeting_device_bans') {
              mockDeviceBansTable.set(`${row.meeting_code}:${row.device_fingerprint}`, record)
            } else if (table === 'meeting_join_requests') {
              mockJoinRequestsTable.set(`${row.meeting_code}:${row.user_id}`, record)
            }
            inserted.push(record)
          }

          return { data: inserted[0] || null, error: null }
        }

        const executeUpdate = async () => {
          if (table === 'participants' && options.missingPartCfColumn && updateValues?.cloudflare_participant_id) {
            return {
              data: null,
              error: {
                code: 'PGRST204',
                message: "Could not find the 'cloudflare_participant_id' column of 'participants' in schema cache"
              }
            }
          }

          if (table === 'meetings') {
            for (const [id, m] of mockMeetingsTable.entries()) {
              let match = true
              if (filters.meeting_id && m.meeting_id !== filters.meeting_id) match = false
              if (match) {
                Object.assign(m, updateValues)
                mockMeetingsTable.set(id, m)
                return { data: m, error: null }
              }
            }
          } else if (table === 'participants') {
            for (const [id, p] of mockParticipantsTable.entries()) {
              let match = true
              if (filters.participant_id && p.participant_id !== filters.participant_id) match = false
              if (filters.meeting_id && p.meeting_id !== filters.meeting_id) match = false
              if (filters.user_id && p.user_id !== filters.user_id) match = false
              if (match) {
                Object.assign(p, updateValues)
                mockParticipantsTable.set(id, p)
                return { data: p, error: null }
              }
            }
          }
          return { data: null, error: null }
        }

        const buildUpdateQuery = () => {
          const run = async () => executeUpdate()
          const builder = {
            eq: (field, val) => {
              filters[field] = val
              return builder
            },
            in: (field, array) => {
              inFilters[field] = array
              return builder
            },
            then: (onFulfilled, onRejected) => run().then(onFulfilled, onRejected),
            catch: (onRejected) => run().catch(onRejected)
          }
          return builder
        }

        const buildDeleteQuery = () => {
          const run = async () => {
            if (table === 'meetings') {
              for (const [id, m] of Array.from(mockMeetingsTable.entries())) {
                if (filters.meeting_id && m.meeting_id === filters.meeting_id) mockMeetingsTable.delete(id)
                if (filters.meeting_code && m.meeting_code === filters.meeting_code) mockMeetingsTable.delete(id)
              }
            } else if (table === 'participants') {
              for (const [id, p] of Array.from(mockParticipantsTable.entries())) {
                let match = true
                if (filters.meeting_id && p.meeting_id !== filters.meeting_id) match = false
                if (filters.user_id && p.user_id !== filters.user_id) match = false
                if (match) mockParticipantsTable.delete(id)
              }
            } else if (table === 'meeting_device_bans') {
              for (const [key, b] of Array.from(mockDeviceBansTable.entries())) {
                if (filters.meeting_code && b.meeting_code === filters.meeting_code) mockDeviceBansTable.delete(key)
              }
            } else if (table === 'meeting_join_requests') {
              for (const [key, r] of Array.from(mockJoinRequestsTable.entries())) {
                if (filters.meeting_code && r.meeting_code === filters.meeting_code) mockJoinRequestsTable.delete(key)
              }
            }
            return { error: null }
          }
          const builder = {
            eq: (field, val) => {
              filters[field] = val
              return builder
            },
            in: (field, array) => {
              inFilters[field] = array
              return builder
            },
            then: (onFulfilled, onRejected) => run().then(onFulfilled, onRejected),
            catch: (onRejected) => run().catch(onRejected)
          }
          return builder
        }

        const query = {
          select: (_cols) => query,
          eq: (field, val) => {
            filters[field] = val
            return query
          },
          in: (field, array) => {
            inFilters[field] = array
            return query
          },
          lt: (_field, _val) => query,
          insert: (values) => {
            insertValues = values
            return {
              select: () => ({
                single: executeInsert,
                maybeSingle: executeInsert
              }),
              single: executeInsert,
              maybeSingle: executeInsert,
              then: (onFulfilled, onRejected) => executeInsert().then(onFulfilled, onRejected),
              catch: (onRejected) => executeInsert().catch(onRejected)
            }
          },
          update: (values) => {
            updateValues = values
            return buildUpdateQuery()
          },
          delete: () => buildDeleteQuery(),
          single: async () => query.maybeSingle(),
          maybeSingle: async () => {
            if (table === 'meetings') {
              for (const m of mockMeetingsTable.values()) {
                let match = true
                if (filters.meeting_code && m.meeting_code !== filters.meeting_code) match = false
                if (filters.meeting_id && m.meeting_id !== filters.meeting_id) match = false
                if (filters.is_deleted !== undefined && m.is_deleted !== filters.is_deleted) match = false
                if (match) return { data: { ...m }, error: null }
              }
              return { data: null, error: null }
            }
            if (table === 'participants') {
              for (const p of mockParticipantsTable.values()) {
                let match = true
                if (filters.meeting_id && p.meeting_id !== filters.meeting_id) match = false
                if (filters.user_id && p.user_id !== filters.user_id) match = false
                if (filters.participant_id && p.participant_id !== filters.participant_id) match = false
                if (match) return { data: { ...p }, error: null }
              }
              return { data: null, error: null }
            }
            if (table === 'users') {
              const u = mockUsersTable.get(filters.id)
              return { data: u ? { ...u } : null, error: null }
            }
            if (table === 'meeting_device_bans') {
              const key = `${filters.meeting_code}:${filters.device_fingerprint}`
              const b = mockDeviceBansTable.get(key)
              return { data: b ? { ...b } : null, error: null }
            }
            if (table === 'meeting_join_requests') {
              const key = `${filters.meeting_code}:${filters.user_id}`
              const r = mockJoinRequestsTable.get(key)
              return { data: r ? { ...r } : null, error: null }
            }
            return { data: null, error: null }
          },
          then: async (onFulfilled, onRejected) => {
            if (table === 'participants') {
              const list = []
              for (const p of mockParticipantsTable.values()) {
                let match = true
                if (filters.user_id && p.user_id !== filters.user_id) match = false
                if (filters.participant_status && p.participant_status !== filters.participant_status) match = false
                if (match) list.push({ ...p, meetings: mockMeetingsTable.get(p.meeting_id) })
              }
              return Promise.resolve({ data: list, error: null }).then(onFulfilled, onRejected)
            }
            if (table === 'meetings') {
              const list = Array.from(mockMeetingsTable.values())
              return Promise.resolve({ data: list, error: null }).then(onFulfilled, onRejected)
            }
            return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected)
          }
        }

        return query
      }
    }
  }

  beforeEach(() => {
    origHostPreset = process.env.CLOUDFLARE_REALTIME_HOST_PRESET
    origParticipantPreset = process.env.CLOUDFLARE_REALTIME_PARTICIPANT_PRESET
    mockMeetingsTable.clear()
    mockParticipantsTable.clear()
    mockDeviceBansTable.clear()
    mockJoinRequestsTable.clear()
    mockUsersTable.clear()

    cloudflareCalls = {
      createMeeting: [],
      addParticipant: [],
      endMeeting: [],
      refreshToken: []
    }

    mockUsersTable.set(HOST_ID, {
      id: HOST_ID,
      full_name: 'Dr. Host User',
      email: 'host@meetly.ai'
    })
    mockUsersTable.set(PARTICIPANT_ID, {
      id: PARTICIPANT_ID,
      full_name: 'Alice Student',
      email: 'student@meetly.ai'
    })

    originalSupabaseFrom = supabase.from
    originalSupabaseRpc = supabase.rpc
    supabase.from = createMockDatabase().from
    supabase.rpc = async (fn, args) => {
      if (fn === 'auto_admit_participant_tx') {
        const { p_meeting_code, p_user_id, p_device_fingerprint, p_role } = args
        const banKey = `${p_meeting_code}:${p_device_fingerprint}`
        if (mockDeviceBansTable.has(banKey)) {
          return {
            data: null,
            error: { message: 'Cannot admit participant: this device is banned from the meeting' }
          }
        }
        const part = Array.from(mockParticipantsTable.values()).find(p => p.user_id === p_user_id)
        if (part && part.participant_status === 'removed') {
          return {
            data: null,
            error: { message: 'Cannot admit participant: user has been removed from this meeting' }
          }
        }
        if (part?.device_fingerprint) {
          const partBanKey = `${p_meeting_code}:${part.device_fingerprint}`
          if (mockDeviceBansTable.has(partBanKey)) {
            return {
              data: null,
              error: { message: 'Cannot admit participant: this device is banned from the meeting' }
            }
          }
        }
        let meetingId = 'mtg-test-id'
        for (const m of mockMeetingsTable.values()) {
          if (m.meeting_code === p_meeting_code) {
            meetingId = m.meeting_id
            break
          }
        }
        const partId = part?.participant_id || `part-${p_user_id}`
        const updatedPart = {
          ...(part || {}),
          participant_id: partId,
          meeting_id: meetingId,
          user_id: p_user_id,
          role: p_role || part?.role || 'participant',
          participant_status: 'joined',
          device_fingerprint: p_device_fingerprint,
          joined_at: new Date().toISOString()
        }
        mockParticipantsTable.set(partId, updatedPart)
        return { data: { participant_id: partId, status: 'joined', role: updatedPart.role }, error: null }
      }
      if (fn === 'create_join_request_tx') {
        const { p_meeting_code, p_user_id, p_device_fingerprint } = args
        const banKey = `${p_meeting_code}:${p_device_fingerprint}`
        if (mockDeviceBansTable.has(banKey)) {
          return {
            data: null,
            error: { message: 'Cannot join: this device is banned from the meeting' }
          }
        }
        const reqKey = `${p_meeting_code}:${p_user_id}`
        if (mockJoinRequestsTable.has(reqKey)) {
          return { data: { request_id: 'req-existing', status: 'pending', is_duplicate: true }, error: null }
        }
        mockJoinRequestsTable.set(reqKey, {
          id: 'req-new',
          meeting_code: p_meeting_code,
          user_id: p_user_id,
          device_fingerprint: p_device_fingerprint,
          status: 'pending'
        })
        return { data: { request_id: 'req-new', status: 'pending', is_duplicate: false }, error: null }
      }
      return { data: null, error: { message: `Unknown RPC ${fn}` } }
    }
  })

  afterEach(() => {
    if (originalSupabaseFrom) {
      supabase.from = originalSupabaseFrom
    }
    if (originalSupabaseRpc) {
      supabase.rpc = originalSupabaseRpc
    }
    resetCloudflareService()
    if (origHostPreset !== undefined) {
      process.env.CLOUDFLARE_REALTIME_HOST_PRESET = origHostPreset
    } else {
      delete process.env.CLOUDFLARE_REALTIME_HOST_PRESET
    }
    if (origParticipantPreset !== undefined) {
      process.env.CLOUDFLARE_REALTIME_PARTICIPANT_PRESET = origParticipantPreset
    } else {
      delete process.env.CLOUDFLARE_REALTIME_PARTICIPANT_PRESET
    }
  })

  // =========================================================================
  // 1. CREATE MEETING INTEGRATION TESTS
  // =========================================================================
  describe('createMeeting — Cloudflare RealtimeKit Integration', () => {
    it('1. Successfully creates Cloudflare meeting, enrolls host with host preset, and stores IDs in Supabase', async () => {
      // Explicitly test default fallback preset when CLOUDFLARE_REALTIME_HOST_PRESET is unset
      delete process.env.CLOUDFLARE_REALTIME_HOST_PRESET

      setCloudflareService({
        isConfigured: () => true,
        createMeeting: async (params) => {
          cloudflareCalls.createMeeting.push(params)
          return {
            id: MOCK_CF_MEETING_ID,
            title: params.title,
            status: 'ACTIVE'
          }
        },
        addParticipant: async (meetingId, params) => {
          cloudflareCalls.addParticipant.push({ meetingId, params })
          return {
            participantId: MOCK_CF_PARTICIPANT_ID,
            token: MOCK_CF_TOKEN,
            name: params.name,
            presetName: params.presetName
          }
        }
      })

      const { req, res } = createMockReqRes({
        body: { meetingTitle: 'Biochemistry 101', durationMinutes: 30, meetingType: 'public' },
        user: { id: HOST_ID, email: 'host@meetly.ai' }
      })

      await createMeeting(req, res)

      assert.strictEqual(res.getStatusCode(), 200)
      const data = res.getData()

      // Returned data structure
      assert.strictEqual(data.cloudflareMeetingId, MOCK_CF_MEETING_ID)
      assert.strictEqual(data.cloudflareToken, MOCK_CF_TOKEN)
      assert.strictEqual(data.cloudflareParticipantId, MOCK_CF_PARTICIPANT_ID)
      assert.ok(data.meetingCode)
      assert.ok(data.meetingId)
      assert.strictEqual(data.livekitToken, undefined, 'LiveKit token must not be generated')

      // Cloudflare helper call assertions
      assert.strictEqual(cloudflareCalls.createMeeting.length, 1)
      assert.strictEqual(cloudflareCalls.createMeeting[0].title, 'Biochemistry 101')

      assert.strictEqual(cloudflareCalls.addParticipant.length, 1)
      assert.strictEqual(cloudflareCalls.addParticipant[0].meetingId, MOCK_CF_MEETING_ID)
      assert.strictEqual(cloudflareCalls.addParticipant[0].params.presetName, 'meetly-host')
      assert.strictEqual(cloudflareCalls.addParticipant[0].params.name, 'Dr. Host User')
      assert.strictEqual(cloudflareCalls.addParticipant[0].params.customParticipantId, HOST_ID)

      // Supabase record persistence
      const savedMtg = mockMeetingsTable.get(data.meetingId)
      assert.strictEqual(savedMtg.cloudflare_meeting_id, MOCK_CF_MEETING_ID)
      assert.strictEqual(savedMtg.duration_minutes, 30)
      assert.strictEqual(savedMtg.meeting_status, 'Waiting')

      const savedHostPart = Array.from(mockParticipantsTable.values()).find(
        (p) => p.meeting_id === data.meetingId && p.user_id === HOST_ID
      )
      assert.ok(savedHostPart)
      assert.strictEqual(savedHostPart.cloudflare_participant_id, MOCK_CF_PARTICIPANT_ID)
      assert.strictEqual(savedHostPart.role, 'host')

      // Security check: NEVER expose API token
      const resString = JSON.stringify(data)
      assert.ok(!resString.includes(SECRET_API_TOKEN))
    })

    it('1b. Successfully enrolls host with custom configured CLOUDFLARE_REALTIME_HOST_PRESET', async () => {
      process.env.CLOUDFLARE_REALTIME_HOST_PRESET = 'custom_call_host'

      setCloudflareService({
        isConfigured: () => true,
        createMeeting: async (params) => {
          cloudflareCalls.createMeeting.push(params)
          return {
            id: MOCK_CF_MEETING_ID,
            title: params.title,
            status: 'ACTIVE'
          }
        },
        addParticipant: async (meetingId, params) => {
          cloudflareCalls.addParticipant.push({ meetingId, params })
          return {
            participantId: MOCK_CF_PARTICIPANT_ID,
            token: MOCK_CF_TOKEN,
            name: params.name,
            presetName: params.presetName
          }
        }
      })

      const { req, res } = createMockReqRes({
        body: { meetingTitle: 'Biochemistry 102', durationMinutes: 30, meetingType: 'public' },
        user: { id: HOST_ID, email: 'host@meetly.ai' }
      })

      await createMeeting(req, res)

      assert.strictEqual(res.getStatusCode(), 200)
      assert.strictEqual(cloudflareCalls.addParticipant.length, 1)
      assert.strictEqual(cloudflareCalls.addParticipant[0].params.presetName, 'custom_call_host')
    })

    it('2. Returns HTTP 502 and preserves DB consistency when Cloudflare meeting creation fails', async () => {
      setCloudflareService({
        isConfigured: () => true,
        createMeeting: async () => {
          const err = new Error('Cloudflare API 500: Rate limit exceeded')
          err.code = 'CLOUDFLARE_RATE_LIMIT'
          throw err
        }
      })

      const { req, res } = createMockReqRes({
        body: { meetingTitle: 'Math 202', durationMinutes: 15 },
        user: { id: HOST_ID }
      })

      await createMeeting(req, res)

      assert.strictEqual(res.getStatusCode(), 502)
      assert.match(res.getData().message, /Cloudflare RealtimeKit meeting creation failed/i)
      assert.strictEqual(mockMeetingsTable.size, 0, 'No meeting should be inserted in DB')
      assert.strictEqual(mockParticipantsTable.size, 0, 'No participant should be inserted in DB')
    })

    it('3. Cleans up orphaned Cloudflare meeting if host enrollment fails after meeting creation', async () => {
      setCloudflareService({
        isConfigured: () => true,
        createMeeting: async () => ({
          id: MOCK_CF_MEETING_ID,
          title: 'Physics Lab'
        }),
        addParticipant: async () => {
          throw new Error('Cloudflare API: Preset not found')
        },
        endMeeting: async (id) => {
          cloudflareCalls.endMeeting.push(id)
          return { success: true }
        }
      })

      const { req, res } = createMockReqRes({
        body: { meetingTitle: 'Physics Lab', durationMinutes: 40 },
        user: { id: HOST_ID }
      })

      await createMeeting(req, res)

      assert.strictEqual(res.getStatusCode(), 502)
      assert.strictEqual(cloudflareCalls.endMeeting.length, 1, 'Orphaned Cloudflare meeting must be cleaned up')
      assert.strictEqual(cloudflareCalls.endMeeting[0], MOCK_CF_MEETING_ID)
      assert.strictEqual(mockMeetingsTable.size, 0)
    })

    it('4. Cleans up orphaned Cloudflare meeting and rolls back DB if participant insert fails', async () => {
      supabase.from = createMockDatabase({ failPartInsert: true }).from

      setCloudflareService({
        isConfigured: () => true,
        createMeeting: async () => ({ id: MOCK_CF_MEETING_ID }),
        addParticipant: async () => ({ participantId: MOCK_CF_PARTICIPANT_ID, token: MOCK_CF_TOKEN }),
        endMeeting: async (id) => {
          cloudflareCalls.endMeeting.push(id)
          return { success: true }
        }
      })

      const { req, res } = createMockReqRes({
        body: { meetingTitle: 'Rollback Test', durationMinutes: 5 },
        user: { id: HOST_ID }
      })

      await createMeeting(req, res)

      assert.strictEqual(res.getStatusCode(), 500)
      assert.strictEqual(cloudflareCalls.endMeeting.length, 1, 'Cloudflare room must be deactivated on DB failure')
      assert.strictEqual(cloudflareCalls.endMeeting[0], MOCK_CF_MEETING_ID)
      assert.strictEqual(mockMeetingsTable.size, 0, 'Meeting DB row must be rolled back')
    })

    it('5. In-flight concurrency lock prevents duplicate meeting creation on rapid retries', async () => {
      let resolveFirstCall = null
      const gate = new Promise((r) => {
        resolveFirstCall = r
      })

      setCloudflareService({
        isConfigured: () => true,
        createMeeting: async () => {
          await gate
          return { id: MOCK_CF_MEETING_ID }
        },
        addParticipant: async () => ({ participantId: MOCK_CF_PARTICIPANT_ID, token: MOCK_CF_TOKEN })
      })

      const first = createMockReqRes({
        body: { meetingTitle: 'Concurrent Call 1', durationMinutes: 15 },
        user: { id: HOST_ID }
      })
      const second = createMockReqRes({
        body: { meetingTitle: 'Concurrent Call 2', durationMinutes: 15 },
        user: { id: HOST_ID }
      })

      // Launch first call (holds in-flight lock while waiting on gate)
      const firstPromise = createMeeting(first.req, first.res)

      // Immediately attempt second call with same user ID
      await createMeeting(second.req, second.res)

      assert.strictEqual(second.res.getStatusCode(), 409)
      assert.match(second.res.getData().message, /already in progress/i)

      // Let first call finish
      resolveFirstCall()
      await firstPromise

      assert.strictEqual(first.res.getStatusCode(), 200)
    })

    it('6. Schema backwards-compatibility: gracefully retries without cloudflare columns if not yet present in DB', async () => {
      supabase.from = createMockDatabase({
        missingMeetingCfColumn: true,
        missingPartCfColumn: true
      }).from

      setCloudflareService({
        isConfigured: () => true,
        createMeeting: async () => ({ id: MOCK_CF_MEETING_ID }),
        addParticipant: async () => ({ participantId: MOCK_CF_PARTICIPANT_ID, token: MOCK_CF_TOKEN })
      })

      const { req, res } = createMockReqRes({
        body: { meetingTitle: 'Schema Fallback Meeting', durationMinutes: 30 },
        user: { id: HOST_ID }
      })

      await createMeeting(req, res)

      // Should succeed despite missing DB columns
      assert.strictEqual(res.getStatusCode(), 200)
      const data = res.getData()
      assert.strictEqual(data.cloudflareMeetingId, MOCK_CF_MEETING_ID)
      assert.strictEqual(data.cloudflareToken, MOCK_CF_TOKEN)
      assert.strictEqual(mockMeetingsTable.size, 1)
    })

    it('7. When Cloudflare is NOT configured, meeting creation fails because LiveKit is removed', async () => {
      setCloudflareService({
        isConfigured: () => false
      })

      const { req, res } = createMockReqRes({
        body: { meetingTitle: 'Unconfigured Meeting', durationMinutes: 30 },
        user: { id: HOST_ID }
      })

      await createMeeting(req, res)

      assert.strictEqual(res.getStatusCode(), 500)
      const data = res.getData()
      assert.match(data.message, /Cloudflare RealtimeKit credentials missing/)
    })
  })

  // =========================================================================
  // 2. JOIN MEETING INTEGRATION TESTS
  // =========================================================================
  describe('joinMeeting — Cloudflare RealtimeKit Integration', () => {
    const MEETING_CODE = 'TESTCODE'
    const MEETING_UUID = '55555555-5555-4555-8555-555555555555'

    beforeEach(() => {
      mockMeetingsTable.set(MEETING_UUID, {
        meeting_id: MEETING_UUID,
        meeting_code: MEETING_CODE,
        room_name: 'livekit-room-uuid',
        meeting_title: 'Calculus II',
        host_id: HOST_ID,
        meeting_status: 'Active',
        is_deleted: false,
        duration_minutes: 30,
        cloudflare_meeting_id: MOCK_CF_MEETING_ID,
        auto_admit: true
      })
    })

    it('8. Successfully joins meeting, enrolls participant with participant preset, and updates participant ID in DB', async () => {
      // Explicitly test default fallback preset when CLOUDFLARE_REALTIME_PARTICIPANT_PRESET is unset
      delete process.env.CLOUDFLARE_REALTIME_PARTICIPANT_PRESET

      setCloudflareService({
        isConfigured: () => true,
        addParticipant: async (meetingId, params) => {
          cloudflareCalls.addParticipant.push({ meetingId, params })
          return {
            participantId: 'cf-part-alice-999',
            token: 'cf-alice-jwt-token'
          }
        }
      })

      const { req, res } = createMockReqRes({
        body: {
          meetingCode: MEETING_CODE,
          deviceFingerprint: 'fingerprint_alice_12345'
        },
        user: { id: PARTICIPANT_ID, email: 'student@meetly.ai' }
      })

      await joinMeeting(req, res)

      assert.strictEqual(res.getStatusCode(), 200)
      const data = res.getData()

      assert.strictEqual(data.cloudflareMeetingId, MOCK_CF_MEETING_ID)
      assert.strictEqual(data.cloudflareToken, 'cf-alice-jwt-token')
      assert.strictEqual(data.cloudflareParticipantId, 'cf-part-alice-999')
      assert.strictEqual(data.token, undefined, 'LiveKit token must not be returned')

      // Cloudflare helper assertion
      assert.strictEqual(cloudflareCalls.addParticipant.length, 1)
      assert.strictEqual(cloudflareCalls.addParticipant[0].meetingId, MOCK_CF_MEETING_ID)
      assert.strictEqual(cloudflareCalls.addParticipant[0].params.presetName, 'meetly-participant')
      assert.strictEqual(cloudflareCalls.addParticipant[0].params.customParticipantId, PARTICIPANT_ID)
      assert.strictEqual(cloudflareCalls.addParticipant[0].params.name, 'Alice Student')

      // DB check
      const part = Array.from(mockParticipantsTable.values()).find(
        (p) => p.meeting_id === MEETING_UUID && p.user_id === PARTICIPANT_ID
      )
      assert.ok(part)
      assert.strictEqual(part.cloudflare_participant_id, 'cf-part-alice-999')
      assert.strictEqual(part.participant_status, 'joined')

      // Security check: NEVER expose API token
      assert.ok(!JSON.stringify(data).includes(SECRET_API_TOKEN))
    })

    it('8b. Enrolls participant with custom configured CLOUDFLARE_REALTIME_PARTICIPANT_PRESET', async () => {
      process.env.CLOUDFLARE_REALTIME_PARTICIPANT_PRESET = 'custom_call_participant'

      setCloudflareService({
        isConfigured: () => true,
        addParticipant: async (meetingId, params) => {
          cloudflareCalls.addParticipant.push({ meetingId, params })
          return {
            participantId: 'cf-part-alice-999',
            token: 'cf-alice-jwt-token'
          }
        }
      })

      const { req, res } = createMockReqRes({
        body: {
          meetingCode: MEETING_CODE,
          deviceFingerprint: 'fingerprint_alice_12345'
        },
        user: { id: PARTICIPANT_ID, email: 'student@meetly.ai' }
      })

      await joinMeeting(req, res)

      assert.strictEqual(res.getStatusCode(), 200)
      assert.strictEqual(cloudflareCalls.addParticipant.length, 1)
      assert.strictEqual(cloudflareCalls.addParticipant[0].params.presetName, 'custom_call_participant')
    })

    it('9. Returns HTTP 502 if Cloudflare participant enrollment fails, preserving DB integrity', async () => {
      setCloudflareService({
        isConfigured: () => true,
        addParticipant: async () => {
          throw new Error('Cloudflare API: Meeting capacity reached')
        }
      })

      const { req, res } = createMockReqRes({
        body: {
          meetingCode: MEETING_CODE,
          deviceFingerprint: 'fingerprint_alice_12345'
        },
        user: { id: PARTICIPANT_ID }
      })

      await joinMeeting(req, res)

      assert.strictEqual(res.getStatusCode(), 502)
      assert.match(res.getData().message, /Failed to enroll in Cloudflare RealtimeKit session/i)

      // DB integrity: Participant should not be in 'joined' status
      const part = Array.from(mockParticipantsTable.values()).find(
        (p) => p.meeting_id === MEETING_UUID && p.user_id === PARTICIPANT_ID
      )
      assert.strictEqual(part, undefined)
    })

    it('10. Enforces meeting rejection rules: Ended (410), Locked (400), Banned device (403)', async () => {
      // 1. Ended
      const endedMtg = mockMeetingsTable.get(MEETING_UUID)
      endedMtg.meeting_status = 'Ended'

      const reqResEnded = createMockReqRes({
        body: { meetingCode: MEETING_CODE, deviceFingerprint: 'valid_fingerprint_123' },
        user: { id: PARTICIPANT_ID }
      })
      await joinMeeting(reqResEnded.req, reqResEnded.res)
      assert.strictEqual(reqResEnded.res.getStatusCode(), 410)

      // 2. Locked
      endedMtg.meeting_status = 'Locked'
      const reqResLocked = createMockReqRes({
        body: { meetingCode: MEETING_CODE, deviceFingerprint: 'valid_fingerprint_123' },
        user: { id: PARTICIPANT_ID }
      })
      await joinMeeting(reqResLocked.req, reqResLocked.res)
      assert.strictEqual(reqResLocked.res.getStatusCode(), 400)

      // 3. Banned device
      endedMtg.meeting_status = 'Active'
      mockDeviceBansTable.set(`${MEETING_CODE}:banned_fp_12345`, {
        meeting_code: MEETING_CODE,
        device_fingerprint: 'banned_fp_12345'
      })
      const reqResBanned = createMockReqRes({
        body: { meetingCode: MEETING_CODE, deviceFingerprint: 'banned_fp_12345' },
        user: { id: PARTICIPANT_ID }
      })
      await joinMeeting(reqResBanned.req, reqResBanned.res)
      assert.strictEqual(reqResBanned.res.getStatusCode(), 403)
      assert.match(reqResBanned.res.getData().message, /blocked by the meeting host/i)
    })

    it('11. Lazily provisions Cloudflare meeting if host rejoins a meeting without cloudflare_meeting_id', async () => {
      // Remove cloudflare_meeting_id from existing meeting
      const mtg = mockMeetingsTable.get(MEETING_UUID)
      delete mtg.cloudflare_meeting_id

      setCloudflareService({
        isConfigured: () => true,
        createMeeting: async (params) => {
          cloudflareCalls.createMeeting.push(params)
          return { id: 'lazily-created-cf-mtg' }
        },
        addParticipant: async (meetingId, params) => {
          cloudflareCalls.addParticipant.push({ meetingId, params })
          return { participantId: 'host-part-cf', token: 'host-token-cf' }
        }
      })

      const { req, res } = createMockReqRes({
        body: { meetingCode: MEETING_CODE, deviceFingerprint: 'host_fingerprint_123' },
        user: { id: HOST_ID }
      })

      await joinMeeting(req, res)

      assert.strictEqual(res.getStatusCode(), 200)
      assert.strictEqual(cloudflareCalls.createMeeting.length, 1)
      assert.strictEqual(res.getData().cloudflareMeetingId, 'lazily-created-cf-mtg')
      assert.strictEqual(res.getData().cloudflareToken, 'host-token-cf')
    })
  })

  // =========================================================================
  // 3. END MEETING INTEGRATION TESTS
  // =========================================================================
  describe('endMeeting — Cloudflare RealtimeKit Deactivation', () => {
    const MEETING_CODE = 'ENDTEST1'
    const MEETING_UUID = '77777777-7777-4777-8777-777777777777'

    it('12. Deactivates Cloudflare RealtimeKit meeting room when host ends meeting', async () => {
      mockMeetingsTable.set(MEETING_UUID, {
        meeting_id: MEETING_UUID,
        meeting_code: MEETING_CODE,
        room_name: 'livekit-room-uuid',
        host_id: HOST_ID,
        active_host_id: HOST_ID,
        meeting_status: 'Active',
        is_deleted: false,
        cloudflare_meeting_id: MOCK_CF_MEETING_ID
      })

      setCloudflareService({
        isConfigured: () => true,
        endMeeting: async (id) => {
          cloudflareCalls.endMeeting.push(id)
          return { success: true }
        }
      })

      const { req, res } = createMockReqRes({
        body: { meetingId: MEETING_UUID },
        user: { id: HOST_ID }
      })

      await endMeeting(req, res)

      assert.strictEqual(res.getStatusCode(), 200)
      assert.strictEqual(cloudflareCalls.endMeeting.length, 1)
      assert.strictEqual(cloudflareCalls.endMeeting[0], MOCK_CF_MEETING_ID)
      assert.strictEqual(mockMeetingsTable.get(MEETING_UUID).meeting_status, 'Ended')
    })
  })
})
