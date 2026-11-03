import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  executeParticipantRemoval,
  runRemovalWorkerCycle,
  startRemovalWorker,
  stopRemovalWorker,
  manualRetryRemovalJob,
  importLegacyFilePendingRevocations,
  isConfirmedParticipantNotFound,
  setDatabaseClient,
  resetDatabaseClient,
  getPendingRemovalJobs
} from '../services/participantRemovalService.js'
import {
  removeParticipant,
  setCloudflareService,
  resetCloudflareService
} from '../controllers/securityController.js'
import { supabase } from '../config/supabase.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('Meetly AI — Supabase-Based Participant Revocation Queue Test Suite', () => {
  const MEETING_ID = '11111111-1111-4111-8111-111111111111'
  const MEETING_CODE = 'SUPA-111'
  const ROOM_NAME = 'room-supa-1111'
  const HOST_ID = '22222222-2222-4222-8222-222222222222'
  const COHOST_ID = '33333333-3333-4333-8333-333333333333'
  const PARTICIPANT_USER = '44444444-4444-4444-8444-444444444444'
  const CF_MEETING_ID = 'cf-mtg-supa-1111'
  const CF_PART_ID = 'cf-part-supa-3333'

  // In-memory tables mimicking Supabase PostgreSQL
  let meetingsTable = new Map()
  let participantsTable = new Map()
  let usersTable = new Map()
  let jobsTable = new Map()

  // Track Cloudflare API calls
  let cfCalls = []
  let cfCustomHandler = null

  const mockCfService = {
    isConfigured: () => true,
    removeParticipant: async (meetingId, participantId) => {
      cfCalls.push({ meetingId, participantId, timestamp: Date.now() })
      if (cfCustomHandler) {
        return await cfCustomHandler(meetingId, participantId)
      }
      return { success: true, meetingId, participantId }
    }
  }

  // Simulated Supabase Database Engine with transactional RPCs & FK semantics
  const createMockDb = () => {
    return {
      from: (table) => {
        let currentTable = table
        let conditions = []
        let updatePayload = null
        let insertPayload = null
        let isDelete = false
        let isSingle = false

        const executeQuery = () => {
          if (currentTable === 'meetings') {
            const results = []
            for (const m of meetingsTable.values()) {
              const match = conditions.every((c) => {
                const rowVal = m[c.col] === null || m[c.col] === undefined ? null : String(m[c.col]).toLowerCase()
                if (c.op === 'in') {
                  return c.val.map((v) => String(v).toLowerCase()).includes(rowVal)
                }
                return rowVal === c.val
              })
              if (match) {
                if (updatePayload) Object.assign(m, updatePayload)
                results.push({ ...m })
              }
            }
            if (isDelete) {
              for (const m of results) {
                meetingsTable.delete(m.meeting_id)
                // PostgreSQL ON DELETE SET NULL on participant_removal_jobs:
                for (const j of new Set(jobsTable.values())) {
                  if (j.meeting_id === m.meeting_id) {
                    j.meeting_id = null
                  }
                }
              }
              return { data: results, error: null }
            }
            return { data: isSingle ? (results[0] || null) : results, error: null }
          }

          if (currentTable === 'users') {
            const results = []
            for (const u of usersTable.values()) {
              const match = conditions.every((c) => {
                const rowVal = u[c.col] === null || u[c.col] === undefined ? null : String(u[c.col]).toLowerCase()
                if (c.op === 'in') {
                  return c.val.map((v) => String(v).toLowerCase()).includes(rowVal)
                }
                return rowVal === c.val
              })
              if (match) {
                if (updatePayload) Object.assign(u, updatePayload)
                results.push({ ...u })
              }
            }
            if (isDelete) {
              for (const u of results) {
                usersTable.delete(u.id)
                // PostgreSQL ON DELETE SET NULL on participant_removal_jobs:
                for (const j of new Set(jobsTable.values())) {
                  if (j.user_id === u.id) {
                    j.user_id = null
                  }
                }
              }
              return { data: results, error: null }
            }
            return { data: isSingle ? (results[0] || null) : results, error: null }
          }

          if (currentTable === 'participants') {
            const results = []
            for (const p of participantsTable.values()) {
              const match = conditions.every((c) => {
                const rowVal = p[c.col] === null || p[c.col] === undefined ? null : String(p[c.col]).toLowerCase()
                if (c.op === 'in') {
                  return c.val.map((v) => String(v).toLowerCase()).includes(rowVal)
                }
                return rowVal === c.val
              })
              if (match) {
                if (updatePayload) Object.assign(p, updatePayload)
                results.push({ ...p })
              }
            }
            if (isDelete) {
              for (const p of results) {
                participantsTable.delete(`${p.meeting_id}:${p.user_id}`.toLowerCase())
              }
              return { data: results, error: null }
            }
            return { data: isSingle ? (results[0] || null) : results, error: null }
          }

          if (currentTable === 'participant_removal_jobs') {
            if (insertPayload) {
              const items = Array.isArray(insertPayload) ? insertPayload : [insertPayload]
              const inserted = []
              for (const item of items) {
                const id = item.id || 'job-uuid-' + Math.random().toString(36).slice(2)
                const sessionKey = item.session_key || (item.cloudflare_participant_id ? `cf:${item.cloudflare_meeting_id || item.meeting_id || 'none'}:${item.cloudflare_participant_id}` : `part:${item.meeting_id || 'none'}:${item.user_id}`)
                const row = {
                  id,
                  session_key: sessionKey,
                  ...item,
                  status: item.status || 'pending',
                  created_at: item.created_at || new Date().toISOString(),
                  updated_at: new Date().toISOString()
                }
                jobsTable.set(id, row)
                jobsTable.set(sessionKey, row)
                if (item.meeting_id && item.user_id) {
                  jobsTable.set(`${item.meeting_id}:${item.user_id}`.toLowerCase(), row)
                }
                inserted.push(row)
              }
              return { data: isSingle ? inserted[0] : inserted, error: null }
            }

            const uniqueJobs = Array.from(new Set(jobsTable.values()))
            const results = []
            for (const j of uniqueJobs) {
              const match = conditions.every((c) => {
                const rowVal = j[c.col] === null || j[c.col] === undefined ? null : String(j[c.col]).toLowerCase()
                if (c.op === 'in') {
                  return c.val.map((v) => String(v).toLowerCase()).includes(rowVal)
                }
                return rowVal === c.val
              })
              if (match) {
                if (updatePayload) Object.assign(j, updatePayload)
                results.push({ ...j })
              }
            }

            if (isDelete) {
              for (const r of results) {
                jobsTable.delete(r.id)
                if (r.session_key) jobsTable.delete(r.session_key)
                if (r.meeting_id && r.user_id) {
                  jobsTable.delete(`${r.meeting_id}:${r.user_id}`.toLowerCase())
                }
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
            conditions.push({ col, val: val === null || val === undefined ? null : String(val).toLowerCase(), op: 'eq' })
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
        // 1. create_participant_removal_job_tx
        if (funcName === 'create_participant_removal_job_tx') {
          const { p_meeting_id, p_user_id, p_cloudflare_meeting_id, p_cloudflare_participant_id } = params
          if (!p_meeting_id) {
            return { data: null, error: new Error('Meeting ID is required') }
          }
          if (!p_user_id) {
            return { data: null, error: new Error('User ID is required') }
          }

          const partKey = `${p_meeting_id}:${p_user_id}`.toLowerCase()
          const part = participantsTable.get(partKey)

          // PARTICIPANT VALIDATION: Check FOUND immediately
          if (!part) {
            return { data: null, error: new Error('Participant not found in meeting') }
          }

          part.participant_status = 'removed'
          part.left_at = new Date().toISOString()

          const cfPartId = (p_cloudflare_participant_id && String(p_cloudflare_participant_id).trim())
            || part.cloudflare_participant_id
            || null
          const cfMtgId = (p_cloudflare_meeting_id && String(p_cloudflare_meeting_id).trim())
            || meetingsTable.get(p_meeting_id)?.cloudflare_meeting_id
            || p_meeting_id
          const sessionKey = cfPartId
            ? `cf:${cfMtgId}:${cfPartId}`
            : `part:${p_meeting_id}:${part.participant_id || partKey}`

          let job = null
          for (const j of new Set(jobsTable.values())) {
            if (j.session_key === sessionKey) {
              job = j
              break
            }
          }

          if (job) {
            // DUPLICATE REQUEST HANDLING: Return existing job without modifying its state!
            return { data: [{ ...job }], error: null }
          }

          const id = 'job-uuid-' + Math.random().toString(36).slice(2)
          job = {
            id,
            meeting_id: p_meeting_id,
            user_id: p_user_id,
            cloudflare_meeting_id: cfMtgId,
            cloudflare_participant_id: cfPartId,
            session_key: sessionKey,
            status: 'pending',
            attempts: 0,
            next_retry_at: new Date().toISOString(),
            last_error: null,
            lease_expires_at: null,
            lease_token: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            completed_at: null
          }
          jobsTable.set(id, job)
          jobsTable.set(sessionKey, job)
          jobsTable.set(partKey, job)
          return { data: [{ ...job }], error: null }
        }

        // 2. claim_participant_removal_jobs_tx (implements lease_token generation & input validation)
        if (funcName === 'claim_participant_removal_jobs_tx') {
          const batchSize = params?.p_batch_size
          const leaseSecs = params?.p_lease_seconds
          if (batchSize === null || batchSize === undefined || batchSize < 1 || batchSize > 100) {
            return { data: null, error: new Error('Batch size must be between 1 and 100') }
          }
          if (leaseSecs === null || leaseSecs === undefined || leaseSecs < 1 || leaseSecs > 3600) {
            return { data: null, error: new Error('Lease duration must be between 1 and 3600 seconds') }
          }

          const claimed = []
          const now = Date.now()
          const uniqueJobs = Array.from(new Set(jobsTable.values()))
          for (const j of uniqueJobs) {
            const isEligible =
              j.status === 'pending' ||
              (j.status === 'processing' && j.lease_expires_at && new Date(j.lease_expires_at).getTime() <= now)

            if (isEligible) {
              const leaseToken = 'lease-uuid-' + Math.random().toString(36).slice(2)
              j.status = 'processing'
              j.attempts = (j.attempts || 0) + 1
              j.lease_expires_at = new Date(now + leaseSecs * 1000).toISOString()
              j.lease_token = leaseToken
              j.updated_at = new Date().toISOString()

              const mtg = j.meeting_id ? meetingsTable.get(j.meeting_id) : null
              claimed.push({
                ...j,
                meeting_code: mtg?.meeting_code || null,
                room_name: mtg?.room_name || null
              })
              if (claimed.length >= batchSize) break
            }
          }
          return { data: claimed, error: null }
        }

        // 3. complete_participant_removal_job_tx (fenced by lease_token)
        if (funcName === 'complete_participant_removal_job_tx') {
          if (!params?.p_job_id) {
            return { data: null, error: new Error('Job ID is required') }
          }
          const reqToken = params?.p_lease_token
          let found = false
          for (const j of new Set(jobsTable.values())) {
            if (j.id === params?.p_job_id) {
              if (reqToken) {
                if (j.lease_token === reqToken) {
                  j.status = 'completed'
                  j.completed_at = new Date().toISOString()
                  j.lease_expires_at = null
                  j.lease_token = null
                  j.last_error = null
                  j.updated_at = new Date().toISOString()
                  found = true
                }
              } else {
                if (!j.lease_token || j.status !== 'processing') {
                  j.status = 'completed'
                  j.completed_at = new Date().toISOString()
                  j.lease_expires_at = null
                  j.lease_token = null
                  j.last_error = null
                  j.updated_at = new Date().toISOString()
                  found = true
                }
              }
              break
            }
          }
          return { data: found, error: null }
        }

        // 4. schedule_participant_removal_retry_tx (fenced by lease_token & input validation)
        if (funcName === 'schedule_participant_removal_retry_tx') {
          if (!params?.p_job_id) {
            return { data: null, error: new Error('Job ID is required') }
          }
          const backoff = params?.p_backoff_seconds
          const maxAttempts = params?.p_max_attempts
          if (backoff === null || backoff === undefined || backoff < 0 || backoff > 86400) {
            return { data: null, error: new Error('Backoff duration must be between 0 and 86400 seconds') }
          }
          if (maxAttempts === null || maxAttempts === undefined || maxAttempts < 1 || maxAttempts > 100) {
            return { data: null, error: new Error('Max attempts must be between 1 and 100') }
          }

          const reqToken = params?.p_lease_token
          let resStatus = null
          for (const j of new Set(jobsTable.values())) {
            if (j.id === params?.p_job_id) {
              const canRetry = reqToken
                ? j.lease_token === reqToken
                : (!j.lease_token || j.status !== 'processing')

              if (canRetry) {
                const isFailed = (j.attempts || 1) >= maxAttempts
                j.status = isFailed ? 'failed' : 'pending'
                j.last_error = params?.p_error_message
                j.next_retry_at = new Date(Date.now() + backoff * 1000).toISOString()
                j.lease_expires_at = null
                j.lease_token = null
                j.updated_at = new Date().toISOString()
                resStatus = j.status
              }
              break
            }
          }
          return { data: resStatus, error: null }
        }

        // 5. recover_expired_participant_removal_leases_tx (clears lease_token)
        if (funcName === 'recover_expired_participant_removal_leases_tx') {
          const batchSize = params?.p_batch_size || 50
          if (batchSize < 1 || batchSize > 500) {
            return { data: null, error: new Error('Batch size must be between 1 and 500') }
          }
          let count = 0
          const now = Date.now()
          for (const j of new Set(jobsTable.values())) {
            if (j.status === 'processing' && j.lease_expires_at && new Date(j.lease_expires_at).getTime() <= now) {
              j.status = 'pending'
              j.lease_expires_at = null
              j.lease_token = null
              j.updated_at = new Date().toISOString()
              count++
            }
          }
          return { data: count, error: null }
        }

        return { data: null, error: null }
      }
    }
  }

  let mockDb
  let originalSupabaseFrom
  let originalSupabaseRpc

  before(() => {
    mockDb = createMockDb()
    setDatabaseClient(mockDb)
    setCloudflareService(mockCfService)

    originalSupabaseFrom = supabase.from
    originalSupabaseRpc = supabase.rpc
    supabase.from = mockDb.from
    supabase.rpc = mockDb.rpc
  })

  after(() => {
    stopRemovalWorker()
    resetDatabaseClient()
    resetCloudflareService()
    if (originalSupabaseFrom) supabase.from = originalSupabaseFrom
    if (originalSupabaseRpc) supabase.rpc = originalSupabaseRpc
  })

  beforeEach(() => {
    meetingsTable.clear()
    participantsTable.clear()
    usersTable.clear()
    jobsTable.clear()
    cfCalls = []
    cfCustomHandler = null

    // Seed test meeting
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
    usersTable.set(HOST_ID, { id: HOST_ID, email: 'host@meetly.ai' })
    usersTable.set(COHOST_ID, { id: COHOST_ID, email: 'cohost@meetly.ai' })
    usersTable.set(PARTICIPANT_USER, { id: PARTICIPANT_USER, email: 'student@meetly.ai' })

    // Seed active participant
    participantsTable.set(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase(), {
      participant_id: 'part-supa-uuid-1',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      participant_status: 'joined',
      cloudflare_participant_id: CF_PART_ID
    })
  })

  // --------------------------------------------------------------------------
  // TEST 1: Pending removal survives simulated backend restart
  // --------------------------------------------------------------------------
  it('1. pending removal survives simulated backend restart', async () => {
    cfCustomHandler = async () => {
      const err = new Error('Cloudflare gateway timeout 504')
      err.status = 504
      throw err
    }

    const meeting = meetingsTable.get(MEETING_ID)

    await assert.rejects(
      async () => {
        await executeParticipantRemoval({
          meeting,
          userId: PARTICIPANT_USER,
          initiatorUserId: HOST_ID,
          dbClient: mockDb,
          cfService: mockCfService
        })
      },
      (err) => err.code === 'CLOUDFLARE_REVOCATION_PENDING'
    )

    const pendingJobsBeforeRestart = await getPendingRemovalJobs({ dbClient: mockDb })
    assert.equal(pendingJobsBeforeRestart.length, 1, 'Job must be persisted in Supabase')
    assert.equal(pendingJobsBeforeRestart[0].user_id, PARTICIPANT_USER)

    stopRemovalWorker()
    cfCustomHandler = null

    const cycleRes = await runRemovalWorkerCycle({
      dbClient: mockDb,
      cfService: mockCfService
    })

    assert.equal(cycleRes.completed, 1, 'Restarted worker must claim and complete pending job')
    const remainingPending = await getPendingRemovalJobs({ dbClient: mockDb })
    assert.equal(remainingPending.length, 0, 'No pending jobs should remain after restart recovery')

    const job = jobsTable.get(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase())
    assert.equal(job.status, 'completed')
    assert.ok(job.completed_at)
  })

  // --------------------------------------------------------------------------
  // TEST 2: Cloudflare temporary failure retains a pending job
  // --------------------------------------------------------------------------
  it('2. Cloudflare temporary failure retains a pending job without deleting it', async () => {
    cfCustomHandler = async () => {
      const err = new Error('Cloudflare Internal Server Error 500')
      err.status = 500
      throw err
    }

    const meeting = meetingsTable.get(MEETING_ID)

    await assert.rejects(
      async () => {
        await executeParticipantRemoval({
          meeting,
          userId: PARTICIPANT_USER,
          initiatorUserId: HOST_ID,
          dbClient: mockDb,
          cfService: mockCfService
        })
      },
      (err) => err.code === 'CLOUDFLARE_REVOCATION_PENDING'
    )

    assert.equal(cfCalls.length, 3, 'Must attempt 3 immediate retries before queuing')

    const jobs = await getPendingRemovalJobs({ dbClient: mockDb })
    assert.equal(jobs.length, 1, 'Job must be preserved in queue')
    assert.equal(jobs[0].status, 'pending')
    assert.equal(jobs[0].last_error, 'Cloudflare Internal Server Error 500')
  })

  // --------------------------------------------------------------------------
  // TEST 3: Cloudflare recovery completes the pending job
  // --------------------------------------------------------------------------
  it('3. Cloudflare recovery completes the pending job', async () => {
    cfCustomHandler = async () => {
      const err = new Error('Cloudflare 503 Service Unavailable')
      err.status = 503
      throw err
    }

    const meeting = meetingsTable.get(MEETING_ID)
    try {
      await executeParticipantRemoval({
        meeting,
        userId: PARTICIPANT_USER,
        initiatorUserId: HOST_ID,
        dbClient: mockDb,
        cfService: mockCfService
      })
    } catch (_) {}

    assert.equal((await getPendingRemovalJobs({ dbClient: mockDb })).length, 1)

    cfCustomHandler = null
    const cycleResult = await runRemovalWorkerCycle({
      dbClient: mockDb,
      cfService: mockCfService
    })

    assert.equal(cycleResult.completed, 1)
    const pending = await getPendingRemovalJobs({ dbClient: mockDb })
    assert.equal(pending.length, 0, 'Pending queue must be empty after recovery')

    const part = participantsTable.get(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase())
    assert.equal(part.participant_status, 'removed')
  })

  // --------------------------------------------------------------------------
  // TEST 4: Concurrent workers cannot claim the same job (SKIP LOCKED)
  // --------------------------------------------------------------------------
  it('4. concurrent workers cannot claim the same job (FOR UPDATE SKIP LOCKED)', async () => {
    const key = `${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase()
    const jobRow = {
      id: 'job-concurrency-test',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: `cf:${CF_PART_ID}`,
      status: 'pending',
      attempts: 0,
      next_retry_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobRow.id, jobRow)
    jobsTable.set(key, jobRow)

    const { data: worker1Claimed } = await mockDb.rpc('claim_participant_removal_jobs_tx', {
      p_batch_size: 10,
      p_lease_seconds: 60
    })
    assert.equal(worker1Claimed.length, 1, 'Worker 1 must claim the job')
    assert.ok(worker1Claimed[0].lease_token, 'Claimed job must receive a lease_token')

    const { data: worker2Claimed } = await mockDb.rpc('claim_participant_removal_jobs_tx', {
      p_batch_size: 10,
      p_lease_seconds: 60
    })
    assert.equal(worker2Claimed.length, 0, 'Worker 2 must skip locked row and receive 0 jobs')
  })

  // --------------------------------------------------------------------------
  // TEST 5: Duplicate removal requests remain idempotent
  // --------------------------------------------------------------------------
  it('5. duplicate removal requests remain idempotent', async () => {
    const meeting = meetingsTable.get(MEETING_ID)

    const res1 = await executeParticipantRemoval({
      meeting,
      userId: PARTICIPANT_USER,
      initiatorUserId: HOST_ID,
      dbClient: mockDb,
      cfService: mockCfService
    })
    assert.equal(res1.status, 'completed')

    const res2 = await executeParticipantRemoval({
      meeting,
      userId: PARTICIPANT_USER,
      initiatorUserId: HOST_ID,
      dbClient: mockDb,
      cfService: mockCfService
    })
    assert.equal(res2.status, 'completed')

    const uniqueCount = new Set(jobsTable.values()).size
    assert.equal(uniqueCount, 1, 'Must strictly enforce 1 job per active session')
  })

  // --------------------------------------------------------------------------
  // TEST 6: Expired processing leases are recovered and lease_token cleared
  // --------------------------------------------------------------------------
  it('6. expired processing leases are recovered and lease_token cleared', async () => {
    const key = `${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase()
    const jobRow = {
      id: 'job-expired-lease-test',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: `cf:${CF_PART_ID}`,
      status: 'processing',
      attempts: 1,
      lease_expires_at: new Date(Date.now() - 600000).toISOString(),
      lease_token: 'lease-stale-token-1234',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobRow.id, jobRow)
    jobsTable.set(key, jobRow)

    const { data: recoveredCount } = await mockDb.rpc('recover_expired_participant_removal_leases_tx', { p_batch_size: 50 })
    assert.equal(recoveredCount, 1, 'Must recover 1 expired lease')

    const job = jobsTable.get(jobRow.id)
    assert.equal(job.status, 'pending')
    assert.equal(job.lease_expires_at, null)
    assert.equal(job.lease_token, null, 'Lease token must be cleared on recovery')
  })

  // --------------------------------------------------------------------------
  // TEST 7: Cloudflare 401/403 is not treated as successful revocation
  // --------------------------------------------------------------------------
  it('7. Cloudflare 401/403 is not treated as successful revocation', async () => {
    cfCustomHandler = async () => {
      const err = new Error('Cloudflare RealtimeKit: 401 Unauthorized API Token')
      err.status = 401
      throw err
    }

    const meeting = meetingsTable.get(MEETING_ID)

    await assert.rejects(
      async () => {
        await executeParticipantRemoval({
          meeting,
          userId: PARTICIPANT_USER,
          initiatorUserId: HOST_ID,
          dbClient: mockDb,
          cfService: mockCfService
        })
      },
      (err) => err.code === 'CLOUDFLARE_REVOCATION_PENDING'
    )

    const job = jobsTable.get(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase())
    assert.notEqual(job.status, 'completed', 'Job must NEVER be marked completed on 401/403 error')
    assert.equal(job.status, 'pending')
  })

  // --------------------------------------------------------------------------
  // TEST 8: Generic 404 is not treated as successful revocation
  // --------------------------------------------------------------------------
  it('8. generic 404 is not treated as successful revocation', async () => {
    assert.equal(isConfirmedParticipantNotFound({ status: 404, message: 'Route not found' }), false)
    assert.equal(isConfirmedParticipantNotFound({ status: 404, message: 'Meeting not found' }), false)

    cfCustomHandler = async () => {
      const err = new Error('Route not found')
      err.status = 404
      throw err
    }

    const meeting = meetingsTable.get(MEETING_ID)

    await assert.rejects(
      async () => {
        await executeParticipantRemoval({
          meeting,
          userId: PARTICIPANT_USER,
          initiatorUserId: HOST_ID,
          dbClient: mockDb,
          cfService: mockCfService
        })
      },
      (err) => err.code === 'CLOUDFLARE_REVOCATION_PENDING'
    )

    const job = jobsTable.get(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase())
    assert.notEqual(job.status, 'completed', 'Job must not be marked completed on generic 404')
  })

  // --------------------------------------------------------------------------
  // TEST 9: Confirmed participant-not-found responses are handled correctly
  // --------------------------------------------------------------------------
  it('9. confirmed participant-not-found responses are handled correctly as already revoked', async () => {
    assert.equal(isConfirmedParticipantNotFound({ status: 404, message: 'Participant not found in meeting' }), true)
    assert.equal(isConfirmedParticipantNotFound({ status: 410, message: 'Participant session does not exist' }), true)

    cfCustomHandler = async () => {
      const err = new Error('Participant not found in meeting')
      err.status = 404
      throw err
    }

    const meeting = meetingsTable.get(MEETING_ID)

    const res = await executeParticipantRemoval({
      meeting,
      userId: PARTICIPANT_USER,
      initiatorUserId: HOST_ID,
      dbClient: mockDb,
      cfService: mockCfService
    })

    assert.equal(res.status, 'completed')
    assert.equal(res.cloudflareEvicted, true)

    const job = jobsTable.get(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase())
    assert.equal(job.status, 'completed')
  })

  // --------------------------------------------------------------------------
  // TEST 10: Original host cannot be removed by an assigned co-host
  // --------------------------------------------------------------------------
  it('10. original host cannot be removed by an assigned co-host', async () => {
    const meeting = meetingsTable.get(MEETING_ID)

    await assert.rejects(
      async () => {
        await executeParticipantRemoval({
          meeting,
          userId: HOST_ID,
          initiatorUserId: COHOST_ID,
          dbClient: mockDb,
          cfService: mockCfService
        })
      },
      (err) => {
        assert.equal(err.code, 'CANNOT_REMOVE_ORIGINAL_HOST')
        assert.equal(err.status, 403)
        return true
      }
    )
  })

  // --------------------------------------------------------------------------
  // TEST 11: A host cannot remove themselves through participant removal
  // --------------------------------------------------------------------------
  it('11. a host cannot remove themselves through participant removal', async () => {
    const meeting = meetingsTable.get(MEETING_ID)

    await assert.rejects(
      async () => {
        await executeParticipantRemoval({
          meeting,
          userId: HOST_ID,
          initiatorUserId: HOST_ID,
          dbClient: mockDb,
          cfService: mockCfService
        })
      },
      (err) => {
        assert.equal(err.code, 'CANNOT_REMOVE_SELF')
        assert.equal(err.status, 400)
        return true
      }
    )
  })

  // --------------------------------------------------------------------------
  // TEST 12: REST and Socket.IO use the same removal service
  // --------------------------------------------------------------------------
  it('12. REST and Socket.IO use the same removal service', async () => {
    let capturedStatus = null
    let capturedJson = null

    const req = {
      body: {
        meetingCode: MEETING_CODE,
        userId: PARTICIPANT_USER
      },
      user: {
        id: HOST_ID
      },
      app: {
        get: () => ({
          to: () => ({ emit: () => {} })
        })
      }
    }

    const res = {
      status: (code) => {
        capturedStatus = code
        return {
          json: (data) => {
            capturedJson = data
          }
        }
      }
    }

    await removeParticipant(req, res)

    assert.equal(capturedStatus, 200)
    assert.equal(capturedJson.success, true)
    assert.equal(capturedJson.status, 'completed')

    const job = jobsTable.get(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase())
    assert.equal(job.status, 'completed')
  })

  // --------------------------------------------------------------------------
  // TEST 13: Pending jobs survive a process crash after the database transaction
  // --------------------------------------------------------------------------
  it('13. pending jobs survive a process crash after the database transaction', async () => {
    const { data: jobRows } = await mockDb.rpc('create_participant_removal_job_tx', {
      p_meeting_id: MEETING_ID,
      p_user_id: PARTICIPANT_USER,
      p_cloudflare_meeting_id: CF_MEETING_ID,
      p_cloudflare_participant_id: CF_PART_ID
    })

    assert.equal(jobRows.length, 1)
    const jobId = jobRows[0].id

    const pendingAfterCrash = await getPendingRemovalJobs({ dbClient: mockDb })
    assert.equal(pendingAfterCrash.length, 1)
    assert.equal(pendingAfterCrash[0].id, jobId)

    const cycleRes = await runRemovalWorkerCycle({
      dbClient: mockDb,
      cfService: mockCfService
    })
    assert.equal(cycleRes.completed, 1)
    assert.equal((await getPendingRemovalJobs({ dbClient: mockDb })).length, 0)
  })

  // --------------------------------------------------------------------------
  // TEST 14: A repeated Cloudflare DELETE after a crash is handled safely
  // --------------------------------------------------------------------------
  it('14. a repeated Cloudflare DELETE after a crash is handled safely', async () => {
    let callCount = 0
    cfCustomHandler = async () => {
      callCount++
      if (callCount > 1) {
        const err = new Error('Participant not found in meeting')
        err.status = 404
        throw err
      }
      return { success: true }
    }

    await mockCfService.removeParticipant(CF_MEETING_ID, CF_PART_ID)

    const key = `${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase()
    const jobRow = {
      id: 'job-crash-repeat-test',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: `cf:${CF_PART_ID}`,
      status: 'pending',
      attempts: 1,
      next_retry_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobRow.id, jobRow)
    jobsTable.set(key, jobRow)

    const cycleRes = await runRemovalWorkerCycle({
      dbClient: mockDb,
      cfService: mockCfService
    })

    assert.equal(cycleRes.completed, 1, 'Must successfully handle repeated DELETE as completed')
    const job = jobsTable.get(jobRow.id)
    assert.equal(job.status, 'completed')
  })

  // --------------------------------------------------------------------------
  // TEST 15: Deleting a meeting does not delete pending jobs (ON DELETE SET NULL)
  // --------------------------------------------------------------------------
  it('15. deleting a meeting does not delete pending jobs (ON DELETE SET NULL)', async () => {
    const jobId = 'job-fk-meeting-test'
    const jobRow = {
      id: jobId,
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: `cf:${CF_PART_ID}`,
      status: 'pending',
      attempts: 0,
      next_retry_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobId, jobRow)
    jobsTable.set(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase(), jobRow)

    await mockDb.from('meetings').delete().eq('meeting_id', MEETING_ID)

    const { data: mtg } = await mockDb.from('meetings').select('*').eq('meeting_id', MEETING_ID).maybeSingle()
    assert.equal(mtg, null, 'Meeting must be deleted')

    const jobAfterDelete = Array.from(new Set(jobsTable.values())).find((j) => j.id === jobId)
    assert.ok(jobAfterDelete, 'Job must survive meeting deletion')
    assert.equal(jobAfterDelete.meeting_id, null, 'meeting_id must be SET NULL')
    assert.equal(jobAfterDelete.status, 'pending')
    assert.equal(jobAfterDelete.cloudflare_meeting_id, CF_MEETING_ID)
    assert.equal(jobAfterDelete.cloudflare_participant_id, CF_PART_ID)
  })

  // --------------------------------------------------------------------------
  // TEST 16: Deleting a user does not delete pending jobs (ON DELETE SET NULL)
  // --------------------------------------------------------------------------
  it('16. deleting a user does not delete pending jobs (ON DELETE SET NULL)', async () => {
    const jobId = 'job-fk-user-test'
    const jobRow = {
      id: jobId,
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: `cf:${CF_PART_ID}`,
      status: 'pending',
      attempts: 0,
      next_retry_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobId, jobRow)
    jobsTable.set(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase(), jobRow)

    await mockDb.from('users').delete().eq('id', PARTICIPANT_USER)

    const { data: u } = await mockDb.from('users').select('*').eq('id', PARTICIPANT_USER).maybeSingle()
    assert.equal(u, null, 'User must be deleted')

    const jobAfterDelete = Array.from(new Set(jobsTable.values())).find((j) => j.id === jobId)
    assert.ok(jobAfterDelete, 'Job must survive user deletion')
    assert.equal(jobAfterDelete.user_id, null, 'user_id must be SET NULL')
    assert.equal(jobAfterDelete.status, 'pending')
    assert.equal(jobAfterDelete.cloudflare_meeting_id, CF_MEETING_ID)
    assert.equal(jobAfterDelete.cloudflare_participant_id, CF_PART_ID)
  })

  // --------------------------------------------------------------------------
  // TEST 17: Orphaned jobs can still revoke Cloudflare participants
  // --------------------------------------------------------------------------
  it('17. orphaned jobs (null meeting_id & null user_id) can still revoke Cloudflare participants', async () => {
    const jobId = 'job-orphaned-eviction-test'
    const orphanedJob = {
      id: jobId,
      meeting_id: null,
      user_id: null,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: `cf:${CF_PART_ID}`,
      status: 'pending',
      attempts: 1,
      next_retry_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobId, orphanedJob)

    const cycleRes = await runRemovalWorkerCycle({
      dbClient: mockDb,
      cfService: mockCfService
    })

    assert.equal(cycleRes.completed, 1, 'Worker must process and complete orphaned job')
    assert.equal(cfCalls.length, 1, 'Worker must call Cloudflare eviction using stored IDs')
    assert.equal(cfCalls[0].meetingId, CF_MEETING_ID)
    assert.equal(cfCalls[0].participantId, CF_PART_ID)

    const completedJob = Array.from(new Set(jobsTable.values())).find((j) => j.id === jobId)
    assert.equal(completedJob.status, 'completed')
    assert.ok(completedJob.completed_at)
  })

  // --------------------------------------------------------------------------
  // TEST 18: Failed jobs remain available for manual retry
  // --------------------------------------------------------------------------
  it('18. failed jobs remain available for manual retry and succeed once service is restored', async () => {
    const jobId = 'job-failed-retry-test'
    const failedJob = {
      id: jobId,
      meeting_id: null,
      user_id: null,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: `cf:${CF_PART_ID}`,
      status: 'failed',
      attempts: 5,
      last_error: 'Upstream gateway down permanently',
      next_retry_at: new Date(Date.now() + 3600000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobId, failedJob)

    const retryRes = await manualRetryRemovalJob(jobId, {
      dbClient: mockDb,
      cfService: mockCfService
    })

    assert.equal(retryRes.completed, 1, 'Manual retry must complete the failed job')
    const finalJob = Array.from(new Set(jobsTable.values())).find((j) => j.id === jobId)
    assert.equal(finalJob.status, 'completed')
    assert.ok(finalJob.completed_at)
  })

  // --------------------------------------------------------------------------
  // TEST 19: Completed jobs remain auditable
  // --------------------------------------------------------------------------
  it('19. completed jobs remain auditable with all timestamps and IDs intact', async () => {
    const jobId = 'job-audit-retention-test'
    const jobRow = {
      id: jobId,
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: `cf:${CF_PART_ID}`,
      status: 'completed',
      attempts: 2,
      last_error: null,
      completed_at: new Date().toISOString(),
      created_at: new Date(Date.now() - 3600000).toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobId, jobRow)

    const { data: auditLogs } = await mockDb
      .from('participant_removal_jobs')
      .select('*')
      .eq('status', 'completed')

    assert.ok(auditLogs && auditLogs.length > 0)
    const auditRecord = auditLogs.find((j) => j.id === jobId)
    assert.equal(auditRecord.status, 'completed')
    assert.equal(auditRecord.cloudflare_meeting_id, CF_MEETING_ID)
    assert.equal(auditRecord.cloudflare_participant_id, CF_PART_ID)
    assert.ok(auditRecord.completed_at)
    assert.ok(auditRecord.created_at)
  })

  // --------------------------------------------------------------------------
  // TEST 20: PARTICIPANT VALIDATION — non-existent participants are rejected
  // --------------------------------------------------------------------------
  it('20. participant validation: rejects nonexistent participants without creating a job', async () => {
    const NONEXISTENT_USER = '99999999-9999-4999-8999-999999999999'
    const meeting = meetingsTable.get(MEETING_ID)

    await assert.rejects(
      async () => {
        await executeParticipantRemoval({
          meeting,
          userId: NONEXISTENT_USER,
          initiatorUserId: HOST_ID,
          dbClient: mockDb,
          cfService: mockCfService
        })
      },
      (err) => {
        assert.equal(err.code, 'PARTICIPANT_NOT_FOUND')
        assert.equal(err.status, 404)
        return true
      }
    )

    // Verify zero removal jobs were created
    const jobs = await getPendingRemovalJobs({ dbClient: mockDb })
    assert.equal(jobs.length, 0, 'No removal job must be created for nonexistent participant')
  })

  // --------------------------------------------------------------------------
  // TEST 21: PARTICIPANT VALIDATION — safe repeated removal for existing participant
  // --------------------------------------------------------------------------
  it('21. participant validation: allows repeated removals for existing participant idempotently', async () => {
    const meeting = meetingsTable.get(MEETING_ID)

    // First removal
    const res1 = await executeParticipantRemoval({
      meeting,
      userId: PARTICIPANT_USER,
      initiatorUserId: HOST_ID,
      dbClient: mockDb,
      cfService: mockCfService
    })
    assert.equal(res1.status, 'completed')

    // Second removal when participant_status is already 'removed'
    const res2 = await executeParticipantRemoval({
      meeting,
      userId: PARTICIPANT_USER,
      initiatorUserId: HOST_ID,
      dbClient: mockDb,
      cfService: mockCfService
    })
    assert.equal(res2.status, 'completed')
    assert.equal(res2.jobId, res1.jobId, 'Repeated removal must return existing job ID')
  })

  // --------------------------------------------------------------------------
  // TEST 22: SESSION-BASED IDEMPOTENCY — new Cloudflare session creates a new job
  // --------------------------------------------------------------------------
  it('22. session-based idempotency: new Cloudflare session creates fresh job and preserves history', async () => {
    const meeting = meetingsTable.get(MEETING_ID)

    // Session 1: completed removal
    const res1 = await executeParticipantRemoval({
      meeting,
      userId: PARTICIPANT_USER,
      initiatorUserId: HOST_ID,
      dbClient: mockDb,
      cfService: mockCfService
    })
    assert.equal(res1.status, 'completed')
    const job1 = jobsTable.get(res1.jobId)
    assert.equal(job1.status, 'completed')

    // Simulate participant rejoining with a NEW Cloudflare session ID
    const NEW_CF_PART_ID = 'cf-part-session-2222'
    participantsTable.set(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase(), {
      participant_id: 'part-supa-uuid-1',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      participant_status: 'joined',
      cloudflare_participant_id: NEW_CF_PART_ID
    })

    // Removal of Session 2
    const res2 = await executeParticipantRemoval({
      meeting,
      userId: PARTICIPANT_USER,
      initiatorUserId: HOST_ID,
      dbClient: mockDb,
      cfService: mockCfService
    })
    assert.equal(res2.status, 'completed')
    assert.notEqual(res2.jobId, res1.jobId, 'New session must create a distinct removal job')

    // Verify Session 1 job is preserved in history
    const preservedJob1 = jobsTable.get(res1.jobId)
    assert.ok(preservedJob1, 'Session 1 job must remain in database')
    assert.equal(preservedJob1.status, 'completed')
    assert.equal(preservedJob1.cloudflare_participant_id, CF_PART_ID)

    // Verify Session 2 job is separate
    const job2 = jobsTable.get(res2.jobId)
    assert.ok(job2, 'Session 2 job must exist')
    assert.equal(job2.cloudflare_participant_id, NEW_CF_PART_ID)
  })

  // --------------------------------------------------------------------------
  // TEST 23: SESSION-BASED IDEMPOTENCY — explicit null Cloudflare participant ID handling
  // --------------------------------------------------------------------------
  it('23. session-based idempotency: handles null Cloudflare participant IDs explicitly', async () => {
    // Participant without Cloudflare token
    participantsTable.set(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase(), {
      participant_id: 'part-supa-uuid-1',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      participant_status: 'joined',
      cloudflare_participant_id: null
    })

    const { data: jobRows } = await mockDb.rpc('create_participant_removal_job_tx', {
      p_meeting_id: MEETING_ID,
      p_user_id: PARTICIPANT_USER,
      p_cloudflare_meeting_id: CF_MEETING_ID,
      p_cloudflare_participant_id: null
    })

    assert.equal(jobRows.length, 1)
    const job = jobRows[0]
    assert.equal(job.cloudflare_participant_id, null)
    assert.equal(job.session_key, `part:${MEETING_ID}:part-supa-uuid-1`, 'Must generate stable session key from participant ID and meeting ID')
  })

  // --------------------------------------------------------------------------
  // TEST 24: WORKER LEASE FENCING — claims generate lease_token and reject stale completions
  // --------------------------------------------------------------------------
  it('24. worker lease fencing: claims generate lease_token and reject stale completions', async () => {
    const jobRow = {
      id: 'job-fencing-test',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: `cf:${CF_PART_ID}`,
      status: 'pending',
      attempts: 0,
      next_retry_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobRow.id, jobRow)

    // Worker A claims job
    const { data: workerAClaimed } = await mockDb.rpc('claim_participant_removal_jobs_tx', {
      p_batch_size: 10,
      p_lease_seconds: 60
    })
    assert.equal(workerAClaimed.length, 1)
    const workerAToken = workerAClaimed[0].lease_token
    assert.ok(workerAToken, 'Worker A must have a lease_token')

    // Simulate Worker A lease expiring and Worker B claiming the job
    const expiredJob = jobsTable.get(jobRow.id)
    expiredJob.lease_expires_at = new Date(Date.now() - 1000).toISOString()

    const { data: workerBClaimed } = await mockDb.rpc('claim_participant_removal_jobs_tx', {
      p_batch_size: 10,
      p_lease_seconds: 60
    })
    assert.equal(workerBClaimed.length, 1)
    const workerBToken = workerBClaimed[0].lease_token
    assert.notEqual(workerAToken, workerBToken, 'Worker B must receive a different lease_token')

    // Worker A (stale) attempts to complete the job using its stale lease_token
    const { data: staleCompleteOk } = await mockDb.rpc('complete_participant_removal_job_tx', {
      p_job_id: jobRow.id,
      p_lease_token: workerAToken
    })
    assert.equal(staleCompleteOk, false, 'Stale worker completion MUST be rejected by lease fencing')

    const currentJob = jobsTable.get(jobRow.id)
    assert.equal(currentJob.status, 'processing', 'Job must remain in processing under Worker B')
    assert.equal(currentJob.lease_token, workerBToken)

    // Worker B (valid) completes the job
    const { data: validCompleteOk } = await mockDb.rpc('complete_participant_removal_job_tx', {
      p_job_id: jobRow.id,
      p_lease_token: workerBToken
    })
    assert.equal(validCompleteOk, true, 'Valid worker completion must succeed')

    const finalizedJob = jobsTable.get(jobRow.id)
    assert.equal(finalizedJob.status, 'completed')
    assert.equal(finalizedJob.lease_token, null, 'Lease token must be cleared on completion')
  })

  // --------------------------------------------------------------------------
  // TEST 25: WORKER LEASE FENCING — retry scheduling requires matching lease token
  // --------------------------------------------------------------------------
  it('25. worker lease fencing: retry scheduling requires matching lease token', async () => {
    const jobRow = {
      id: 'job-fencing-retry-test',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: `cf:${CF_PART_ID}`,
      status: 'processing',
      attempts: 1,
      lease_expires_at: new Date(Date.now() + 60000).toISOString(),
      lease_token: 'valid-lease-token-abc',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobRow.id, jobRow)

    // Stale worker tries to schedule retry with wrong token
    const { data: staleRetryRes } = await mockDb.rpc('schedule_participant_removal_retry_tx', {
      p_job_id: jobRow.id,
      p_error_message: 'Stale error',
      p_backoff_seconds: 30,
      p_max_attempts: 5,
      p_lease_token: 'stale-wrong-token-xyz'
    })
    assert.equal(staleRetryRes, null, 'Stale retry must not modify job status')

    // Valid worker schedules retry with correct token
    const { data: validRetryRes } = await mockDb.rpc('schedule_participant_removal_retry_tx', {
      p_job_id: jobRow.id,
      p_error_message: 'Temporary upstream error',
      p_backoff_seconds: 30,
      p_max_attempts: 5,
      p_lease_token: 'valid-lease-token-abc'
    })
    assert.equal(validRetryRes, 'pending', 'Valid retry must schedule job to pending')

    const updatedJob = jobsTable.get(jobRow.id)
    assert.equal(updatedJob.lease_token, null, 'Lease token must be cleared on retry scheduling')
  })

  // --------------------------------------------------------------------------
  // TEST 26: INPUT VALIDATION — rejects invalid batch sizes, durations, and backoffs
  // --------------------------------------------------------------------------
  it('26. input validation: rejects invalid batch sizes, durations, and backoffs', async () => {
    // claim_participant_removal_jobs_tx: batch size <= 0
    const { error: batchErr1 } = await mockDb.rpc('claim_participant_removal_jobs_tx', {
      p_batch_size: 0,
      p_lease_seconds: 60
    })
    assert.ok(batchErr1, 'Must reject batch_size = 0')

    // claim_participant_removal_jobs_tx: batch size > 100
    const { error: batchErr2 } = await mockDb.rpc('claim_participant_removal_jobs_tx', {
      p_batch_size: 150,
      p_lease_seconds: 60
    })
    assert.ok(batchErr2, 'Must reject batch_size > 100')

    // claim_participant_removal_jobs_tx: lease_seconds <= 0
    const { error: leaseErr1 } = await mockDb.rpc('claim_participant_removal_jobs_tx', {
      p_batch_size: 10,
      p_lease_seconds: -10
    })
    assert.ok(leaseErr1, 'Must reject negative lease_seconds')

    // schedule_participant_removal_retry_tx: negative backoff
    const { error: backoffErr } = await mockDb.rpc('schedule_participant_removal_retry_tx', {
      p_job_id: 'any-id',
      p_error_message: 'err',
      p_backoff_seconds: -5,
      p_max_attempts: 5
    })
    assert.ok(backoffErr, 'Must reject negative backoff')

    // schedule_participant_removal_retry_tx: max_attempts < 1
    const { error: maxAttErr } = await mockDb.rpc('schedule_participant_removal_retry_tx', {
      p_job_id: 'any-id',
      p_error_message: 'err',
      p_backoff_seconds: 30,
      p_max_attempts: 0
    })
    assert.ok(maxAttErr, 'Must reject max_attempts < 1')
  })

  // --------------------------------------------------------------------------
  // TEST 27: FULL MIGRATION VALIDATION — DDL definitions and session unique index
  // --------------------------------------------------------------------------
  it('27. migration DDL defines session_key, lease_token, and ON DELETE SET NULL foreign keys', () => {
    const migrationSql = fs.readFileSync(path.resolve(__dirname, '../../migrations/20261103_participant_removal_jobs.sql'), 'utf8')

    assert.match(migrationSql, /meeting_id UUID NULL REFERENCES public\.meetings\(meeting_id\) ON DELETE SET NULL/i)
    assert.match(migrationSql, /user_id UUID NULL REFERENCES public\.users\(id\) ON DELETE SET NULL/i)
    assert.match(migrationSql, /session_key TEXT NOT NULL/i)
    assert.match(migrationSql, /lease_token UUID NULL/i)

    // Unique index on session_key
    assert.match(migrationSql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_participant_removal_jobs_session_key\s+ON public\.participant_removal_jobs\s*\(session_key\);/i)
    assert.match(migrationSql, /ON CONFLICT \(session_key\) DO UPDATE SET/i)
  })

  // --------------------------------------------------------------------------
  // TEST 28: FULL MIGRATION VALIDATION — Idempotent migration upgrades existing tables
  // --------------------------------------------------------------------------
  it('28. migration safely handles an existing development table via idempotent ALTER TABLE statements', () => {
    const migrationSql = fs.readFileSync(path.resolve(__dirname, '../../migrations/20261103_participant_removal_jobs.sql'), 'utf8')

    assert.match(migrationSql, /ALTER TABLE public\.participant_removal_jobs ADD COLUMN session_key TEXT;/i)
    assert.match(migrationSql, /ALTER TABLE public\.participant_removal_jobs ADD COLUMN lease_token UUID;/i)
    assert.match(migrationSql, /ALTER TABLE public\.participant_removal_jobs ALTER COLUMN meeting_id DROP NOT NULL;/i)
    assert.match(migrationSql, /ALTER TABLE public\.participant_removal_jobs ALTER COLUMN user_id DROP NOT NULL;/i)
    assert.match(migrationSql, /ADD CONSTRAINT fk_participant_removal_jobs_meeting_id\s+FOREIGN KEY \(meeting_id\) REFERENCES public\.meetings\(meeting_id\) ON DELETE SET NULL/i)
    assert.match(migrationSql, /ADD CONSTRAINT fk_participant_removal_jobs_user_id\s+FOREIGN KEY \(user_id\) REFERENCES public\.users\(id\) ON DELETE SET NULL/i)
    assert.match(migrationSql, /DROP CONSTRAINT uq_participant_removal_jobs_meeting_user/i)
  })

  // --------------------------------------------------------------------------
  // TEST 29: RETENTION CLEANUP COMPATIBILITY — protects meetings with active removals
  // --------------------------------------------------------------------------
  it('29. retention cleanup preserves meetings with pending or processing removal jobs', async () => {
    const activeMeetingId = 'active-meeting-with-pending-removal'
    meetingsTable.set(activeMeetingId, {
      meeting_id: activeMeetingId,
      meeting_code: 'ACTIVE-MTR',
      room_name: 'room-active-mtr',
      meeting_status: 'Ended',
      ended_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    })

    const pendingJob = {
      id: 'job-active-protect',
      meeting_id: activeMeetingId,
      user_id: PARTICIPANT_USER,
      status: 'pending',
      session_key: 'cf:cf-protect',
      cloudflare_meeting_id: 'cf-protect',
      cloudflare_participant_id: 'part-protect'
    }
    jobsTable.set(pendingJob.id, pendingJob)

    const { data: expiredMeetings } = await mockDb
      .from('meetings')
      .select('meeting_id, meeting_code')
      .eq('meeting_status', 'Ended')

    const candidateIds = expiredMeetings.map((m) => m.meeting_id)
    const protectedIds = new Set()

    const { data: removalCheck } = await mockDb
      .from('participant_removal_jobs')
      .select('meeting_id')
      .in('meeting_id', candidateIds)
      .in('status', ['pending', 'processing'])

    if (removalCheck && removalCheck.length > 0) {
      removalCheck.forEach((r) => {
        if (r.meeting_id) protectedIds.add(r.meeting_id)
      })
    }

    assert.ok(protectedIds.has(activeMeetingId), 'Meeting with pending removal job must be protected from cleanup')
    const deleteCandidates = candidateIds.filter((id) => !protectedIds.has(id))
    assert.ok(!deleteCandidates.includes(activeMeetingId), 'Protected meeting must not be in deletion candidates')
  })

  // --------------------------------------------------------------------------
  // TEST 30: SECURITY DEFINER search_path and privileges are hardened
  // --------------------------------------------------------------------------
  it('30. SECURITY DEFINER search_path is hardened and permissions remain restricted', () => {
    const migrationSql = fs.readFileSync(path.resolve(__dirname, '../../migrations/20261103_participant_removal_jobs.sql'), 'utf8')

    assert.match(migrationSql, /REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;/i)

    const searchPathMatches = migrationSql.match(/\n\s*SET search_path = pg_catalog, public, pg_temp/g)
    assert.equal(searchPathMatches ? searchPathMatches.length : 0, 5, 'All 5 RPC functions must set hardened search_path')

    assert.match(migrationSql, /REVOKE EXECUTE ON FUNCTION public\.create_participant_removal_job_tx FROM PUBLIC, anon, authenticated;/i)
    assert.match(migrationSql, /REVOKE EXECUTE ON FUNCTION public\.claim_participant_removal_jobs_tx FROM PUBLIC, anon, authenticated;/i)
    assert.match(migrationSql, /REVOKE EXECUTE ON FUNCTION public\.complete_participant_removal_job_tx FROM PUBLIC, anon, authenticated;/i)
    assert.match(migrationSql, /REVOKE EXECUTE ON FUNCTION public\.schedule_participant_removal_retry_tx FROM PUBLIC, anon, authenticated;/i)
    assert.match(migrationSql, /REVOKE EXECUTE ON FUNCTION public\.recover_expired_participant_removal_leases_tx FROM PUBLIC, anon, authenticated;/i)

    assert.match(migrationSql, /GRANT EXECUTE ON FUNCTION public\.create_participant_removal_job_tx TO service_role, postgres;/i)
    assert.match(migrationSql, /GRANT EXECUTE ON FUNCTION public\.claim_participant_removal_jobs_tx TO service_role, postgres;/i)
    assert.match(migrationSql, /GRANT EXECUTE ON FUNCTION public\.complete_participant_removal_job_tx TO service_role, postgres;/i)
    assert.match(migrationSql, /GRANT EXECUTE ON FUNCTION public\.schedule_participant_removal_retry_tx TO service_role, postgres;/i)
    assert.match(migrationSql, /GRANT EXECUTE ON FUNCTION public\.recover_expired_participant_removal_leases_tx TO service_role, postgres;/i)
  })

  // --------------------------------------------------------------------------
  // TEST 31: Same participant IDs across different meetings
  // --------------------------------------------------------------------------
  it('31. same participant IDs across different meetings create distinct, independent removal jobs', async () => {
    const MEETING_2_ID = 'meeting-2-uuid-9999'
    const CF_MEETING_2_ID = 'cf-mtg-2-uuid-9999'
    const SHARED_CF_PART_ID = 'cf-shared-participant-111'
    const SHARED_USER_ID = 'user-shared-uuid-7777'

    // Setup Meeting 1 & Participant
    meetingsTable.set(MEETING_ID, {
      meeting_id: MEETING_ID,
      meeting_code: 'MTG-1',
      room_name: 'room-1',
      host_id: HOST_ID,
      meeting_status: 'Active',
      cloudflare_meeting_id: CF_MEETING_ID
    })
    participantsTable.set(`${MEETING_ID}:${SHARED_USER_ID}`.toLowerCase(), {
      participant_id: 'part-uuid-m1',
      meeting_id: MEETING_ID,
      user_id: SHARED_USER_ID,
      participant_status: 'joined',
      cloudflare_participant_id: SHARED_CF_PART_ID
    })

    // Setup Meeting 2 & Participant with the exact same participant ID and user ID
    meetingsTable.set(MEETING_2_ID, {
      meeting_id: MEETING_2_ID,
      meeting_code: 'MTG-2',
      room_name: 'room-2',
      host_id: HOST_ID,
      meeting_status: 'Active',
      cloudflare_meeting_id: CF_MEETING_2_ID
    })
    participantsTable.set(`${MEETING_2_ID}:${SHARED_USER_ID}`.toLowerCase(), {
      participant_id: 'part-uuid-m2',
      meeting_id: MEETING_2_ID,
      user_id: SHARED_USER_ID,
      participant_status: 'joined',
      cloudflare_participant_id: SHARED_CF_PART_ID
    })

    // Create removal job for Meeting 1
    const { data: jobRows1 } = await mockDb.rpc('create_participant_removal_job_tx', {
      p_meeting_id: MEETING_ID,
      p_user_id: SHARED_USER_ID,
      p_cloudflare_meeting_id: CF_MEETING_ID,
      p_cloudflare_participant_id: SHARED_CF_PART_ID
    })
    assert.equal(jobRows1.length, 1)
    const job1 = jobRows1[0]
    assert.equal(job1.session_key, `cf:${CF_MEETING_ID}:${SHARED_CF_PART_ID}`)

    // Create removal job for Meeting 2
    const { data: jobRows2 } = await mockDb.rpc('create_participant_removal_job_tx', {
      p_meeting_id: MEETING_2_ID,
      p_user_id: SHARED_USER_ID,
      p_cloudflare_meeting_id: CF_MEETING_2_ID,
      p_cloudflare_participant_id: SHARED_CF_PART_ID
    })
    assert.equal(jobRows2.length, 1)
    const job2 = jobRows2[0]
    assert.equal(job2.session_key, `cf:${CF_MEETING_2_ID}:${SHARED_CF_PART_ID}`)

    // Verify both jobs exist independently without collision
    assert.notEqual(job1.id, job2.id, 'Jobs across different meetings must have distinct IDs')
    assert.notEqual(job1.session_key, job2.session_key, 'Session keys must include meeting ID and not collide')
    const allJobs = Array.from(new Set(jobsTable.values()))
    assert.ok(allJobs.some((j) => j.id === job1.id && j.meeting_id === MEETING_ID))
    assert.ok(allJobs.some((j) => j.id === job2.id && j.meeting_id === MEETING_2_ID))
  })

  // --------------------------------------------------------------------------
  // TEST 32: Duplicate requests while processing
  // --------------------------------------------------------------------------
  it('32. duplicate removal requests while processing never reset worker lease or lease_token', async () => {
    const meeting = meetingsTable.get(MEETING_ID)
    const LEASE_TOKEN = 'lease-active-uuid-9999'
    const FUTURE_LEASE = new Date(Date.now() + 60000).toISOString()
    const sessionKey = `cf:${CF_MEETING_ID}:${CF_PART_ID}`

    // Insert an in-flight job currently leased by a background worker
    const jobRow = {
      id: 'job-active-processing',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: sessionKey,
      status: 'processing',
      attempts: 1,
      lease_token: LEASE_TOKEN,
      lease_expires_at: FUTURE_LEASE,
      next_retry_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobRow.id, jobRow)
    jobsTable.set(sessionKey, jobRow)
    jobsTable.set(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase(), jobRow)

    // Execute duplicate removal request
    const res = await executeParticipantRemoval({
      meeting,
      userId: PARTICIPANT_USER,
      initiatorUserId: HOST_ID,
      dbClient: mockDb,
      cfService: mockCfService
    })

    assert.equal(res.status, 'processing', 'Must return processing status idempotently')
    assert.equal(res.jobId, jobRow.id)

    // Verify job in database retained its exact lease token and lease expiry
    const dbJob = jobsTable.get(jobRow.id)
    assert.equal(dbJob.status, 'processing', 'Status must remain processing')
    assert.equal(dbJob.lease_token, LEASE_TOKEN, 'Worker lease_token must not be overwritten or cleared')
    assert.equal(dbJob.lease_expires_at, FUTURE_LEASE, 'Lease expiry must not be reset')
  })

  // --------------------------------------------------------------------------
  // TEST 33: Duplicate requests during scheduled backoff
  // --------------------------------------------------------------------------
  it('33. duplicate removal requests during scheduled backoff never bypass existing next_retry_at', async () => {
    const meeting = meetingsTable.get(MEETING_ID)
    const FUTURE_RETRY = new Date(Date.now() + 120000).toISOString()
    const sessionKey = `cf:${CF_MEETING_ID}:${CF_PART_ID}`

    // Insert a pending job in backoff
    const jobRow = {
      id: 'job-in-backoff',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: sessionKey,
      status: 'pending',
      attempts: 2,
      last_error: 'Upstream rate limit 429',
      next_retry_at: FUTURE_RETRY,
      lease_token: null,
      lease_expires_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobRow.id, jobRow)
    jobsTable.set(sessionKey, jobRow)
    jobsTable.set(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase(), jobRow)

    // Execute duplicate removal request
    const res = await executeParticipantRemoval({
      meeting,
      userId: PARTICIPANT_USER,
      initiatorUserId: HOST_ID,
      dbClient: mockDb,
      cfService: mockCfService
    })

    assert.equal(res.status, 'pending')
    assert.equal(res.jobId, jobRow.id)

    // Verify job in database kept its future next_retry_at
    const dbJob = jobsTable.get(jobRow.id)
    assert.equal(dbJob.next_retry_at, FUTURE_RETRY, 'next_retry_at must remain in the future; backoff not bypassed')
    assert.equal(dbJob.attempts, 2, 'Attempts count must not be altered')
  })

  // --------------------------------------------------------------------------
  // TEST 34: Duplicate requests for failed jobs
  // --------------------------------------------------------------------------
  it('34. duplicate removal requests for failed jobs never automatically reopen them', async () => {
    const meeting = meetingsTable.get(MEETING_ID)
    const sessionKey = `cf:${CF_MEETING_ID}:${CF_PART_ID}`

    // Insert a job that exhausted all max attempts
    const jobRow = {
      id: 'job-failed-exhausted',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: sessionKey,
      status: 'failed',
      attempts: 5,
      max_attempts: 5,
      last_error: 'Cloudflare service permanent error 400',
      next_retry_at: new Date(Date.now() - 10000).toISOString(),
      lease_token: null,
      lease_expires_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobRow.id, jobRow)
    jobsTable.set(sessionKey, jobRow)
    jobsTable.set(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase(), jobRow)

    // Execute duplicate removal request
    const res = await executeParticipantRemoval({
      meeting,
      userId: PARTICIPANT_USER,
      initiatorUserId: HOST_ID,
      dbClient: mockDb,
      cfService: mockCfService
    })

    assert.equal(res.status, 'failed', 'Must report failed status without automatic reopening')
    assert.equal(res.jobId, jobRow.id)

    // Verify job in database remained failed and attempts intact
    const dbJob = jobsTable.get(jobRow.id)
    assert.equal(dbJob.status, 'failed', 'Job must not be reopened by duplicate requests')
    assert.equal(dbJob.attempts, 5, 'Attempts must not be reset')
  })

  // --------------------------------------------------------------------------
  // TEST 35: Explicit manual retry
  // --------------------------------------------------------------------------
  it('35. explicit manual retry is the only mechanism that reopens failed jobs', async () => {
    const sessionKey = `cf:${CF_MEETING_ID}:${CF_PART_ID}`
    const jobRow = {
      id: 'job-manual-retry-target',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: sessionKey,
      status: 'failed',
      attempts: 5,
      max_attempts: 5,
      last_error: 'Cloudflare timeout after 5 attempts',
      lease_token: null,
      lease_expires_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobRow.id, jobRow)
    jobsTable.set(sessionKey, jobRow)
    jobsTable.set(`${MEETING_ID}:${PARTICIPANT_USER}`.toLowerCase(), jobRow)

    // Ensure Cloudflare now succeeds
    cfCustomHandler = null

    // Call explicit manual retry
    const res = await manualRetryRemovalJob(jobRow.id, {
      dbClient: mockDb,
      cfService: mockCfService
    })

    assert.equal(res.completed, 1, 'Manual retry cycle must claim and complete the job')
    const dbJob = jobsTable.get(jobRow.id)
    assert.equal(dbJob.status, 'completed', 'Job must now be marked completed')
    assert.ok(dbJob.completed_at)
  })

  // --------------------------------------------------------------------------
  // TEST 36: Stale worker rejection
  // --------------------------------------------------------------------------
  it('36. stale worker completion and retry calls are strictly rejected by lease_token fencing', async () => {
    const sessionKey = `cf:${CF_MEETING_ID}:${CF_PART_ID}`
    const VALID_LEASE_TOKEN = 'lease-valid-worker-2222'
    const STALE_LEASE_TOKEN = 'lease-stale-worker-1111'

    const jobRow = {
      id: 'job-fencing-stale-test',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: sessionKey,
      status: 'processing',
      attempts: 2,
      lease_token: VALID_LEASE_TOKEN,
      lease_expires_at: new Date(Date.now() + 60000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(jobRow.id, jobRow)
    jobsTable.set(sessionKey, jobRow)

    // Stale worker tries to complete job using old lease token
    const { data: completeResult } = await mockDb.rpc('complete_participant_removal_job_tx', {
      p_job_id: jobRow.id,
      p_lease_token: STALE_LEASE_TOKEN
    })
    assert.equal(completeResult, false, 'Stale worker completion must return false')
    assert.equal(jobsTable.get(jobRow.id).status, 'processing', 'Job status must remain processing')

    // Stale worker tries to schedule retry using old lease token
    const { data: retryResult } = await mockDb.rpc('schedule_participant_removal_retry_tx', {
      p_job_id: jobRow.id,
      p_error_message: 'Stale worker error',
      p_backoff_seconds: 30,
      p_max_attempts: 5,
      p_lease_token: STALE_LEASE_TOKEN
    })
    assert.equal(retryResult, null, 'Stale worker retry must be rejected')
    assert.equal(jobsTable.get(jobRow.id).lease_token, VALID_LEASE_TOKEN, 'Valid lease token must be preserved')

    // Valid worker completes job
    const { data: validComplete } = await mockDb.rpc('complete_participant_removal_job_tx', {
      p_job_id: jobRow.id,
      p_lease_token: VALID_LEASE_TOKEN
    })
    assert.equal(validComplete, true, 'Valid worker completion must succeed')
    assert.equal(jobsTable.get(jobRow.id).status, 'completed')
  })

  // --------------------------------------------------------------------------
  // TEST 37: Migration resolves duplicate canonical keys without data loss
  // --------------------------------------------------------------------------
  it('37. migration detects duplicate canonical session keys, preserves all records with :dup:<id>, and creates unique index', () => {
    const migrationSql = fs.readFileSync(path.resolve(__dirname, '../../migrations/20261103_participant_removal_jobs.sql'), 'utf8')

    // Detects canonical session key migration with ROW_NUMBER() ranking
    assert.match(migrationSql, /WITH ranked_jobs AS/i)
    assert.match(migrationSql, /ROW_NUMBER\(\) OVER/i)
    assert.match(migrationSql, /r\.canonical_key \|\| ':dup:' \|\| r\.id::text/i)
    assert.match(migrationSql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_participant_removal_jobs_session_key/i)
  })

  // --------------------------------------------------------------------------
  // TEST 38: Worker rejects claimed jobs missing lease_token
  // --------------------------------------------------------------------------
  it('38. worker strictly rejects claimed jobs if lease_token is missing without calling completion or retry', async () => {
    const unleasedJob = {
      id: 'job-unleased-test-uuid',
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_USER,
      cloudflare_meeting_id: CF_MEETING_ID,
      cloudflare_participant_id: CF_PART_ID,
      session_key: `cf:${CF_MEETING_ID}:${CF_PART_ID}`,
      status: 'processing',
      attempts: 1,
      lease_token: null, // Missing lease token!
      lease_expires_at: new Date(Date.now() + 60000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    jobsTable.set(unleasedJob.id, unleasedJob)

    let completionCalled = false
    let retryCalled = false

    const spyDb = {
      ...mockDb,
      rpc: async (func, params) => {
        if (func === 'complete_participant_removal_job_tx') {
          completionCalled = true
        }
        if (func === 'schedule_participant_removal_retry_tx') {
          retryCalled = true
        }
        return await mockDb.rpc(func, params)
      }
    }

    const res = await runRemovalWorkerCycle({
      dbClient: spyDb,
      cfService: mockCfService,
      batchSize: 10
    })

    assert.equal(completionCalled, false, 'Worker completion must NEVER be called with null lease token')
    assert.equal(retryCalled, false, 'Worker retry must NEVER be called with null lease token')
    assert.equal(jobsTable.get(unleasedJob.id).status, 'processing', 'Unleased job must be skipped/rejected')
  })
})
