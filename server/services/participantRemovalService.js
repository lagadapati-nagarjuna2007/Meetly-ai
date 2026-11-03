import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { supabase } from '../config/supabase.js'
import {
  isCloudflareConfigured,
  removeCloudflareParticipant
} from '../config/cloudflareRealtime.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_LEGACY_PATH = path.resolve(__dirname, '../../server/data/pending_revocations.json')

// Active DB client reference allowing test injection
let activeDbClient = supabase

// Default Cloudflare service reference allowing test overrides
let defaultCloudflareService = {
  isConfigured: isCloudflareConfigured,
  removeParticipant: removeCloudflareParticipant
}

export const setDatabaseClient = (client) => {
  activeDbClient = client
}

export const resetDatabaseClient = () => {
  activeDbClient = supabase
}

export const setRemovalCloudflareService = (service) => {
  defaultCloudflareService = { ...defaultCloudflareService, ...service }
}

export const resetRemovalCloudflareService = () => {
  defaultCloudflareService = {
    isConfigured: isCloudflareConfigured,
    removeParticipant: removeCloudflareParticipant
  }
}

// In-process mutex per "meetingId:userId" to coordinate concurrent requests on the same node
const revocationMutexes = new Map()

const withRevocationMutex = async (key, fn) => {
  while (revocationMutexes.has(key)) {
    try {
      await revocationMutexes.get(key)
    } catch (_) {}
  }
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  revocationMutexes.set(key, promise)
  try {
    return await fn()
  } finally {
    revocationMutexes.delete(key)
    release()
  }
}

/**
 * Helper to determine if an RPC function is missing/unimplemented on the database or mock
 */
const isRpcMissing = (err) => {
  if (!err) return false
  const msg = String(err.message || '').toLowerCase()
  return (
    msg.includes('unknown rpc') ||
    (msg.includes('function') && msg.includes('does not exist')) ||
    err.code === 'PGRST202' ||
    err.code === '42883'
  )
}

/**
 * Checks whether an error from Cloudflare RealtimeKit is a confirmed participant-not-found response.
 * Only HTTP 404 / 410 where error specifically indicates participant is absent is considered successful eviction.
 * Unrelated errors (e.g. generic 404 Route Not Found, 401 Unauthorized, 403 Forbidden, 500, network timeouts) return false.
 */
export const isConfirmedParticipantNotFound = (cfErr) => {
  if (!cfErr) return false
  const status = Number(cfErr.status || cfErr.statusCode || 0)
  if (status !== 404 && status !== 410) {
    return false
  }
  const msg = String(cfErr.message || '').toLowerCase()
  const mentionsParticipant =
    msg.includes('participant') ||
    msg.includes('peer') ||
    msg.includes('user') ||
    msg.includes('session')
  const mentionsAbsence =
    msg.includes('not found') ||
    msg.includes('does not exist') ||
    msg.includes('absent') ||
    msg.includes('not in meeting')
  return mentionsParticipant && mentionsAbsence
}

/**
 * Executes a participant removal with:
 * 1. Original host protection (original host cannot be removed by co-hosts).
 * 2. Self-removal prevention (users must use leave meeting).
 * 3. Durable PostgreSQL participant_removal_jobs queue in Supabase.
 * 4. Immediate application & Socket.IO room disconnect.
 * 5. Bounded immediate retries for Cloudflare eviction.
 * 6. Durable queue state transition upon success or scheduling for background worker.
 */
export const executeParticipantRemoval = async ({
  meeting,
  userId,
  initiatorUserId = null,
  dbClient = activeDbClient,
  cfService = defaultCloudflareService,
  ioInstance = null,
  roomUserSockets = null
}) => {
  if (!meeting?.meeting_id) {
    throw new Error('Valid meeting record is required for participant removal.')
  }
  if (!userId) {
    throw new Error('Valid userId is required for participant removal.')
  }

  const targetUserIdStr = String(userId).trim().toLowerCase()
  const origHostStr = String(meeting.host_id || meeting.hostId || '').trim().toLowerCase()
  const initiatorStr = initiatorUserId ? String(initiatorUserId).trim().toLowerCase() : null

  // 1. Self-removal prevention
  if (initiatorStr && initiatorStr === targetUserIdStr) {
    const err = new Error('Cannot remove yourself through participant removal. Use leave meeting instead.')
    err.code = 'CANNOT_REMOVE_SELF'
    err.status = 400
    throw err
  }

  // 2. Original Host protection: original host must never be removable
  if (origHostStr && targetUserIdStr === origHostStr) {
    const err = new Error('The original host cannot be removed from the meeting.')
    err.code = 'CANNOT_REMOVE_ORIGINAL_HOST'
    err.status = 403
    throw err
  }

  const lockKey = `${meeting.meeting_id}:${targetUserIdStr}`

  // 3. Concurrency Lock: coordinate cleanups on the same participant
  return await withRevocationMutex(lockKey, async () => {
    // 3.1. Fetch participant record
    const { data: participant, error: fetchErr } = await dbClient
      .from('participants')
      .select('participant_id, cloudflare_participant_id, participant_status')
      .eq('meeting_id', meeting.meeting_id)
      .eq('user_id', userId)
      .maybeSingle()

    if (fetchErr) {
      console.error('[ParticipantRemoval] Error querying participant:', fetchErr)
      throw fetchErr
    }

    // PARTICIPANT VALIDATION: Reject nonexistent participants immediately
    if (!participant) {
      const notFoundErr = new Error('Participant not found in meeting')
      notFoundErr.code = 'PARTICIPANT_NOT_FOUND'
      notFoundErr.status = 404
      throw notFoundErr
    }

    const cfMeetingId = meeting.cloudflare_meeting_id || null
    const cfPartId = participant?.cloudflare_participant_id || null
    const isCfConfigured = Boolean(cfMeetingId && cfPartId && cfService?.isConfigured?.())

    const effectiveSessionKey = cfPartId
      ? `cf:${cfMeetingId || meeting.meeting_id}:${cfPartId}`
      : `part:${meeting.meeting_id}:${participant?.participant_id || targetUserIdStr}`

    // 3.2. Check if a job already exists for this exact session
    let existingJob = null
    const { data: jobBySession } = await dbClient
      .from('participant_removal_jobs')
      .select('id, status, attempts, next_retry_at, last_error, lease_token, lease_expires_at, cloudflare_participant_id, session_key')
      .eq('session_key', effectiveSessionKey)
      .maybeSingle()
    existingJob = jobBySession

    // DUPLICATE REQUEST HANDLING:
    // - Make duplicate removal requests idempotent without changing existing job state.
    // - Never reset a processing job's lease.
    // - Never bypass an existing next_retry_at.
    // - Never automatically reopen a failed job through a duplicate request.
    // - Keep explicit manual retry as the only mechanism for reopening failed jobs.
    // - Preserve completed records.

    if (existingJob?.status === 'completed') {
      return {
        jobId: existingJob.id,
        participantId: participant?.participant_id || null,
        status: 'completed',
        cloudflareEvicted: true
      }
    }

    if (existingJob?.status === 'processing') {
      return {
        jobId: existingJob.id,
        participantId: participant?.participant_id || null,
        status: 'processing',
        cloudflareEvicted: false,
        message: 'Participant removal is currently being processed by worker.'
      }
    }

    if (existingJob?.status === 'pending' && existingJob.next_retry_at && new Date(existingJob.next_retry_at).getTime() > Date.now()) {
      return {
        jobId: existingJob.id,
        participantId: participant?.participant_id || null,
        status: 'pending',
        cloudflareEvicted: false,
        message: 'Participant removal is scheduled for retry.'
      }
    }

    if (existingJob?.status === 'failed') {
      return {
        jobId: existingJob.id,
        participantId: participant?.participant_id || null,
        status: 'failed',
        cloudflareEvicted: false,
        lastError: existingJob.last_error,
        message: 'Participant removal previously failed max retry attempts. Manual retry is required.'
      }
    }

    // 3.3. Create durable pending job in Supabase & mark participant as removed in DB atomically
    let jobRecord = null
    let useRpc = typeof dbClient.rpc === 'function'

    if (useRpc) {
      const { data: rpcRows, error: rpcErr } = await dbClient.rpc('create_participant_removal_job_tx', {
        p_meeting_id: meeting.meeting_id,
        p_user_id: targetUserIdStr,
        p_cloudflare_meeting_id: cfMeetingId,
        p_cloudflare_participant_id: cfPartId
      })

      if (rpcErr) {
        if (isRpcMissing(rpcErr)) {
          useRpc = false
        } else {
          console.error('[ParticipantRemoval] Error executing create_participant_removal_job_tx RPC:', rpcErr)
          throw rpcErr
        }
      } else {
        jobRecord = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows
      }
    }

    if (!useRpc || !jobRecord) {
      // Fallback for mock environments without RPC
      if (participant) {
        await dbClient
          .from('participants')
          .update({
            participant_status: 'removed',
            left_at: new Date().toISOString()
          })
          .eq('participant_id', participant.participant_id)
      }

      const sessionKey = effectiveSessionKey
      if (!existingJob) {
        try {
          const { data: insertedJob } = await dbClient
            .from('participant_removal_jobs')
            .insert({
              meeting_id: meeting.meeting_id,
              user_id: targetUserIdStr,
              cloudflare_meeting_id: cfMeetingId,
              cloudflare_participant_id: cfPartId,
              session_key: sessionKey,
              status: 'pending',
              attempts: 0,
              next_retry_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .select()
            .maybeSingle()

          jobRecord = insertedJob || { id: 'job-' + Date.now(), user_id: targetUserIdStr, meeting_id: meeting.meeting_id, session_key: sessionKey }
        } catch (_) {
          jobRecord = { id: 'job-' + Date.now(), user_id: targetUserIdStr, meeting_id: meeting.meeting_id, session_key: sessionKey }
        }
      } else {
        jobRecord = existingJob
      }
    }

    if (jobRecord?.status === 'completed') {
      return {
        jobId: jobRecord.id,
        participantId: participant?.participant_id || null,
        status: 'completed',
        cloudflareEvicted: true
      }
    }
    if (jobRecord?.status === 'processing') {
      return {
        jobId: jobRecord.id,
        participantId: participant?.participant_id || null,
        status: 'processing',
        cloudflareEvicted: false,
        message: 'Participant removal is currently being processed by worker.'
      }
    }
    if (jobRecord?.status === 'failed') {
      return {
        jobId: jobRecord.id,
        participantId: participant?.participant_id || null,
        status: 'failed',
        cloudflareEvicted: false,
        lastError: jobRecord.last_error,
        message: 'Participant removal previously failed max retry attempts. Manual retry is required.'
      }
    }
    if (jobRecord?.status === 'pending' && jobRecord.next_retry_at && new Date(jobRecord.next_retry_at).getTime() > Date.now()) {
      return {
        jobId: jobRecord.id,
        participantId: participant?.participant_id || null,
        status: 'pending',
        cloudflareEvicted: false,
        message: 'Participant removal is scheduled for retry.'
      }
    }

    const jobId = jobRecord?.id

    // 3.4. Immediately remove their Socket.IO room access and emit participant_removed
    if (ioInstance && meeting.room_name) {
      ioInstance.to(meeting.room_name).emit('participant_removed', { userId: targetUserIdStr })

      const userMap =
        roomUserSockets?.get?.(meeting.room_name) ||
        ioInstance.roomUserSockets?.get?.(meeting.room_name)
      const targetSockets = userMap?.get?.(targetUserIdStr)
      if (targetSockets) {
        targetSockets.forEach((sId) => {
          const s = ioInstance.sockets?.sockets?.get?.(sId)
          if (s) {
            s.emit('participant_removed', { userId: targetUserIdStr })
            s.leave(meeting.room_name)
          }
        })
        userMap.delete(targetUserIdStr)
      }

      // Notify host that removal is initiated and revocation is in progress
      if (isCfConfigured) {
        ioInstance.to(meeting.room_name).emit('participant_removal_pending', {
          jobId,
          userId: targetUserIdStr,
          roomName: meeting.room_name,
          message: 'Participant removal initiated. Cloudflare RealtimeKit media revocation in progress...'
        })
      }
    }

    // 3.5. If Cloudflare is not configured, mark job complete immediately
    if (!isCfConfigured) {
      if (jobId) {
        let done = false
        if (typeof dbClient.rpc === 'function') {
          const { error: rpcErr } = await dbClient.rpc('complete_participant_removal_job_tx', { p_job_id: jobId })
          if (!rpcErr || !isRpcMissing(rpcErr)) {
            done = true
          }
        }
        if (!done) {
          try {
            await dbClient
              .from('participant_removal_jobs')
              .update({
                status: 'completed',
                completed_at: new Date().toISOString(),
                lease_expires_at: null,
                updated_at: new Date().toISOString()
              })
              .eq('id', jobId)
          } catch (_) {}
        }
      }

      if (ioInstance && meeting.room_name) {
        ioInstance.to(meeting.room_name).emit('participant_removal_completed', {
          jobId,
          userId: targetUserIdStr,
          roomName: meeting.room_name,
          participantId: participant?.participant_id || null
        })
      }

      return {
        jobId,
        participantId: participant?.participant_id || null,
        status: 'completed',
        cloudflareEvicted: true
      }
    }

    // 3.6. Attempt Cloudflare RealtimeKit media session revocation with bounded retries
    let cloudflareEvicted = false
    let lastError = null
    const maxImmediateAttempts = 3

    for (let attempt = 1; attempt <= maxImmediateAttempts; attempt++) {
      try {
        await cfService.removeParticipant(cfMeetingId, cfPartId)
        cloudflareEvicted = true
        console.log(`[ParticipantRemoval] Successfully evicted participant ${cfPartId} from Cloudflare meeting ${cfMeetingId} (attempt ${attempt})`)
        break
      } catch (cfErr) {
        lastError = cfErr

        // Treat ONLY confirmed participant-not-found as successful eviction
        if (isConfirmedParticipantNotFound(cfErr)) {
          cloudflareEvicted = true
          console.log(`[ParticipantRemoval] Confirmed participant ${cfPartId} was already absent from Cloudflare session.`)
          break
        }

        const statusCode = Number(cfErr.status || cfErr.statusCode || 0)
        // If 401 Unauthorized or 403 Forbidden, credentials are invalid/forbidden — do not loop rapidly
        if (statusCode === 401 || statusCode === 403) {
          console.error(`[ParticipantRemoval] Cloudflare authentication/permission error (${statusCode}):`, cfErr.message)
          break
        }

        console.warn(`[ParticipantRemoval] Cloudflare removeParticipant attempt ${attempt}/${maxImmediateAttempts} failed for ${cfPartId}:`, cfErr.message)
        if (attempt < maxImmediateAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
        }
      }
    }

    // 3.7. Handle Success: Mark job completed in Supabase queue
    if (cloudflareEvicted) {
      if (jobId) {
        let done = false
        if (typeof dbClient.rpc === 'function') {
          const { error: rpcErr } = await dbClient.rpc('complete_participant_removal_job_tx', { p_job_id: jobId })
          if (!rpcErr || !isRpcMissing(rpcErr)) {
            done = true
          }
        }
        if (!done) {
          try {
            await dbClient
              .from('participant_removal_jobs')
              .update({
                status: 'completed',
                completed_at: new Date().toISOString(),
                lease_expires_at: null,
                last_error: null,
                updated_at: new Date().toISOString()
              })
              .eq('id', jobId)
          } catch (_) {}
        }
      }

      // Notify host of completed removal state
      if (ioInstance && meeting.room_name) {
        ioInstance.to(meeting.room_name).emit('participant_removal_completed', {
          jobId,
          userId: targetUserIdStr,
          roomName: meeting.room_name,
          participantId: participant?.participant_id || null
        })
      }

      return {
        jobId,
        participantId: participant?.participant_id || null,
        status: 'completed',
        cloudflareEvicted: true
      }
    }

    // 3.8. Handle Persistent Cloudflare Failure: schedule retry in Supabase queue
    const backoffSeconds = 15
    if (jobId) {
      let done = false
      if (typeof dbClient.rpc === 'function') {
        const { error: rpcErr } = await dbClient.rpc('schedule_participant_removal_retry_tx', {
          p_job_id: jobId,
          p_error_message: lastError?.message || 'Upstream Cloudflare error',
          p_backoff_seconds: backoffSeconds,
          p_max_attempts: 5
        })
        if (!rpcErr || !isRpcMissing(rpcErr)) {
          done = true
        }
      }
      if (!done) {
        try {
          await dbClient
            .from('participant_removal_jobs')
            .update({
              status: 'pending',
              attempts: (jobRecord?.attempts || 0) + maxImmediateAttempts,
              last_error: lastError?.message || 'Upstream Cloudflare error',
              next_retry_at: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
              lease_expires_at: null,
              updated_at: new Date().toISOString()
            })
            .eq('id', jobId)
        } catch (_) {}
      }
    }

    console.error(`[ParticipantRemoval CRITICAL] Cloudflare revocation pending for ${cfPartId} in ${cfMeetingId}. Job ${jobId} queued for background worker.`)

    const pendingErr = new Error(`Cloudflare participant revocation pending: ${lastError?.message || 'Upstream error'}. Automatic recovery scheduled.`)
    pendingErr.code = 'CLOUDFLARE_REVOCATION_PENDING'
    pendingErr.status = 502
    pendingErr.jobId = jobId
    throw pendingErr
  })
}

// ----------------------------------------------------------------------------
// AUTOMATIC RETRY WORKER
// ----------------------------------------------------------------------------
let workerIntervalId = null
let isWorkerCycleRunning = false

/**
 * Runs a single cycle of the removal worker:
 * 1. Atomically claims eligible jobs using FOR UPDATE SKIP LOCKED via RPC claim_participant_removal_jobs_tx.
 * 2. Attempts Cloudflare RealtimeKit eviction.
 * 3. On success: completes job in Supabase.
 * 4. On failure: updates attempts and schedules exponential backoff.
 */
export const runRemovalWorkerCycle = async ({
  dbClient = activeDbClient,
  cfService = defaultCloudflareService,
  ioInstance = null,
  batchSize = 10,
  leaseSeconds = 60,
  maxAttempts = 5
} = {}) => {
  if (isWorkerCycleRunning) {
    return { processed: 0, reason: 'cycle_already_in_flight' }
  }

  // Strict input validation
  const validBatchSize = Math.max(1, Math.min(100, Math.floor(Number(batchSize) || 10)))
  const validLeaseSeconds = Math.max(1, Math.min(3600, Math.floor(Number(leaseSeconds) || 60)))
  const validMaxAttempts = Math.max(1, Math.min(100, Math.floor(Number(maxAttempts) || 5)))

  isWorkerCycleRunning = true
  let claimedCount = 0
  let completedCount = 0
  let retriedCount = 0

  try {
    let claimedJobs = []
    let useRpc = typeof dbClient.rpc === 'function'

    if (useRpc) {
      const { data: jobs, error: claimErr } = await dbClient.rpc('claim_participant_removal_jobs_tx', {
        p_batch_size: validBatchSize,
        p_lease_seconds: validLeaseSeconds
      })

      if (claimErr) {
        if (isRpcMissing(claimErr)) {
          useRpc = false
        } else {
          console.warn('[ParticipantRemoval Worker] Error claiming jobs via RPC:', claimErr.message)
        }
      } else if (jobs && jobs.length > 0) {
        claimedJobs = jobs
      }
    }

    if (!useRpc) {
      // Direct query fallback for test environments without RPC
      const nowIso = new Date().toISOString()
      const { data: jobs } = await dbClient
        .from('participant_removal_jobs')
        .select('*')
        .or(`and(status.eq.pending,next_retry_at.lte.${nowIso}),and(status.eq.processing,lease_expires_at.lte.${nowIso})`)
        .limit(validBatchSize)

      if (jobs && jobs.length > 0) {
        claimedJobs = jobs
        // Set lease with fresh lease token
        const leaseExpiresIso = new Date(Date.now() + validLeaseSeconds * 1000).toISOString()
        for (const j of claimedJobs) {
          const leaseToken = 'lease-' + Math.random().toString(36).slice(2)
          j.lease_token = leaseToken
          await dbClient
            .from('participant_removal_jobs')
            .update({
              status: 'processing',
              lease_expires_at: leaseExpiresIso,
              lease_token: leaseToken,
              attempts: (j.attempts || 0) + 1,
              updated_at: nowIso
            })
            .eq('id', j.id)
        }
      }
    }

    if (!claimedJobs || claimedJobs.length === 0) {
      return { processed: 0, completed: 0, retried: 0 }
    }

    claimedCount = claimedJobs.length
    console.log(`[ParticipantRemoval Worker] Claimed ${claimedCount} job(s) for processing.`)

    for (const job of claimedJobs) {
      // Fencing check: worker operations strictly require a valid lease_token
      if (!job.lease_token) {
        console.error(`[ParticipantRemoval Worker] Fencing violation: Claimed job ${job.id} is missing a lease_token. Rejecting execution.`)
        continue
      }

      const lockKey = `${job.meeting_id || 'orphaned'}:${job.user_id || 'orphaned'}:${job.id}`
      await withRevocationMutex(lockKey, async () => {
        let evicted = false
        let lastError = null

        const cfMeetingId = job.cloudflare_meeting_id
        const cfPartId = job.cloudflare_participant_id
        const isCfConfigured = Boolean(cfMeetingId && cfPartId && cfService?.isConfigured?.())

        if (isCfConfigured) {
          try {
            await cfService.removeParticipant(cfMeetingId, cfPartId)
            evicted = true
          } catch (cfErr) {
            lastError = cfErr
            if (isConfirmedParticipantNotFound(cfErr)) {
              evicted = true
            }
          }
        } else {
          evicted = true
        }

        if (evicted) {
          if (typeof dbClient.rpc === 'function') {
            await dbClient.rpc('complete_participant_removal_job_tx', {
              p_job_id: job.id,
              p_lease_token: job.lease_token
            })
          } else {
            await dbClient
              .from('participant_removal_jobs')
              .update({
                status: 'completed',
                completed_at: new Date().toISOString(),
                lease_expires_at: null,
                lease_token: null,
                last_error: null,
                updated_at: new Date().toISOString()
              })
              .eq('id', job.id)
          }

          // Ensure participant status is marked 'removed' in participants table if parent records exist
          if (job.meeting_id && job.user_id) {
            try {
              await dbClient
                .from('participants')
                .update({
                  participant_status: 'removed',
                  left_at: new Date().toISOString()
                })
                .eq('meeting_id', job.meeting_id)
                .eq('user_id', job.user_id)
            } catch (partUpdateErr) {
              console.warn('[ParticipantRemoval Worker] Note: Could not update participants table:', partUpdateErr.message)
            }
          }

          completedCount++

          // Realtime notification if room still exists
          if (ioInstance && job.room_name) {
            if (job.user_id) {
              ioInstance.to(job.room_name).emit('participant_removed', { userId: job.user_id })
            }
            ioInstance.to(job.room_name).emit('participant_removal_completed', {
              jobId: job.id,
              userId: job.user_id || null,
              roomName: job.room_name
            })
          }
        } else {
          retriedCount++
          const backoffSeconds = Math.min(300, Math.pow(2, job.attempts || 1) * 10)

          if (typeof dbClient.rpc === 'function') {
            await dbClient.rpc('schedule_participant_removal_retry_tx', {
              p_job_id: job.id,
              p_error_message: lastError?.message || 'Worker eviction failed',
              p_backoff_seconds: backoffSeconds,
              p_max_attempts: validMaxAttempts,
              p_lease_token: job.lease_token
            })
          } else {
            const nextRetryIso = new Date(Date.now() + backoffSeconds * 1000).toISOString()
            const isFailed = (job.attempts || 1) >= validMaxAttempts
            await dbClient
              .from('participant_removal_jobs')
              .update({
                status: isFailed ? 'failed' : 'pending',
                last_error: lastError?.message || 'Worker eviction failed',
                next_retry_at: nextRetryIso,
                lease_expires_at: null,
                lease_token: null,
                updated_at: new Date().toISOString()
              })
              .eq('id', job.id)
          }
        }
      })
    }
  } catch (err) {
    console.error('[ParticipantRemoval Worker] Error during worker cycle:', err)
  } finally {
    isWorkerCycleRunning = false
  }

  return { processed: claimedCount, completed: completedCount, retried: retriedCount }
}

/**
 * Starts the automatic retry worker on backend startup.
 */
export const startRemovalWorker = ({
  intervalMs = 15000,
  dbClient = activeDbClient,
  cfService = defaultCloudflareService,
  ioInstance = null
} = {}) => {
  if (workerIntervalId) {
    clearInterval(workerIntervalId)
    workerIntervalId = null
  }

  // Run immediate recovery cycle on startup
  runRemovalWorkerCycle({ dbClient, cfService, ioInstance }).catch((err) => {
    console.warn('[ParticipantRemoval Worker] Initial recovery cycle warning:', err.message)
  })

  // Start background recurring interval
  workerIntervalId = setInterval(() => {
    runRemovalWorkerCycle({ dbClient, cfService, ioInstance }).catch((err) => {
      console.warn('[ParticipantRemoval Worker] Periodic cycle error:', err.message)
    })
  }, intervalMs)

  if (workerIntervalId.unref) {
    workerIntervalId.unref()
  }

  console.log(`[ParticipantRemoval Worker] Worker started with ${intervalMs}ms interval.`)
}

/**
 * Stops the background worker interval (for tests and graceful server shutdown).
 */
export const stopRemovalWorker = () => {
  if (workerIntervalId) {
    clearInterval(workerIntervalId)
    workerIntervalId = null
  }
  isWorkerCycleRunning = false
  console.log('[ParticipantRemoval Worker] Worker stopped.')
}

/**
 * Supports safe manual retry for a specific job (e.g. from admin tools or error recovery).
 */
export const manualRetryRemovalJob = async (
  jobId,
  {
    dbClient = activeDbClient,
    cfService = defaultCloudflareService,
    ioInstance = null
  } = {}
) => {
  if (!jobId) throw new Error('Job ID is required for manual retry.')

  // Reset job to pending with immediate retry timestamp, zero attempts, and clear lease token
  await dbClient
    .from('participant_removal_jobs')
    .update({
      status: 'pending',
      attempts: 0,
      next_retry_at: new Date().toISOString(),
      lease_expires_at: null,
      lease_token: null,
      last_error: null,
      updated_at: new Date().toISOString()
    })
    .eq('id', jobId)

  // Run a cycle to process it immediately
  return await runRemovalWorkerCycle({ dbClient, cfService, ioInstance, batchSize: 10 })
}

/**
 * Safe, idempotent migration/import procedure to migrate legacy file-based
 * pending_revocations.json into the Supabase participant_removal_jobs table.
 */
export const importLegacyFilePendingRevocations = async ({
  dbClient = activeDbClient,
  filePath = DEFAULT_LEGACY_PATH
} = {}) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { imported: 0 }
    }
    const raw = fs.readFileSync(filePath, 'utf8')
    if (!raw || !raw.trim()) return { imported: 0 }

    const store = JSON.parse(raw)
    const entries = Object.values(store)
    if (entries.length === 0) return { imported: 0 }

    console.log(`[ParticipantRemoval Migration] Found ${entries.length} legacy pending revocation(s) in ${filePath}. Importing to Supabase...`)
    let imported = 0

    for (const item of entries) {
      if (item.meetingId && item.userId) {
        try {
          if (typeof dbClient.rpc === 'function') {
            await dbClient.rpc('create_participant_removal_job_tx', {
              p_meeting_id: item.meetingId,
              p_user_id: item.userId,
              p_cloudflare_meeting_id: item.cloudflareMeetingId || null,
              p_cloudflare_participant_id: item.cloudflareParticipantId || null
            })
          } else {
            const sessionKey = item.cloudflareParticipantId
              ? `cf:${item.cloudflareMeetingId || item.meetingId || 'none'}:${item.cloudflareParticipantId}`
              : `part:${item.meetingId || 'none'}:${item.participantId || item.userId || 'none'}`
            await dbClient.from('participant_removal_jobs').upsert({
              meeting_id: item.meetingId,
              user_id: item.userId,
              cloudflare_meeting_id: item.cloudflareMeetingId || null,
              cloudflare_participant_id: item.cloudflareParticipantId || null,
              session_key: sessionKey,
              status: 'pending',
              attempts: item.attempts || 0,
              next_retry_at: new Date().toISOString(),
              created_at: item.createdAt || new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
          }
          imported++
        } catch (impErr) {
          console.warn(`[ParticipantRemoval Migration] Warning importing legacy item for ${item.userId}:`, impErr.message)
        }
      }
    }

    // Safely clear the legacy file contents so it is not re-imported
    try {
      fs.writeFileSync(filePath, JSON.stringify({}, null, 2), 'utf8')
      console.log(`[ParticipantRemoval Migration] Successfully migrated ${imported} legacy job(s). Cleared ${filePath}.`)
    } catch (writeErr) {
      console.warn('[ParticipantRemoval Migration] Error clearing legacy file:', writeErr.message)
    }

    return { imported }
  } catch (err) {
    console.warn('[ParticipantRemoval Migration] Legacy import encountered error:', err.message)
    return { imported: 0, error: err.message }
  }
}

/**
 * Backward compatibility helpers
 */
export const recoverPendingRevocations = async (options = {}) => {
  const result = await runRemovalWorkerCycle(options)
  return { recovered: result.completed || 0, failed: result.retried || 0 }
}

export const getPendingRemovalJobs = async ({ dbClient = activeDbClient } = {}) => {
  const { data, error } = await dbClient
    .from('participant_removal_jobs')
    .select('*')
    .in('status', ['pending', 'processing'])

  if (error) throw error
  return data || []
}

export const setStoragePath = () => {}
export const resetStoragePath = () => {}

export const clearPendingRevocations = async ({ dbClient = activeDbClient } = {}) => {
  if (typeof dbClient.from === 'function') {
    await dbClient.from('participant_removal_jobs').delete()
  }
}

// Retained for test backward compatibility
export const getPendingRevocations = async ({ dbClient = activeDbClient } = {}) => {
  const jobs = await getPendingRemovalJobs({ dbClient })
  return jobs.map((j) => ({
    ...j,
    key: `${j.meeting_id}:${j.user_id}`,
    meetingId: j.meeting_id,
    userId: j.user_id,
    cloudflareMeetingId: j.cloudflare_meeting_id,
    cloudflareParticipantId: j.cloudflare_participant_id,
    // Map 'pending' to 'pending_revocation' for legacy test assertions
    status: j.status === 'pending' ? 'pending_revocation' : j.status
  }))
}
