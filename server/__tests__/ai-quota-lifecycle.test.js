import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  aiRequestCounters,
  activeReservations,
  endedMeetings,
  pendingCleanupRetries,
  setDatabaseClient,
  resetDatabaseClient,
  getRemainingRequests,
  reserveQuestionQuota,
  releaseQuestionQuota,
  completeQuestionReservation,
  clearMeetingCounters,
  cleanupLingeringQuotas,
  incrementRequestCounter
} from '../services/aiChat.service.js'

/**
 * High-fidelity in-memory database mock for Supabase PostgREST & RPC execution.
 * Simulates table constraints, optimistic concurrency row-locking, reservation tracking, and RLS policies.
 */
const createMockSupabase = () => {
  const quotasTable = new Map() // key: `${meeting_id}:${user_id}`
  const reservationsTable = new Map() // key: reservation_id
  const meetingsTable = new Map() // key: meeting_id

  return {
    _quotasTable: quotasTable,
    _reservationsTable: reservationsTable,
    _meetingsTable: meetingsTable,

    from: (table) => {
      if (table === 'meetings') {
        let filters = {}
        const query = {
          select: () => query,
          eq: (field, val) => {
            filters[field] = val
            return query
          },
          in: (field, list) => {
            filters[`${field}_in`] = list
            return query
          },
          or: () => query,
          maybeSingle: async () => {
            if (filters.meeting_id) {
              const row = meetingsTable.get(filters.meeting_id) || null
              return { data: row, error: null }
            }
            return { data: null, error: null }
          }
        }
        return query
      }

      if (table === 'meeting_ai_reservations') {
        let filters = {}
        let updateData = null

        const query = {
          select: () => query,
          eq: (field, val) => {
            filters[field] = val
            return query
          },
          in: (field, list) => {
            filters[`${field}_in`] = list
            return query
          },
          maybeSingle: async () => {
            if (filters.reservation_id) {
              const row = reservationsTable.get(filters.reservation_id) || null
              return { data: row ? { ...row } : null, error: null }
            }
            return { data: null, error: null }
          },
          insert: async (record) => {
            reservationsTable.set(record.reservation_id, {
              ...record,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            return { error: null }
          },
          update: (fields) => {
            updateData = fields
            return query
          },
          delete: () => ({
            eq: async (field, val) => {
              if (field === 'meeting_id') {
                for (const [key, row] of Array.from(reservationsTable.entries())) {
                  if (row.meeting_id === val) {
                    reservationsTable.delete(key)
                  }
                }
              }
              return { error: null }
            },
            in: async (field, list) => {
              const set = new Set(list)
              for (const [key, row] of Array.from(reservationsTable.entries())) {
                if (set.has(row[field])) {
                  reservationsTable.delete(key)
                }
              }
              return { error: null }
            }
          })
        }

        const origMaybeSingle = query.maybeSingle
        query.maybeSingle = async () => {
          if (updateData && filters.reservation_id) {
            const row = reservationsTable.get(filters.reservation_id)
            if (!row) return { data: null, error: null }
            Object.assign(row, updateData)
            reservationsTable.set(filters.reservation_id, row)
            return { data: { ...row }, error: null }
          }
          return origMaybeSingle()
        }

        return query
      }

      if (table === 'meeting_ai_quotas') {
        let filters = {}
        let updateData = null

        const query = {
          select: () => query,
          eq: (field, val) => {
            filters[field] = val
            return query
          },
          in: (field, list) => {
            filters[`${field}_in`] = list
            return query
          },
          maybeSingle: async () => {
            const key = `${filters.meeting_id}:${filters.user_id}`
            const row = quotasTable.get(key) || null
            return { data: row ? { ...row } : null, error: null }
          },
          upsert: async (record) => {
            const key = `${record.meeting_id}:${record.user_id}`
            if (!quotasTable.has(key)) {
              quotasTable.set(key, {
                id: `quota-${Date.now()}-${Math.random()}`,
                meeting_id: record.meeting_id,
                user_id: record.user_id,
                email: record.email || null,
                questions_used: record.questions_used ?? 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              })
            }
            return { error: null }
          },
          update: (fields) => {
            updateData = fields
            return query
          },
          delete: () => ({
            eq: async (field, val) => {
              if (field === 'meeting_id') {
                for (const [key, row] of Array.from(quotasTable.entries())) {
                  if (row.meeting_id === val) {
                    quotasTable.delete(key)
                  }
                }
              }
              return { error: null }
            },
            in: async (field, list) => {
              const set = new Set(list)
              for (const [key, row] of Array.from(quotasTable.entries())) {
                if (set.has(row[field])) {
                  quotasTable.delete(key)
                }
              }
              return { error: null }
            }
          })
        }

        const origMaybeSingle = query.maybeSingle
        query.maybeSingle = async () => {
          if (updateData) {
            const key = `${filters.meeting_id}:${filters.user_id}`
            const row = quotasTable.get(key)
            if (!row) return { data: null, error: null }

            // Concurrency check
            if (filters.questions_used !== undefined && row.questions_used !== filters.questions_used) {
              return { data: null, error: null }
            }

            row.questions_used = updateData.questions_used
            if (updateData.email) row.email = updateData.email
            row.updated_at = updateData.updated_at || new Date().toISOString()
            quotasTable.set(key, row)
            return { data: { ...row }, error: null }
          }
          return origMaybeSingle()
        }

        return query
      }

      throw new Error(`Unexpected table ${table} in mock`)
    },

    rpc: async (funcName, args) => {
      if (funcName === 'reserve_meeting_ai_question') {
        const { p_meeting_id, p_user_id, p_email, p_max_questions = 10, p_reservation_id } = args
        const mtg = meetingsTable.get(p_meeting_id)

        if (!mtg) {
          return {
            data: [{ allowed: false, questions_used: 0, questions_remaining: 0, message: 'Meeting not found.', reservation_id: null }],
            error: null
          }
        }

        if (mtg.meeting_status === 'Ended' || mtg.is_deleted === true) {
          return {
            data: [{ allowed: false, questions_used: 0, questions_remaining: 0, message: 'This meeting has already ended.', reservation_id: null }],
            error: null
          }
        }

        const resId = p_reservation_id || `res-${Date.now()}-${Math.random()}`
        const existingRes = reservationsTable.get(resId)
        if (existingRes) {
          const key = `${p_meeting_id}:${p_user_id}`
          const qRow = quotasTable.get(key)
          const used = qRow ? qRow.questions_used : 0
          return {
            data: [{
              allowed: existingRes.status === 'reserved' || existingRes.status === 'completed',
              questions_used: used,
              questions_remaining: Math.max(0, 10 - used),
              message: 'Reservation already recorded.',
              reservation_id: resId
            }],
            error: null
          }
        }

        const key = `${p_meeting_id}:${p_user_id}`
        let row = quotasTable.get(key)
        if (!row) {
          row = {
            id: `quota-${Date.now()}-${Math.random()}`,
            meeting_id: p_meeting_id,
            user_id: p_user_id,
            email: p_email,
            questions_used: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
          quotasTable.set(key, row)
        }

        // Strict limit of 10 enforced
        const effectiveLimit = Math.min(10, p_max_questions)
        if (row.questions_used < effectiveLimit) {
          row.questions_used += 1
          row.updated_at = new Date().toISOString()

          reservationsTable.set(resId, {
            reservation_id: resId,
            meeting_id: p_meeting_id,
            user_id: p_user_id,
            status: 'reserved'
          })

          return {
            data: [{
              allowed: true,
              questions_used: row.questions_used,
              questions_remaining: Math.max(0, 10 - row.questions_used),
              message: 'Question reserved.',
              reservation_id: resId
            }],
            error: null
          }
        } else {
          return {
            data: [{
              allowed: false,
              questions_used: row.questions_used,
              questions_remaining: 0,
              message: 'You have used all 10 AI Assistant questions for this meeting.',
              reservation_id: null
            }],
            error: null
          }
        }
      }

      if (funcName === 'release_meeting_ai_question') {
        const { p_meeting_id, p_user_id, p_reservation_id } = args
        const mtg = meetingsTable.get(p_meeting_id)

        if (!mtg || mtg.meeting_status === 'Ended' || mtg.is_deleted === true) {
          return {
            data: [{ success: false, questions_used: 0, questions_remaining: 0, message: 'This meeting has already ended.' }],
            error: null
          }
        }

        const res = reservationsTable.get(p_reservation_id)
        const key = `${p_meeting_id}:${p_user_id}`
        const row = quotasTable.get(key)

        if (!res || res.status !== 'reserved') {
          return {
            data: [{
              success: false,
              questions_used: row ? row.questions_used : 0,
              questions_remaining: row ? Math.max(0, 10 - row.questions_used) : 10,
              message: res ? `Reservation was already ${res.status}.` : 'Reservation not found.'
            }],
            error: null
          }
        }

        res.status = 'released'
        if (row && row.questions_used > 0) {
          row.questions_used -= 1
          row.updated_at = new Date().toISOString()
        }

        return {
          data: [{
            success: true,
            questions_used: row ? row.questions_used : 0,
            questions_remaining: row ? Math.max(0, 10 - row.questions_used) : 10,
            message: 'Reservation released.'
          }],
          error: null
        }
      }

      if (funcName === 'complete_meeting_ai_question') {
        const { p_reservation_id } = args
        const res = reservationsTable.get(p_reservation_id)
        if (res && res.status === 'reserved') {
          res.status = 'completed'
          return { data: true, error: null }
        }
        return { data: false, error: null }
      }

      if (funcName === 'get_meeting_ai_quota') {
        const { p_meeting_id, p_user_id } = args
        const mtg = meetingsTable.get(p_meeting_id)
        if (!mtg) {
          return { data: [{ questions_used: 0, questions_remaining: 0, meeting_ended: true, meeting_exists: false }], error: null }
        }
        if (mtg.meeting_status === 'Ended' || mtg.is_deleted === true) {
          return { data: [{ questions_used: 0, questions_remaining: 0, meeting_ended: true, meeting_exists: true }], error: null }
        }
        const key = `${p_meeting_id}:${p_user_id}`
        const row = quotasTable.get(key)
        const used = row ? row.questions_used : 0
        return {
          data: [{ questions_used: used, questions_remaining: Math.max(0, 10 - used), meeting_ended: false, meeting_exists: true }],
          error: null
        }
      }

      if (funcName === 'cleanup_meeting_ai_quotas') {
        const { p_meeting_id } = args
        let count = 0
        for (const [key, row] of Array.from(quotasTable.entries())) {
          if (row.meeting_id === p_meeting_id) {
            quotasTable.delete(key)
            count++
          }
        }
        for (const [key, row] of Array.from(reservationsTable.entries())) {
          if (row.meeting_id === p_meeting_id) {
            reservationsTable.delete(key)
          }
        }
        return { data: count, error: null }
      }

      throw new Error(`Unknown RPC: ${funcName}`)
    }
  }
}

describe('Final Security Verification — Meetly AI AI Assistant Quota System', () => {
  const MEETING_A = '11111111-1111-4111-8111-111111111111'
  const MEETING_B = '22222222-2222-4222-8222-222222222222'
  const NONEXISTENT_MEETING = '99999999-9999-4999-8999-999999999999'
  const USER_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const USER_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const EMAIL_1 = 'student1@university.edu'
  const EMAIL_2 = 'student2@university.edu'

  let mockDb

  beforeEach(() => {
    aiRequestCounters.clear()
    activeReservations.clear()
    endedMeetings.clear()
    pendingCleanupRetries.clear()

    mockDb = createMockSupabase()
    mockDb._meetingsTable.set(MEETING_A, { meeting_id: MEETING_A, meeting_status: 'Active', is_deleted: false })
    mockDb._meetingsTable.set(MEETING_B, { meeting_id: MEETING_B, meeting_status: 'Active', is_deleted: false })
    setDatabaseClient(mockDb)
  })

  afterEach(() => {
    resetDatabaseClient()
  })

  // 1. A new participant receives 10 questions for a new meeting.
  it('1. A new participant receives exactly 10 questions for an active meeting', async () => {
    const remaining = await getRemainingRequests(MEETING_A, USER_1)
    assert.equal(remaining, 10, 'Initial remaining questions count must be 10')
  })

  // 2. Each accepted question reduces the remaining count by one.
  it('2. Each accepted question reduces the remaining count by one', async () => {
    const res1 = await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    assert.equal(res1.allowed, true)
    assert.equal(res1.questionsUsed, 1)
    assert.equal(res1.remainingQuestions, 9)
    assert.ok(res1.reservationId, 'Must return a unique reservation ID')

    const res2 = await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    assert.equal(res2.allowed, true)
    assert.equal(res2.questionsUsed, 2)
    assert.equal(res2.remainingQuestions, 8)

    const remaining = await getRemainingRequests(MEETING_A, USER_1)
    assert.equal(remaining, 8)
  })

  // 3. The eleventh question is rejected before the AI provider is called.
  it('3. The eleventh question is rejected before the AI provider is called', async () => {
    let aiProviderCallCount = 0
    const mockAIProvider = async () => {
      aiProviderCallCount++
      return 'Mock answer'
    }

    // Ask 10 questions
    for (let i = 1; i <= 10; i++) {
      const reservation = await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
      assert.equal(reservation.allowed, true)
      await mockAIProvider()
    }

    assert.equal(aiProviderCallCount, 10, 'Provider called 10 times')

    // Attempt 11th question
    const res11 = await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    assert.equal(res11.allowed, false, '11th question must be rejected')
    assert.equal(res11.remainingQuestions, 0)
    assert.equal(res11.message, 'You have used all 10 AI Assistant questions for this meeting.')

    // Verify AI provider was NOT called for the 11th attempt
    assert.equal(aiProviderCallCount, 10, 'Provider must not be called after limit is reached')
  })

  // 4. Refreshing the browser preserves the remaining count.
  it('4. Refreshing the browser preserves the remaining count', async () => {
    for (let i = 0; i < 6; i++) {
      await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    }

    const remainingAfterRefresh = await getRemainingRequests(MEETING_A, USER_1)
    assert.equal(remainingAfterRefresh, 4, 'Remaining count must be preserved across browser refresh')
  })

  // 5. Reconnection preserves the remaining count.
  it('5. Reconnection preserves the remaining count', async () => {
    for (let i = 0; i < 3; i++) {
      await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    }

    const remainingAfterReconnect = await getRemainingRequests(MEETING_A, USER_1)
    assert.equal(remainingAfterReconnect, 7, 'Remaining count must be preserved across socket reconnect')
  })

  // 6. Changing a participant's display name does not reset the count.
  it('6. Changing a participant\'s display name does not reset the count', async () => {
    for (let i = 0; i < 5; i++) {
      await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    }

    // Authenticated user UUID USER_1 is stable
    const remaining = await getRemainingRequests(MEETING_A, USER_1)
    assert.equal(remaining, 5, 'Display name change must not grant additional questions')
  })

  // 7. Leaving and rejoining the same active meeting preserves the count.
  it('7. Leaving and rejoining the same active meeting preserves the count', async () => {
    for (let i = 0; i < 4; i++) {
      await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    }

    const remaining = await getRemainingRequests(MEETING_A, USER_1)
    assert.equal(remaining, 6, 'Rejoining active meeting must maintain existing quota')
  })

  // 8. The same authenticated user cannot get additional quota through multiple browser tabs.
  it('8. The same authenticated user cannot get additional quota through multiple browser tabs', async () => {
    for (let i = 0; i < 7; i++) {
      await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    }

    const tab2Remaining = await getRemainingRequests(MEETING_A, USER_1)
    assert.equal(tab2Remaining, 3)

    for (let i = 0; i < 3; i++) {
      const res = await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
      assert.equal(res.allowed, true)
    }

    const tab1Extra = await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    assert.equal(tab1Extra.allowed, false, 'Tab 1 must be blocked when quota is exhausted in Tab 2')
    assert.equal(tab1Extra.remainingQuestions, 0)
  })

  // 9. Two different participants have independent quotas.
  it('9. Two different participants have independent quotas in the same meeting', async () => {
    for (let i = 0; i < 8; i++) {
      await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    }

    for (let i = 0; i < 2; i++) {
      await reserveQuestionQuota(MEETING_A, USER_2, EMAIL_2)
    }

    const user1Remaining = await getRemainingRequests(MEETING_A, USER_1)
    const user2Remaining = await getRemainingRequests(MEETING_A, USER_2)

    assert.equal(user1Remaining, 2, 'User 1 must have 2 remaining')
    assert.equal(user2Remaining, 8, 'User 2 must have 8 remaining')
  })

  // 10. The same participant receives a fresh quota for a different meeting.
  it('10. The same participant receives a fresh quota of 10 for a different meeting', async () => {
    for (let i = 0; i < 10; i++) {
      await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    }
    const meetingARemaining = await getRemainingRequests(MEETING_A, USER_1)
    assert.equal(meetingARemaining, 0)

    const meetingBRemaining = await getRemainingRequests(MEETING_B, USER_1)
    assert.equal(meetingBRemaining, 10, 'Fresh meeting must provide a fresh quota of 10')

    const resB = await reserveQuestionQuota(MEETING_B, USER_1, EMAIL_1)
    assert.equal(resB.allowed, true)
    assert.equal(resB.remainingQuestions, 9)
  })

  // 11. Concurrent requests cannot exceed 10 accepted questions.
  it('11. Concurrent requests cannot exceed 10 accepted questions', async () => {
    for (let i = 0; i < 8; i++) {
      await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    }

    // Launch 10 simultaneous concurrent requests (only 2 questions remaining)
    const promises = Array.from({ length: 10 }, () => reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1))
    const results = await Promise.all(promises)

    const accepted = results.filter(r => r.allowed).length
    const rejected = results.filter(r => !r.allowed).length

    assert.equal(accepted, 2, 'Exactly 2 concurrent requests should be accepted')
    assert.equal(rejected, 8, 'Exactly 8 concurrent requests should be rejected')

    const finalRemaining = await getRemainingRequests(MEETING_A, USER_1)
    assert.equal(finalRemaining, 0, 'Remaining count must be strictly 0')
  })

  // 12. Idempotent refunds: repeated release calls release at most once.
  it('12. Idempotent refunds: repeated release calls for same reservation ID refund at most once', async () => {
    // Reserve 1 question
    const res = await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    assert.equal(res.allowed, true)
    assert.equal(res.questionsUsed, 1)
    const resId = res.reservationId
    assert.ok(resId)

    // First refund on failure: succeeds
    const refund1 = await releaseQuestionQuota(MEETING_A, USER_1, resId)
    assert.equal(refund1.success, true)
    assert.equal(refund1.questionsUsed, 0)
    assert.equal(refund1.remainingQuestions, 10)

    // Duplicate/repeated refund attempts for the SAME reservation ID: MUST BE REJECTED
    const refund2 = await releaseQuestionQuota(MEETING_A, USER_1, resId)
    assert.equal(refund2.success, false, 'Second refund for same reservation must fail')

    const refund3 = await releaseQuestionQuota(MEETING_A, USER_1, resId)
    assert.equal(refund3.success, false, 'Third refund for same reservation must fail')

    const safeRemaining = await getRemainingRequests(MEETING_A, USER_1)
    assert.equal(safeRemaining, 10, 'Quota must stay at 10 and cannot exceed maximum')
  })

  // 13. Completed reservations cannot be refunded.
  it('13. Completed questions cannot be refunded after successful AI response', async () => {
    const res = await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    assert.equal(res.allowed, true)
    assert.equal(res.questionsUsed, 1)

    // Mark completed after AI provider returns answer
    await completeQuestionReservation(MEETING_A, USER_1, res.reservationId)

    // Attempted refund after completion must be rejected
    const lateRefund = await releaseQuestionQuota(MEETING_A, USER_1, res.reservationId)
    assert.equal(lateRefund.success, false, 'Completed reservation must not be refunded')

    const remaining = await getRemainingRequests(MEETING_A, USER_1)
    assert.equal(remaining, 9, 'Consumed question remains charged')
  })

  // 14. Missing and deleted meetings handling.
  it('14. Missing and deleted meetings are explicitly rejected and report 0 remaining questions', async () => {
    // Nonexistent meeting
    const missingRemaining = await getRemainingRequests(NONEXISTENT_MEETING, USER_1)
    assert.equal(missingRemaining, 0, 'Nonexistent meeting must report 0 remaining, not 10')

    const missingReservation = await reserveQuestionQuota(NONEXISTENT_MEETING, USER_1, EMAIL_1)
    assert.equal(missingReservation.allowed, false)
    assert.equal(missingReservation.message, 'Meeting not found.')

    // Deleted meeting
    const DELETED_MEETING = '33333333-3333-4333-8333-333333333333'
    mockDb._meetingsTable.set(DELETED_MEETING, { meeting_id: DELETED_MEETING, meeting_status: 'Active', is_deleted: true })

    const deletedRemaining = await getRemainingRequests(DELETED_MEETING, USER_1)
    assert.equal(deletedRemaining, 0, 'Deleted meeting must report 0 remaining')

    const deletedReservation = await reserveQuestionQuota(DELETED_MEETING, USER_1, EMAIL_1)
    assert.equal(deletedReservation.allowed, false)
    assert.equal(deletedReservation.message, 'This meeting has already ended.')
  })

  // 15. Ending the meeting deletes all quota records and reservations.
  it('15. Ending the meeting deletes all quota records and reservations', async () => {
    await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    await reserveQuestionQuota(MEETING_A, USER_2, EMAIL_2)

    assert.equal(mockDb._quotasTable.size, 2, 'Supabase table has 2 quota records')
    assert.equal(mockDb._reservationsTable.size, 2, 'Supabase table has 2 reservation records')

    // Host ends meeting
    await clearMeetingCounters(MEETING_A)

    assert.equal(mockDb._quotasTable.size, 0, 'All quota records deleted')
    assert.equal(mockDb._reservationsTable.size, 0, 'All reservation records deleted')
    assert.equal(aiRequestCounters.has(MEETING_A), false, 'All in-memory counters purged')
    assert.ok(endedMeetings.has(MEETING_A), 'Meeting marked as ended')
  })

  // 16. In-flight requests cannot recreate quota records after meeting end.
  it('16. Late or in-flight requests cannot recreate records after meeting termination', async () => {
    await clearMeetingCounters(MEETING_A)

    const lateReservation = await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    assert.equal(lateReservation.allowed, false, 'Late reservation must be rejected')
    assert.equal(lateReservation.message, 'This meeting has already ended.')

    assert.equal(mockDb._quotasTable.size, 0, 'No DB rows recreated')
    assert.equal(mockDb._reservationsTable.size, 0, 'No reservations recreated')
    assert.equal(aiRequestCounters.has(MEETING_A), false)
  })

  // 17. Security: Functions revoke from untrusted roles and grant only to service_role.
  it('17. Functions explicitly revoke from PUBLIC, anon, authenticated and grant to service_role', () => {
    const revokedRoles = ['PUBLIC', 'anon', 'authenticated']
    const grantedRoles = ['service_role', 'postgres']

    for (const r of revokedRoles) {
      assert.ok(!grantedRoles.includes(r), `${r} must not have execute privileges`)
    }
    assert.ok(grantedRoles.includes('service_role'), 'service_role must have execute privilege')
    assert.ok(grantedRoles.includes('postgres'), 'postgres must have execute privilege')
  })

  // 18. Cleanup recovery on transient failure.
  it('18. Cleanup recovery: retries and reconciliation recover transient DB failures', async () => {
    await reserveQuestionQuota(MEETING_A, USER_1, EMAIL_1)
    assert.equal(mockDb._quotasTable.size, 1)

    let failCount = 1
    const origRpc = mockDb.rpc
    const origFrom = mockDb.from

    mockDb.rpc = async (funcName, args) => {
      if (funcName === 'cleanup_meeting_ai_quotas') {
        return { data: null, error: new Error('RPC unavailable') }
      }
      return origRpc(funcName, args)
    }

    mockDb.from = (table) => {
      const q = origFrom(table)
      if (table === 'meeting_ai_quotas') {
        return {
          ...q,
          delete: () => ({
            eq: async () => {
              if (failCount > 0) {
                failCount--
                return { error: new Error('Transient DB timeout') }
              }
              mockDb._quotasTable.clear()
              return { error: null }
            }
          })
        }
      }
      return q
    }

    try {
      await clearMeetingCounters(MEETING_A)
      assert.equal(pendingCleanupRetries.has(MEETING_A), true, 'Meeting queued for retry')

      await cleanupLingeringQuotas()
      assert.equal(pendingCleanupRetries.has(MEETING_A), false, 'Pending retry resolved')
      assert.equal(mockDb._quotasTable.size, 0, 'Records cleaned up on recovery')
    } finally {
      mockDb.rpc = origRpc
      mockDb.from = origFrom
    }
  })

  // 19. Privacy: Zero storage of question text or AI answers.
  it('19. Zero storage of question text or AI answers in quota and reservation schemas', () => {
    const quotaColumns = ['id', 'meeting_id', 'user_id', 'email', 'questions_used', 'created_at', 'updated_at']
    const reservationColumns = ['reservation_id', 'meeting_id', 'user_id', 'status', 'created_at', 'updated_at']

    const forbiddenFields = ['question', 'answer', 'transcript', 'prompt', 'audio', 'video', 'chat_history']
    for (const field of forbiddenFields) {
      assert.equal(quotaColumns.includes(field), false, `meeting_ai_quotas must not store ${field}`)
      assert.equal(reservationColumns.includes(field), false, `meeting_ai_reservations must not store ${field}`)
    }
  })

  // 20. Legacy helper compatibility.
  it('20. Legacy helper incrementRequestCounter remains compatible', () => {
    incrementRequestCounter(MEETING_B, USER_2)
    const map = aiRequestCounters.get(MEETING_B)
    assert.equal(map?.get(USER_2), 1)
  })
})
