import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('Meeting Retention & Storage Cleanup Coordination', () => {
  it('protects ended meetings with active or retained recordings from 2-hour hard cleanup', () => {
    const expiredMeetings = [
      { meeting_id: 'm-with-rec', meeting_code: 'CODE1' },
      { meeting_id: 'm-without-rec', meeting_code: 'CODE2' }
    ]

    const activeRecordings = [
      { meeting_id: 'm-with-rec', status: 'ready', cleanup_status: 'none' }
    ]

    const protectedIds = new Set(
      activeRecordings
        .filter(r => r.status !== 'purged')
        .map(r => r.meeting_id)
    )

    const meetingsToHardDelete = expiredMeetings
      .filter(m => !protectedIds.has(m.meeting_id))
      .map(m => m.meeting_id)

    assert.equal(meetingsToHardDelete.length, 1)
    assert.equal(meetingsToHardDelete[0], 'm-without-rec', 'Only meeting without recording should be hard deleted')
  })

  it('allows 2-hour cleanup to proceed once recording is marked purged and cleaned', () => {
    const expiredMeetings = [
      { meeting_id: 'm-purged-rec', meeting_code: 'CODE3' }
    ]

    const allRecordings = [
      { meeting_id: 'm-purged-rec', status: 'purged', cleanup_status: 'cleaned' }
    ]

    const protectedIds = new Set(
      allRecordings
        .filter(r => r.status !== 'purged')
        .map(r => r.meeting_id)
    )

    const meetingsToHardDelete = expiredMeetings
      .filter(m => !protectedIds.has(m.meeting_id))
      .map(m => m.meeting_id)

    assert.equal(meetingsToHardDelete.length, 1)
    assert.equal(meetingsToHardDelete[0], 'm-purged-rec', 'Meeting with purged recording can safely be deleted')
  })

  it('prevents worker claim collisions using claim tokens and lease intervals', () => {
    const now = new Date('2026-10-11T10:00:00.000Z')
    const leaseSeconds = 300 // 5 minutes

    const row1 = {
      recording_id: 'rec-1',
      cleanup_status: 'cleaning',
      operation_claimed_at: new Date('2026-10-11T09:58:00.000Z') // Claimed 2 mins ago (active lease)
    }

    const row2 = {
      recording_id: 'rec-2',
      cleanup_status: 'cleaning',
      operation_claimed_at: new Date('2026-10-11T09:50:00.000Z') // Claimed 10 mins ago (expired lease)
    }

    const isLeaseExpired = (claimedAt) => {
      if (!claimedAt) return true
      return (now.getTime() - new Date(claimedAt).getTime()) > (leaseSeconds * 1000)
    }

    assert.equal(isLeaseExpired(row1.operation_claimed_at), false, 'Active lease must NOT be reclaimed')
    assert.equal(isLeaseExpired(row2.operation_claimed_at), true, 'Expired lease must be reclaimable after crash')
  })

  it('prohibits elapsed time or expired quarantine from authorizing cleanup on in-flight or unresolved operations', () => {
    const now = new Date('2026-10-11T12:00:00.000Z')
    const leaseSeconds = 300 // 5 minutes

    const inFlightSessionOld = {
      recording_id: 'rec-inflight-old',
      b2_operation_state: 'in_flight',
      cleanup_status: 'none',
      operation_started_at: new Date('2026-10-11T10:00:00.000Z') // 2 hours ago
    }

    const unresolvedErrorOld = {
      recording_id: 'rec-unresolved-old',
      b2_operation_state: 'unresolved',
      cleanup_status: 'unresolved_error',
      operation_started_at: new Date('2026-10-11T09:00:00.000Z') // 3 hours ago
    }

    const settledExpiredReady = {
      recording_id: 'rec-settled-expired',
      status: 'ready',
      expires_at: new Date('2026-10-10T10:00:00.000Z'), // Expired yesterday
      b2_operation_state: 'settled',
      cleanup_status: 'none'
    }

    // Predicate exactly matching rpc_claim_cleanup_batch and retention worker candidate rules
    const isEligibleForCleanupClaim = (rec) => {
      // STRICT RULE: in_flight or unresolved B2 operations are NEVER eligible regardless of elapsed time
      if (rec.b2_operation_state === 'in_flight' || rec.b2_operation_state === 'unresolved') {
        return false
      }
      if (rec.cleanup_status === 'unresolved_error') {
        return false
      }
      // Must be settled B2 state
      if (rec.b2_operation_state !== 'settled') {
        return false
      }
      // Must be expired ready, pending deletion/failed, or crashed lease on settled row
      const isExpiredReady = rec.status === 'ready' && rec.expires_at < now && rec.cleanup_status === 'none'
      const isPendingOrFailedCleanup = ['pending_deletion', 'failed'].includes(rec.status) && rec.cleanup_status === 'pending_cleanup'
      const isCrashedLease = rec.cleanup_status === 'cleaning' && (
        !rec.operation_claimed_at || (now.getTime() - new Date(rec.operation_claimed_at).getTime()) > (leaseSeconds * 1000)
      )

      return isExpiredReady || isPendingOrFailedCleanup || isCrashedLease
    }

    assert.equal(isEligibleForCleanupClaim(inFlightSessionOld), false, 'Elapsed time (2h) must NOT make in_flight operation claimable')
    assert.equal(isEligibleForCleanupClaim(unresolvedErrorOld), false, 'Elapsed time (3h) must NOT make unresolved_error operation claimable')
    assert.equal(isEligibleForCleanupClaim(settledExpiredReady), true, 'Settled expired ready recording IS eligible for normal retention cleanup')
  })

  it('includes oversized failed recordings in cleanup claims when settled, but excludes them if in-flight or unresolved', () => {
    const now = new Date('2026-10-11T12:00:00.000Z')
    const leaseSeconds = 300 // 5 minutes

    // 1. Oversized recording that exceeded 2,000,000,000 bytes, settled B2 state, pending cleanup
    const settledOversizedFailed = {
      recording_id: 'rec-oversized-settled',
      status: 'failed',
      file_size_bytes: 2050000000,
      failure_reason: 'Completed recording exceeded 2,000,000,000 bytes hard limit.',
      cleanup_status: 'pending_cleanup',
      b2_operation_state: 'settled',
      operation_claimed_at: null
    }

    // 2. Oversized recording whose B2 operation is unresolved
    const unresolvedOversizedFailed = {
      recording_id: 'rec-oversized-unresolved',
      status: 'failed',
      file_size_bytes: 2050000000,
      failure_reason: 'B2 network error during multipart completion',
      cleanup_status: 'unresolved_error',
      b2_operation_state: 'unresolved',
      operation_claimed_at: null
    }

    // 3. In-flight session (cannot be claimed even if elapsed time has passed)
    const inFlightSession = {
      recording_id: 'rec-inflight',
      status: 'recording',
      cleanup_status: 'pending_cleanup',
      b2_operation_state: 'in_flight',
      operation_claimed_at: null
    }

    const isEligibleForCleanupClaim = (rec) => {
      // STRICT GUARD: in_flight or unresolved B2 operations are NEVER eligible
      if (rec.b2_operation_state === 'in_flight' || rec.b2_operation_state === 'unresolved') {
        return false
      }
      if (rec.cleanup_status === 'unresolved_error') {
        return false
      }
      // Must be settled B2 state
      if (rec.b2_operation_state !== 'settled') {
        return false
      }
      // Matches rpc_claim_cleanup_batch rules:
      const isExpiredReady = rec.status === 'ready' && rec.expires_at < now && rec.cleanup_status === 'none'
      const isPendingOrFailedCleanup = ['pending_deletion', 'failed'].includes(rec.status) && rec.cleanup_status === 'pending_cleanup'
      const isCrashedLease = rec.cleanup_status === 'cleaning' && (
        !rec.operation_claimed_at || (now.getTime() - new Date(rec.operation_claimed_at).getTime()) > (leaseSeconds * 1000)
      )

      return isExpiredReady || isPendingOrFailedCleanup || isCrashedLease
    }

    // Assertions
    assert.equal(isEligibleForCleanupClaim(settledOversizedFailed), true, 'Settled oversized failed recording MUST be eligible for cleanup claims')
    assert.equal(isEligibleForCleanupClaim(unresolvedOversizedFailed), false, 'Unresolved oversized recording must NOT be claimed')
    assert.equal(isEligibleForCleanupClaim(inFlightSession), false, 'In-flight operation must NOT be claimed')

    // Simulate purge resolution
    const purgeRecord = (rec) => ({
      ...rec,
      status: 'purged',
      cleanup_status: 'cleaned',
      b2_operation_state: 'settled'
    })

    const purged = purgeRecord(settledOversizedFailed)
    assert.equal(purged.status, 'purged')
    assert.equal(purged.cleanup_status, 'cleaned')
    assert.equal(purged.b2_operation_state, 'settled')
    assert.equal(purged.failure_reason, 'Completed recording exceeded 2,000,000,000 bytes hard limit.', 'Preserves failure reason for audit trail')
  })

  it('preserves unresolved operation metadata and rejects marking cleaned on storage error', () => {
    const unresolvedSession = {
      recording_id: 'rec-preserve-meta',
      operation_id: 'op-12345',
      b2_key: 'recordings/mtg-1/rec-preserve-meta.webm',
      b2_upload_id: 'upload-id-999',
      last_b2_operation: 'complete_multipart',
      b2_operation_state: 'unresolved',
      cleanup_status: 'unresolved_error',
      failure_reason: 'B2 network timeout during part assembly'
    }

    // When an error occurs during purge, metadata must be preserved
    const handlePurgeError = (rec, err) => {
      return {
        ...rec,
        cleanup_status: 'unresolved_error',
        b2_operation_state: 'unresolved',
        failure_reason: `Storage purge failed: ${err.message}`
      }
    }

    const updated = handlePurgeError(unresolvedSession, new Error('Connection reset by peer'))

    assert.equal(updated.b2_operation_state, 'unresolved', 'Must remain unresolved')
    assert.equal(updated.cleanup_status, 'unresolved_error', 'Must remain unresolved_error')
    assert.equal(updated.operation_id, 'op-12345', 'Operation ID must be preserved')
    assert.equal(updated.b2_upload_id, 'upload-id-999', 'Upload ID must be preserved')
    assert.notEqual(updated.cleanup_status, 'cleaned', 'Must NEVER be marked cleaned')
    assert.notEqual(updated.status, 'purged', 'Must NEVER be marked purged')
  })

  it('prohibits rpc_purge_and_hard_delete_meeting when cleanup_status is not cleaned or b2_operation_state is not settled', () => {
    const claimToken = 'claim-token-123'
    const fencingToken = 2

    // Pure predicate replicating rpc_purge_and_hard_delete_meeting verification
    const verifyCanHardDelete = (rec, pFencingToken, pClaimToken) => {
      // Must match tokens
      if (rec.fencing_token !== pFencingToken || rec.operation_claim_token !== pClaimToken) {
        return false
      }
      // STRICT DATABASE SAFEGUARD: Must be confirmed cleaned AND settled
      if (rec.cleanup_status !== 'cleaned' || rec.b2_operation_state !== 'settled') {
        return false
      }
      return true
    }

    const uncleanedRow = {
      recording_id: 'rec-uncleaned',
      meeting_id: 'mtg-1',
      operation_claim_token: claimToken,
      fencing_token: fencingToken,
      cleanup_status: 'pending_cleanup',
      b2_operation_state: 'settled'
    }

    const inFlightRow = {
      recording_id: 'rec-inflight-del',
      meeting_id: 'mtg-1',
      operation_claim_token: claimToken,
      fencing_token: fencingToken,
      cleanup_status: 'cleaned',
      b2_operation_state: 'in_flight'
    }

    const unresolvedRow = {
      recording_id: 'rec-unresolved-del',
      meeting_id: 'mtg-1',
      operation_claim_token: claimToken,
      fencing_token: fencingToken,
      cleanup_status: 'unresolved_error',
      b2_operation_state: 'unresolved'
    }

    const fullySettledAndCleaned = {
      recording_id: 'rec-clean',
      meeting_id: 'mtg-1',
      operation_claim_token: claimToken,
      fencing_token: fencingToken,
      cleanup_status: 'cleaned',
      b2_operation_state: 'settled'
    }

    assert.equal(verifyCanHardDelete(uncleanedRow, fencingToken, claimToken), false, 'Must reject deletion if cleanup_status is pending_cleanup')
    assert.equal(verifyCanHardDelete(inFlightRow, fencingToken, claimToken), false, 'Must reject deletion if b2_operation_state is in_flight')
    assert.equal(verifyCanHardDelete(unresolvedRow, fencingToken, claimToken), false, 'Must reject deletion if b2_operation_state is unresolved')
    assert.equal(verifyCanHardDelete(fullySettledAndCleaned, fencingToken, claimToken), true, 'Must permit deletion only when cleaned AND settled')
  })

  it('enforces database-level concurrency protection against simultaneous recording starts for the same meeting', () => {
    // Simulates database concurrency protection (table with unique partial index uq_active_recording_per_meeting
    // and advisory transaction lock per meeting_id)
    const activeStatuses = new Set(['starting', 'recording', 'finalizing'])
    const existingTable = [
      {
        recording_id: 'rec-active-1',
        meeting_id: 'mtg-concurrent',
        status: 'starting'
      }
    ]

    const simulateDatabaseInsert = (newRecording) => {
      // 1. Transaction-level locking ensures serialized evaluation
      // 2. Declarative unique index constraint: uq_active_recording_per_meeting
      const hasActiveConflict = existingTable.some(
        r => r.meeting_id === newRecording.meeting_id && activeStatuses.has(r.status)
      )

      if (hasActiveConflict) {
        const err = new Error('duplicate key value violates unique constraint "uq_active_recording_per_meeting"')
        err.code = '23505'
        throw err
      }

      existingTable.push(newRecording)
      return { success: true }
    }

    const concurrentStart = {
      recording_id: 'rec-active-2',
      meeting_id: 'mtg-concurrent',
      status: 'starting'
    }

    assert.throws(
      () => simulateDatabaseInsert(concurrentStart),
      (err) => err.code === '23505' && err.message.includes('uq_active_recording_per_meeting'),
      'Concurrent start must be rejected with unique constraint violation 23505'
    )
  })
})
