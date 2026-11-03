import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { Server } from 'socket.io'
import { io as ClientIO } from 'socket.io-client'

process.env.NODE_ENV = 'test'
const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-meetly-2026'
process.env.JWT_SECRET = TEST_JWT_SECRET

import { setupSocketServer, isUserHostOrCoHost } from '../server.js'
import { resetAllMeetingChats, CHAT_POLICIES } from '../services/meetingChatService.js'
import { cancelCleanup } from '../services/meetingCleanup.js'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  getPendingRevocations,
  recoverPendingRevocations,
  clearPendingRevocations,
  setStoragePath,
  resetStoragePath,
  isConfirmedParticipantNotFound,
  setDatabaseClient,
  resetDatabaseClient,
  stopRemovalWorker
} from '../services/participantRemovalService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TEST_STORAGE_PATH = path.resolve(__dirname, '../data/test_pending_revocations.json')

describe('Meetly AI — Socket.IO Security & Authorization Matrix', () => {
  let httpServer
  let ioServer
  let serverPort
  let socketState
  let activeClients = []

  // Mock Database State
  let meetingsTable = new Map()
  let participantsTable = new Map() // key: `${meeting_id}:${user_id}`
  let usersTable = new Map()
  let deviceBansTable = new Map() // key: `${meeting_code}:${device_fingerprint}`

  // Mock Cloudflare Service Tracking
  let cfCalls = []
  let cfMockShouldFail = false
  let cfFailCount = 0

  const mockCfService = {
    isConfigured: () => true,
    removeParticipant: async (meetingId, participantId) => {
      cfCalls.push({ meetingId, participantId })
      if (cfMockShouldFail) {
        const err = new Error('Cloudflare upstream connection timeout')
        err.status = 504
        throw err
      }
      if (cfFailCount > 0) {
        cfFailCount--
        const err = new Error('Cloudflare temporary 500 error')
        err.status = 500
        throw err
      }
      return { success: true, meetingId, participantId }
    }
  }

  const ROOM_NAME = 'room-sec-test-1234'
  const MEETING_CODE = 'SEC-TEST'
  const MEETING_ID = 'meeting-sec-uuid-1111'
  const CF_MEETING_ID = 'cf-mtg-test-1111'
  const HOST_ID = 'host-user-uuid-1111'
  const COHOST_ID = 'cohost-user-uuid-2222'
  const PARTICIPANT_A = 'participant-user-uuid-aaaa'
  const PARTICIPANT_B = 'participant-user-uuid-bbbb'
  const STRANGER_USER = 'stranger-user-uuid-9999'

  const removalJobsTable = new Map()

  // Mock Supabase Client supporting select, maybeSingle, update, insert, delete, and RPC execution
  const mockDb = {
    from: (table) => {
      let currentTable = table
      let conditions = []
      let updatePayload = null
      let insertPayload = null
      let isDelete = false
      let isSingle = false

      const executeQuery = () => {
        if (currentTable === 'meetings') {
          for (const m of meetingsTable.values()) {
            const match = conditions.every((c) => {
              const rowVal = String(m[c.col] || '').toLowerCase()
              return rowVal === c.val
            })
            if (match) {
              if (updatePayload) {
                Object.assign(m, updatePayload)
              }
              return { data: { ...m }, error: null }
            }
          }
          return { data: null, error: null }
        }

        if (currentTable === 'participants') {
          for (const p of participantsTable.values()) {
            const match = conditions.every((c) => {
              const rowVal = String(p[c.col] || '').toLowerCase()
              return rowVal === c.val
            })
            if (match) {
              if (updatePayload) {
                Object.assign(p, updatePayload)
              }
              return { data: { ...p }, error: null }
            }
          }
          return { data: null, error: null }
        }

        if (currentTable === 'users') {
          const userCond = conditions.find((c) => c.col === 'id')
          if (userCond && usersTable.has(userCond.val)) {
            return { data: { ...usersTable.get(userCond.val) }, error: null }
          }
          return { data: null, error: null }
        }

        if (currentTable === 'meeting_device_bans') {
          for (const b of deviceBansTable.values()) {
            const match = conditions.every((c) => {
              const rowVal = String(b[c.col] || '').toLowerCase()
              return rowVal === c.val
            })
            if (match) {
              return { data: { ...b }, error: null }
            }
          }
          return { data: null, error: null }
        }

        if (currentTable === 'participant_removal_jobs') {
          if (insertPayload) {
            const items = Array.isArray(insertPayload) ? insertPayload : [insertPayload]
            const inserted = []
            for (const item of items) {
              const key = `${item.meeting_id}:${item.user_id}`.toLowerCase()
              const row = {
                id: item.id || 'job-uuid-' + Math.random().toString(36).slice(2),
                ...item,
                status: item.status || 'pending',
                created_at: item.created_at || new Date().toISOString(),
                updated_at: new Date().toISOString()
              }
              removalJobsTable.set(key, row)
              inserted.push(row)
            }
            return { data: isSingle ? inserted[0] : inserted, error: null }
          }

          const results = []
          for (const j of removalJobsTable.values()) {
            const match = conditions.every((c) => {
              const rowVal = String(j[c.col] || '').toLowerCase()
              if (c.op === 'in') {
                return c.val.map((v) => String(v).toLowerCase()).includes(rowVal)
              }
              return rowVal === c.val
            })
            if (match) {
              if (updatePayload) {
                Object.assign(j, updatePayload)
              }
              results.push({ ...j })
            }
          }

          if (isDelete) {
            for (const r of results) {
              removalJobsTable.delete(`${r.meeting_id}:${r.user_id}`.toLowerCase())
            }
            return { data: results, error: null }
          }

          return { data: isSingle ? (results[0] || null) : results, error: null }
        }

        return { data: null, error: null }
      }

      const builder = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: (col, val) => {
          conditions.push({ col, val: String(val).toLowerCase(), op: 'eq' })
          return builder
        },
        in: (col, vals) => {
          conditions.push({ col, val: vals, op: 'in' })
          return builder
        },
        delete: () => {
          isDelete = true
          return builder
        },
        insert: (data) => {
          insertPayload = data
          return builder
        },
        update: (data) => {
          updatePayload = data
          return builder
        },
        maybeSingle: async () => {
          isSingle = true
          return executeQuery()
        },
        then: (onResolve, onReject) => {
          try {
            const res = executeQuery()
            return Promise.resolve(res).then(onResolve, onReject)
          } catch (e) {
            return Promise.reject(e).then(onResolve, onReject)
          }
        }
      }
      return builder
    },

    rpc: async (funcName, params) => {
      if (funcName === 'create_participant_removal_job_tx') {
        const { p_meeting_id, p_user_id, p_cloudflare_meeting_id, p_cloudflare_participant_id } = params
        const partKey = `${p_meeting_id}:${p_user_id}`.toLowerCase()
        const part = participantsTable.get(partKey)
        if (part) {
          part.participant_status = 'removed'
          part.left_at = new Date().toISOString()
        }
        let job = removalJobsTable.get(partKey)
        if (job && job.status === 'completed') {
          return { data: [{ ...job }], error: null }
        }
        if (!job) {
          job = {
            id: 'job-uuid-' + Math.random().toString(36).slice(2),
            meeting_id: p_meeting_id,
            user_id: p_user_id,
            cloudflare_meeting_id: p_cloudflare_meeting_id,
            cloudflare_participant_id: p_cloudflare_participant_id,
            status: 'pending',
            attempts: 0,
            next_retry_at: new Date().toISOString(),
            last_error: null,
            lease_expires_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: null
          }
          removalJobsTable.set(partKey, job)
        } else {
          job.status = 'pending'
          job.attempts = 0
          job.next_retry_at = new Date().toISOString()
          job.updated_at = new Date().toISOString()
        }
        return { data: [{ ...job }], error: null }
      }

      if (funcName === 'claim_participant_removal_jobs_tx') {
        const claimed = []
        for (const j of removalJobsTable.values()) {
          if (
            j.status === 'pending' ||
            (j.status === 'processing' && j.lease_expires_at && new Date(j.lease_expires_at) <= new Date())
          ) {
            j.status = 'processing'
            j.attempts = (j.attempts || 0) + 1
            j.lease_expires_at = new Date(Date.now() + (params?.p_lease_seconds || 60) * 1000).toISOString()
            j.lease_token = 'lease-uuid-' + Math.random().toString(36).slice(2)
            const mtg = meetingsTable.get(j.meeting_id)
            claimed.push({
              ...j,
              meeting_code: mtg?.meeting_code || 'SEC-TEST',
              room_name: mtg?.room_name || 'room-sec-test-1234'
            })
            if (claimed.length >= (params?.p_batch_size || 10)) break
          }
        }
        return { data: claimed, error: null }
      }

      if (funcName === 'complete_participant_removal_job_tx') {
        for (const j of removalJobsTable.values()) {
          if (j.id === params?.p_job_id) {
            j.status = 'completed'
            j.completed_at = new Date().toISOString()
            j.lease_expires_at = null
            j.lease_token = null
            j.last_error = null
            break
          }
        }
        return { data: true, error: null }
      }

      if (funcName === 'schedule_participant_removal_retry_tx') {
        for (const j of removalJobsTable.values()) {
          if (j.id === params?.p_job_id) {
            const isFailed = (j.attempts || 1) >= (params?.p_max_attempts || 5)
            j.status = isFailed ? 'failed' : 'pending'
            j.last_error = params?.p_error_message
            j.next_retry_at = new Date(Date.now() + (params?.p_backoff_seconds || 30) * 1000).toISOString()
            j.lease_expires_at = null
            j.lease_token = null
            return { data: j.status, error: null }
          }
        }
        return { data: 'pending', error: null }
      }

      if (funcName === 'recover_expired_participant_removal_leases_tx') {
        let count = 0
        for (const j of removalJobsTable.values()) {
          if (j.status === 'processing' && j.lease_expires_at && new Date(j.lease_expires_at) <= new Date()) {
            j.status = 'pending'
            j.lease_expires_at = null
            count++
          }
        }
        return { data: count, error: null }
      }

      return { data: null, error: null }
    }
  }

  const createToken = (userId, email) => {
    return jwt.sign({ id: userId, email: email || `${userId}@meetly.ai` }, TEST_JWT_SECRET, { expiresIn: '1h' })
  }

  const connectClient = (token, options = {}) => {
    return new Promise((resolve) => {
      const client = ClientIO(`http://localhost:${serverPort}`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        timeout: 3000,
        auth: token ? { token } : undefined,
        ...options
      })

      activeClients.push(client)

      client.on('connect', () => resolve(client))
      client.on('connect_error', (err) => resolve({ connectError: err, client }))
    })
  }

  before(async () => {
    setDatabaseClient(mockDb)
    setStoragePath(TEST_STORAGE_PATH)
    clearPendingRevocations()
    httpServer = http.createServer()
    ioServer = new Server(httpServer, {
      cors: { origin: '*' }
    })
    socketState = setupSocketServer(ioServer, mockDb, mockCfService)

    await new Promise((resolve) => {
      httpServer.listen(0, resolve)
    })
    serverPort = httpServer.address().port
  })

  after(async () => {
    stopRemovalWorker()
    resetDatabaseClient()
    for (const c of activeClients) {
      if (typeof c.disconnect === 'function') c.disconnect()
    }
    activeClients = []
    await new Promise((r) => setTimeout(r, 100))
    cancelCleanup(MEETING_ID)
    if (socketState?.hostGracePeriodTimers) {
      for (const entry of socketState.hostGracePeriodTimers.values()) {
        if (entry?.timer) clearTimeout(entry.timer)
      }
      socketState.hostGracePeriodTimers.clear()
    }
    if (ioServer) {
      await new Promise((resolve) => {
        ioServer.close(() => resolve())
      })
    }
    if (httpServer && httpServer.listening) {
      await new Promise((resolve) => {
        httpServer.close(() => resolve())
      })
    }
    clearPendingRevocations()
    try {
      if (fs.existsSync(TEST_STORAGE_PATH)) fs.unlinkSync(TEST_STORAGE_PATH)
    } catch (_) {}
    resetStoragePath()
  })

  beforeEach(() => {
    resetAllMeetingChats()
    meetingsTable.clear()
    participantsTable.clear()
    usersTable.clear()
    deviceBansTable.clear()
    removalJobsTable.clear()
    clearPendingRevocations()
    cfCalls = []
    cfMockShouldFail = false
    cfFailCount = 0

    // Seed default active meeting
    meetingsTable.set(MEETING_ID, {
      meeting_id: MEETING_ID,
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      assigned_host_id: COHOST_ID,
      active_host_id: HOST_ID,
      meeting_status: 'Active',
      cloudflare_meeting_id: CF_MEETING_ID,
      is_deleted: false
    })

    // Seed users
    usersTable.set(HOST_ID, { id: HOST_ID, full_name: 'Dr. Host Admin', email: 'host@meetly.ai' })
    usersTable.set(COHOST_ID, { id: COHOST_ID, full_name: 'Prof. CoHost', email: 'cohost@meetly.ai' })
    usersTable.set(PARTICIPANT_A, { id: PARTICIPANT_A, full_name: 'Alice Student', email: 'alice@meetly.ai' })
    usersTable.set(PARTICIPANT_B, { id: PARTICIPANT_B, full_name: 'Bob Observer', email: 'bob@meetly.ai' })

    // Seed participants
    participantsTable.set(`${MEETING_ID}:${PARTICIPANT_A}`.toLowerCase(), {
      participant_id: 'part-uuid-alice',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_A,
      participant_status: 'joined',
      cloudflare_participant_id: 'cf-part-test-aaaa',
      device_fingerprint: 'fp-alice-clean'
    })

    participantsTable.set(`${MEETING_ID}:${PARTICIPANT_B}`.toLowerCase(), {
      participant_id: 'part-uuid-bob',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_B,
      participant_status: 'joined',
      cloudflare_participant_id: 'cf-part-test-bbbb',
      device_fingerprint: 'fp-bob-clean'
    })
  })

  afterEach(() => {
    cancelCleanup(MEETING_ID)
    if (socketState?.hostGracePeriodTimers) {
      for (const entry of socketState.hostGracePeriodTimers.values()) {
        if (entry?.timer) clearTimeout(entry.timer)
      }
      socketState.hostGracePeriodTimers.clear()
    }
    for (const c of activeClients) {
      if (typeof c.disconnect === 'function') {
        c.disconnect()
      }
    }
    activeClients = []
  })

  describe('1. Authentication Middleware & Handshake Security', () => {
    it('rejects unauthenticated socket connections with Authentication required', async () => {
      const res = await connectClient(null)
      assert.ok(res.connectError, 'Unauthenticated connection must be rejected')
      assert.match(res.connectError.message, /authentication required/i)
    })

    it('rejects connections with invalid or malformed tokens', async () => {
      const res = await connectClient('malformed.token.value')
      assert.ok(res.connectError, 'Invalid token must be rejected')
      assert.match(res.connectError.message, /invalid or expired/i)
    })

    it('rejects connections signed with a different secret', async () => {
      const wrongSecretToken = jwt.sign({ id: PARTICIPANT_A }, 'attacker-secret')
      const res = await connectClient(wrongSecretToken)
      assert.ok(res.connectError, 'Token with wrong secret must be rejected')
      assert.match(res.connectError.message, /invalid or expired/i)
    })

    it('rejects query-string JWT tokens (handshake.query.token is disabled)', async () => {
      const token = createToken(PARTICIPANT_A)
      // Attempt connection passing token in query ONLY, without auth payload
      const res = await connectClient(null, { query: { token } })
      assert.ok(res.connectError, 'Query string JWT connection must be rejected')
      assert.match(res.connectError.message, /authentication required/i)
    })

    it('successfully connects authenticated users with valid Meetly JWT via handshake.auth', async () => {
      const token = createToken(PARTICIPANT_A)
      const client = await connectClient(token)
      assert.ok(client.connected, 'Authenticated client should connect successfully')
    })

    it('successfully connects authenticated users via HTTP-only meetly_token cookie in headers', async () => {
      const token = createToken(PARTICIPANT_A)
      const client = await connectClient(null, {
        extraHeaders: {
          cookie: `meetly_token=${encodeURIComponent(token)}`
        }
      })
      assert.ok(client.connected, 'Client with valid meetly_token cookie should connect successfully')
    })
  })

  describe('2. Room Joining & Impersonation Prevention', () => {
    it('rejects users who are not participants or hosts in the meeting', async () => {
      const token = createToken(STRANGER_USER)
      const client = await connectClient(token)

      const joinRes = await new Promise((resolve) => {
        client.emit('join_room', { roomName: ROOM_NAME }, resolve)
      })

      assert.equal(joinRes.success, false)
      assert.match(joinRes.error, /not an authorized participant/i)
    })

    it('rejects banned or removed participants from joining room', async () => {
      participantsTable.set(`${MEETING_ID}:${PARTICIPANT_A}`.toLowerCase(), {
        participant_id: 'part-uuid-alice',
        meeting_id: MEETING_ID,
        user_id: PARTICIPANT_A,
        participant_status: 'removed'
      })

      const token = createToken(PARTICIPANT_A)
      const client = await connectClient(token)

      const joinRes = await new Promise((resolve) => {
        client.emit('join_room', { roomName: ROOM_NAME }, resolve)
      })

      assert.equal(joinRes.success, false)
      assert.match(joinRes.error, /blocked|removed/i)
    })

    it('strictly ignores claimedUserId in join_room and never grants host authority to participant', async () => {
      const token = createToken(PARTICIPANT_A)
      const client = await connectClient(token)

      const joinRes = await new Promise((resolve) => {
        client.emit('join_room', { roomName: ROOM_NAME, userId: HOST_ID, claimedUserId: HOST_ID }, resolve)
      })

      assert.equal(joinRes.success, true)
      assert.equal(joinRes.isHost, false, 'Claimed host ID in payload must be ignored')
    })

    it('allows waiting room participant to join socket room but does not authorize chat history', async () => {
      participantsTable.set(`${MEETING_ID}:${PARTICIPANT_A}`.toLowerCase(), {
        participant_id: 'part-uuid-alice',
        meeting_id: MEETING_ID,
        user_id: PARTICIPANT_A,
        participant_status: 'waiting'
      })

      const token = createToken(PARTICIPANT_A)
      const client = await connectClient(token)

      const joinRes = await new Promise((resolve) => {
        client.emit('join_room', { roomName: ROOM_NAME }, resolve)
      })

      assert.equal(joinRes.success, true)
      assert.equal(joinRes.isWaiting, true)
      assert.deepEqual(joinRes.messages, [], 'Waiting room user must receive empty chat history')
    })
  })

  describe('3. Meeting Termination (end_meeting) Authorization', () => {
    it('normal participant CANNOT end meeting and is rejected', async () => {
      const token = createToken(PARTICIPANT_A)
      const client = await connectClient(token)

      await new Promise((resolve) => client.emit('join_room', { roomName: ROOM_NAME }, resolve))

      let errorEventReceived = null
      client.on('error', (err) => {
        errorEventReceived = err
      })

      const endRes = await new Promise((resolve) => {
        client.emit('end_meeting', { roomName: ROOM_NAME }, resolve)
      })

      assert.equal(endRes.success, false)
      assert.match(endRes.error, /only the host or co-host can end/i)
      assert.ok(errorEventReceived, 'Unauthorized caller must receive error event')

      const mtg = meetingsTable.get(MEETING_ID)
      assert.equal(mtg.meeting_status, 'Active', 'Meeting status must remain Active')
    })

    it('authorized original host CAN end meeting and marks meeting ended', async () => {
      const hostToken = createToken(HOST_ID)
      const aliceToken = createToken(PARTICIPANT_A)

      const hostClient = await connectClient(hostToken)
      const aliceClient = await connectClient(aliceToken)

      await new Promise((resolve) => hostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))
      await new Promise((resolve) => aliceClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      let aliceReceivedEnd = null
      aliceClient.on('meeting_ended', (payload) => {
        aliceReceivedEnd = payload || true
      })

      const endRes = await new Promise((resolve) => {
        hostClient.emit('end_meeting', { roomName: ROOM_NAME }, resolve)
      })

      assert.equal(endRes.success, true)
      const mtg = meetingsTable.get(MEETING_ID)
      assert.equal(mtg.meeting_status, 'Ended')

      await new Promise((r) => setTimeout(r, 50))
      assert.ok(aliceReceivedEnd, 'Alice must receive meeting_ended broadcast')
    })

    it('authorized assigned co-host CAN end meeting', async () => {
      const cohostToken = createToken(COHOST_ID)
      const cohostClient = await connectClient(cohostToken)

      await new Promise((resolve) => cohostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      const endRes = await new Promise((resolve) => {
        cohostClient.emit('end_meeting', { roomName: ROOM_NAME }, resolve)
      })

      assert.equal(endRes.success, true)
      const mtg = meetingsTable.get(MEETING_ID)
      assert.equal(mtg.meeting_status, 'Ended')
    })
  })

  describe('4. Meeting Lock (lock_meeting) Authorization', () => {
    it('normal participant CANNOT lock meeting', async () => {
      const token = createToken(PARTICIPANT_A)
      const client = await connectClient(token)

      await new Promise((resolve) => client.emit('join_room', { roomName: ROOM_NAME }, resolve))

      const lockRes = await new Promise((resolve) => {
        client.emit('lock_meeting', { roomName: ROOM_NAME, isLocked: true }, resolve)
      })

      assert.equal(lockRes.success, false)
      assert.match(lockRes.error, /only the host or co-host can lock/i)

      const mtg = meetingsTable.get(MEETING_ID)
      assert.equal(mtg.meeting_status, 'Active')
    })

    it('authorized host CAN lock meeting and broadcasts meeting_locked', async () => {
      const hostToken = createToken(HOST_ID)
      const aliceToken = createToken(PARTICIPANT_A)

      const hostClient = await connectClient(hostToken)
      const aliceClient = await connectClient(aliceToken)

      await new Promise((resolve) => hostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))
      await new Promise((resolve) => aliceClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      let lockEventReceived = null
      aliceClient.on('meeting_locked', (payload) => {
        lockEventReceived = payload
      })

      const lockRes = await new Promise((resolve) => {
        hostClient.emit('lock_meeting', { roomName: ROOM_NAME, isLocked: true }, resolve)
      })

      assert.equal(lockRes.success, true)
      assert.equal(lockRes.isLocked, true)

      const mtg = meetingsTable.get(MEETING_ID)
      assert.equal(mtg.meeting_status, 'Locked')

      await new Promise((r) => setTimeout(r, 50))
      assert.deepEqual(lockEventReceived, { isLocked: true })
    })
  })

  describe('5. Participant Removal & Cloudflare Revocation Authorization', () => {
    it('normal participant CANNOT remove other participants', async () => {
      const token = createToken(PARTICIPANT_A)
      const client = await connectClient(token)

      await new Promise((resolve) => client.emit('join_room', { roomName: ROOM_NAME }, resolve))

      const removeRes = await new Promise((resolve) => {
        client.emit('remove_participant_from_meeting', { roomName: ROOM_NAME, userId: PARTICIPANT_B }, resolve)
      })

      assert.equal(removeRes.success, false)
      assert.match(removeRes.error, /only the host or co-host can remove/i)

      const bobRow = participantsTable.get(`${MEETING_ID}:${PARTICIPANT_B}`.toLowerCase())
      assert.equal(bobRow.participant_status, 'joined', 'Bob status must remain joined')
      assert.equal(cfCalls.length, 0, 'Cloudflare revocation must NOT be called for unauthorized attempt')
    })

    it('authorized host CAN remove a participant, updates DB, evicts Cloudflare session, and broadcasts removal', async () => {
      const hostToken = createToken(HOST_ID)
      const bobToken = createToken(PARTICIPANT_B)

      const hostClient = await connectClient(hostToken)
      const bobClient = await connectClient(bobToken)

      await new Promise((resolve) => hostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))
      await new Promise((resolve) => bobClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      let bobRemovedEvent = null
      bobClient.on('participant_removed', (payload) => {
        bobRemovedEvent = payload
      })

      const removeRes = await new Promise((resolve) => {
        hostClient.emit('remove_participant_from_meeting', { roomName: ROOM_NAME, userId: PARTICIPANT_B }, resolve)
      })

      assert.equal(removeRes.success, true)
      const bobRow = participantsTable.get(`${MEETING_ID}:${PARTICIPANT_B}`.toLowerCase())
      assert.equal(bobRow.participant_status, 'removed')

      // Verifies Cloudflare RealtimeKit participant revocation was executed
      assert.equal(cfCalls.length, 1, 'Cloudflare participant revocation must be invoked')
      assert.equal(cfCalls[0].meetingId, CF_MEETING_ID)
      assert.equal(cfCalls[0].participantId, 'cf-part-test-bbbb')

      await new Promise((r) => setTimeout(r, 50))
      assert.deepEqual(bobRemovedEvent, { userId: PARTICIPANT_B })
    })

    it('participant removal automatically retries transient Cloudflare failure and succeeds', async () => {
      const hostToken = createToken(HOST_ID)
      const hostClient = await connectClient(hostToken)
      await new Promise((resolve) => hostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      // Simulate 1 transient failure before success
      cfFailCount = 1

      const removeRes = await new Promise((resolve) => {
        hostClient.emit('remove_participant_from_meeting', { roomName: ROOM_NAME, userId: PARTICIPANT_B }, resolve)
      })

      assert.equal(removeRes.success, true)
      assert.equal(cfCalls.length, 2, 'Must have attempted Cloudflare revocation twice (1 retry)')
      const bobRow = participantsTable.get(`${MEETING_ID}:${PARTICIPANT_B}`.toLowerCase())
      assert.equal(bobRow.participant_status, 'removed')
    })

    it('participant removal fails reliably and surfaces error when Cloudflare revocation persistently fails', async () => {
      const hostToken = createToken(HOST_ID)
      const hostClient = await connectClient(hostToken)
      await new Promise((resolve) => hostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      cfMockShouldFail = true

      const removeRes = await new Promise((resolve) => {
        hostClient.emit('remove_participant_from_meeting', { roomName: ROOM_NAME, userId: PARTICIPANT_B }, resolve)
      })

      assert.equal(removeRes.success, false)
      assert.match(removeRes.error, /Cloudflare participant revocation pending/i)
      assert.equal(cfCalls.length, 3, 'Must have executed all 3 retry attempts before failing')
    })

    it('authorized co-host / assigned host CAN remove a participant', async () => {
      const cohostToken = createToken(COHOST_ID)
      const cohostClient = await connectClient(cohostToken)

      await new Promise((resolve) => cohostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      const removeRes = await new Promise((resolve) => {
        cohostClient.emit('remove_participant_from_meeting', { roomName: ROOM_NAME, userId: PARTICIPANT_A }, resolve)
      })

      assert.equal(removeRes.success, true)
      const aliceRow = participantsTable.get(`${MEETING_ID}:${PARTICIPANT_A}`.toLowerCase())
      assert.equal(aliceRow.participant_status, 'removed')
      assert.equal(cfCalls.length, 1)
      assert.equal(cfCalls[0].participantId, 'cf-part-test-aaaa')
    })

    it('assigned co-host CANNOT remove original host and is rejected', async () => {
      const cohostToken = createToken(COHOST_ID)
      const cohostClient = await connectClient(cohostToken)
      await new Promise((resolve) => cohostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      const removeRes = await new Promise((resolve) => {
        cohostClient.emit('remove_participant_from_meeting', { roomName: ROOM_NAME, userId: HOST_ID }, resolve)
      })

      assert.equal(removeRes.success, false)
      assert.equal(removeRes.code, 'CANNOT_REMOVE_ORIGINAL_HOST')
      assert.match(removeRes.error, /original host cannot be removed/i)
      assert.equal(meetingsTable.get(MEETING_ID).host_id, HOST_ID, 'Host ID must remain unchanged')
    })

    it('host CANNOT remove themselves through participant removal', async () => {
      const hostToken = createToken(HOST_ID)
      const hostClient = await connectClient(hostToken)
      await new Promise((resolve) => hostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      const removeRes = await new Promise((resolve) => {
        hostClient.emit('remove_participant_from_meeting', { roomName: ROOM_NAME, userId: HOST_ID }, resolve)
      })

      assert.equal(removeRes.success, false)
      assert.equal(removeRes.code, 'CANNOT_REMOVE_SELF')
      assert.match(removeRes.error, /cannot remove yourself/i)
    })

    it('Cloudflare persistent failure creates pending revocation and surfaces pending state', async () => {
      const hostToken = createToken(HOST_ID)
      const hostClient = await connectClient(hostToken)
      await new Promise((resolve) => hostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      cfMockShouldFail = true

      const removeRes = await new Promise((resolve) => {
        hostClient.emit('remove_participant_from_meeting', { roomName: ROOM_NAME, userId: PARTICIPANT_B }, resolve)
      })

      assert.equal(removeRes.success, false)
      assert.equal(removeRes.status, 'pending_revocation')
      assert.match(removeRes.error, /Cloudflare participant revocation pending/i)

      const pending = await getPendingRevocations()
      assert.equal(pending.length, 1, 'Pending revocation must be persisted')
      assert.equal(pending[0].userId, PARTICIPANT_B.toLowerCase())
      assert.equal(pending[0].status, 'pending_revocation')
    })

    it('backend restart recovery processes pending revocations and completes eviction', async () => {
      const hostToken = createToken(HOST_ID)
      const hostClient = await connectClient(hostToken)
      await new Promise((resolve) => hostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      // 1. Fail to create durable pending revocation
      cfMockShouldFail = true
      await new Promise((resolve) => {
        hostClient.emit('remove_participant_from_meeting', { roomName: ROOM_NAME, userId: PARTICIPANT_B }, resolve)
      })
      assert.equal((await getPendingRevocations()).length, 1)

      // 2. Simulate backend restart: Cloudflare is back online
      cfMockShouldFail = false
      const recoveryResult = await recoverPendingRevocations({
        dbClient: mockDb,
        cfService: mockCfService,
        ioInstance: ioServer
      })

      assert.equal(recoveryResult.recovered, 1, 'Must recover 1 pending revocation')
      assert.equal((await getPendingRevocations()).length, 0, 'Durable pending queue must be cleared on completion')
      const bobRow = participantsTable.get(`${MEETING_ID}:${PARTICIPANT_B}`.toLowerCase())
      assert.equal(bobRow.participant_status, 'removed', 'Bob status must be updated to removed in DB')
    })

    it('successful retry completes participant removal and clears pending state', async () => {
      const hostToken = createToken(HOST_ID)
      const hostClient = await connectClient(hostToken)
      await new Promise((resolve) => hostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      // 1. First attempt fails
      cfMockShouldFail = true
      await new Promise((resolve) => {
        hostClient.emit('remove_participant_from_meeting', { roomName: ROOM_NAME, userId: PARTICIPANT_B }, resolve)
      })
      assert.equal((await getPendingRevocations()).length, 1)

      // 2. Retry succeeds
      cfMockShouldFail = false
      const retryRes = await new Promise((resolve) => {
        hostClient.emit('remove_participant_from_meeting', { roomName: ROOM_NAME, userId: PARTICIPANT_B }, resolve)
      })

      assert.equal(retryRes.success, true)
      assert.equal(retryRes.status, 'completed')
      assert.equal((await getPendingRevocations()).length, 0, 'Pending store must be cleared after successful retry')
      const bobRow = participantsTable.get(`${MEETING_ID}:${PARTICIPANT_B}`.toLowerCase())
      assert.equal(bobRow.participant_status, 'removed')
    })

    it('concurrent removal requests execute safely via mutex without duplicate cloudflare errors', async () => {
      const hostToken = createToken(HOST_ID)
      const cohostToken = createToken(COHOST_ID)
      const hostClient = await connectClient(hostToken)
      const cohostClient = await connectClient(cohostToken)

      await new Promise((resolve) => hostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))
      await new Promise((resolve) => cohostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      // Trigger concurrent removals of Bob from both Host and Co-host
      const [res1, res2] = await Promise.all([
        new Promise((resolve) => hostClient.emit('remove_participant_from_meeting', { roomName: ROOM_NAME, userId: PARTICIPANT_B }, resolve)),
        new Promise((resolve) => cohostClient.emit('remove_participant_from_meeting', { roomName: ROOM_NAME, userId: PARTICIPANT_B }, resolve))
      ])

      assert.ok(res1.success || res2.success, 'At least one request must succeed')
      const bobRow = participantsTable.get(`${MEETING_ID}:${PARTICIPANT_B}`.toLowerCase())
      assert.equal(bobRow.participant_status, 'removed')
      assert.equal((await getPendingRevocations()).length, 0)
    })

    it('treats only confirmed participant-not-found responses as successful eviction', () => {
      // 404 with participant message -> true
      assert.equal(isConfirmedParticipantNotFound({ status: 404, message: 'Participant not found in meeting' }), true)
      assert.equal(isConfirmedParticipantNotFound({ status: 410, message: 'Participant session does not exist' }), true)

      // Unrelated 404 or other errors -> false
      assert.equal(isConfirmedParticipantNotFound({ status: 404, message: 'Route not found' }), false)
      assert.equal(isConfirmedParticipantNotFound({ status: 401, message: 'Unauthorized API token' }), false)
      assert.equal(isConfirmedParticipantNotFound({ status: 403, message: 'Forbidden' }), false)
      assert.equal(isConfirmedParticipantNotFound({ status: 500, message: 'Internal Server Error' }), false)
      assert.equal(isConfirmedParticipantNotFound({ status: 504, message: 'Gateway Timeout' }), false)
    })
  })

  describe('6. Chat Policy & Sender Spoofing Protection', () => {
    it('normal participant CANNOT change chat policy', async () => {
      const token = createToken(PARTICIPANT_A)
      const client = await connectClient(token)

      await new Promise((resolve) => client.emit('join_room', { roomName: ROOM_NAME }, resolve))

      const policyRes = await new Promise((resolve) => {
        client.emit('chat:set_policy', { roomName: ROOM_NAME, policy: CHAT_POLICIES.NO_ONE }, resolve)
      })

      assert.equal(policyRes.success, false)
      assert.match(policyRes.error, /only the host or co-host can change chat/i)
    })

    it('participant cannot spoof senderId in chat:send_message', async () => {
      const token = createToken(PARTICIPANT_A)
      const client = await connectClient(token)

      await new Promise((resolve) => client.emit('join_room', { roomName: ROOM_NAME }, resolve))

      const sendRes = await new Promise((resolve) => {
        client.emit(
          'chat:send_message',
          {
            roomName: ROOM_NAME,
            text: 'I am pretending to be the Host',
            senderId: HOST_ID,
            userId: HOST_ID
          },
          resolve
        )
      })

      assert.equal(sendRes.success, true)
      assert.equal(sendRes.message.senderId, PARTICIPANT_A, 'SenderId must be bound to authenticated socket.user.id')
    })

    it('authorized host CAN change chat policy to no_one, which blocks participants from chatting', async () => {
      const hostToken = createToken(HOST_ID)
      const aliceToken = createToken(PARTICIPANT_A)

      const hostClient = await connectClient(hostToken)
      const aliceClient = await connectClient(aliceToken)

      await new Promise((resolve) => hostClient.emit('join_room', { roomName: ROOM_NAME }, resolve))
      await new Promise((resolve) => aliceClient.emit('join_room', { roomName: ROOM_NAME }, resolve))

      const policyRes = await new Promise((resolve) => {
        hostClient.emit('chat:set_policy', { roomName: ROOM_NAME, policy: CHAT_POLICIES.NO_ONE }, resolve)
      })

      assert.equal(policyRes.success, true)

      const sendRes = await new Promise((resolve) => {
        aliceClient.emit(
          'chat:send_message',
          {
            roomName: ROOM_NAME,
            text: 'Is chat blocked?'
          },
          resolve
        )
      })

      assert.equal(sendRes.success, false)
      assert.match(sendRes.error, /host has disabled chat/i)
    })
  })

  describe('7. Reactions and Presence Identity Verification', () => {
    it('broadcasts reaction with verified name and caller identity', async () => {
      const tokenA = createToken(PARTICIPANT_A)
      const tokenB = createToken(PARTICIPANT_B)

      const clientA = await connectClient(tokenA)
      const clientB = await connectClient(tokenB)

      await new Promise((resolve) => clientA.emit('join_room', { roomName: ROOM_NAME }, resolve))
      await new Promise((resolve) => clientB.emit('join_room', { roomName: ROOM_NAME }, resolve))

      let reactionReceived = null
      clientB.on('participant_reaction', (payload) => {
        reactionReceived = payload
      })

      clientA.emit('send_reaction', {
        roomName: ROOM_NAME,
        reaction: '👍',
        identity: PARTICIPANT_A,
        senderName: 'Alice Student'
      })

      await new Promise((r) => setTimeout(r, 50))
      assert.ok(reactionReceived)
      assert.equal(reactionReceived.reaction, '👍')
      assert.equal(reactionReceived.senderName, 'Alice Student')
      assert.equal(reactionReceived.identity, PARTICIPANT_A)
    })

    it('ignores reaction events from users not present in the room', async () => {
      const tokenA = createToken(PARTICIPANT_A)
      const tokenB = createToken(PARTICIPANT_B)

      const clientA = await connectClient(tokenA)
      const clientB = await connectClient(tokenB)

      // Only clientB joins the room; clientA does not join
      await new Promise((resolve) => clientB.emit('join_room', { roomName: ROOM_NAME }, resolve))

      let reactionReceived = null
      clientB.on('participant_reaction', (payload) => {
        reactionReceived = payload
      })

      // Client A attempts to emit to ROOM_NAME without joining
      clientA.emit('send_reaction', {
        roomName: ROOM_NAME,
        reaction: '🔥'
      })

      await new Promise((r) => setTimeout(r, 50))
      assert.equal(reactionReceived, null, 'Unjoined socket must not be able to broadcast reactions into room')
    })
  })

  describe('8. Negative Authorization: In-Meeting Controls & History', () => {
    it('unadmitted or waiting-room participant CANNOT raise hand', async () => {
      participantsTable.set(`${MEETING_ID}:${PARTICIPANT_A}`.toLowerCase(), {
        participant_id: 'part-uuid-alice',
        meeting_id: MEETING_ID,
        user_id: PARTICIPANT_A,
        participant_status: 'waiting'
      })

      const tokenA = createToken(PARTICIPANT_A)
      const tokenB = createToken(PARTICIPANT_B)

      const clientA = await connectClient(tokenA)
      const clientB = await connectClient(tokenB)

      await new Promise((resolve) => clientA.emit('join_room', { roomName: ROOM_NAME }, resolve))
      await new Promise((resolve) => clientB.emit('join_room', { roomName: ROOM_NAME }, resolve))

      let handRaiseReceived = null
      clientB.on('participant_raise_hand', (p) => {
        handRaiseReceived = p
      })

      clientA.emit('toggle_raise_hand', { roomName: ROOM_NAME, raised: true })
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(handRaiseReceived, null, 'Waiting participant cannot broadcast hand raises')
    })

    it('client outside the room CANNOT raise hand in room', async () => {
      const tokenA = createToken(PARTICIPANT_A)
      const tokenB = createToken(PARTICIPANT_B)

      const clientA = await connectClient(tokenA)
      const clientB = await connectClient(tokenB)

      // Only clientB joins the room
      await new Promise((resolve) => clientB.emit('join_room', { roomName: ROOM_NAME }, resolve))

      let handRaiseReceived = null
      clientB.on('participant_raise_hand', (p) => {
        handRaiseReceived = p
      })

      // ClientA emits without joining
      clientA.emit('toggle_raise_hand', { roomName: ROOM_NAME, raised: true })
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(handRaiseReceived, null, 'Unjoined socket cannot raise hand')
    })

    it('unadmitted or waiting participant CANNOT toggle participant status', async () => {
      participantsTable.set(`${MEETING_ID}:${PARTICIPANT_A}`.toLowerCase(), {
        participant_id: 'part-uuid-alice',
        meeting_id: MEETING_ID,
        user_id: PARTICIPANT_A,
        participant_status: 'waiting'
      })

      const tokenA = createToken(PARTICIPANT_A)
      const tokenB = createToken(PARTICIPANT_B)

      const clientA = await connectClient(tokenA)
      const clientB = await connectClient(tokenB)

      await new Promise((resolve) => clientA.emit('join_room', { roomName: ROOM_NAME }, resolve))
      await new Promise((resolve) => clientB.emit('join_room', { roomName: ROOM_NAME }, resolve))

      let statusReceived = null
      clientB.on('participant_status_change', (p) => {
        statusReceived = p
      })

      clientA.emit('toggle_status', { roomName: ROOM_NAME, status: 'away' })
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(statusReceived, null, 'Waiting participant cannot toggle status')
    })

    it('unjoined client CANNOT broadcast typing events', async () => {
      const tokenA = createToken(PARTICIPANT_A)
      const tokenB = createToken(PARTICIPANT_B)

      const clientA = await connectClient(tokenA)
      const clientB = await connectClient(tokenB)

      await new Promise((resolve) => clientB.emit('join_room', { roomName: ROOM_NAME }, resolve))

      let typingReceived = null
      clientB.on('typing', (p) => {
        typingReceived = p
      })

      clientA.emit('typing', { roomName: ROOM_NAME, isTyping: true, name: 'Alice' })
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(typingReceived, null, 'Unjoined socket cannot broadcast typing')
    })

    it('admitted participant cannot spoof another user identity in typing event', async () => {
      const tokenA = createToken(PARTICIPANT_A)
      const tokenB = createToken(PARTICIPANT_B)

      const clientA = await connectClient(tokenA)
      const clientB = await connectClient(tokenB)

      await new Promise((resolve) => clientA.emit('join_room', { roomName: ROOM_NAME }, resolve))
      await new Promise((resolve) => clientB.emit('join_room', { roomName: ROOM_NAME }, resolve))

      let typingReceived = null
      clientB.on('typing', (p) => {
        typingReceived = p
      })

      // Client A attempts to spoof userId as HOST_ID
      clientA.emit('typing', { roomName: ROOM_NAME, isTyping: true, userId: HOST_ID, name: 'Alice' })
      await new Promise((r) => setTimeout(r, 50))

      assert.ok(typingReceived)
      assert.equal(typingReceived.userId, PARTICIPANT_A, 'Typing userId must match authenticated socket.user.id')
    })

    it('unjoined client CANNOT send message via legacy send_message', async () => {
      const tokenA = createToken(PARTICIPANT_A)
      const tokenB = createToken(PARTICIPANT_B)

      const clientA = await connectClient(tokenA)
      const clientB = await connectClient(tokenB)

      await new Promise((resolve) => clientB.emit('join_room', { roomName: ROOM_NAME }, resolve))

      let msgReceived = null
      clientB.on('receive_message', (p) => {
        msgReceived = p
      })

      clientA.emit('send_message', { roomName: ROOM_NAME, text: 'Hello from outside' })
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(msgReceived, null, 'Unjoined socket cannot broadcast via send_message')
    })

    it('waiting-room participant is REJECTED from chat:sync with empty messages', async () => {
      participantsTable.set(`${MEETING_ID}:${PARTICIPANT_A}`.toLowerCase(), {
        participant_id: 'part-uuid-alice',
        meeting_id: MEETING_ID,
        user_id: PARTICIPANT_A,
        participant_status: 'waiting'
      })

      const tokenA = createToken(PARTICIPANT_A)
      const clientA = await connectClient(tokenA)

      await new Promise((resolve) => clientA.emit('join_room', { roomName: ROOM_NAME }, resolve))

      const syncRes = await new Promise((resolve) => {
        clientA.emit('chat:sync', { roomName: ROOM_NAME }, resolve)
      })

      assert.equal(syncRes.success, false)
      assert.deepEqual(syncRes.messages, [])
      assert.match(syncRes.error, /not an authorized participant/i)
    })

    it('waiting-room participant is REJECTED from chat:get_history', async () => {
      participantsTable.set(`${MEETING_ID}:${PARTICIPANT_A}`.toLowerCase(), {
        participant_id: 'part-uuid-alice',
        meeting_id: MEETING_ID,
        user_id: PARTICIPANT_A,
        participant_status: 'waiting'
      })

      const tokenA = createToken(PARTICIPANT_A)
      const clientA = await connectClient(tokenA)

      await new Promise((resolve) => clientA.emit('join_room', { roomName: ROOM_NAME }, resolve))

      const historyRes = await new Promise((resolve) => {
        clientA.emit('chat:get_history', { roomName: ROOM_NAME }, resolve)
      })

      assert.equal(historyRes.success, false)
      assert.deepEqual(historyRes.messages, [])
      assert.match(historyRes.error, /not an authorized participant/i)
    })

    it('participant chat:sync returns ended=true when meeting status is Ended', async () => {
      meetingsTable.set(MEETING_ID, {
        meeting_id: MEETING_ID,
        meeting_code: MEETING_CODE,
        room_name: ROOM_NAME,
        host_id: HOST_ID,
        meeting_status: 'Ended'
      })

      const tokenA = createToken(PARTICIPANT_A)
      const clientA = await connectClient(tokenA)

      const syncRes = await new Promise((resolve) => {
        clientA.emit('chat:sync', { roomName: ROOM_NAME }, resolve)
      })

      assert.equal(syncRes.success, false)
      assert.equal(syncRes.ended, true)
    })
  })
})
