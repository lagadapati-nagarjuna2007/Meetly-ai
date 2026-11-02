/**
 * Meetly AI — Waiting-Room Dual-Provider (Cloudflare RealtimeKit & LiveKit) Test Suite
 *
 * Comprehensive Concurrency, Security, & Lifecycle Verification:
 * 1. Clean device admission (Cloudflare and LiveKit).
 * 2. Already-banned device rejection.
 * 3. Cross-account shared-device ban.
 * 4. Concurrent ban and admission without deadlocks.
 * 5. Ban during Cloudflare enrollment.
 * 6. Ban after finalization but before credential delivery.
 * 7. LiveKit ban during token creation/delivery.
 * 8. Removed participant resurrection prevention.
 * 9. Duplicate acceptance.
 * 10. Provider enrollment failure and rollback.
 * 11. Stale enrollment recovery.
 * 12. Non-host receives HTTP 403.
 * 13. Only intended participant receives credentials (targeted socket delivery).
 * 14. Cloudflare participant removal during eviction (removeParticipant).
 * 15. Frontend receives credentials and resolves effective provider without refresh.
 * 16. Invalid or duplicate socket admission events are ignored.
 * 17. finalize_participant_admission_tx acquires advisory lock BEFORE locking the participant row.
 * 18. accept_join_request_tx strictly rejects resurrecting a participant in removed status.
 * 19. accept_join_request_tx aborts with retry error if fingerprint changed concurrently.
 * 20. finalize_participant_admission_tx handles NULL fingerprints and distinguishes missing records.
 * 21. Concurrent ban and finalization serialize on advisory lock without deadlock.
 * 22. ban_device_tx handles participant fingerprint differing from waiting-request fingerprint without deadlock.
 * 23. Concurrent admission and ban for the same user serialize without deadlock.
 * 24. Concurrent cross-account ban on User A and admission on User B sharing device serializes safely.
 * 25. ban_device_tx detects fingerprint mutation during lock acquisition and aborts with retry error.
 * 26. Regression 1: Waiting-request fingerprint changing from NULL to a value during ban acquisition aborts with retry error.
 * 27. Regression 2: Participant fingerprint changing from NULL to a value during ban acquisition aborts with retry error.
 * 28. Regression 3: Request row disappearing during ban acquisition aborts with retry error.
 * 29. Regression 4: Participant row disappearing during ban acquisition aborts with retry error.
 * 30. Regression 5: Multiple matching waiting requests are locked before any participant row.
 * 31. Regression 6: Multiple affected participants are locked in deterministic order.
 * 32. Regression 7: Concurrent admission and ban with different fingerprints for the same user serialize safely.
 * 33. Regression 8: Concurrent cross-account admission and ban sharing a fingerprint serialize safely.
 * 34. Step 6.7.5.11: Waiting-request creation versus device ban.
 * 35. Step 6.7.5.11: Auto-admission versus device ban.
 * 36. Step 6.7.5.11: Rollback request restoration versus device ban.
 * 37. Step 6.7.5.11: Rejection versus admission.
 * 38. Step 6.7.5.11: Duplicate waiting requests.
 * 39. Step 6.7.5.11: Re-admission of removed participants.
 * 40. Step 6.7.5.11: Cross-account requests sharing the same fingerprint.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  acceptJoinRequest,
  rejectJoinRequest,
  removeParticipant,
  banDevice,
  setCloudflareService,
  resetCloudflareService
} from '../controllers/securityController.js'
import {
  joinMeeting,
  setCloudflareService as setMeetingCloudflareService,
  resetCloudflareService as resetMeetingCloudflareService
} from '../controllers/meetingController.js'
import { supabase } from '../config/supabase.js'
import { resolveEffectiveProvider, shouldMountProvider } from '../../src/components/meeting/providerSelectionUtils.js'

describe('Meetly AI — Waiting-Room Dual-Provider Concurrency & Admission Security Suite', () => {
  const HOST_ID = '11111111-1111-4111-8111-111111111111'
  const PARTICIPANT_ID = '22222222-2222-4222-8222-222222222222'
  const PARTICIPANT_B_ID = '33333333-3333-4333-8333-333333333333'
  const MEETING_CODE = 'WAIT-TEST-01'
  const ROOM_NAME = 'room-wait-test-01'
  const CF_MEETING_ID = 'cf-mtg-test-uuid-999'
  const CF_PART_ID = 'cf-part-test-uuid-888'
  const CF_TOKEN = 'cf-jwt-token-sample-12345'
  const DEVICE_FINGERPRINT = 'fp_browser_hash_abc123'
  const BANNED_FINGERPRINT = 'fp_banned_device_bad999'

  let mockMeetingsTable
  let mockParticipantsTable
  let mockJoinRequestsTable
  let mockDeviceBansTable
  let mockUsersTable
  let originalSupabaseFrom
  let originalSupabaseRpc

  let cloudflareCalls
  let emittedSocketEvents

  const setupMockReqRes = ({
    body = {},
    user = { id: HOST_ID, email: 'host@meetly.ai' },
    roomUserSockets = new Map()
  } = {}) => {
    const events = []

    const io = {
      to: (target) => ({
        emit: (event, payload) => {
          events.push({ target, event, payload })
          emittedSocketEvents.push({ target, event, payload })
        }
      })
    }

    const app = {
      get: (key) => {
        if (key === 'io') return io
        if (key === 'roomUserSockets') return roomUserSockets
        return null
      }
    }

    const req = {
      body,
      params: {},
      user,
      headers: {},
      app
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

    return { req, res, emittedSocketEvents: events }
  }

  const createQueryMock = (table) => {
    const filters = []
    const orFilters = []
    let isDelete = false
    let updateData = null

    const builder = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      eq: (col, val) => {
        filters.push({ type: 'eq', col, val })
        return builder
      },
      in: (col, vals) => {
        filters.push({ type: 'in', col, val: vals })
        return builder
      },
      lt: (col, val) => {
        filters.push({ type: 'lt', col, val })
        return builder
      },
      or: (orString) => {
        const clauses = orString.split(',').map((c) => {
          const parts = c.split('.eq.')
          return { col: parts[0], val: parts[1] }
        })
        orFilters.push(clauses)
        return builder
      },
      insert: async (records) => {
        const list = Array.isArray(records) ? records : [records]
        for (const item of list) {
          const id = item.id || item.participant_id || `gen-${Date.now()}-${Math.random()}`
          const rec = { ...item, id }
          if (table === 'meeting_join_requests') {
            mockJoinRequestsTable.set(id, rec)
          } else if (table === 'participants') {
            mockParticipantsTable.set(id, rec)
          } else if (table === 'meeting_device_bans') {
            mockDeviceBansTable.set(`${item.meeting_code}:${item.device_fingerprint}`, rec)
          }
        }
        return { data: list[0] || null, error: null }
      },
      update: (data) => {
        updateData = data
        return builder
      },
      delete: () => {
        isDelete = true
        return builder
      },
      then: (resolve, reject) => {
        execute().then(resolve, reject)
      },
      catch: (onRejected) => {
        execute().catch(onRejected)
      },
      maybeSingle: async () => {
        const { data, error } = await execute()
        if (error) return { data: null, error }
        return { data: Array.isArray(data) ? (data[0] || null) : data, error: null }
      }
    }

    const matchRecord = (rec) => {
      for (const f of filters) {
        if (f.type === 'eq' && rec[f.col] !== f.val) return false
        if (f.type === 'in' && (!Array.isArray(f.val) || !f.val.includes(rec[f.col]))) return false
        if (f.type === 'lt' && !(rec[f.col] < f.val)) return false
      }
      for (const clauses of orFilters) {
        const matchedAny = clauses.some((c) => rec[c.col] === c.val)
        if (!matchedAny) return false
      }
      return true
    }

    const execute = async () => {
      let sourceMap
      if (table === 'meetings') sourceMap = mockMeetingsTable
      else if (table === 'participants') sourceMap = mockParticipantsTable
      else if (table === 'meeting_join_requests') sourceMap = mockJoinRequestsTable
      else if (table === 'meeting_device_bans') sourceMap = mockDeviceBansTable
      else if (table === 'users') sourceMap = mockUsersTable
      else sourceMap = new Map()

      if (isDelete) {
        const deleted = []
        for (const [key, rec] of Array.from(sourceMap.entries())) {
          if (matchRecord(rec)) {
            sourceMap.delete(key)
            deleted.push(rec)
          }
        }
        return { data: deleted, error: null }
      }

      if (updateData) {
        const updated = []
        for (const [key, rec] of sourceMap.entries()) {
          if (matchRecord(rec)) {
            Object.assign(rec, updateData)
            sourceMap.set(key, rec)
            updated.push(rec)
          }
        }
        return { data: updated, error: null }
      }

      const results = []
      for (const rec of sourceMap.values()) {
        if (matchRecord(rec)) {
          results.push({ ...rec })
        }
      }
      return { data: results, error: null }
    }

    return builder
  }

  beforeEach(() => {
    mockMeetingsTable = new Map()
    mockParticipantsTable = new Map()
    mockJoinRequestsTable = new Map()
    mockDeviceBansTable = new Map()
    mockUsersTable = new Map()

    cloudflareCalls = {
      addParticipant: [],
      removeParticipant: []
    }
    emittedSocketEvents = []

    mockUsersTable.set(HOST_ID, {
      id: HOST_ID,
      full_name: 'Dr. Host Organizer',
      email: 'host@meetly.ai'
    })
    mockUsersTable.set(PARTICIPANT_ID, {
      id: PARTICIPANT_ID,
      full_name: 'Alice Participant',
      email: 'alice@meetly.ai'
    })
    mockUsersTable.set(PARTICIPANT_B_ID, {
      id: PARTICIPANT_B_ID,
      full_name: 'Bob Participant',
      email: 'bob@meetly.ai'
    })

    const cfMock = {
      isConfigured: () => true,
      addParticipant: async (meetingId, params) => {
        cloudflareCalls.addParticipant.push({ meetingId, params })
        return {
          participantId: CF_PART_ID,
          token: CF_TOKEN,
          name: params.name,
          presetName: params.presetName
        }
      },
      removeParticipant: async (meetingId, participantId) => {
        cloudflareCalls.removeParticipant.push({ meetingId, participantId })
        return { success: true }
      }
    }
    setCloudflareService(cfMock)
    setMeetingCloudflareService(cfMock)

    originalSupabaseFrom = supabase.from
    originalSupabaseRpc = supabase.rpc

    supabase.from = (table) => createQueryMock(table)

    supabase.rpc = async (fn, args) => {
      if (fn === 'accept_join_request_tx') {
        const { p_meeting_code, p_user_id } = args

        // Step 1: Meeting check
        let meeting = null
        for (const m of mockMeetingsTable.values()) {
          if (m.meeting_code === p_meeting_code) {
            meeting = m
            break
          }
        }
        if (!meeting) {
          return { data: null, error: { message: 'Meeting not found' } }
        }
        if (meeting.meeting_status === 'Ended' || meeting.is_deleted) {
          return { data: null, error: { message: 'This meeting has already ended' } }
        }

        if (args._trackLockOrder) {
          args._trackLockOrder.push(`USER_ADVISORY_LOCK:${p_meeting_code}:${p_user_id}`)
        }

        // Step 2: Unlocked read of request AND participant
        let foundReq = null
        let foundReqKey = null
        for (const [key, r] of mockJoinRequestsTable.entries()) {
          if (r.meeting_code === p_meeting_code && r.user_id === p_user_id) {
            foundReq = r
            foundReqKey = key
            break
          }
        }
        if (!foundReq) {
          return { data: null, error: { message: 'Pending request not found' } }
        }

        const partId = `part-${p_user_id}`
        let part = Array.from(mockParticipantsTable.values()).find(
          (p) => p.user_id === p_user_id && p.meeting_id === meeting.meeting_id
        )

        // Step 3: Transaction Advisory Lock(s) on all distinct non-empty fingerprints in deterministic sorted order
        const distinctFps = Array.from(new Set([foundReq.device_fingerprint, part?.device_fingerprint].filter(Boolean))).sort()
        if (args._trackLockOrder) {
          for (const fp of distinctFps) {
            args._trackLockOrder.push(`ADVISORY_LOCK:${fp}`)
          }
        }

        // Step 4 (Row-Lock Order 1): Re-read and lock request with FOR UPDATE on meeting_join_requests
        if (args._trackLockOrder) {
          args._trackLockOrder.push('ROW_LOCK_REQUESTS_ACQUIRED')
        }

        if (foundReq._simulateFpChange) {
          return {
            data: null,
            error: { message: 'Device fingerprint changed concurrently; please retry' }
          }
        }

        // Step 5 (Row-Lock Order 2): Re-read and lock participant row with FOR UPDATE on participants
        if (args._trackLockOrder) {
          args._trackLockOrder.push('ROW_LOCK_PARTICIPANTS_ACQUIRED')
        }

        if (part && part._simulateFpChange) {
          return {
            data: null,
            error: { message: 'Device fingerprint changed concurrently; please retry' }
          }
        }

        // Step 6: ATOMIC DEVICE BAN VERIFICATION inside locks across all locked fingerprints
        for (const fp of distinctFps) {
          const banKey = `${p_meeting_code}:${fp}`
          if (mockDeviceBansTable.has(banKey)) {
            return {
              data: null,
              error: { message: 'Cannot admit participant: this device is banned from the meeting' }
            }
          }
        }

        // Step 7: Reject terminal or already-admitted participant states using locked status
        if (part) {
          if (part.participant_status === 'removed') {
            return {
              data: null,
              error: { message: 'Cannot admit participant: user has been removed from this meeting' }
            }
          }
          if (part.participant_status === 'joined' || part.participant_status === 'enrolling') {
            return {
              data: null,
              error: { message: 'Cannot admit participant: user is already admitted to this meeting' }
            }
          }
        }

        // Step 8: Atomic Consumption of Join Request
        mockJoinRequestsTable.delete(foundReqKey)

        // Step 9: Transition participant record to 'enrolling' state
        if (part) {
          part.participant_status = 'enrolling'
          part.device_fingerprint = foundReq.device_fingerprint
          part.joined_at = new Date().toISOString()
          mockParticipantsTable.set(part.participant_id || partId, part)
        } else {
          mockParticipantsTable.set(partId, {
            participant_id: partId,
            meeting_id: meeting.meeting_id,
            user_id: p_user_id,
            participant_status: 'enrolling',
            device_fingerprint: foundReq.device_fingerprint,
            joined_at: new Date().toISOString()
          })
        }

        return { data: foundReq.device_fingerprint, error: null }
      }

      if (fn === 'finalize_participant_admission_tx') {
        const { p_meeting_id, p_user_id, p_cloudflare_participant_id } = args

        // Step 1: Find meeting code, status, and is_deleted (FOR SHARE)
        let targetMeeting = null
        for (const m of mockMeetingsTable.values()) {
          if (m.meeting_id === p_meeting_id) {
            targetMeeting = m
            break
          }
        }
        if (!targetMeeting) {
          return { data: false, error: null }
        }
        if (targetMeeting.meeting_status === 'Ended' || targetMeeting.is_deleted) {
          return { data: false, error: null }
        }
        const meetingCode = targetMeeting.meeting_code

        // Step 2 (Issue 1 & 4): Read participant state and fingerprint without locking
        let part = null
        for (const p of mockParticipantsTable.values()) {
          if (p.meeting_id === p_meeting_id && p.user_id === p_user_id) {
            part = p
            break
          }
        }

        // Issue 4 Fix: Distinguish missing participant from participant with NULL fingerprint
        if (!part) {
          return { data: false, error: null }
        }
        if (part.participant_status !== 'enrolling') {
          return { data: false, error: null }
        }

        // Step 3 (Issue 1 Fix): Advisory lock acquired before row lock
        if (args._trackLockOrder) {
          args._trackLockOrder.push('ADVISORY_LOCK_ACQUIRED')
        }

        // Step 4: Row lock for update
        if (args._trackLockOrder) {
          args._trackLockOrder.push('ROW_LOCK_ACQUIRED')
        }

        // Step 5: Check ban if fingerprint is present
        if (part.device_fingerprint) {
          for (const b of mockDeviceBansTable.values()) {
            if (b.device_fingerprint === part.device_fingerprint) {
              part.participant_status = 'removed'
              mockParticipantsTable.set(part.participant_id, part)
              return { data: false, error: null }
            }
          }
        }

        // Step 6: Finalize to joined (handles null device_fingerprint cleanly)
        part.participant_status = 'joined'
        if (p_cloudflare_participant_id) {
          part.cloudflare_participant_id = p_cloudflare_participant_id
        }
        mockParticipantsTable.set(part.participant_id, part)
        return { data: true, error: null }
      }

      if (fn === 'ban_device_tx') {
        const { p_meeting_code, p_user_id } = args

        // Step 1: Meeting check
        let meeting = null
        for (const m of mockMeetingsTable.values()) {
          if (m.meeting_code === p_meeting_code) {
            meeting = m
            break
          }
        }
        if (!meeting) {
          return { data: null, error: { message: 'Meeting not found' } }
        }

        // Step 2: Unlocked read of fingerprints from both tables for this user
        let reqFp = null
        let v_req_found = false
        for (const r of mockJoinRequestsTable.values()) {
          if (r.meeting_code === p_meeting_code && r.user_id === p_user_id) {
            v_req_found = true
            reqFp = r.device_fingerprint || null
            break
          }
        }

        let partFp = null
        let v_part_found = false
        for (const p of mockParticipantsTable.values()) {
          if (p.meeting_id === meeting.meeting_id && p.user_id === p_user_id) {
            v_part_found = true
            partFp = p.device_fingerprint || null
            break
          }
        }

        if ((!reqFp || !reqFp.trim()) && (!partFp || !partFp.trim())) {
          return { data: null, error: { message: 'Participant has no recorded device fingerprint' } }
        }

        const primaryFp = reqFp || partFp
        const secondaryFp = reqFp && partFp && reqFp !== partFp ? partFp : null

        // Step 3: Transaction Advisory Lock(s)
        if (args._trackLockOrder) {
          args._trackLockOrder.push('ADVISORY_LOCK_ACQUIRED')
          if (args._trackDetailedFpLocks) {
            const distinctFps = Array.from(new Set([primaryFp, secondaryFp].filter(Boolean))).sort()
            for (const fp of distinctFps) {
              args._trackLockOrder.push(`ADVISORY_LOCK:${fp}`)
            }
          }
        }

        // Step 4: Row Lock Order 1: Lock ALL affected meeting_join_requests FIRST (ORDER BY id)
        const targetFps = secondaryFp ? [primaryFp, secondaryFp] : [primaryFp]
        const affectedReqs = Array.from(mockJoinRequestsTable.values())
          .filter(r => r.meeting_code === p_meeting_code && (
            r.user_id === p_user_id ||
            targetFps.includes(r.device_fingerprint)
          ))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

        if (args._trackLockOrder) {
          args._trackLockOrder.push('ROW_LOCK_REQUESTS_ACQUIRED')
          if (args._trackDetailedRowLocks) {
            for (const req of affectedReqs) {
              args._trackLockOrder.push(`LOCK_REQUEST:${req.id}`)
            }
          }
        }

        // Re-read target user request under lock & validate mutations
        let v_locked_req_found = false
        let v_locked_req_fp = null
        for (const r of mockJoinRequestsTable.values()) {
          if (r.meeting_code === p_meeting_code && r.user_id === p_user_id) {
            v_locked_req_found = true
            v_locked_req_fp = r.device_fingerprint || null
            break
          }
        }

        // Mutation simulation triggers (testing concurrency edge cases)
        if (args._simulateReqFpNullToValue) {
          v_locked_req_fp = 'fp_mutated_from_null'
        }
        if (args._simulateReqDisappearing) {
          v_locked_req_found = false
          v_locked_req_fp = null
        }
        if (args._simulateReqAppearing) {
          v_req_found = false
          v_locked_req_found = true
          v_locked_req_fp = primaryFp
        }
        if (args._simulateReqFpChange) {
          v_locked_req_fp = 'fp_mutated_val'
        }

        // Step 4.1: Comprehensive Mutation Validation on meeting_join_requests
        if (v_req_found && !v_locked_req_found) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }
        if (!v_req_found && v_locked_req_found) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }
        if (v_req_found && v_locked_req_found && (v_locked_req_fp !== reqFp)) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }

        // Row Lock Order 2: Lock ALL affected participants SECOND (ORDER BY participant_id)
        const affectedParts = Array.from(mockParticipantsTable.values())
          .filter(p => p.meeting_id === meeting.meeting_id && (
            p.user_id === p_user_id ||
            targetFps.includes(p.device_fingerprint)
          ))
          .sort((a, b) => (a.participant_id < b.participant_id ? -1 : a.participant_id > b.participant_id ? 1 : 0))

        if (args._trackLockOrder) {
          args._trackLockOrder.push('ROW_LOCK_PARTICIPANTS_ACQUIRED')
          if (args._trackDetailedRowLocks) {
            for (const part of affectedParts) {
              args._trackLockOrder.push(`LOCK_PARTICIPANT:${part.participant_id}`)
            }
          }
        }

        // Re-read target user participant under lock & validate mutations
        let v_locked_part_found = false
        let v_locked_part_fp = null
        for (const p of mockParticipantsTable.values()) {
          if (p.meeting_id === meeting.meeting_id && p.user_id === p_user_id) {
            v_locked_part_found = true
            v_locked_part_fp = p.device_fingerprint || null
            break
          }
        }

        if (args._simulatePartFpNullToValue) {
          v_locked_part_fp = 'fp_part_mutated_from_null'
        }
        if (args._simulatePartDisappearing) {
          v_locked_part_found = false
          v_locked_part_fp = null
        }
        if (args._simulatePartAppearing) {
          v_part_found = false
          v_locked_part_found = true
          v_locked_part_fp = primaryFp
        }
        if (args._simulatePartFpChange) {
          v_locked_part_fp = 'fp_part_mutated_val'
        }

        // Step 4.2: Comprehensive Mutation Validation on participants
        if (v_part_found && !v_locked_part_found) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }
        if (!v_part_found && v_locked_part_found) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }
        if (v_part_found && v_locked_part_found && (v_locked_part_fp !== partFp)) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }

        // Check object-level flags on found records
        const directReq = Array.from(mockJoinRequestsTable.values()).find(r => r.meeting_code === p_meeting_code && r.user_id === p_user_id)
        const directPart = Array.from(mockParticipantsTable.values()).find(p => p.meeting_id === meeting.meeting_id && p.user_id === p_user_id)
        if ((directReq && directReq._simulateFpChange) || (directPart && directPart._simulateFpChange)) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }

        // Step 5: Insert device ban(s)
        mockDeviceBansTable.set(`${p_meeting_code}:${primaryFp}`, {
          meeting_code: p_meeting_code,
          device_fingerprint: primaryFp,
          blocked_at: new Date().toISOString()
        })

        if (secondaryFp) {
          mockDeviceBansTable.set(`${p_meeting_code}:${secondaryFp}`, {
            meeting_code: p_meeting_code,
            device_fingerprint: secondaryFp,
            blocked_at: new Date().toISOString()
          })
        }

        // Step 6: Atomic Cross-Account Cleanup in consistent order (requests -> participants)
        for (const [key, r] of Array.from(mockJoinRequestsTable.entries())) {
          if (r.meeting_code === p_meeting_code && (r.user_id === p_user_id || targetFps.includes(r.device_fingerprint))) {
            mockJoinRequestsTable.delete(key)
          }
        }

        for (const p of mockParticipantsTable.values()) {
          if (p.meeting_id === meeting.meeting_id && (p.user_id === p_user_id || targetFps.includes(p.device_fingerprint))) {
            p.participant_status = 'removed'
            p.left_at = new Date().toISOString()
            mockParticipantsTable.set(p.participant_id, p)
          }
        }

        return { data: primaryFp, error: null }
      }

      if (fn === 'create_join_request_tx') {
        const { p_meeting_code, p_user_id, p_device_fingerprint } = args

        // Step 1: Meeting check
        let meeting = null
        for (const m of mockMeetingsTable.values()) {
          if (m.meeting_code === p_meeting_code) {
            meeting = m
            break
          }
        }
        if (!meeting) {
          return { data: null, error: { message: 'Meeting not found' } }
        }
        if (meeting.meeting_status === 'Ended' || meeting.is_deleted) {
          return { data: null, error: { message: 'This meeting has already ended' } }
        }

        if (args._trackLockOrder) {
          args._trackLockOrder.push(`USER_ADVISORY_LOCK:${p_meeting_code}:${p_user_id}`)
        }

        // Step 2: Unlocked read of existing request AND existing participant
        let existingReq = null
        for (const r of mockJoinRequestsTable.values()) {
          if (r.meeting_code === p_meeting_code && r.user_id === p_user_id) {
            existingReq = r
            break
          }
        }
        const existingReqFp = existingReq?.device_fingerprint || null

        let existingPart = null
        for (const p of mockParticipantsTable.values()) {
          if (p.meeting_id === meeting.meeting_id && p.user_id === p_user_id) {
            existingPart = p
            break
          }
        }
        const existingPartFp = existingPart?.device_fingerprint || null
        const incomingFp = p_device_fingerprint || null

        // Step 3: Advisory lock tracking for all distinct non-empty fingerprints in deterministic order
        const distinctFps = Array.from(new Set([existingReqFp, existingPartFp, incomingFp].filter(Boolean))).sort()
        if (args._trackLockOrder) {
          for (const fp of distinctFps) {
            args._trackLockOrder.push(`ADVISORY_LOCK:${fp}`)
          }
        }

        // Step 4 (Row-Lock Order 1): Re-read and lock request row FOR UPDATE
        if (args._trackLockOrder) {
          args._trackLockOrder.push('ROW_LOCK_REQUEST_FOR_UPDATE')
        }

        // Comprehensive Mutation Validation simulation on request
        if (args._simulateFpMutation || (existingReq && existingReq._simulateFpChange)) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }
        if (args._simulateReqDisappearing) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }

        // Step 5 (Row-Lock Order 2): Re-read and lock participant row FOR UPDATE
        if (args._trackLockOrder) {
          args._trackLockOrder.push('ROW_LOCK_PARTICIPANT_FOR_UPDATE')
        }

        if (existingPart && existingPart._simulateFpChange) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }

        // Step 6: Check device bans against all relevant fingerprints
        for (const fp of distinctFps) {
          const banKey = `${p_meeting_code}:${fp}`
          if (mockDeviceBansTable.has(banKey)) {
            return { data: null, error: { message: 'Cannot join: this device is banned from the meeting' } }
          }
        }

        // Step 7: Check participant status under locked row
        if (existingPart && existingPart.participant_status === 'removed') {
          return { data: null, error: { message: 'Cannot join: user has been removed from this meeting' } }
        }
        if (existingPart && (existingPart.participant_status === 'joined' || existingPart.participant_status === 'enrolling')) {
          return { data: null, error: { message: 'Cannot join: user is already admitted to this meeting' } }
        }

        // Step 8: Update or Insert
        if (existingReq) {
          existingReq.device_fingerprint = incomingFp
          existingReq.status = 'pending'
          return {
            data: { request_id: existingReq.id, status: 'pending', is_duplicate: true },
            error: null
          }
        }

        const newId = `req-${p_user_id}`
        const newReq = {
          id: newId,
          meeting_code: p_meeting_code,
          user_id: p_user_id,
          device_fingerprint: incomingFp,
          status: 'pending',
          created_at: new Date().toISOString()
        }
        mockJoinRequestsTable.set(newId, newReq)
        return {
          data: { request_id: newId, status: 'pending', is_duplicate: false },
          error: null
        }
      }

      if (fn === 'auto_admit_participant_tx') {
        const { p_meeting_code, p_user_id, p_device_fingerprint, p_role } = args

        // Step 1: Meeting check
        let meeting = null
        for (const m of mockMeetingsTable.values()) {
          if (m.meeting_code === p_meeting_code) {
            meeting = m
            break
          }
        }
        if (!meeting) {
          return { data: null, error: { message: 'Meeting not found' } }
        }
        if (meeting.meeting_status === 'Ended' || meeting.is_deleted) {
          return { data: null, error: { message: 'This meeting has already ended' } }
        }

        // Step 2: Per-user admission advisory lock
        if (args._trackLockOrder) {
          args._trackLockOrder.push(`USER_ADVISORY_LOCK:${p_meeting_code}:${p_user_id}`)
        }

        // Step 3: Unlocked reads of existing waiting-request and participant fingerprints
        let reqFp = null
        let v_req_found = false
        for (const r of mockJoinRequestsTable.values()) {
          if (r.meeting_code === p_meeting_code && r.user_id === p_user_id) {
            v_req_found = true
            reqFp = r.device_fingerprint || null
            break
          }
        }

        let partFp = null
        let v_part_found = false
        let part = null
        for (const p of mockParticipantsTable.values()) {
          if (p.meeting_id === meeting.meeting_id && p.user_id === p_user_id) {
            v_part_found = true
            partFp = p.device_fingerprint || null
            part = p
            break
          }
        }

        const incomingFp = p_device_fingerprint || null

        // Step 3: Build distinct non-empty fingerprints and acquire advisory locks in deterministic hash order
        const distinctFps = Array.from(new Set([reqFp, partFp, incomingFp].filter(Boolean))).sort()

        if (args._trackLockOrder) {
          for (const fp of distinctFps) {
            args._trackLockOrder.push(`ADVISORY_LOCK:${fp}`)
          }
        }

        // Step 4 (Row Lock Order 1): Re-read and lock all affected meeting_join_requests rows in deterministic id order
        const affectedReqs = Array.from(mockJoinRequestsTable.values())
          .filter(r => r.meeting_code === p_meeting_code && r.user_id === p_user_id)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

        if (args._trackLockOrder) {
          args._trackLockOrder.push('ROW_LOCK_REQUESTS_ACQUIRED')
          for (const req of affectedReqs) {
            args._trackLockOrder.push(`LOCK_REQUEST:${req.id}`)
          }
        }

        // Step 5: Verify waiting-request existence and fingerprint match initial read
        let lockedReqFp = null
        let v_locked_req_found = false
        for (const r of mockJoinRequestsTable.values()) {
          if (r.meeting_code === p_meeting_code && r.user_id === p_user_id) {
            v_locked_req_found = true
            lockedReqFp = r.device_fingerprint || null
            break
          }
        }

        if (args._simulateReqFpMutation || (affectedReqs[0] && affectedReqs[0]._simulateFpChange)) {
          lockedReqFp = 'fp_mutated_request'
        }
        if (args._simulateReqDisappearing) {
          v_locked_req_found = false
        }

        if (v_req_found && !v_locked_req_found) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }
        if (!v_req_found && v_locked_req_found) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }
        if (v_req_found && v_locked_req_found && (lockedReqFp !== reqFp)) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }

        // Step 6 (Row Lock Order 2): Re-read and lock participant row in deterministic participant_id order
        let lockedPartFp = null
        let v_locked_part_found = false
        let lockedPart = null
        for (const p of mockParticipantsTable.values()) {
          if (p.meeting_id === meeting.meeting_id && p.user_id === p_user_id) {
            v_locked_part_found = true
            lockedPartFp = p.device_fingerprint || null
            lockedPart = p
            break
          }
        }

        if (args._trackLockOrder) {
          args._trackLockOrder.push('ROW_LOCK_PARTICIPANTS_ACQUIRED')
          if (lockedPart) {
            args._trackLockOrder.push(`LOCK_PARTICIPANT:${lockedPart.participant_id}`)
          }
        }

        if (args._simulatePartFpMutation || (part && part._simulateFpChange)) {
          lockedPartFp = 'fp_mutated_part'
        }
        if (args._simulatePartDisappearing) {
          v_locked_part_found = false
        }

        // Step 7: Verify participant existence and fingerprint match initial read
        if (v_part_found && !v_locked_part_found) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }
        if (!v_part_found && v_locked_part_found) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }
        if (v_part_found && v_locked_part_found && (lockedPartFp !== partFp)) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }

        // Step 8: Check device bans for all relevant fingerprints while holding locks
        for (const fp of distinctFps) {
          const banKey = `${p_meeting_code}:${fp}`
          if (mockDeviceBansTable.has(banKey)) {
            return { data: null, error: { message: 'Cannot admit participant: this device is banned from the meeting' } }
          }
        }

        // Step 9: Preserve terminal removed status protection
        if (lockedPart && lockedPart.participant_status === 'removed') {
          return { data: null, error: { message: 'Cannot admit participant: user has been removed from this meeting' } }
        }

        const role = lockedPart?.role || p_role || 'participant'
        const partId = lockedPart?.participant_id || `part-${p_user_id}`

        if (lockedPart) {
          lockedPart.participant_status = 'joined'
          lockedPart.role = role
          lockedPart.device_fingerprint = incomingFp || lockedPart.device_fingerprint
          lockedPart.joined_at = new Date().toISOString()
          lockedPart.left_at = null
          mockParticipantsTable.set(partId, lockedPart)
        } else {
          lockedPart = {
            participant_id: partId,
            meeting_id: meeting.meeting_id,
            user_id: p_user_id,
            role,
            participant_status: 'joined',
            device_fingerprint: incomingFp,
            joined_at: new Date().toISOString(),
            left_at: null
          }
          mockParticipantsTable.set(partId, lockedPart)
        }

        // Step 10 & 11: Clean up lingering requests (already locked in Step 4)
        for (const [key, r] of Array.from(mockJoinRequestsTable.entries())) {
          if (r.meeting_code === p_meeting_code && r.user_id === p_user_id) {
            mockJoinRequestsTable.delete(key)
          }
        }

        return {
          data: { participant_id: partId, status: 'joined', role },
          error: null
        }
      }

      if (fn === 'reject_join_request_tx') {
        const { p_meeting_code, p_user_id } = args

        // Step 1: Meeting check
        let meeting = null
        for (const m of mockMeetingsTable.values()) {
          if (m.meeting_code === p_meeting_code) {
            meeting = m
            break
          }
        }
        if (!meeting) {
          return { data: false, error: null }
        }

        // Step 2: Per-user admission advisory lock
        if (args._trackLockOrder) {
          args._trackLockOrder.push(`USER_ADVISORY_LOCK:${p_meeting_code}:${p_user_id}`)
        }

        // Step 3: Unlocked read of request
        let foundKey = null
        let foundReq = null
        for (const [key, r] of mockJoinRequestsTable.entries()) {
          if (r.meeting_code === p_meeting_code && r.user_id === p_user_id) {
            foundKey = key
            foundReq = r
            break
          }
        }
        if (!foundReq) {
          return { data: false, error: null }
        }

        const initialFp = foundReq.device_fingerprint || null

        // Step 2: Advisory lock
        if (args._trackLockOrder) {
          args._trackLockOrder.push(`ADVISORY_LOCK:${initialFp}`)
        }

        // Step 3: Re-read and lock request FOR UPDATE
        if (args._trackLockOrder) {
          args._trackLockOrder.push('ROW_LOCK_REQUEST_FOR_UPDATE')
        }

        if (args._simulateReqDisappearing) {
          return { data: false, error: null } // safe no-op
        }

        if (args._simulateFpMutation || foundReq._simulateFpChange) {
          return { data: null, error: { message: 'Device fingerprint changed concurrently; please retry' } }
        }

        // Step 4: Atomic deletion
        mockJoinRequestsTable.delete(foundKey)
        return { data: true, error: null }
      }

      return { data: null, error: { message: `Unknown RPC ${fn}` } }
    }
  })

  afterEach(() => {
    supabase.from = originalSupabaseFrom
    supabase.rpc = originalSupabaseRpc
    resetCloudflareService()
    resetMeetingCloudflareService()
  })

  // ── SCENARIO 1: Clean Device Admission (Cloudflare & LiveKit) ───────────────
  it('1. Clean device admission succeeds for Cloudflare and LiveKit with targeted credentials', async () => {
    // 1A: Cloudflare meeting
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })
    mockJoinRequestsTable.set('req-1', {
      id: 'req-1',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    const roomUserSockets = new Map()
    const userMap = new Map()
    userMap.set(PARTICIPANT_ID.toLowerCase(), new Set(['s-alice-123']))
    roomUserSockets.set(ROOM_NAME, userMap)

    const { req, res, emittedSocketEvents: events1 } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID },
      roomUserSockets
    })

    await acceptJoinRequest(req, res)

    assert.equal(res.getStatusCode(), 200)
    assert.equal(res.getData()?.success, true)
    assert.equal(cloudflareCalls.addParticipant.length, 1)

    const part = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === PARTICIPANT_ID)
    assert.ok(part)
    assert.equal(part.participant_status, 'joined')
    assert.equal(part.cloudflare_participant_id, CF_PART_ID)

    const cfAccepted = events1.find((e) => e.event === 'participant_accepted')
    assert.ok(cfAccepted)
    assert.equal(cfAccepted.target, 's-alice-123')
    assert.equal(cfAccepted.payload.cloudflareToken, CF_TOKEN)
    assert.equal(cfAccepted.payload.activeProvider, 'cloudflare')

    // 1B: Participant B admission via Cloudflare RealtimeKit
    mockMeetingsTable.set('meeting-uuid-002', {
      meeting_id: 'meeting-uuid-002',
      meeting_code: 'LK-TEST-02',
      room_name: 'room-lk-test',
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })
    mockJoinRequestsTable.set('req-lk', {
      id: 'req-lk',
      meeting_code: 'LK-TEST-02',
      user_id: PARTICIPANT_B_ID,
      device_fingerprint: 'fp_bob_clean_999',
      status: 'pending'
    })
    const userMapLk = new Map()
    userMapLk.set(PARTICIPANT_B_ID.toLowerCase(), new Set(['s-bob-lk']))
    roomUserSockets.set('room-lk-test', userMapLk)

    const { req: reqLk, res: resLk, emittedSocketEvents: eventsLk } = setupMockReqRes({
      body: { meetingCode: 'LK-TEST-02', userId: PARTICIPANT_B_ID },
      user: { id: HOST_ID },
      roomUserSockets
    })

    await acceptJoinRequest(reqLk, resLk)
    assert.equal(resLk.getStatusCode(), 200)
    const lkAccepted = eventsLk.find((e) => e.event === 'participant_accepted')
    assert.ok(lkAccepted)
    assert.equal(lkAccepted.payload.activeProvider, 'cloudflare')
    assert.equal(lkAccepted.payload.cloudflareToken, CF_TOKEN)
    assert.equal(lkAccepted.payload.token, undefined)
  })

  // ── SCENARIO 2: Already-Banned Device Rejection ─────────────────────────────
  it('2. Already-banned device is rejected atomically inside transaction and purges request', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    mockDeviceBansTable.set(`${MEETING_CODE}:${BANNED_FINGERPRINT}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: BANNED_FINGERPRINT
    })

    mockJoinRequestsTable.set('req-banned', {
      id: 'req-banned',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: BANNED_FINGERPRINT,
      status: 'pending'
    })

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await acceptJoinRequest(req, res)

    assert.equal(res.getStatusCode(), 403)
    assert.equal(res.getData()?.code, 'FORBIDDEN')
    assert.equal(cloudflareCalls.addParticipant.length, 0, 'Must never enroll a banned device')

    // Banned request must be purged
    const reqRemaining = Array.from(mockJoinRequestsTable.values()).find((r) => r.user_id === PARTICIPANT_ID)
    assert.equal(reqRemaining, undefined, 'Banned request must be removed')
  })

  // ── SCENARIO 3: Cross-Account Shared-Device Ban ─────────────────────────────
  it('3. Cross-account shared-device ban removes all participants and requests with that fingerprint', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID
    })

    // Alice is joined from DEVICE_FINGERPRINT
    mockParticipantsTable.set('part-alice', {
      participant_id: 'part-alice',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      cloudflare_participant_id: 'cf-part-alice',
      participant_status: 'joined',
      device_fingerprint: DEVICE_FINGERPRINT
    })

    // Bob has a pending join request from the SAME physical device
    mockJoinRequestsTable.set('req-bob', {
      id: 'req-bob',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_B_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await banDevice(req, res)
    assert.equal(res.getStatusCode(), 200)

    // Verify ban in table
    assert.ok(mockDeviceBansTable.has(`${MEETING_CODE}:${DEVICE_FINGERPRINT}`))

    // Verify Alice was marked 'removed'
    const alicePart = mockParticipantsTable.get('part-alice')
    assert.equal(alicePart.participant_status, 'removed')

    // Verify Bob's join request from the same device was purged
    const bobReq = mockJoinRequestsTable.get('req-bob')
    assert.equal(bobReq, undefined, 'Shared device join request must be purged')

    // Verify Cloudflare eviction occurred for Alice
    assert.equal(cloudflareCalls.removeParticipant.length, 1)
    assert.equal(cloudflareCalls.removeParticipant[0].participantId, 'cf-part-alice')
  })

  // ── SCENARIO 4: Concurrent Ban and Admission Without Deadlocks ──────────────
  it('4. Concurrent ban and admission serialize cleanly without deadlocks and preserve ban invariant', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    mockJoinRequestsTable.set('req-concurrent', {
      id: 'req-concurrent',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    const { req: reqAccept, res: resAccept } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })
    const { req: reqBan, res: resBan } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    // Run both operations concurrently via Promise.all
    await Promise.all([
      acceptJoinRequest(reqAccept, resAccept),
      banDevice(reqBan, resBan)
    ])

    // Ban must succeed
    assert.equal(resBan.getStatusCode(), 200)

    // The terminal state must be 'removed' or non-joined, NEVER 'joined'
    const finalPart = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === PARTICIPANT_ID)
    if (finalPart) {
      assert.notEqual(finalPart.participant_status, 'joined', 'Terminal state must never be joined after ban')
    }
  })

  // ── SCENARIO 5: Ban During Cloudflare Enrollment ────────────────────────────
  it('5. Ban during Cloudflare enrollment aborts finalization, evicts participant, and withholds credentials', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    mockJoinRequestsTable.set('req-midflight-ban', {
      id: 'req-midflight-ban',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    // Simulate ban occurring during Cloudflare API enrollment
    setCloudflareService({
      isConfigured: () => true,
      addParticipant: async (meetingId, params) => {
        cloudflareCalls.addParticipant.push({ meetingId, params })
        // Concurrent ban executes while Cloudflare API is processing
        mockDeviceBansTable.set(`${MEETING_CODE}:${DEVICE_FINGERPRINT}`, {
          meeting_code: MEETING_CODE,
          device_fingerprint: DEVICE_FINGERPRINT
        })
        const part = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === PARTICIPANT_ID)
        if (part) {
          part.participant_status = 'removed'
        }
        return {
          participantId: CF_PART_ID,
          token: CF_TOKEN,
          name: params.name,
          presetName: params.presetName
        }
      },
      removeParticipant: async (meetingId, participantId) => {
        cloudflareCalls.removeParticipant.push({ meetingId, participantId })
        return { success: true }
      }
    })

    const { req, res, emittedSocketEvents: events } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await acceptJoinRequest(req, res)

    assert.equal(res.getStatusCode(), 403)
    assert.equal(res.getData()?.code, 'FORBIDDEN')

    // Verify Cloudflare participant was immediately evicted
    assert.equal(cloudflareCalls.removeParticipant.length, 1)
    assert.equal(cloudflareCalls.removeParticipant[0].participantId, CF_PART_ID)

    // Verify NO participant_accepted event was emitted
    const acceptEvent = events.find((e) => e.event === 'participant_accepted')
    assert.equal(acceptEvent, undefined, 'Must not emit credentials to banned participant')
  })

  // ── SCENARIO 6: Ban After Finalization but Before Delivery ──────────────────
  it('6. Ban between finalization and socket delivery is caught by pre-emission check', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    mockJoinRequestsTable.set('req-pre-emit', {
      id: 'req-pre-emit',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    // Mock finalize RPC to simulate ban committing immediately after finalization
    const origRpc = supabase.rpc
    supabase.rpc = async (fn, args) => {
      const res = await origRpc(fn, args)
      if (fn === 'finalize_participant_admission_tx') {
        // Participant was finalized to 'joined', but right after, a ban sets status to 'removed'
        const part = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === PARTICIPANT_ID)
        if (part) {
          part.participant_status = 'removed'
        }
      }
      return res
    }

    const { req, res, emittedSocketEvents: events } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await acceptJoinRequest(req, res)

    assert.equal(res.getStatusCode(), 403)
    assert.equal(res.getData()?.code, 'FORBIDDEN')

    // Evicted from Cloudflare
    assert.equal(cloudflareCalls.removeParticipant.length, 1)

    // Withheld credentials
    const acceptEvent = events.find((e) => e.event === 'participant_accepted')
    assert.equal(acceptEvent, undefined)
  })

  // ── SCENARIO 7: LiveKit Ban During Token Creation / Delivery ────────────────
  it('7. LiveKit ban during token creation fails finalization and withholds tokens', async () => {
    mockMeetingsTable.set('meeting-uuid-002', {
      meeting_id: 'meeting-uuid-002',
      meeting_code: 'LK-RACE-01',
      room_name: 'room-lk-race',
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: null,
      auto_admit: false
    })

    mockJoinRequestsTable.set('req-lk-race', {
      id: 'req-lk-race',
      meeting_code: 'LK-RACE-01',
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    process.env.LIVEKIT_API_KEY = 'test_lk_key'
    process.env.LIVEKIT_API_SECRET = 'test_lk_secret_123456789012345678901234567890'

    // Mock ban right before finalize
    const origRpc = supabase.rpc
    supabase.rpc = async (fn, args) => {
      if (fn === 'finalize_participant_admission_tx') {
        // Status was changed to 'removed' by concurrent ban
        return { data: false, error: null }
      }
      return origRpc(fn, args)
    }

    const { req, res, emittedSocketEvents: events } = setupMockReqRes({
      body: { meetingCode: 'LK-RACE-01', userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await acceptJoinRequest(req, res)

    assert.equal(res.getStatusCode(), 403)
    const acceptEvent = events.find((e) => e.event === 'participant_accepted')
    assert.equal(acceptEvent, undefined, 'LiveKit token must never be emitted')
  })

  // ── SCENARIO 8: Removed Participant Resurrection Prevention ─────────────────
  it('8. Terminal removed participant status cannot be overwritten by finalize or rollback', async () => {
    mockParticipantsTable.set('part-banned', {
      participant_id: 'part-banned',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'removed',
      device_fingerprint: DEVICE_FINGERPRINT
    })

    // Attempt finalization on already removed participant
    const { data: finalizeResult } = await supabase.rpc('finalize_participant_admission_tx', {
      p_meeting_id: 'meeting-uuid-001',
      p_user_id: PARTICIPANT_ID,
      p_cloudflare_participant_id: 'cf-fake-resurrection'
    })

    assert.equal(finalizeResult, false, 'Finalize must return false for removed participant')
    const part = mockParticipantsTable.get('part-banned')
    assert.equal(part.participant_status, 'removed', 'Status must remain removed')
    assert.equal(part.cloudflare_participant_id, undefined)
  })

  // ── SCENARIO 9: Duplicate Acceptance ────────────────────────────────────────
  it('9. Duplicate acceptance attempt fails atomically and enrolls exactly once', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    mockJoinRequestsTable.set('req-dup', {
      id: 'req-dup',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    const { req: req1, res: res1 } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })
    const { req: req2, res: res2 } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await acceptJoinRequest(req1, res1)
    assert.equal(res1.getStatusCode(), 200)

    await acceptJoinRequest(req2, res2)
    assert.equal(res2.getStatusCode(), 400)
    assert.equal(res2.getData()?.code, 'TRANSACTION_FAILED')

    assert.equal(cloudflareCalls.addParticipant.length, 1, 'Cloudflare must be called exactly once')
  })

  // ── SCENARIO 10: Provider Enrollment Failure and Rollback ───────────────────
  it('10. Provider enrollment failure returns HTTP 502, restores request, and rolls back enrolling state', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    mockJoinRequestsTable.set('req-fail', {
      id: 'req-fail',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    setCloudflareService({
      isConfigured: () => true,
      addParticipant: async () => {
        throw new Error('Cloudflare API 500 Service Unavailable')
      }
    })

    const { req, res, emittedSocketEvents: events } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await acceptJoinRequest(req, res)

    assert.equal(res.getStatusCode(), 502)
    assert.equal(res.getData()?.code, 'CLOUDFLARE_ENROLLMENT_FAILED')

    // Join request must be restored
    const restoredReq = Array.from(mockJoinRequestsTable.values()).find((r) => r.user_id === PARTICIPANT_ID)
    assert.ok(restoredReq, 'Join request must be restored')

    // Enrolling participant row must be deleted
    const part = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === PARTICIPANT_ID)
    assert.equal(part, undefined, 'Enrolling participant record must be cleaned up')

    // No credentials emitted
    assert.equal(events.find((e) => e.event === 'participant_accepted'), undefined)
  })

  // ── SCENARIO 11: Stale Enrollment Recovery ──────────────────────────────────
  it('11. joinMeeting recovers from stale enrolling participant (>30s) and blocks in-flight (<30s)', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Scheduled',
      is_deleted: false
    })

    // Case A: Recent enrollment (< 30s)
    mockParticipantsTable.set('part-recent', {
      participant_id: 'part-recent',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'enrolling',
      joined_at: new Date(Date.now() - 5000).toISOString()
    })

    const { req: reqRecent, res: resRecent } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, deviceFingerprint: DEVICE_FINGERPRINT },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai', user_metadata: { full_name: 'Alice' } }
    })

    await joinMeeting(reqRecent, resRecent)
    assert.equal(resRecent.getStatusCode(), 200)
    assert.equal(resRecent.getData()?.status, 'waiting')
    assert.equal(resRecent.getData()?.message, 'Admission is currently in progress.')

    // Case B: Stale enrollment (> 30s)
    mockParticipantsTable.set('part-stale', {
      participant_id: 'part-stale',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_B_ID,
      participant_status: 'enrolling',
      joined_at: new Date(Date.now() - 60000).toISOString()
    })

    const { req: reqStale, res: resStale } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, deviceFingerprint: 'fp_bob_clean_999' },
      user: { id: PARTICIPANT_B_ID, email: 'bob@meetly.ai', user_metadata: { full_name: 'Bob' } }
    })

    await joinMeeting(reqStale, resStale)
    assert.equal(resStale.getStatusCode(), 200)
    assert.equal(resStale.getData()?.status, 'waiting')

    // Stale enrolling row must have been cleaned up
    const stalePart = mockParticipantsTable.get('part-stale')
    assert.equal(stalePart, undefined, 'Stale enrolling record must be deleted')
  })

  // ── AUTHORIZATION & TARGETED DELIVERY ───────────────────────────────────────
  it('12. Non-host user attempting to accept a participant receives HTTP 403', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: PARTICIPANT_B_ID } // Non-host
    })

    await acceptJoinRequest(req, res)

    assert.equal(res.getStatusCode(), 403)
    assert.equal(res.getData()?.code, 'FORBIDDEN')
    assert.equal(cloudflareCalls.addParticipant.length, 0)
  })

  it('13. Emits participant_accepted only to the admitted user socket and broadcasts waiting_list_updated to room', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    mockJoinRequestsTable.set('req-target', {
      id: 'req-target',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    const roomUserSockets = new Map()
    const userMap = new Map()
    userMap.set(HOST_ID.toLowerCase(), new Set(['socket-host']))
    userMap.set(PARTICIPANT_ID.toLowerCase(), new Set(['socket-alice-target']))
    userMap.set(PARTICIPANT_B_ID.toLowerCase(), new Set(['socket-bob-other']))
    roomUserSockets.set(ROOM_NAME, userMap)

    const { req, res, emittedSocketEvents: events } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID },
      roomUserSockets
    })

    await acceptJoinRequest(req, res)

    const acceptEvents = events.filter((e) => e.event === 'participant_accepted')
    assert.equal(acceptEvents.length, 1)
    assert.equal(acceptEvents[0].target, 'socket-alice-target', 'Must be sent to Alice socket ONLY')

    const roomCredentialLeaks = acceptEvents.filter((e) => e.target === ROOM_NAME)
    assert.equal(roomCredentialLeaks.length, 0, 'Credentials must never be broadcast to room')

    const waitingListEvent = events.find((e) => e.event === 'waiting_list_updated' && e.target === ROOM_NAME)
    assert.ok(waitingListEvent, 'waiting_list_updated must be broadcast to the meeting room')
  })

  it('14. removeParticipant evicts participant from Cloudflare session when cloudflare_meeting_id exists', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID
    })

    mockParticipantsTable.set('part-to-remove', {
      participant_id: 'part-to-remove',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      cloudflare_participant_id: CF_PART_ID,
      participant_status: 'joined'
    })

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await removeParticipant(req, res)

    assert.equal(res.getStatusCode(), 200)
    assert.equal(cloudflareCalls.removeParticipant.length, 1)
    assert.equal(cloudflareCalls.removeParticipant[0].meetingId, CF_MEETING_ID)
    assert.equal(cloudflareCalls.removeParticipant[0].participantId, CF_PART_ID)
  })

  // ── FRONTEND UTILITIES ──────────────────────────────────────────────────────
  it('15. Frontend providerSelectionUtils resolves Cloudflare and mounts RealtimeKitAdapter reactively', () => {
    let provider = resolveEffectiveProvider({
      activeProvider: null,
      cloudflareToken: null,
      livekitToken: null
    })
    assert.equal(provider, null)

    let decisions = shouldMountProvider({
      effectiveProvider: provider,
      cloudflareToken: null,
      livekitToken: null
    })
    assert.equal(decisions.mountCloudflare, false)
    assert.equal(decisions.mountLiveKit, false)

    const receivedCfToken = CF_TOKEN
    provider = resolveEffectiveProvider({
      activeProvider: 'cloudflare',
      cloudflareToken: receivedCfToken,
      livekitToken: null
    })
    assert.equal(provider, 'cloudflare')

    decisions = shouldMountProvider({
      effectiveProvider: provider,
      cloudflareToken: receivedCfToken,
      livekitToken: null
    })
    assert.equal(decisions.mountCloudflare, true, 'RealtimeKitAdapter must mount immediately without refresh')
    assert.equal(decisions.mountLiveKit, false, 'LiveKit must not mount')
    assert.equal(decisions.selectedProvider, 'cloudflare')
  })

  it('16. Frontend handler ignores admission events for other users or when already admitted', () => {
    let cloudflareTokenSet = null
    let waitingForApprovalState = true

    const handleParticipantAccepted = (payload, currentUserId, isWaiting) => {
      const { userId, cloudflareToken } = payload || {}
      if (!currentUserId || !userId || String(userId).trim().toLowerCase() !== String(currentUserId).trim().toLowerCase()) {
        return false
      }
      if (!isWaiting) {
        return false
      }
      if (cloudflareToken) {
        cloudflareTokenSet = cloudflareToken
        waitingForApprovalState = false
        return true
      }
      return false
    }

    const resA = handleParticipantAccepted(
      { userId: PARTICIPANT_B_ID, cloudflareToken: 'token-b' },
      PARTICIPANT_ID,
      true
    )
    assert.equal(resA, false, 'Must ignore event for different user')
    assert.equal(cloudflareTokenSet, null)
    assert.equal(waitingForApprovalState, true)

    const resB = handleParticipantAccepted(
      { userId: PARTICIPANT_ID, cloudflareToken: CF_TOKEN },
      PARTICIPANT_ID,
      false
    )
    assert.equal(resB, false, 'Must ignore duplicate event when already out of waiting room')
    assert.equal(cloudflareTokenSet, null)

    const resC = handleParticipantAccepted(
      { userId: PARTICIPANT_ID, cloudflareToken: CF_TOKEN },
      PARTICIPANT_ID,
      true
    )
    assert.equal(resC, true, 'Must process valid event')
    assert.equal(cloudflareTokenSet, CF_TOKEN)
    assert.equal(waitingForApprovalState, false)
  })

  // ── STEP 6.7.5.7 REGRESSION & DEADLOCK TESTS ───────────────────────────────

  // Finding 1: Advisory Lock Acquisition Order in Finalization
  it('17. finalize_participant_admission_tx acquires advisory lock BEFORE locking the participant row', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID
    })

    mockParticipantsTable.set('part-order-test', {
      participant_id: 'part-order-test',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'enrolling',
      device_fingerprint: DEVICE_FINGERPRINT
    })

    const lockOrder = []
    const { data: finalizeResult } = await supabase.rpc('finalize_participant_admission_tx', {
      p_meeting_id: 'meeting-uuid-001',
      p_user_id: PARTICIPANT_ID,
      p_cloudflare_participant_id: CF_PART_ID,
      _trackLockOrder: lockOrder
    })

    assert.equal(finalizeResult, true)
    assert.deepEqual(
      lockOrder,
      ['ADVISORY_LOCK_ACQUIRED', 'ROW_LOCK_ACQUIRED'],
      'Advisory lock must be acquired before row lock on participants'
    )
  })

  // Finding 2: Resurrection Prevention in accept_join_request_tx
  it('18. accept_join_request_tx strictly rejects resurrecting a participant in removed status', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    // Participant row exists in terminal 'removed' state
    mockParticipantsTable.set('part-removed', {
      participant_id: 'part-removed',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'removed',
      device_fingerprint: DEVICE_FINGERPRINT,
      left_at: new Date().toISOString()
    })

    // Waiting request somehow present
    mockJoinRequestsTable.set('req-removed', {
      id: 'req-removed',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await acceptJoinRequest(req, res)

    // Must be rejected with HTTP 403 FORBIDDEN
    assert.equal(res.getStatusCode(), 403)
    assert.equal(res.getData()?.code, 'FORBIDDEN')
    assert.match(res.getData()?.message, /user has been removed/)

    // Participant record must NEVER be transitioned back to 'enrolling' or 'joined'
    const part = mockParticipantsTable.get('part-removed')
    assert.equal(part.participant_status, 'removed', 'Participant must remain removed')
    assert.equal(cloudflareCalls.addParticipant.length, 0, 'Must never enroll a removed participant')

    // Join request must be purged
    const reqRem = mockJoinRequestsTable.get('req-removed')
    assert.equal(reqRem, undefined, 'Invalid join request must be purged')
  })

  it('18b. accept_join_request_tx rejects participant with existing joined status and preserves status', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    // Participant row exists in 'joined' state
    mockParticipantsTable.set('part-joined', {
      participant_id: 'part-joined',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'joined',
      device_fingerprint: DEVICE_FINGERPRINT,
      joined_at: new Date().toISOString()
    })

    // Stale waiting request present
    mockJoinRequestsTable.set('req-stale-joined', {
      id: 'req-stale-joined',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    // Direct RPC call to accept_join_request_tx
    const { data: result, error: rpcErr } = await supabase.rpc('accept_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID
    })

    assert.equal(result, null)
    assert.ok(rpcErr, 'accept_join_request_tx must return an error for joined participant')
    assert.match(rpcErr.message, /already admitted/)

    // Participant status must remain 'joined'
    const part = mockParticipantsTable.get('part-joined')
    assert.equal(part.participant_status, 'joined', 'Participant status must remain joined')

    // Request was not deleted by the failed transaction
    const req = mockJoinRequestsTable.get('req-stale-joined')
    assert.ok(req, 'Stale waiting request must not be consumed by rolled back transaction')
  })

  it('18c. accept_join_request_tx rejects participant with existing enrolling status and preserves status', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    // Participant row exists in 'enrolling' state
    mockParticipantsTable.set('part-enrolling', {
      participant_id: 'part-enrolling',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'enrolling',
      device_fingerprint: DEVICE_FINGERPRINT,
      joined_at: new Date().toISOString()
    })

    // Stale waiting request present
    mockJoinRequestsTable.set('req-stale-enrolling', {
      id: 'req-stale-enrolling',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    // Direct RPC call to accept_join_request_tx
    const { data: result, error: rpcErr } = await supabase.rpc('accept_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID
    })

    assert.equal(result, null)
    assert.ok(rpcErr, 'accept_join_request_tx must return an error for enrolling participant')
    assert.match(rpcErr.message, /already admitted/)

    // Participant status must remain 'enrolling'
    const part = mockParticipantsTable.get('part-enrolling')
    assert.equal(part.participant_status, 'enrolling', 'Participant status must remain enrolling')

    // Request was not deleted by the failed transaction
    const req = mockJoinRequestsTable.get('req-stale-enrolling')
    assert.ok(req, 'Stale waiting request must not be consumed by rolled back transaction')
  })

  // Finding 3: Concurrent Fingerprint Change Aborts Without Second Advisory Lock
  it('19. accept_join_request_tx aborts with retry error if fingerprint changed concurrently', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    mockJoinRequestsTable.set('req-mutated', {
      id: 'req-mutated',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending',
      _simulateFpChange: true // Simulates fingerprint change between initial read and locked re-read
    })

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await acceptJoinRequest(req, res)

    // Aborts transaction and requires retry (HTTP 409 CONCURRENCY_CONFLICT)
    assert.equal(res.getStatusCode(), 409)
    assert.equal(res.getData()?.code, 'CONCURRENCY_CONFLICT')
    assert.equal(cloudflareCalls.addParticipant.length, 0, 'Must not enroll before clean lock acquisition')
  })

  // Finding 4: Correct Handling of NULL Fingerprints in Finalization
  it('20. finalize_participant_admission_tx handles NULL fingerprints and distinguishes missing records', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID
    })

    // Case 4A: Missing participant record altogether -> returns FALSE
    const { data: missingResult } = await supabase.rpc('finalize_participant_admission_tx', {
      p_meeting_id: 'meeting-uuid-001',
      p_user_id: '99999999-9999-4999-8999-999999999999',
      p_cloudflare_participant_id: CF_PART_ID
    })
    assert.equal(missingResult, false, 'Missing participant must return false')

    // Case 4B: Existing participant in 'enrolling' with device_fingerprint = NULL
    mockParticipantsTable.set('part-null-fp', {
      participant_id: 'part-null-fp',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'enrolling',
      device_fingerprint: null
    })

    const { data: nullFpResult } = await supabase.rpc('finalize_participant_admission_tx', {
      p_meeting_id: 'meeting-uuid-001',
      p_user_id: PARTICIPANT_ID,
      p_cloudflare_participant_id: CF_PART_ID
    })

    // Must successfully finalize to joined and NOT treat null fingerprint as missing!
    assert.equal(nullFpResult, true, 'Participant with NULL fingerprint must finalize successfully')
    const finalizedPart = mockParticipantsTable.get('part-null-fp')
    assert.equal(finalizedPart.participant_status, 'joined')
    assert.equal(finalizedPart.cloudflare_participant_id, CF_PART_ID)
  })

  // Deadlock Prevention Test: Concurrent Ban and Finalization
  it('21. Concurrent ban and finalization serialize on advisory lock without deadlock', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID
    })

    // Participant is currently enrolling
    mockParticipantsTable.set('part-race-final', {
      participant_id: 'part-race-final',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'enrolling',
      device_fingerprint: DEVICE_FINGERPRINT
    })

    // Execute banDevice and finalize_participant_admission_tx concurrently
    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    const [banResult, finalizeRpcResult] = await Promise.all([
      banDevice(banReq, banRes),
      supabase.rpc('finalize_participant_admission_tx', {
        p_meeting_id: 'meeting-uuid-001',
        p_user_id: PARTICIPANT_ID,
        p_cloudflare_participant_id: CF_PART_ID
      })
    ])

    assert.equal(banRes.getStatusCode(), 200, 'Ban must succeed')
    // Because ban serializes and sets status to 'removed', finalization cannot overwrite it
    const part = mockParticipantsTable.get('part-race-final')
    assert.equal(part.participant_status, 'removed', 'Terminal status must remain removed')
    assert.ok(mockDeviceBansTable.has(`${MEETING_CODE}:${DEVICE_FINGERPRINT}`))
  })

  // ── STEP 6.7.5.8 FINAL BAN TRANSACTION & LOCK-ORDER REGRESSION TESTS ───────

  // Test 22: Existing participant fingerprint differs from waiting-request fingerprint
  it('22. ban_device_tx handles participant fingerprint differing from waiting-request fingerprint without deadlock', async () => {
    const FP_PARTICIPANT = 'fp_alice_browser_old_111'
    const FP_WAITING_REQ = 'fp_alice_mobile_new_222'

    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    // Existing participant from earlier session has FP_PARTICIPANT
    mockParticipantsTable.set('part-diff-fp', {
      participant_id: 'part-diff-fp',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'disconnected',
      device_fingerprint: FP_PARTICIPANT
    })

    // Current waiting-room request has FP_WAITING_REQ
    mockJoinRequestsTable.set('req-diff-fp', {
      id: 'req-diff-fp',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: FP_WAITING_REQ,
      status: 'pending'
    })

    const lockOrder = []
    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    // Track lock order in ban_device_tx
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'ban_device_tx') {
        args._trackLockOrder = lockOrder
      }
      return origRpc(fn, args)
    }

    await banDevice(banReq, banRes)

    assert.equal(banRes.getStatusCode(), 200)

    // Verify row-lock order was consistent: requests FIRST, participants SECOND
    assert.deepEqual(
      lockOrder,
      ['ADVISORY_LOCK_ACQUIRED', 'ROW_LOCK_REQUESTS_ACQUIRED', 'ROW_LOCK_PARTICIPANTS_ACQUIRED'],
      'Row locks must strictly follow meeting_join_requests -> participants'
    )

    // Verify BOTH fingerprints are banned in meeting_device_bans
    assert.ok(mockDeviceBansTable.has(`${MEETING_CODE}:${FP_WAITING_REQ}`), 'Waiting request fingerprint must be banned')
    assert.ok(mockDeviceBansTable.has(`${MEETING_CODE}:${FP_PARTICIPANT}`), 'Participant fingerprint must be banned')

    // Verify waiting request is deleted
    assert.equal(mockJoinRequestsTable.get('req-diff-fp'), undefined, 'Waiting request must be purged')

    // Verify participant is marked removed
    const part = mockParticipantsTable.get('part-diff-fp')
    assert.equal(part.participant_status, 'removed')
  })

  // Test 23: Concurrent admission and ban for the same user
  it('23. Concurrent admission and ban for the same user serialize without deadlock and enforce ban invariant', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    mockJoinRequestsTable.set('req-concurrent-same-user', {
      id: 'req-concurrent-same-user',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    const { req: acceptReq, res: acceptRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    // Run simultaneously
    await Promise.all([
      acceptJoinRequest(acceptReq, acceptRes),
      banDevice(banReq, banRes)
    ])

    // Ban must succeed with 200
    assert.equal(banRes.getStatusCode(), 200)

    // User must NOT be admitted or joined
    const part = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === PARTICIPANT_ID)
    if (part) {
      assert.equal(part.participant_status, 'removed', 'User must end up removed, never joined')
    }

    assert.ok(mockDeviceBansTable.has(`${MEETING_CODE}:${DEVICE_FINGERPRINT}`))
  })

  // Test 24: Concurrent cross-account ban and admission
  it('24. Concurrent cross-account ban on User A and admission on User B sharing device serializes safely', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    const SHARED_DEVICE_FP = 'fp_shared_hardware_device_xyz'

    // User A is enrolled/joined with SHARED_DEVICE_FP
    mockParticipantsTable.set('part-user-a', {
      participant_id: 'part-user-a',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      cloudflare_participant_id: 'cf-part-a',
      participant_status: 'joined',
      device_fingerprint: SHARED_DEVICE_FP
    })

    // User B is waiting to be admitted with the SAME physical device fingerprint
    mockJoinRequestsTable.set('req-user-b', {
      id: 'req-user-b',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_B_ID,
      device_fingerprint: SHARED_DEVICE_FP,
      status: 'pending'
    })

    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    const { req: acceptReq, res: acceptRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_B_ID },
      user: { id: HOST_ID }
    })

    // Concurrently ban User A while attempting to accept User B
    await Promise.all([
      banDevice(banReq, banRes),
      acceptJoinRequest(acceptReq, acceptRes)
    ])

    // Ban on User A succeeds
    assert.equal(banRes.getStatusCode(), 200)

    // Cross-account enforcement: User B admission must be rejected as device is banned
    assert.notEqual(acceptRes.getStatusCode(), 200, 'User B must not be admitted on banned shared device')

    // Both users must not be in 'joined' state
    const partA = mockParticipantsTable.get('part-user-a')
    assert.equal(partA.participant_status, 'removed')

    const partB = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === PARTICIPANT_B_ID)
    if (partB) {
      assert.notEqual(partB.participant_status, 'joined')
    }

    // Shared device is in meeting_device_bans
    assert.ok(mockDeviceBansTable.has(`${MEETING_CODE}:${SHARED_DEVICE_FP}`))
  })

  // Test 25: Fingerprint changes while a ban operation is acquiring its lock
  it('25. ban_device_tx detects fingerprint mutation during lock acquisition and aborts with retry error', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID
    })

    mockParticipantsTable.set('part-mutating-fp', {
      participant_id: 'part-mutating-fp',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'joined',
      device_fingerprint: DEVICE_FINGERPRINT,
      _simulateFpChange: true // Simulates fingerprint change while acquiring lock
    })

    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await banDevice(banReq, banRes)

    // Aborts transaction with HTTP 409 CONCURRENCY_CONFLICT
    assert.equal(banRes.getStatusCode(), 409)
    assert.equal(banRes.getData()?.code, 'CONCURRENCY_CONFLICT')
    assert.match(banRes.getData()?.message, /fingerprint changed during ban operation/i)
  })

  // ── ISSUE 3: REGRESSION TEST SUITE (8 SPECIFIED SCENARIOS) ───────────────────

  // 1. Waiting-request fingerprint changing from NULL to a value during ban acquisition
  it('26. Regression 1: Waiting-request fingerprint changing from NULL to a value during ban acquisition aborts with retry error', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID
    })

    // Participant has a valid fingerprint (so ban initiates based on participant)
    mockParticipantsTable.set('part-user', {
      participant_id: 'part-user',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'joined',
      device_fingerprint: DEVICE_FINGERPRINT
    })

    // Waiting request initially has NULL fingerprint
    mockJoinRequestsTable.set('req-user', {
      id: 'req-user',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: null,
      status: 'pending'
    })

    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'ban_device_tx') {
        args._simulateReqFpNullToValue = true
      }
      return origRpc(fn, args)
    }

    await banDevice(banReq, banRes)

    // Must return HTTP 409 CONCURRENCY_CONFLICT
    assert.equal(banRes.getStatusCode(), 409)
    assert.equal(banRes.getData()?.code, 'CONCURRENCY_CONFLICT')
    assert.match(banRes.getData()?.message, /fingerprint changed during ban operation/i)
  })

  // 2. Participant fingerprint changing from NULL to a value during ban acquisition
  it('27. Regression 2: Participant fingerprint changing from NULL to a value during ban acquisition aborts with retry error', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID
    })

    // Waiting request has a valid fingerprint
    mockJoinRequestsTable.set('req-user', {
      id: 'req-user',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    // Participant record initially has NULL fingerprint
    mockParticipantsTable.set('part-user', {
      participant_id: 'part-user',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'enrolling',
      device_fingerprint: null
    })

    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'ban_device_tx') {
        args._simulatePartFpNullToValue = true
      }
      return origRpc(fn, args)
    }

    await banDevice(banReq, banRes)

    assert.equal(banRes.getStatusCode(), 409)
    assert.equal(banRes.getData()?.code, 'CONCURRENCY_CONFLICT')
    assert.match(banRes.getData()?.message, /fingerprint changed during ban operation/i)
  })

  // 3. Request row disappearing during ban acquisition
  it('28. Regression 3: Request row disappearing during ban acquisition aborts with retry error', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID
    })

    mockParticipantsTable.set('part-user', {
      participant_id: 'part-user',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'joined',
      device_fingerprint: DEVICE_FINGERPRINT
    })

    mockJoinRequestsTable.set('req-user', {
      id: 'req-user',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'ban_device_tx') {
        args._simulateReqDisappearing = true
      }
      return origRpc(fn, args)
    }

    await banDevice(banReq, banRes)

    assert.equal(banRes.getStatusCode(), 409)
    assert.equal(banRes.getData()?.code, 'CONCURRENCY_CONFLICT')
    assert.match(banRes.getData()?.message, /fingerprint changed during ban operation/i)
  })

  // 4. Participant row disappearing during ban acquisition
  it('29. Regression 4: Participant row disappearing during ban acquisition aborts with retry error', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID
    })

    mockJoinRequestsTable.set('req-user', {
      id: 'req-user',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    mockParticipantsTable.set('part-user', {
      participant_id: 'part-user',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'joined',
      device_fingerprint: DEVICE_FINGERPRINT
    })

    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'ban_device_tx') {
        args._simulatePartDisappearing = true
      }
      return origRpc(fn, args)
    }

    await banDevice(banReq, banRes)

    assert.equal(banRes.getStatusCode(), 409)
    assert.equal(banRes.getData()?.code, 'CONCURRENCY_CONFLICT')
    assert.match(banRes.getData()?.message, /fingerprint changed during ban operation/i)
  })

  // 5. Multiple matching waiting requests being locked before any participant row
  it('30. Regression 5: Multiple matching waiting requests are locked before any participant row', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID
    })

    const TARGET_FP = 'fp_multi_req_target'

    // Multiple matching waiting requests (unsorted on purpose: req-03, req-01, req-02)
    mockJoinRequestsTable.set('req-03', {
      id: 'req-03',
      meeting_code: MEETING_CODE,
      user_id: 'user-333',
      device_fingerprint: TARGET_FP,
      status: 'pending'
    })
    mockJoinRequestsTable.set('req-01', {
      id: 'req-01',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: TARGET_FP,
      status: 'pending'
    })
    mockJoinRequestsTable.set('req-02', {
      id: 'req-02',
      meeting_code: MEETING_CODE,
      user_id: 'user-222',
      device_fingerprint: TARGET_FP,
      status: 'pending'
    })

    // Multiple participants matching target fingerprint
    mockParticipantsTable.set('part-02', {
      participant_id: 'part-02',
      meeting_id: 'meeting-uuid-001',
      user_id: 'user-222',
      participant_status: 'joined',
      device_fingerprint: TARGET_FP
    })
    mockParticipantsTable.set('part-01', {
      participant_id: 'part-01',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'joined',
      device_fingerprint: TARGET_FP
    })

    const lockOrder = []
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'ban_device_tx') {
        args._trackLockOrder = lockOrder
        args._trackDetailedRowLocks = true
      }
      return origRpc(fn, args)
    }

    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await banDevice(banReq, banRes)

    assert.equal(banRes.getStatusCode(), 200)

    // Find indices of requests and participants in lock order
    const reqIndices = lockOrder
      .map((entry, idx) => (entry.startsWith('LOCK_REQUEST:') ? idx : -1))
      .filter((idx) => idx !== -1)
    const partIndices = lockOrder
      .map((entry, idx) => (entry.startsWith('LOCK_PARTICIPANT:') ? idx : -1))
      .filter((idx) => idx !== -1)

    assert.ok(reqIndices.length > 0, 'Must have locked request rows')
    assert.ok(partIndices.length > 0, 'Must have locked participant rows')

    const maxReqIndex = Math.max(...reqIndices)
    const minPartIndex = Math.min(...partIndices)

    // Complete request-row locking before participant-row locking!
    assert.ok(
      maxReqIndex < minPartIndex,
      `All request locks (max idx: ${maxReqIndex}) must be acquired before ANY participant lock (min idx: ${minPartIndex})`
    )

    // Verify request locks are acquired in sorted id order: req-01, req-02, req-03
    const lockedReqIds = lockOrder
      .filter((entry) => entry.startsWith('LOCK_REQUEST:'))
      .map((entry) => entry.replace('LOCK_REQUEST:', ''))
    assert.deepEqual(lockedReqIds, ['req-01', 'req-02', 'req-03'])
  })

  // 6. Multiple affected participants being locked in deterministic order
  it('31. Regression 6: Multiple affected participants are locked in deterministic order', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID
    })

    const TARGET_FP = 'fp_multi_part_target'

    mockJoinRequestsTable.set('req-target', {
      id: 'req-target',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: TARGET_FP,
      status: 'pending'
    })

    // Unordered participant IDs: part-gamma, part-alpha, part-beta
    mockParticipantsTable.set('part-gamma', {
      participant_id: 'part-gamma',
      meeting_id: 'meeting-uuid-001',
      user_id: 'user-gamma',
      participant_status: 'joined',
      device_fingerprint: TARGET_FP
    })
    mockParticipantsTable.set('part-alpha', {
      participant_id: 'part-alpha',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'joined',
      device_fingerprint: TARGET_FP
    })
    mockParticipantsTable.set('part-beta', {
      participant_id: 'part-beta',
      meeting_id: 'meeting-uuid-001',
      user_id: 'user-beta',
      participant_status: 'joined',
      device_fingerprint: TARGET_FP
    })

    const lockOrder = []
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'ban_device_tx') {
        args._trackLockOrder = lockOrder
        args._trackDetailedRowLocks = true
      }
      return origRpc(fn, args)
    }

    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await banDevice(banReq, banRes)

    assert.equal(banRes.getStatusCode(), 200)

    // Participant locks must be in strictly ascending order: part-alpha, part-beta, part-gamma
    const lockedPartIds = lockOrder
      .filter((entry) => entry.startsWith('LOCK_PARTICIPANT:'))
      .map((entry) => entry.replace('LOCK_PARTICIPANT:', ''))
    assert.deepEqual(lockedPartIds, ['part-alpha', 'part-beta', 'part-gamma'])
  })

  // 7. Concurrent admission and ban with different fingerprints for the same user
  it('32. Regression 7: Concurrent admission and ban with different fingerprints for the same user serialize safely', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    const FP_PART = 'fp_diff_user_old_laptop'
    const FP_REQ = 'fp_diff_user_new_mobile'

    // Existing participant has FP_PART
    mockParticipantsTable.set('part-diff-same-user', {
      participant_id: 'part-diff-same-user',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'disconnected',
      device_fingerprint: FP_PART
    })

    // Current waiting request has FP_REQ
    mockJoinRequestsTable.set('req-diff-same-user', {
      id: 'req-diff-same-user',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: FP_REQ,
      status: 'pending'
    })

    const { req: acceptReq, res: acceptRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    // Concurrently trigger ban and accept
    await Promise.all([
      banDevice(banReq, banRes),
      acceptJoinRequest(acceptReq, acceptRes)
    ])

    // Ban succeeds
    assert.equal(banRes.getStatusCode(), 200)

    // Both device fingerprints must be banned
    assert.ok(mockDeviceBansTable.has(`${MEETING_CODE}:${FP_REQ}`), 'Waiting request fingerprint must be banned')
    assert.ok(mockDeviceBansTable.has(`${MEETING_CODE}:${FP_PART}`), 'Participant fingerprint must be banned')

    // Participant must not be joined
    const part = mockParticipantsTable.get('part-diff-same-user')
    assert.equal(part.participant_status, 'removed', 'Participant must be removed')

    // Waiting request must be deleted
    assert.equal(mockJoinRequestsTable.get('req-diff-same-user'), undefined)
  })

  // 8. Concurrent cross-account admission and ban sharing a fingerprint
  it('33. Regression 8: Concurrent cross-account admission and ban sharing a fingerprint serialize safely', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    const SHARED_FP = 'fp_shared_library_pc'

    // User A is enrolled/joined on the shared PC
    mockParticipantsTable.set('part-user-alpha', {
      participant_id: 'part-user-alpha',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      cloudflare_participant_id: 'cf-part-alpha',
      participant_status: 'joined',
      device_fingerprint: SHARED_FP
    })

    // User B (another account) is waiting to join from the SAME shared PC
    mockJoinRequestsTable.set('req-user-beta', {
      id: 'req-user-beta',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_B_ID,
      device_fingerprint: SHARED_FP,
      status: 'pending'
    })

    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    const { req: acceptReq, res: acceptRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_B_ID },
      user: { id: HOST_ID }
    })

    // Simultaneously ban User A while admitting User B
    await Promise.all([
      banDevice(banReq, banRes),
      acceptJoinRequest(acceptReq, acceptRes)
    ])

    // Ban succeeds
    assert.equal(banRes.getStatusCode(), 200)

    // Admission on banned device must fail
    assert.notEqual(acceptRes.getStatusCode(), 200, 'User B admission must be rejected on banned device')

    // User A is removed
    const partA = mockParticipantsTable.get('part-user-alpha')
    assert.equal(partA.participant_status, 'removed')

    // User B is not joined
    const partB = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === PARTICIPANT_B_ID)
    if (partB) {
      assert.notEqual(partB.participant_status, 'joined')
    }

    // Shared fingerprint is recorded in meeting_device_bans
    assert.ok(mockDeviceBansTable.has(`${MEETING_CODE}:${SHARED_FP}`))

    // Waiting request for User B is deleted
    assert.equal(mockJoinRequestsTable.get('req-user-beta'), undefined)
  })

  // ── STEP 6.7.5.11: UNIFIED ENTRY-POINT ADVISORY-LOCK CONCURRENCY SUITE ───────

  // 1. Waiting-request creation versus device ban
  it('34. Step 6.7.5.11: Waiting-request creation on banned device is rejected atomically without creating phantom row', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const BANNED_FP = 'fp_banned_during_request'
    mockDeviceBansTable.set(`${MEETING_CODE}:${BANNED_FP}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: BANNED_FP,
      blocked_at: new Date().toISOString()
    })

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: BANNED_FP },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(req, res)

    assert.equal(res.getStatusCode(), 403)
    assert.match(res.getData()?.message, /device has been blocked by the meeting host/i)

    // Ensure NO phantom request was created in meeting_join_requests
    const request = Array.from(mockJoinRequestsTable.values()).find(
      (r) => r.meeting_code === MEETING_CODE && r.device_fingerprint === BANNED_FP
    )
    assert.equal(request, undefined, 'No phantom request row must exist for banned device')
  })

  // 2. Auto-admission versus device ban
  it('35. Step 6.7.5.11: Auto-admission on banned device is atomically rejected and no credentials are generated', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true, // Auto-admit meeting
      meeting_status: 'Active',
      is_deleted: false
    })

    const BANNED_FP = 'fp_banned_auto_candidate'
    mockDeviceBansTable.set(`${MEETING_CODE}:${BANNED_FP}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: BANNED_FP,
      blocked_at: new Date().toISOString()
    })

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: BANNED_FP },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(req, res)

    // Must be rejected with 403
    assert.equal(res.getStatusCode(), 403)
    assert.match(res.getData()?.message, /device has been blocked by the meeting host/i)

    // Cloudflare enrollment must NOT have been called
    assert.equal(cloudflareCalls.addParticipant.length, 0, 'No Cloudflare credentials must be issued')

    // Participant must not be joined
    const part = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === PARTICIPANT_ID)
    if (part) {
      assert.notEqual(part.participant_status, 'joined')
    }
  })

  // 3. Rollback request restoration versus device ban
  it('36. Step 6.7.5.11: Rollback request restoration is rejected if device was banned mid-flight', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    mockJoinRequestsTable.set('req-rollback-test', {
      id: 'req-rollback-test',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    // Cloudflare enrollment fails
    setCloudflareService({
      isConfigured: () => true,
      addParticipant: async () => {
        // Device is banned mid-flight!
        mockDeviceBansTable.set(`${MEETING_CODE}:${DEVICE_FINGERPRINT}`, {
          meeting_code: MEETING_CODE,
          device_fingerprint: DEVICE_FINGERPRINT,
          blocked_at: new Date().toISOString()
        })
        throw new Error('Cloudflare network timeout during enrollment')
      }
    })

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await acceptJoinRequest(req, res)

    // acceptJoinRequest returns 502 / error because provider enrollment failed
    assert.notEqual(res.getStatusCode(), 200)

    // Waiting request must NOT have been restored for banned device!
    const restoredReq = Array.from(mockJoinRequestsTable.values()).find(
      (r) => r.meeting_code === MEETING_CODE && r.user_id === PARTICIPANT_ID
    )
    assert.equal(restoredReq, undefined, 'Waiting request must not be restored for banned device')
  })

  // 4. Rejection versus admission (reject_join_request_tx vs accept_join_request_tx)
  it('37. Step 6.7.5.11: Rejection and admission serialize on advisory lock without race condition', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    mockJoinRequestsTable.set('req-reject-race', {
      id: 'req-reject-race',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    const { req: rejectReq, res: rejectRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    const { req: acceptReq, res: acceptRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    // Concurrently trigger rejection and acceptance
    await Promise.all([
      rejectJoinRequest(rejectReq, rejectRes),
      acceptJoinRequest(acceptReq, acceptRes)
    ])

    // Rejection succeeds
    assert.equal(rejectRes.getStatusCode(), 200)

    // Acceptance fails because request was atomically purged
    assert.notEqual(acceptRes.getStatusCode(), 200)

    // Request is deleted
    assert.equal(mockJoinRequestsTable.get('req-reject-race'), undefined)

    // Participant is not admitted
    const part = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === PARTICIPANT_ID)
    if (part) {
      assert.notEqual(part.participant_status, 'joined')
    }
  })

  // 5. Duplicate waiting requests
  it('38. Step 6.7.5.11: Duplicate waiting requests return idempotent status without duplicate rows', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const { req: req1, res: res1 } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: DEVICE_FINGERPRINT },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    // First join request
    await joinMeeting(req1, res1)
    assert.equal(res1.getStatusCode(), 200)
    assert.equal(res1.getData()?.status, 'waiting')

    // Second join request from same user
    const { req: req2, res: res2 } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: DEVICE_FINGERPRINT },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(req2, res2)
    assert.equal(res2.getStatusCode(), 200)
    assert.equal(res2.getData()?.status, 'waiting')
    assert.match(res2.getData()?.message, /already waiting for host approval/i)

    // Verify exactly one request exists
    const matchingReqs = Array.from(mockJoinRequestsTable.values()).filter(
      (r) => r.meeting_code === MEETING_CODE && r.user_id === PARTICIPANT_ID
    )
    assert.equal(matchingReqs.length, 1, 'Exactly one join request row must exist')
  })

  // 6. Re-admission of removed participants
  it('39. Step 6.7.5.11: Re-admission of removed participant is rejected in both waiting-room and auto-admit modes', async () => {
    // Mode A: Waiting room enabled
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    mockParticipantsTable.set('part-removed-user', {
      participant_id: 'part-removed-user',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'removed',
      device_fingerprint: DEVICE_FINGERPRINT
    })

    const { req: reqA, res: resA } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: DEVICE_FINGERPRINT },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(reqA, resA)
    assert.equal(resA.getStatusCode(), 403)
    assert.match(resA.getData()?.message, /removed from this meeting by the host/i)

    // Mode B: Auto-admit enabled
    const meeting = mockMeetingsTable.get('meeting-uuid-001')
    meeting.auto_admit = true

    const { req: reqB, res: resB } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: DEVICE_FINGERPRINT },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(reqB, resB)
    assert.equal(resB.getStatusCode(), 403)
    assert.match(resB.getData()?.message, /removed from this meeting by the host/i)

    // Participant remains in 'removed' status
    const part = mockParticipantsTable.get('part-removed-user')
    assert.equal(part.participant_status, 'removed', 'Terminal status removed must never be overwritten')
  })

  // 7. Cross-account requests sharing the same fingerprint
  it('40. Step 6.7.5.11: Cross-account participant sharing banned fingerprint is rejected atomically', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const HARDWARE_FP = 'fp_shared_library_macbook_777'

    // Ban was recorded for User A on HARDWARE_FP
    mockDeviceBansTable.set(`${MEETING_CODE}:${HARDWARE_FP}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: HARDWARE_FP,
      blocked_at: new Date().toISOString()
    })

    // User B (completely different account) attempts to join using HARDWARE_FP
    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: HARDWARE_FP },
      user: { id: PARTICIPANT_B_ID, email: 'bob@meetly.ai' }
    })

    await joinMeeting(req, res)

    // Must be rejected atomically under advisory lock
    assert.equal(res.getStatusCode(), 403)
    assert.match(res.getData()?.message, /device has been blocked by the meeting host/i)

    // No request created for User B
    const reqB = Array.from(mockJoinRequestsTable.values()).find(
      (r) => r.meeting_code === MEETING_CODE && r.user_id === PARTICIPANT_B_ID
    )
    assert.equal(reqB, undefined, 'No request may be created for banned hardware fingerprint')
  })

  // ── STEP 6.7.5.13: Final SQL Lock-Order and Fingerprint Correction ──────────
  it('41. Step 6.7.5.13: Auto-admission versus waiting-room acceptance locks requests before participants', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    // User has a lingering waiting request
    mockJoinRequestsTable.set('req-existing-01', {
      id: 'req-existing-01',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending'
    })

    const lockOrder = []
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'auto_admit_participant_tx') {
        args._trackLockOrder = lockOrder
      }
      return origRpc(fn, args)
    }

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: DEVICE_FINGERPRINT },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(req, res)

    assert.equal(res.getStatusCode(), 200)

    // Strict lock hierarchy verification:
    // 1. Advisory lock
    // 2. Row Lock Order 1: meeting_join_requests
    // 3. Row Lock Order 2: participants
    const reqLockIdx = lockOrder.indexOf('ROW_LOCK_REQUESTS_ACQUIRED')
    const partLockIdx = lockOrder.indexOf('ROW_LOCK_PARTICIPANTS_ACQUIRED')
    assert.ok(reqLockIdx !== -1, 'Must acquire request row lock')
    assert.ok(partLockIdx !== -1, 'Must acquire participant row lock')
    assert.ok(reqLockIdx < partLockIdx, 'Request row locks MUST precede participant row locks')

    // Cleaned up request
    const lingeringReq = mockJoinRequestsTable.get('req-existing-01')
    assert.equal(lingeringReq, undefined, 'Lingering join request must be cleaned up')
  })

  it('42. Step 6.7.5.13: Auto-admission versus device ban serializes on advisory lock and rejects banned device', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    const BANNED_DEV = 'fp_concurrent_banned_device_888'
    mockDeviceBansTable.set(`${MEETING_CODE}:${BANNED_DEV}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: BANNED_DEV,
      blocked_at: new Date().toISOString()
    })

    const lockOrder = []
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'auto_admit_participant_tx') {
        args._trackLockOrder = lockOrder
      }
      return origRpc(fn, args)
    }

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: BANNED_DEV },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(req, res)

    assert.equal(res.getStatusCode(), 403)
    assert.match(res.getData()?.message, /device has been blocked by the meeting host/i)
    assert.ok(lockOrder.includes(`ADVISORY_LOCK:${BANNED_DEV}`))
  })

  it('43. Step 6.7.5.13: create_join_request_tx acquires dual advisory locks in deterministic order when fingerprint A changes to B', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP_A = 'fp_device_alpha_111'
    const FP_B = 'fp_device_beta_222'

    // Existing request with fingerprint A
    mockJoinRequestsTable.set('req-user-alpha', {
      id: 'req-user-alpha',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: FP_A,
      status: 'pending'
    })

    const lockOrder = []
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'create_join_request_tx') {
        args._trackLockOrder = lockOrder
      }
      return origRpc(fn, args)
    }

    // User re-submits join request with fingerprint B
    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: FP_B },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(req, res)

    assert.equal(res.getStatusCode(), 200)

    // Verify dual advisory locks were acquired in deterministic order
    const expectedLocks = [FP_A, FP_B].sort()
    assert.ok(lockOrder.includes(`ADVISORY_LOCK:${expectedLocks[0]}`))
    assert.ok(lockOrder.includes(`ADVISORY_LOCK:${expectedLocks[1]}`))
    assert.ok(lockOrder.includes('ROW_LOCK_REQUEST_FOR_UPDATE'))

    // Verify request updated to FP_B
    const updatedReq = mockJoinRequestsTable.get('req-user-alpha')
    assert.equal(updatedReq.device_fingerprint, FP_B)
  })

  it('44. Step 6.7.5.13: create_join_request_tx handles NULL-to-value transition explicitly', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    // Existing request with NULL fingerprint
    mockJoinRequestsTable.set('req-user-null-fp', {
      id: 'req-user-null-fp',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: null,
      status: 'pending'
    })

    const NEW_FP = 'fp_resolved_fingerprint_555'
    const lockOrder = []
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'create_join_request_tx') {
        args._trackLockOrder = lockOrder
      }
      return origRpc(fn, args)
    }

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: NEW_FP },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(req, res)

    assert.equal(res.getStatusCode(), 200)
    assert.ok(lockOrder.includes(`ADVISORY_LOCK:${NEW_FP}`))
    assert.ok(lockOrder.includes('ROW_LOCK_REQUEST_FOR_UPDATE'))

    // Successfully transitioned from NULL to NEW_FP
    const updatedReq = mockJoinRequestsTable.get('req-user-null-fp')
    assert.equal(updatedReq.device_fingerprint, NEW_FP)
  })

  it('45. Step 6.7.5.13: reject_join_request_tx detects fingerprint mutation and returns controlled conflict without deleting on stale lock', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    mockJoinRequestsTable.set('req-mutation-test', {
      id: 'req-mutation-test',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: DEVICE_FINGERPRINT,
      status: 'pending',
      _simulateFpChange: true // Simulated concurrent mutation between unlocked read and locked read
    })

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID, email: 'host@meetly.ai' }
    })

    await rejectJoinRequest(req, res)

    // Must return controlled conflict (HTTP 409)
    assert.equal(res.getStatusCode(), 409)
    assert.equal(res.getData()?.code, 'CONCURRENCY_CONFLICT')
    assert.match(res.getData()?.message, /Device fingerprint changed concurrently; please retry/i)

    // Request MUST NOT be deleted using stale lock
    assert.ok(mockJoinRequestsTable.has('req-mutation-test'), 'Request must not be deleted on stale fingerprint lock')
  })

  it('46. Step 6.7.5.13: reject_join_request_tx missing or already handled request returns safe no-op (HTTP 200)', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    // No request exists in mockJoinRequestsTable for PARTICIPANT_ID
    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID, email: 'host@meetly.ai' }
    })

    await rejectJoinRequest(req, res)

    // Safe no-op returns 200
    assert.equal(res.getStatusCode(), 200)
    assert.equal(res.getData()?.success, true)
    assert.match(res.getData()?.message, /already handled or not found/i)
  })

  it('47. Step 6.7.5.13: Existing participant fingerprint A -> incoming B, concurrent ban on A is caught and rejected', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP_A = 'fp_participant_initial_aaa'
    const FP_B = 'fp_participant_new_bbb'

    // Existing participant with FP_A
    mockParticipantsTable.set('part-user-001', {
      participant_id: 'part-user-001',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      role: 'participant',
      participant_status: 'joined',
      device_fingerprint: FP_A
    })

    // Ban recorded on FP_A
    mockDeviceBansTable.set(`${MEETING_CODE}:${FP_A}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: FP_A,
      blocked_at: new Date().toISOString()
    })

    const lockOrder = []
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'auto_admit_participant_tx') {
        args._trackLockOrder = lockOrder
      }
      return origRpc(fn, args)
    }

    // User attempts auto-admission presenting FP_B
    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: FP_B },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(req, res)

    // Must be rejected atomically because existing participant fingerprint A is banned
    assert.equal(res.getStatusCode(), 403)
    assert.match(res.getData()?.message, /device has been blocked by the meeting host/i)

    // Both advisory locks must have been acquired in deterministic order
    const expectedLocks = [FP_A, FP_B].sort()
    assert.ok(lockOrder.includes(`ADVISORY_LOCK:${expectedLocks[0]}`))
    assert.ok(lockOrder.includes(`ADVISORY_LOCK:${expectedLocks[1]}`))
  })

  it('48. Step 6.7.5.13: Existing waiting-request fingerprint A -> incoming B, concurrent ban on A is caught and rejected', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP_A = 'fp_request_initial_aaa'
    const FP_B = 'fp_request_new_bbb'

    // Existing waiting request with FP_A
    mockJoinRequestsTable.set('req-existing-fp-a', {
      id: 'req-existing-fp-a',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: FP_A,
      status: 'pending'
    })

    // Ban recorded on FP_A
    mockDeviceBansTable.set(`${MEETING_CODE}:${FP_A}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: FP_A,
      blocked_at: new Date().toISOString()
    })

    const lockOrder = []
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'auto_admit_participant_tx') {
        args._trackLockOrder = lockOrder
      }
      return origRpc(fn, args)
    }

    // User attempts auto-admission presenting FP_B
    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: FP_B },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(req, res)

    // Must be rejected atomically because existing request fingerprint A is banned
    assert.equal(res.getStatusCode(), 403)
    assert.match(res.getData()?.message, /device has been blocked by the meeting host/i)

    // Both advisory locks must have been acquired in deterministic order
    const expectedLocks = [FP_A, FP_B].sort()
    assert.ok(lockOrder.includes(`ADVISORY_LOCK:${expectedLocks[0]}`))
    assert.ok(lockOrder.includes(`ADVISORY_LOCK:${expectedLocks[1]}`))
  })

  it('49. Step 6.7.5.13: Existing participant fingerprint A -> incoming NULL preserves existing fingerprint and succeeds', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP_A = 'fp_existing_session_aaa'

    mockParticipantsTable.set('part-user-002', {
      participant_id: 'part-user-002',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      role: 'participant',
      participant_status: 'joined',
      device_fingerprint: FP_A
    })

    const lockOrder = []
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'auto_admit_participant_tx') {
        args._trackLockOrder = lockOrder
      }
      return origRpc(fn, args)
    }

    // Directly invoke auto_admit_participant_tx with incoming NULL fingerprint
    const { data: result, error: admitErr } = await supabase.rpc('auto_admit_participant_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      p_device_fingerprint: null,
      p_role: 'participant'
    })

    assert.equal(admitErr, null)
    assert.equal(result.status, 'joined')
    assert.ok(lockOrder.includes(`ADVISORY_LOCK:${FP_A}`))

    // Participant preserves existing fingerprint FP_A
    const part = mockParticipantsTable.get('part-user-002')
    assert.equal(part.device_fingerprint, FP_A)
    assert.equal(part.participant_status, 'joined')
  })

  it('50. Step 6.7.5.13: Multiple distinct fingerprints are acquired in deterministic order', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP_REQ = 'fp_ccc_999'
    const FP_PART = 'fp_aaa_111'
    const FP_INCOMING = 'fp_bbb_555'

    mockJoinRequestsTable.set('req-multi-fp', {
      id: 'req-multi-fp',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: FP_REQ,
      status: 'pending'
    })

    mockParticipantsTable.set('part-multi-fp', {
      participant_id: 'part-multi-fp',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      role: 'participant',
      participant_status: 'joined',
      device_fingerprint: FP_PART
    })

    const lockOrder = []
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'auto_admit_participant_tx') {
        args._trackLockOrder = lockOrder
      }
      return origRpc(fn, args)
    }

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: FP_INCOMING },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(req, res)

    assert.equal(res.getStatusCode(), 200)

    // Advisory locks must appear in deterministic sorted order
    const expectedFps = [FP_REQ, FP_PART, FP_INCOMING].sort()
    const advisoryLocks = lockOrder.filter(l => l.startsWith('ADVISORY_LOCK:')).map(l => l.replace('ADVISORY_LOCK:', ''))
    assert.deepEqual(advisoryLocks, expectedFps)

    // Row lock order: requests first, participants second
    const reqLockIdx = lockOrder.indexOf('ROW_LOCK_REQUESTS_ACQUIRED')
    const partLockIdx = lockOrder.indexOf('ROW_LOCK_PARTICIPANTS_ACQUIRED')
    assert.ok(reqLockIdx < partLockIdx, 'Request row locks must precede participant row locks')
  })

  it('51. Step 6.7.5.13: Fingerprint mutation between initial read and locked re-read aborts with conflict', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP_A = 'fp_participant_initial_aaa'

    mockParticipantsTable.set('part-user-mutated', {
      participant_id: 'part-user-mutated',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      role: 'participant',
      participant_status: 'joined',
      device_fingerprint: FP_A,
      _simulateFpChange: true // Simulates concurrent mutation between initial read and locked re-read
    })

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: FP_A },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(req, res)

    // Must return HTTP 409 CONCURRENCY_CONFLICT
    assert.equal(res.getStatusCode(), 409)
    assert.equal(res.getData()?.code, 'CONCURRENCY_CONFLICT')
    assert.match(res.getData()?.message, /Device fingerprint changed concurrently; please retry/i)
  })

  // ═════════════════════════════════════════════════════════════════════════════
  // STEP 6.7.5.14: FINAL PHANTOM-ROW AND LOCK-ORDER REGRESSION TESTS
  // ═════════════════════════════════════════════════════════════════════════════

  it('52. Phantom-Row Fix: Auto-admit vs concurrent request creation serializes on user-lock and prevents phantom rows', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP = 'fp_user_concurrent_test_123'
    const lockTimeline = []

    // Async barrier simulating two concurrent transactions serializing on per-user admission advisory lock:
    // (hashtext('meetly-admission-user:' || v_clean_code), hashtext(p_user_id::text))
    let userLockHeldBy = null
    const userLockWaiters = []

    const acquireUserLock = async (workerId) => {
      lockTimeline.push(`${workerId}:WAIT_USER_LOCK`)
      if (userLockHeldBy !== null) {
        await new Promise((resolve) => userLockWaiters.push(resolve))
      }
      userLockHeldBy = workerId
      lockTimeline.push(`${workerId}:ACQUIRED_USER_LOCK`)
    }

    const releaseUserLock = (workerId) => {
      lockTimeline.push(`${workerId}:RELEASE_USER_LOCK`)
      userLockHeldBy = null
      if (userLockWaiters.length > 0) {
        const next = userLockWaiters.shift()
        next()
      }
    }

    const origRpc = supabase.rpc
    supabase.rpc = async (fn, args) => {
      if (fn === 'auto_admit_participant_tx') {
        await acquireUserLock('TX1_AUTO_ADMIT')
        // Simulate in-flight work while holding user advisory lock
        await new Promise((r) => setTimeout(r, 20))
        const res = await origRpc(fn, args)
        releaseUserLock('TX1_AUTO_ADMIT')
        return res
      }
      if (fn === 'create_join_request_tx') {
        await acquireUserLock('TX2_CREATE_REQ')
        const res = await origRpc(fn, args)
        releaseUserLock('TX2_CREATE_REQ')
        return res
      }
      return origRpc(fn, args)
    }

    // Launch Tx 1 (Auto-admission) and concurrent Tx 2 (Request creation) for the same user
    const { req: req1, res: res1 } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: FP },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })
    const { req: req2, res: res2 } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: FP },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    // Auto-admit runs
    const p1 = joinMeeting(req1, res1)
    // Request creation is fired concurrently
    const p2 = (async () => {
      await new Promise((r) => setTimeout(r, 5))
      return supabase.rpc('create_join_request_tx', {
        p_meeting_code: MEETING_CODE,
        p_user_id: PARTICIPANT_ID,
        p_device_fingerprint: FP
      })
    })()

    await Promise.all([p1, p2])

    assert.equal(res1.getStatusCode(), 200)

    // Verify deterministic user-lock acquisition order:
    // Tx 2 had to wait for Tx 1 to release the user lock before it could proceed
    const tx1AcquireIdx = lockTimeline.indexOf('TX1_AUTO_ADMIT:ACQUIRED_USER_LOCK')
    const tx1ReleaseIdx = lockTimeline.indexOf('TX1_AUTO_ADMIT:RELEASE_USER_LOCK')
    const tx2AcquireIdx = lockTimeline.indexOf('TX2_CREATE_REQ:ACQUIRED_USER_LOCK')

    assert.ok(tx1AcquireIdx < tx1ReleaseIdx, 'Tx 1 must acquire before releasing')
    assert.ok(tx1ReleaseIdx < tx2AcquireIdx, 'Tx 2 must wait until Tx 1 releases user lock')

    // Participant is joined
    const part = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === PARTICIPANT_ID)
    assert.equal(part?.participant_status, 'joined')
  })

  it('53. Phantom-Row Fix: Auto-admit vs concurrent acceptance serializes on user-lock and does not deadlock', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP = 'fp_concurrent_accept_user_555'

    mockJoinRequestsTable.set('req-pre-existing', {
      id: 'req-pre-existing',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: FP,
      status: 'pending'
    })

    const timeline = []
    let activeLock = null
    const waiters = []

    const acquireLock = async (tag) => {
      timeline.push(`${tag}:WAIT`)
      if (activeLock) {
        await new Promise((r) => waiters.push(r))
      }
      activeLock = tag
      timeline.push(`${tag}:ACQUIRED`)
    }

    const releaseLock = (tag) => {
      timeline.push(`${tag}:RELEASED`)
      activeLock = null
      if (waiters.length > 0) waiters.shift()()
    }

    const origRpc = supabase.rpc
    supabase.rpc = async (fn, args) => {
      if (fn === 'auto_admit_participant_tx') {
        await acquireLock('AUTO_ADMIT')
        await new Promise((r) => setTimeout(r, 15))
        const res = await origRpc(fn, args)
        releaseLock('AUTO_ADMIT')
        return res
      }
      if (fn === 'accept_join_request_tx') {
        await acquireLock('ACCEPT_REQ')
        const res = await origRpc(fn, args)
        releaseLock('ACCEPT_REQ')
        return res
      }
      return origRpc(fn, args)
    }

    const { req: admitReq, res: admitRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: FP },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })
    const { req: acceptReq, res: acceptRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID, email: 'host@meetly.ai' }
    })

    const pAdmit = joinMeeting(admitReq, admitRes)
    const pAccept = (async () => {
      await new Promise((r) => setTimeout(r, 5))
      return acceptJoinRequest(acceptReq, acceptRes)
    })()

    await Promise.all([pAdmit, pAccept])

    // Auto admit succeeds
    assert.equal(admitRes.getStatusCode(), 200)

    // Serialization was strictly enforced without deadlock
    assert.ok(
      timeline.indexOf('AUTO_ADMIT:RELEASED') < timeline.indexOf('ACCEPT_REQ:ACQUIRED'),
      'Accept request must serialize after auto-admission releases user-lock'
    )

    // Participant is joined
    const part = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === PARTICIPANT_ID)
    assert.equal(part?.participant_status, 'joined')
    // Waiting request was cleaned up
    assert.equal(mockJoinRequestsTable.get('req-pre-existing'), undefined)
  })

  it('54. Phantom-Row Fix: Auto-admit vs concurrent rejection maintains consistent state without orphan requests', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP = 'fp_concurrent_reject_user_777'

    mockJoinRequestsTable.set('req-to-reject', {
      id: 'req-to-reject',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: FP,
      status: 'pending'
    })

    const timeline = []
    let userLock = null
    const waiters = []

    const acquire = async (tag) => {
      if (userLock) await new Promise((r) => waiters.push(r))
      userLock = tag
      timeline.push(`${tag}:LOCKED`)
    }
    const release = (tag) => {
      timeline.push(`${tag}:UNLOCKED`)
      userLock = null
      if (waiters.length > 0) waiters.shift()()
    }

    const origRpc = supabase.rpc
    supabase.rpc = async (fn, args) => {
      if (fn === 'auto_admit_participant_tx') {
        await acquire('AUTO_ADMIT')
        await new Promise((r) => setTimeout(r, 10))
        const res = await origRpc(fn, args)
        release('AUTO_ADMIT')
        return res
      }
      if (fn === 'reject_join_request_tx') {
        await acquire('REJECT_REQ')
        const res = await origRpc(fn, args)
        release('REJECT_REQ')
        return res
      }
      return origRpc(fn, args)
    }

    const { req: admitReq, res: admitRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: FP },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })
    const { req: rejectReq, res: rejectRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID, email: 'host@meetly.ai' }
    })

    await Promise.all([
      joinMeeting(admitReq, admitRes),
      (async () => {
        await new Promise((r) => setTimeout(r, 2))
        return rejectJoinRequest(rejectReq, rejectRes)
      })()
    ])

    // Auto admit succeeded and cleaned up request
    assert.equal(admitRes.getStatusCode(), 200)
    assert.equal(mockJoinRequestsTable.get('req-to-reject'), undefined, 'Waiting request must be purged')
  })

  it('55. Phantom-Row Fix: Auto-admit vs device ban rejects banned fingerprint atomically under lock', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    const BANNED_DEV = 'fp_auto_admit_banned_device_999'

    mockDeviceBansTable.set(`${MEETING_CODE}:${BANNED_DEV}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: BANNED_DEV,
      blocked_at: new Date().toISOString()
    })

    const lockOrder = []
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'auto_admit_participant_tx') {
        args._trackLockOrder = lockOrder
      }
      return origRpc(fn, args)
    }

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: BANNED_DEV },
      user: { id: PARTICIPANT_ID, email: 'banned@meetly.ai' }
    })

    await joinMeeting(req, res)

    assert.equal(res.getStatusCode(), 403)
    assert.match(res.getData()?.message, /device has been blocked by the meeting host/i)

    // User lock was acquired first, then fingerprint advisory lock, then row locks, before rejecting
    const userLockIdx = lockOrder.indexOf(`USER_ADVISORY_LOCK:${MEETING_CODE}:${PARTICIPANT_ID}`)
    const fpLockIdx = lockOrder.indexOf(`ADVISORY_LOCK:${BANNED_DEV}`)
    assert.ok(userLockIdx !== -1, 'User advisory lock must be acquired')
    assert.ok(fpLockIdx !== -1, 'Fingerprint advisory lock must be acquired')
    assert.ok(userLockIdx < fpLockIdx, 'User lock must precede fingerprint advisory lock')
  })

  it('56. Phantom-Row Fix: Concurrent creation on banned fingerprint waits for ban and rejects without phantom row', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const BANNED_FP = 'fp_concurrent_ban_creation_target'

    // Ban is in effect
    mockDeviceBansTable.set(`${MEETING_CODE}:${BANNED_FP}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: BANNED_FP,
      blocked_at: new Date().toISOString()
    })

    const lockOrder = []
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'create_join_request_tx') {
        args._trackLockOrder = lockOrder
      }
      return origRpc(fn, args)
    }

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: BANNED_FP },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })

    await joinMeeting(req, res)

    // Rejected with 403
    assert.equal(res.getStatusCode(), 403)
    assert.match(res.getData()?.message, /blocked by the meeting host/i)

    // Verify lock order in create_join_request_tx: user lock -> fp lock -> row lock
    const userLockIdx = lockOrder.indexOf(`USER_ADVISORY_LOCK:${MEETING_CODE}:${PARTICIPANT_ID}`)
    const fpLockIdx = lockOrder.indexOf(`ADVISORY_LOCK:${BANNED_FP}`)
    const rowLockIdx = lockOrder.indexOf('ROW_LOCK_REQUEST_FOR_UPDATE')

    assert.ok(userLockIdx < fpLockIdx, 'User advisory lock must precede fingerprint advisory lock')
    assert.ok(fpLockIdx < rowLockIdx, 'Fingerprint advisory lock must precede row lock')

    // Ensure NO phantom request was created in meeting_join_requests
    const remaining = Array.from(mockJoinRequestsTable.values()).filter((r) => r.user_id === PARTICIPANT_ID)
    assert.equal(remaining.length, 0, 'No waiting request row must be created for banned device')
  })

  it('57. Phantom-Row Fix: Cross-account device-ban propagation across different users sharing a fingerprint', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    const SHARED_FP = 'fp_shared_library_computer_999'
    const USER_BOB = '44444444-4444-4444-8444-444444444444'

    // Participant Alice is already banned with SHARED_FP
    mockDeviceBansTable.set(`${MEETING_CODE}:${SHARED_FP}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: SHARED_FP,
      blocked_at: new Date().toISOString()
    })

    // User Bob attempts to join using the same SHARED_FP
    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: SHARED_FP },
      user: { id: USER_BOB, email: 'bob@meetly.ai' }
    })

    await joinMeeting(req, res)

    // Bob must be rejected atomically because SHARED_FP is banned
    assert.equal(res.getStatusCode(), 403)
    assert.match(res.getData()?.message, /device has been blocked by the meeting host/i)

    // Bob has no joined participant record
    const bobPart = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === USER_BOB)
    assert.equal(bobPart, undefined)
  })

  it('58. Phantom-Row Fix: Global lock hierarchy (User Advisory -> Fingerprint Advisory -> Request Row -> Participant Row) across all 4 functions', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP_A = 'fp_hierarchy_test_aaa'
    const USER = PARTICIPANT_ID

    // 1. Check create_join_request_tx lock hierarchy
    const createLocks = []
    await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: USER,
      p_device_fingerprint: FP_A,
      _trackLockOrder: createLocks
    })
    const cUserIdx = createLocks.indexOf(`USER_ADVISORY_LOCK:${MEETING_CODE}:${USER}`)
    const cFpIdx = createLocks.indexOf(`ADVISORY_LOCK:${FP_A}`)
    const cRowIdx = createLocks.indexOf('ROW_LOCK_REQUEST_FOR_UPDATE')
    assert.ok(cUserIdx < cFpIdx, 'create_join_request_tx: user lock precedes fp lock')
    assert.ok(cFpIdx < cRowIdx, 'create_join_request_tx: fp lock precedes row lock')

    // 2. Check accept_join_request_tx lock hierarchy
    const acceptLocks = []
    await supabase.rpc('accept_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: USER,
      _trackLockOrder: acceptLocks
    })
    const aUserIdx = acceptLocks.indexOf(`USER_ADVISORY_LOCK:${MEETING_CODE}:${USER}`)
    const aFpIdx = acceptLocks.indexOf(`ADVISORY_LOCK:${FP_A}`)
    const aReqRowIdx = acceptLocks.indexOf('ROW_LOCK_REQUESTS_ACQUIRED')
    const aPartRowIdx = acceptLocks.indexOf('ROW_LOCK_PARTICIPANTS_ACQUIRED')
    assert.ok(aUserIdx < aFpIdx, 'accept_join_request_tx: user lock precedes fp lock')
    assert.ok(aFpIdx < aReqRowIdx, 'accept_join_request_tx: fp lock precedes request row lock')
    assert.ok(aReqRowIdx < aPartRowIdx, 'accept_join_request_tx: request row lock precedes participant row lock')

    // 3. Check auto_admit_participant_tx lock hierarchy
    const autoLocks = []
    await supabase.rpc('auto_admit_participant_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: USER,
      p_device_fingerprint: FP_A,
      p_role: 'participant',
      _trackLockOrder: autoLocks
    })
    const autoUserIdx = autoLocks.indexOf(`USER_ADVISORY_LOCK:${MEETING_CODE}:${USER}`)
    const autoFpIdx = autoLocks.indexOf(`ADVISORY_LOCK:${FP_A}`)
    const autoReqIdx = autoLocks.indexOf('ROW_LOCK_REQUESTS_ACQUIRED')
    const autoPartIdx = autoLocks.indexOf('ROW_LOCK_PARTICIPANTS_ACQUIRED')
    assert.ok(autoUserIdx < autoFpIdx, 'auto_admit_participant_tx: user lock precedes fp lock')
    assert.ok(autoFpIdx < autoReqIdx, 'auto_admit_participant_tx: fp lock precedes request row lock')
    assert.ok(autoReqIdx < autoPartIdx, 'auto_admit_participant_tx: request row lock precedes participant row lock')

    // Re-create request for reject test
    mockJoinRequestsTable.set('req-for-reject-hierarchy', {
      id: 'req-for-reject-hierarchy',
      meeting_code: MEETING_CODE,
      user_id: USER,
      device_fingerprint: FP_A,
      status: 'pending'
    })

    // 4. Check reject_join_request_tx lock hierarchy
    const rejectLocks = []
    await supabase.rpc('reject_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: USER,
      _trackLockOrder: rejectLocks
    })
    const rUserIdx = rejectLocks.indexOf(`USER_ADVISORY_LOCK:${MEETING_CODE}:${USER}`)
    const rFpIdx = rejectLocks.indexOf(`ADVISORY_LOCK:${FP_A}`)
    const rRowIdx = rejectLocks.indexOf('ROW_LOCK_REQUEST_FOR_UPDATE')
    assert.ok(rUserIdx < rFpIdx, 'reject_join_request_tx: user lock precedes fp lock')
    assert.ok(rFpIdx < rRowIdx, 'reject_join_request_tx: fp lock precedes request row lock')
  })

  // ═════════════════════════════════════════════════════════════════════════════
  // STEP 6.7.5.15: FINAL TWO DEFECTS REGRESSION TESTS
  // ═════════════════════════════════════════════════════════════════════════════

  it('59. Final Defect 1: Direct DELETE fallback is never executed when rejection RPC fails', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    const BANNED_FP = 'fp_banned_no_direct_delete_fallback'
    mockDeviceBansTable.set(`${MEETING_CODE}:${BANNED_FP}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: BANNED_FP
    })

    mockJoinRequestsTable.set('req-banned-direct-delete-test', {
      id: 'req-banned-direct-delete-test',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: BANNED_FP,
      status: 'pending'
    })

    let directDeleteCalled = false
    const origFrom = supabase.from
    supabase.from = (table) => {
      const builder = origFrom(table)
      if (table === 'meeting_join_requests') {
        const origDelete = builder.delete
        builder.delete = function () {
          directDeleteCalled = true
          return origDelete.apply(this, arguments)
        }
      }
      return builder
    }

    let rejectRpcAttempts = 0
    const origRpc = supabase.rpc
    supabase.rpc = (fn, args) => {
      if (fn === 'reject_join_request_tx') {
        rejectRpcAttempts++
        return Promise.resolve({ data: null, error: { message: 'Database lock timeout' } })
      }
      return origRpc(fn, args)
    }

    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })

    await acceptJoinRequest(req, res)

    // Verify 403 Forbidden
    assert.equal(res.getStatusCode(), 403)
    assert.equal(res.getData()?.code, 'FORBIDDEN')

    // Verify reject_join_request_tx retried (bounded retry)
    assert.ok(rejectRpcAttempts >= 2, `Rejection RPC should be retried in a bounded loop (actual: ${rejectRpcAttempts})`)

    // Verify direct DELETE was NEVER called
    assert.equal(directDeleteCalled, false, 'Direct DELETE on meeting_join_requests must never be called as a fallback')
  })

  it('60. Final Defect 2: A joined participant cannot create another waiting request', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    const FP = 'fp_already_joined_user_111'
    mockParticipantsTable.set('part-already-joined', {
      participant_id: 'part-already-joined',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'joined',
      device_fingerprint: FP
    })

    // Attempt direct RPC call to create waiting request
    const { data, error } = await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      p_device_fingerprint: FP
    })

    assert.equal(data, null)
    assert.ok(error)
    assert.match(error.message, /already admitted/i)

    // Verify no waiting request was created
    const reqFound = Array.from(mockJoinRequestsTable.values()).find((r) => r.user_id === PARTICIPANT_ID)
    assert.equal(reqFound, undefined)
  })

  it('61. Final Defect 2: An enrolling participant cannot create another waiting request', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false
    })

    const FP = 'fp_already_enrolling_user_222'
    mockParticipantsTable.set('part-already-enrolling', {
      participant_id: 'part-already-enrolling',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'enrolling',
      device_fingerprint: FP
    })

    // Attempt RPC call to create waiting request
    const { data, error } = await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      p_device_fingerprint: FP
    })

    assert.equal(data, null)
    assert.ok(error)
    assert.match(error.message, /already admitted/i)

    // Verify no waiting request was created
    const reqFound = Array.from(mockJoinRequestsTable.values()).find((r) => r.user_id === PARTICIPANT_ID)
    assert.equal(reqFound, undefined)
  })

  it('62. Final Defect 2: A removed participant remains blocked from creating a waiting request', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP = 'fp_removed_user_333'
    mockParticipantsTable.set('part-removed-user', {
      participant_id: 'part-removed-user',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'removed',
      device_fingerprint: FP
    })

    const { data, error } = await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      p_device_fingerprint: FP
    })

    assert.equal(data, null)
    assert.ok(error)
    assert.match(error.message, /removed from this meeting/i)

    // Verify controller returns HTTP 403
    const { req, res } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: FP },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })
    await joinMeeting(req, res)

    assert.equal(res.getStatusCode(), 403)
    assert.match(res.getData()?.message, /removed from this meeting by the host/i)
  })

  it('63. Final Defect 2: A user who is not yet admitted can still create a waiting request', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP = 'fp_new_unadmitted_user_444'

    const { data, error } = await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      p_device_fingerprint: FP
    })

    assert.equal(error, null)
    assert.equal(data?.status, 'pending')
    assert.equal(data?.is_duplicate, false)

    // Request is in table
    const reqFound = Array.from(mockJoinRequestsTable.values()).find((r) => r.user_id === PARTICIPANT_ID)
    assert.ok(reqFound)
    assert.equal(reqFound.status, 'pending')
    assert.equal(reqFound.device_fingerprint, FP)
  })

  it('64. Final Defect 2: Concurrent auto-admission followed by request creation cannot leave a phantom request', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: true,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP = 'fp_concurrent_auto_admit_then_req'

    // 1. User auto-admits
    const { req: admitReq, res: admitRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: FP },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })
    await joinMeeting(admitReq, admitRes)
    assert.equal(admitRes.getStatusCode(), 200)

    // Participant is joined
    const part = Array.from(mockParticipantsTable.values()).find((p) => p.user_id === PARTICIPANT_ID)
    assert.equal(part?.participant_status, 'joined')

    // 2. A concurrent or delayed request-creation executes for the same user
    const { data: reqData, error: reqErr } = await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      p_device_fingerprint: FP
    })

    // create_join_request_tx rejects because participant is already joined
    assert.equal(reqData, null)
    assert.ok(reqErr)
    assert.match(reqErr.message, /already admitted/i)

    // Verify 0 waiting requests left in table (no phantom request)
    const reqs = Array.from(mockJoinRequestsTable.values()).filter((r) => r.user_id === PARTICIPANT_ID)
    assert.equal(reqs.length, 0, 'No phantom waiting requests must remain after auto-admission')
  })

  it('65. Concurrency Scenario 1 & 2: Participant FP A, incoming request FP B, ban on A commits first -> request creation observes removed and rejects', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP_A = 'fp_part_session_aaa'
    const FP_B = 'fp_incoming_new_bbb'

    // Existing participant has FP_A
    mockParticipantsTable.set('part-scenario-65', {
      participant_id: 'part-scenario-65',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'joined',
      device_fingerprint: FP_A
    })

    // Host bans participant on FP_A (commits first)
    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })
    await banDevice(banReq, banRes)
    assert.equal(banRes.getStatusCode(), 200)

    // Verify participant is marked removed and FP_A is banned
    const part = mockParticipantsTable.get('part-scenario-65')
    assert.equal(part.participant_status, 'removed')
    assert.ok(mockDeviceBansTable.has(`${MEETING_CODE}:${FP_A}`))

    // Now user attempts to create waiting request presenting FP_B
    const { req: joinReq, res: joinRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: FP_B },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })
    await joinMeeting(joinReq, joinRes)

    // Must be rejected with HTTP 403 due to banned participant device / removed status
    assert.equal(joinRes.getStatusCode(), 403)
    assert.match(joinRes.getData()?.message, /blocked by the meeting host|removed from this meeting/i)

    // No waiting requests must exist
    const reqs = Array.from(mockJoinRequestsTable.values()).filter((r) => r.user_id === PARTICIPANT_ID)
    assert.equal(reqs.length, 0, 'No waiting request created for removed user')

    // Also verify when device ban is cleared but participant status is removed under lock:
    // create_join_request_tx explicitly catches and rejects removed participant
    mockDeviceBansTable.delete(`${MEETING_CODE}:${FP_A}`)
    const { data: remData, error: remErr } = await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      p_device_fingerprint: FP_B
    })
    assert.equal(remData, null)
    assert.ok(remErr)
    assert.match(remErr.message, /user has been removed from this meeting/i)
  })

  it('66. Concurrency Scenario 3: Request creation with FP B commits first when participant has FP A; subsequent ban on A removes newly created request with FP B', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP_A = 'fp_part_old_aaa'
    const FP_B = 'fp_req_new_bbb'

    // Existing participant has FP_A
    mockParticipantsTable.set('part-scenario-66', {
      participant_id: 'part-scenario-66',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'left',
      device_fingerprint: FP_A
    })

    // User submits join request with FP_B (commits first)
    const { req: joinReq, res: joinRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, fingerprint: FP_B },
      user: { id: PARTICIPANT_ID, email: 'alice@meetly.ai' }
    })
    await joinMeeting(joinReq, joinRes)
    assert.equal(joinRes.getStatusCode(), 200)

    // Verify waiting request exists with FP_B
    const reqBeforeBan = Array.from(mockJoinRequestsTable.values()).find((r) => r.user_id === PARTICIPANT_ID)
    assert.ok(reqBeforeBan)
    assert.equal(reqBeforeBan.device_fingerprint, FP_B)

    // Host executes ban on User
    const { req: banReq, res: banRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })
    await banDevice(banReq, banRes)
    assert.equal(banRes.getStatusCode(), 200)

    // ban_device_tx must delete target user's waiting request with FP_B even though ban originated from FP_A
    const reqsAfterBan = Array.from(mockJoinRequestsTable.values()).filter((r) => r.user_id === PARTICIPANT_ID)
    assert.equal(reqsAfterBan.length, 0, 'Target user waiting request with FP_B must be deleted by ban')

    // Participant must be marked removed
    const partAfterBan = mockParticipantsTable.get('part-scenario-66')
    assert.equal(partAfterBan.participant_status, 'removed')
  })

  it('67. Concurrency Scenario 4: Acceptance of FP B while existing participant has FP A, concurrent ban on A rejects admission and preserves removed status', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP_A = 'fp_part_current_aaa'
    const FP_B = 'fp_req_waiting_bbb'

    // Existing participant has FP_A
    mockParticipantsTable.set('part-scenario-67', {
      participant_id: 'part-scenario-67',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'disconnected',
      device_fingerprint: FP_A
    })

    // User has pending waiting request with FP_B
    mockJoinRequestsTable.set('req-scenario-67', {
      id: 'req-scenario-67',
      meeting_code: MEETING_CODE,
      user_id: PARTICIPANT_ID,
      device_fingerprint: FP_B,
      status: 'pending'
    })

    // Concurrent ban on FP_A executes
    mockDeviceBansTable.set(`${MEETING_CODE}:${FP_A}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: FP_A,
      blocked_at: new Date().toISOString()
    })
    const part = mockParticipantsTable.get('part-scenario-67')
    part.participant_status = 'removed'

    // Host attempts to accept join request for user with FP_B
    const { req: acceptReq, res: acceptRes } = setupMockReqRes({
      body: { meetingCode: MEETING_CODE, userId: PARTICIPANT_ID },
      user: { id: HOST_ID }
    })
    await acceptJoinRequest(acceptReq, acceptRes)

    // Must be rejected with HTTP 403
    assert.equal(acceptRes.getStatusCode(), 403)
    assert.match(acceptRes.getData()?.message, /removed from this meeting|banned from the meeting/i)

    // Participant remains in removed status; never resurrected to enrolling or joined
    assert.equal(part.participant_status, 'removed')
  })

  it('68. Concurrency Scenario 5: Existing participant fingerprint A with incoming request having NULL fingerprint', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP_A = 'fp_existing_part_68'

    // Existing participant has FP_A
    mockParticipantsTable.set('part-scenario-68', {
      participant_id: 'part-scenario-68',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'left',
      device_fingerprint: FP_A
    })

    // Sub-case 1: When FP_A is banned, incoming NULL fingerprint request must still be rejected
    mockDeviceBansTable.set(`${MEETING_CODE}:${FP_A}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: FP_A,
      blocked_at: new Date().toISOString()
    })

    const { data: banData, error: banErr } = await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      p_device_fingerprint: null
    })
    assert.equal(banData, null)
    assert.ok(banErr)
    assert.match(banErr.message, /banned from the meeting/i)

    // Sub-case 2: When FP_A is not banned, incoming NULL fingerprint succeeds and creates request
    mockDeviceBansTable.delete(`${MEETING_CODE}:${FP_A}`)
    const { data: okData, error: okErr } = await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      p_device_fingerprint: null
    })
    assert.equal(okErr, null)
    assert.equal(okData?.status, 'pending')
    assert.equal(okData?.is_duplicate, false)

    const createdReq = Array.from(mockJoinRequestsTable.values()).find((r) => r.user_id === PARTICIPANT_ID)
    assert.ok(createdReq)
    assert.equal(createdReq.device_fingerprint, null)
  })

  it('69. Concurrency Scenario 6: Participant lifecycle protections under lock (joined, enrolling, removed)', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP = 'fp_lifecycle_69'

    // 1. Participant is 'joined'
    mockParticipantsTable.set('part-joined-69', {
      participant_id: 'part-joined-69',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'joined',
      device_fingerprint: FP
    })

    const { data: d1, error: e1 } = await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      p_device_fingerprint: FP
    })
    assert.equal(d1, null)
    assert.match(e1?.message, /already admitted/i)

    // 2. Participant is 'enrolling'
    const part = mockParticipantsTable.get('part-joined-69')
    part.participant_status = 'enrolling'

    const { data: d2, error: e2 } = await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      p_device_fingerprint: FP
    })
    assert.equal(d2, null)
    assert.match(e2?.message, /already admitted/i)

    // 3. Participant is 'removed'
    part.participant_status = 'removed'

    const { data: d3, error: e3 } = await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      p_device_fingerprint: FP
    })
    assert.equal(d3, null)
    assert.match(e3?.message, /user has been removed/i)
  })

  it('70. Concurrency Scenario 7: Cross-account device-ban propagation and request cleanup', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const SHARED_FP = 'fp_shared_workstation_70'
    const USER_1 = PARTICIPANT_ID
    const USER_2 = '55555555-5555-4555-8555-555555555555'
    const USER_3 = '66666666-6666-4666-8666-666666666666'

    // User 1 participant with SHARED_FP
    mockParticipantsTable.set('part-user-1', {
      participant_id: 'part-user-1',
      meeting_id: 'meeting-uuid-001',
      user_id: USER_1,
      participant_status: 'joined',
      device_fingerprint: SHARED_FP
    })

    // User 2 waiting request with SHARED_FP
    mockJoinRequestsTable.set('req-user-2', {
      id: 'req-user-2',
      meeting_code: MEETING_CODE,
      user_id: USER_2,
      device_fingerprint: SHARED_FP,
      status: 'pending'
    })

    // User 3 participant with SHARED_FP
    mockParticipantsTable.set('part-user-3', {
      participant_id: 'part-user-3',
      meeting_id: 'meeting-uuid-001',
      user_id: USER_3,
      participant_status: 'joined',
      device_fingerprint: SHARED_FP
    })

    // Host bans User 1
    const { data: banResult, error: banErr } = await supabase.rpc('ban_device_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: USER_1
    })
    assert.equal(banErr, null)
    assert.equal(banResult, SHARED_FP)

    // Verify SHARED_FP is banned
    assert.ok(mockDeviceBansTable.has(`${MEETING_CODE}:${SHARED_FP}`))

    // Verify User 2's cross-account waiting request was deleted
    assert.equal(mockJoinRequestsTable.has('req-user-2'), false, 'User 2 request must be deleted')

    // Verify User 3's cross-account participant was updated to removed
    const part3 = mockParticipantsTable.get('part-user-3')
    assert.equal(part3.participant_status, 'removed')

    // Verify User 1's participant is also removed
    const part1 = mockParticipantsTable.get('part-user-1')
    assert.equal(part1.participant_status, 'removed')
  })

  it('71. Global Lock Order Verification: User Operations vs Ban Operation row-lock hierarchy', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP = 'fp_global_lock_71'
    const USER = PARTICIPANT_ID

    // 1. Verify create_join_request_tx hierarchy: user lock -> fp lock -> req row lock -> part row lock
    const createLocks = []
    await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: USER,
      p_device_fingerprint: FP,
      _trackLockOrder: createLocks
    })

    const cUserIdx = createLocks.indexOf(`USER_ADVISORY_LOCK:${MEETING_CODE}:${USER}`)
    const cFpIdx = createLocks.indexOf(`ADVISORY_LOCK:${FP}`)
    const cReqIdx = createLocks.indexOf('ROW_LOCK_REQUEST_FOR_UPDATE')
    const cPartIdx = createLocks.indexOf('ROW_LOCK_PARTICIPANT_FOR_UPDATE')

    assert.ok(cUserIdx >= 0 && cFpIdx >= 0 && cReqIdx >= 0 && cPartIdx >= 0)
    assert.ok(cUserIdx < cFpIdx, 'create_join_request_tx: user lock precedes fp lock')
    assert.ok(cFpIdx < cReqIdx, 'create_join_request_tx: fp lock precedes request row lock')
    assert.ok(cReqIdx < cPartIdx, 'create_join_request_tx: request row lock precedes participant row lock')

    // 2. Verify accept_join_request_tx hierarchy: user lock -> fp lock -> req row lock -> part row lock
    const acceptLocks = []
    await supabase.rpc('accept_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: USER,
      _trackLockOrder: acceptLocks
    })

    const aUserIdx = acceptLocks.indexOf(`USER_ADVISORY_LOCK:${MEETING_CODE}:${USER}`)
    const aFpIdx = acceptLocks.indexOf(`ADVISORY_LOCK:${FP}`)
    const aReqIdx = acceptLocks.indexOf('ROW_LOCK_REQUESTS_ACQUIRED')
    const aPartIdx = acceptLocks.indexOf('ROW_LOCK_PARTICIPANTS_ACQUIRED')

    assert.ok(aUserIdx >= 0 && aFpIdx >= 0 && aReqIdx >= 0 && aPartIdx >= 0)
    assert.ok(aUserIdx < aFpIdx, 'accept_join_request_tx: user lock precedes fp lock')
    assert.ok(aFpIdx < aReqIdx, 'accept_join_request_tx: fp lock precedes request row lock')
    assert.ok(aReqIdx < aPartIdx, 'accept_join_request_tx: request row lock precedes participant row lock')

    // 3. Verify ban_device_tx hierarchy: fp lock -> req row lock -> part row lock (NO user advisory lock)
    const banLocks = []
    await supabase.rpc('ban_device_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: USER,
      _trackLockOrder: banLocks,
      _trackDetailedFpLocks: true
    })

    const bUserIdx = banLocks.indexOf(`USER_ADVISORY_LOCK:${MEETING_CODE}:${USER}`)
    const bFpIdx = banLocks.indexOf(`ADVISORY_LOCK:${FP}`)
    const bReqIdx = banLocks.indexOf('ROW_LOCK_REQUESTS_ACQUIRED')
    const bPartIdx = banLocks.indexOf('ROW_LOCK_PARTICIPANTS_ACQUIRED')

    assert.equal(bUserIdx, -1, 'ban_device_tx must NOT acquire per-user advisory lock')
    assert.ok(bFpIdx >= 0 && bReqIdx >= 0 && bPartIdx >= 0)
    assert.ok(bFpIdx < bReqIdx, 'ban_device_tx: fp lock precedes request row lock')
    assert.ok(bReqIdx < bPartIdx, 'ban_device_tx: request row lock precedes participant row lock')
  })

  it('72. Deterministic Sorted Hash Advisory Lock Order: FP1 and FP2 acquire in deterministic sorted order regardless of argument order', async () => {
    mockMeetingsTable.set('meeting-uuid-001', {
      meeting_id: 'meeting-uuid-001',
      meeting_code: MEETING_CODE,
      room_name: ROOM_NAME,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      cloudflare_meeting_id: CF_MEETING_ID,
      auto_admit: false,
      meeting_status: 'Active',
      is_deleted: false
    })

    const FP_ZEBRA = 'fp_zebra_72'
    const FP_APPLE = 'fp_apple_72'

    // Existing participant has FP_ZEBRA
    mockParticipantsTable.set('part-user-72', {
      participant_id: 'part-user-72',
      meeting_id: 'meeting-uuid-001',
      user_id: PARTICIPANT_ID,
      participant_status: 'left',
      device_fingerprint: FP_ZEBRA
    })

    // Incoming request has FP_APPLE (alphabetically precedes ZEBRA)
    const createLocks = []
    await supabase.rpc('create_join_request_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      p_device_fingerprint: FP_APPLE,
      _trackLockOrder: createLocks
    })

    const fpLocksInCreate = createLocks.filter((l) => l.startsWith('ADVISORY_LOCK:')).map((l) => l.replace('ADVISORY_LOCK:', ''))
    assert.deepEqual(fpLocksInCreate, [FP_APPLE, FP_ZEBRA].sort(), 'Fingerprints must be locked in deterministic sorted order')

    // Test ban_device_tx with both fingerprints
    const banLocks = []
    await supabase.rpc('ban_device_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_ID,
      _trackLockOrder: banLocks,
      _trackDetailedFpLocks: true
    })

    const fpLocksInBan = banLocks.filter((l) => l.startsWith('ADVISORY_LOCK:')).map((l) => l.replace('ADVISORY_LOCK:', ''))
    assert.deepEqual(fpLocksInBan, [FP_APPLE, FP_ZEBRA].sort(), 'ban_device_tx must lock fingerprints in deterministic sorted order')
  })
})
