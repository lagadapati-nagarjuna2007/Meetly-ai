import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcrypt'
import {
  calculateLockoutDuration,
  checkLockout,
  recordFailedLogin,
  clearAllLockouts,
  setDatabaseClient,
  resetDatabaseClient,
  lockoutCache
} from '../services/authLockout.service.js'
import { login } from '../controllers/authController.js'
import { supabase } from '../config/supabase.js'

describe('Meetly AI — Progressive Login Lockout Test Suite', () => {
  let mockUsers = new Map()
  let mockLockouts = new Map()
  let originalSupabaseFrom

  const createMockReqRes = ({ body = {}, headers = {}, cookies = {} } = {}) => {
    const req = { body, headers, cookies }
    let statusCode = 200
    let responseData = null
    const responseHeaders = {}

    const res = {
      status: (code) => {
        statusCode = code
        return res
      },
      json: (data) => {
        responseData = data
        return res
      },
      cookie: () => res,
      setHeader: (name, val) => {
        responseHeaders[name.toLowerCase()] = val
        return res
      },
      getHeader: (name) => responseHeaders[name.toLowerCase()],
      getStatusCode: () => statusCode,
      getData: () => responseData
    }

    return { req, res }
  }

  beforeEach(async () => {
    clearAllLockouts()
    mockUsers.clear()
    mockLockouts.clear()

    // Seed test user with hashed password
    const testPasswordHash = await bcrypt.hash('CorrectPassword123!', 10)
    mockUsers.set('student@meetly.ai', {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'student@meetly.ai',
      full_name: 'Test Student',
      password_hash: testPasswordHash,
      role: 'Student'
    })

    originalSupabaseFrom = supabase.from
    const mockFrom = (table) => {
      let filters = {}
      const queryBuilder = {
        select: () => queryBuilder,
        eq: (col, val) => {
          filters[col] = val
          return queryBuilder
        },
        maybeSingle: async () => {
          if (table === 'users') {
            const u = mockUsers.get(filters.email)
            return { data: u ? { ...u } : null, error: null }
          }
          if (table === 'auth_lockouts') {
            const row = mockLockouts.get(filters.email)
            return { data: row ? { ...row } : null, error: null }
          }
          return { data: null, error: null }
        },
        upsert: async (record) => {
          if (table === 'auth_lockouts') {
            mockLockouts.set(record.email, { ...record })
          }
          return { error: null }
        },
        update: (fields) => {
          return {
            eq: async (col, val) => {
              if (table === 'auth_lockouts') {
                const row = mockLockouts.get(val) || { email: val }
                Object.assign(row, fields)
                mockLockouts.set(val, row)
              }
              return { error: null }
            }
          }
        }
      }
      return queryBuilder
    }

    supabase.from = mockFrom
    setDatabaseClient({ from: mockFrom })
  })

  afterEach(() => {
    clearAllLockouts()
    supabase.from = originalSupabaseFrom
    resetDatabaseClient()
  })

  // 1. Four failed attempts trigger a 2-minute lockout
  it('1. Four failed attempts trigger a 2-minute lockout', async () => {
    const email = 'student@meetly.ai'

    // First 3 failed attempts
    for (let i = 1; i <= 3; i++) {
      const { req, res } = createMockReqRes({
        body: { email, password: 'WrongPassword!' }
      })
      await login(req, res)
      assert.equal(res.getStatusCode(), 400)
      assert.equal(res.getData().message, 'Invalid Email or Password')

      const status = await checkLockout(email)
      assert.equal(status.isLocked, false)
      assert.equal(status.failedAttempts, i)
    }

    // 4th failed attempt triggers 2-minute lockout
    const { req: req4, res: res4 } = createMockReqRes({
      body: { email, password: 'WrongPassword!' }
    })
    await login(req4, res4)

    assert.equal(res4.getStatusCode(), 429)
    assert.match(res4.getData().message, /temporarily locked/i)
    assert.match(res4.getData().message, /2 minutes/i)

    const statusAfter4 = await checkLockout(email)
    assert.equal(statusAfter4.isLocked, true)
    assert.equal(statusAfter4.lockoutTier, 1)
    // 2 minutes = 120 seconds
    assert.ok(statusAfter4.remainingSeconds <= 120 && statusAfter4.remainingSeconds >= 115)
  })

  // 2. Attempts during a lockout are rejected before password verification and do not extend lockout
  it('2. Attempts during a lockout are rejected before password verification and do not extend lockout', async () => {
    const email = 'student@meetly.ai'

    // Trigger tier 1 lockout
    for (let i = 0; i < 4; i++) {
      await recordFailedLogin(email)
    }

    const initialStatus = await checkLockout(email)
    assert.equal(initialStatus.isLocked, true)
    const initialExpiry = initialStatus.lockedUntil.getTime()

    // Attempt login during lockout with CORRECT password
    const { req, res } = createMockReqRes({
      body: { email, password: 'CorrectPassword123!' }
    })
    await login(req, res)

    // Must be rejected with 429 even though password is valid
    assert.equal(res.getStatusCode(), 429)
    assert.match(res.getData().message, /temporarily locked/i)

    // Verify lockout timer was NOT extended
    const statusAfter = await checkLockout(email)
    assert.equal(statusAfter.isLocked, true)
    assert.equal(statusAfter.lockedUntil.getTime(), initialExpiry)
    assert.equal(statusAfter.lockoutTier, 1)
  })

  // 3. Four subsequent failures trigger a 10-minute lockout after the first expires
  it('3. Four subsequent failures trigger a 10-minute lockout after the first expires', async () => {
    const email = 'student@meetly.ai'

    // Tier 1 lockout (4 failures)
    for (let i = 0; i < 4; i++) {
      await recordFailedLogin(email)
    }
    const tier1 = await checkLockout(email)
    assert.equal(tier1.isLocked, true)
    assert.equal(tier1.lockoutTier, 1)

    // Simulate expiration of Tier 1 (advance time beyond lockedUntil)
    const expiredTime = new Date(Date.now() - 1000)
    const cached = lockoutCache.get(email)
    cached.lockedUntil = expiredTime
    mockLockouts.set(email, { ...mockLockouts.get(email), locked_until: expiredTime.toISOString() })

    const statusExpired = await checkLockout(email)
    assert.equal(statusExpired.isLocked, false, 'Lockout should now be expired')

    // Next 3 failures: do not lock yet
    for (let i = 1; i <= 3; i++) {
      const res = await recordFailedLogin(email)
      assert.equal(res.isLocked, false)
      assert.equal(res.failedAttempts, i)
    }

    // 4th failure of tier 2 triggers 10-minute lockout (120s * 5 = 600s)
    const tier2Result = await recordFailedLogin(email)
    assert.equal(tier2Result.isLocked, true)
    assert.equal(tier2Result.lockoutTier, 2)
    assert.ok(tier2Result.remainingSeconds <= 600 && tier2Result.remainingSeconds >= 595)
  })

  // 4. Later escalation follows the ×5 rule and respects the 24-hour cap
  it('4. Later escalation follows the ×5 rule and respects the 24-hour cap', () => {
    // Formula verification:
    // Tier 1: 120s (2 min)
    assert.equal(calculateLockoutDuration(1), 120)

    // Tier 2: 120 * 5 = 600s (10 min)
    assert.equal(calculateLockoutDuration(2), 600)

    // Tier 3: 600 * 5 = 3,000s (50 min)
    assert.equal(calculateLockoutDuration(3), 3000)

    // Tier 4: 3000 * 5 = 15,000s (250 min = 4.16 hrs)
    assert.equal(calculateLockoutDuration(4), 15000)

    // Tier 5: 15000 * 5 = 75,000s (1250 min = 20.83 hrs)
    assert.equal(calculateLockoutDuration(5), 75000)

    // Tier 6: 75000 * 5 = 375,000s -> capped at 86,400s (24 hrs)
    assert.equal(calculateLockoutDuration(6), 86400)

    // Tier 7+: strictly capped at 24 hours (86,400s)
    assert.equal(calculateLockoutDuration(7), 86400)
    assert.equal(calculateLockoutDuration(10), 86400)
  })

  // 5. Successful login resets the escalation state
  it('5. Successful login resets the escalation state', async () => {
    const email = 'student@meetly.ai'

    // Fail 3 times (streak of 3)
    for (let i = 0; i < 3; i++) {
      await recordFailedLogin(email)
    }
    const preCheck = await checkLockout(email)
    assert.equal(preCheck.failedAttempts, 3)

    // Successful login
    const { req, res } = createMockReqRes({
      body: { email, password: 'CorrectPassword123!' }
    })
    await login(req, res)

    assert.equal(res.getStatusCode(), 200)
    assert.ok(res.getData().token)

    // Counter and tier should be fully reset
    const postCheck = await checkLockout(email)
    assert.equal(postCheck.isLocked, false)
    assert.equal(postCheck.failedAttempts, 0)
    assert.equal(postCheck.lockoutTier, 0)

    // Next failure starts fresh at attempt 1 of tier 1
    const nextFail = await recordFailedLogin(email)
    assert.equal(nextFail.failedAttempts, 1)
    assert.equal(nextFail.lockoutTier, 0)
    assert.equal(nextFail.isLocked, false)
  })

  // 6. Email case and surrounding whitespace do not bypass the same account's lockout
  it('6. Email case and surrounding whitespace do not bypass the same account\'s lockout', async () => {
    const variants = [
      'student@meetly.ai',
      '  student@meetly.ai',
      'STUDENT@MEETLY.AI',
      '  Student@Meetly.AI  '
    ]

    // 4 failed attempts across different case and whitespace variants
    for (const v of variants) {
      const { req, res } = createMockReqRes({
        body: { email: v, password: 'WrongPassword' }
      })
      await login(req, res)
    }

    // All variants map to normalized 'student@meetly.ai'
    const status = await checkLockout('  student@meetly.ai  ')
    assert.equal(status.isLocked, true)
    assert.equal(status.lockoutTier, 1)

    // Attempting login with another variant must be locked
    const { req: checkReq, res: checkRes } = createMockReqRes({
      body: { email: '  STUDENT@MEETLY.AI  ', password: 'CorrectPassword123!' }
    })
    await login(checkReq, checkRes)
    assert.equal(checkRes.getStatusCode(), 429)
  })

  // 7. Concurrent failed requests cannot bypass the counter
  it('7. Concurrent failed requests cannot bypass the counter', async () => {
    const email = 'concurrent@meetly.ai'

    // Fire 4 concurrent failed attempts simultaneously
    const promises = Array.from({ length: 4 }).map(() => recordFailedLogin(email))
    await Promise.all(promises)

    // After 4 concurrent failures, account must be locked in Tier 1
    const status = await checkLockout(email)
    assert.equal(status.isLocked, true)
    assert.equal(status.lockoutTier, 1)
  })

  // 8. Lockout survives simulated backend restarts
  it('8. Lockout survives simulated backend restarts', async () => {
    const email = 'persisted@meetly.ai'

    // Lock account
    for (let i = 0; i < 4; i++) {
      await recordFailedLogin(email)
    }

    assert.equal((await checkLockout(email)).isLocked, true)

    // Simulate backend restart: completely purge in-memory cache
    clearAllLockouts()
    assert.equal(lockoutCache.size, 0)

    // Verify state is restored from database records
    const restoredStatus = await checkLockout(email)
    assert.equal(restoredStatus.isLocked, true)
    assert.equal(restoredStatus.lockoutTier, 1)
    assert.ok(restoredStatus.remainingSeconds > 0)
  })

  // 9. Separate accounts maintain separate lockout states
  it('9. Separate accounts maintain separate lockout states', async () => {
    const userA = 'user-a@meetly.ai'
    const userB = 'user-b@meetly.ai'

    // User A fails 4 times -> locked
    for (let i = 0; i < 4; i++) {
      await recordFailedLogin(userA)
    }

    assert.equal((await checkLockout(userA)).isLocked, true)

    // User B must be completely unaffected
    const statusB = await checkLockout(userB)
    assert.equal(statusB.isLocked, false)
    assert.equal(statusB.failedAttempts, 0)
  })

  // 10. Generic errors: Non-existent emails trigger identical lockout without leaking account existence
  it('10. Non-existent emails trigger identical lockout without leaking account existence', async () => {
    const nonExistentEmail = 'ghost@nowhere.com'

    // Ensure user does not exist
    assert.equal(mockUsers.has(nonExistentEmail), false)

    // 4 failed attempts on non-existent account
    for (let i = 0; i < 3; i++) {
      const { req, res } = createMockReqRes({
        body: { email: nonExistentEmail, password: 'RandomPassword' }
      })
      await login(req, res)
      assert.equal(res.getStatusCode(), 400)
      assert.equal(res.getData().message, 'Invalid Email or Password')
    }

    // 4th attempt locks out
    const { req: req4, res: res4 } = createMockReqRes({
      body: { email: nonExistentEmail, password: 'RandomPassword' }
    })
    await login(req4, res4)
    assert.equal(res4.getStatusCode(), 429)
    assert.match(res4.getData().message, /temporarily locked/i)

    const status = await checkLockout(nonExistentEmail)
    assert.equal(status.isLocked, true)
    assert.equal(status.lockoutTier, 1)
  })

  // 11. Lockout-check RPC unavailable falls back to direct database table safely
  it('11. Lockout-check RPC unavailable falls back to direct database table safely', async () => {
    const email = 'rpc-fallback@meetly.ai'
    mockLockouts.set(email, {
      email,
      failed_attempts: 2,
      lockout_tier: 0,
      locked_until: null
    })

    // Mock client where rpc throws/fails but from() succeeds
    setDatabaseClient({
      rpc: async () => { throw new Error('RPC unavailable') },
      from: supabase.from
    })

    const status = await checkLockout(email)
    assert.equal(status.isVerified, true)
    assert.equal(status.isLocked, false)
    assert.equal(status.failedAttempts, 2)
  })

  // 12. Direct database read failure results in unverified status
  it('12. Direct database read failure results in unverified status', async () => {
    const email = 'db-fail@meetly.ai'
    clearAllLockouts()

    // Mock client where both rpc and from fail
    setDatabaseClient({
      rpc: async () => { throw new Error('RPC down') },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: new Error('PostgREST connection timeout') })
          })
        })
      })
    })

    const status = await checkLockout(email)
    assert.equal(status.isVerified, false)
    assert.equal(status.status, 'unverified')
    assert.match(status.error, /unable to verify/i)
  })

  // 13. No password verification or token issuance when lockout status is unknown (503 Service Unavailable)
  it('13. No password verification or token issuance when lockout status is unknown (503)', async () => {
    const email = 'student@meetly.ai'
    clearAllLockouts()

    // Simulate database failure during lockout check
    setDatabaseClient({
      rpc: async () => { throw new Error('DB offline') },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: new Error('DB offline') })
          })
        })
      })
    })

    const { req, res } = createMockReqRes({
      body: { email, password: 'CorrectPassword123!' }
    })
    await login(req, res)

    // Must fail closed with 503 Service Unavailable
    assert.equal(res.getStatusCode(), 503)
    assert.match(res.getData().message, /temporarily unavailable/i)
    // No auth token must be issued
    assert.equal(res.getData().token, undefined)
  })

  // 14. Existing lockouts cannot be bypassed through fallback behavior
  it('14. Existing lockouts cannot be bypassed through fallback behavior', async () => {
    const email = 'student@meetly.ai'

    // First lock the account in memory
    for (let i = 0; i < 4; i++) {
      await recordFailedLogin(email)
    }
    const preStatus = await checkLockout(email)
    assert.equal(preStatus.isLocked, true)

    // Now break the database
    setDatabaseClient({
      rpc: async () => { throw new Error('DB offline') },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: new Error('DB offline') })
          })
        })
      })
    })

    // Account MUST remain locked via active local lockout cache
    const status = await checkLockout(email)
    assert.equal(status.isLocked, true)

    const { req, res } = createMockReqRes({
      body: { email, password: 'CorrectPassword123!' }
    })
    await login(req, res)

    // Must be rejected with 429 Too Many Requests (NOT 200, NOT 503)
    assert.equal(res.getStatusCode(), 429)
    assert.match(res.getData().message, /temporarily locked/i)
    assert.equal(res.getData().token, undefined)
  })

  // 15. Failed-attempt persistence failure emits warning and marks unpersisted
  it('15. Failed-attempt persistence failure marks unpersisted', async () => {
    const email = 'fail-persist@meetly.ai'
    clearAllLockouts()

    // Mock client where both rpc and upsert fail
    setDatabaseClient({
      rpc: async () => { throw new Error('RPC down') },
      from: () => ({
        upsert: async () => ({ error: new Error('DB write failed') }),
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null })
          })
        })
      })
    })

    const result = await recordFailedLogin(email)
    assert.equal(result.persisted, false)
    assert.equal(result.failedAttempts, 1)
  })
})
