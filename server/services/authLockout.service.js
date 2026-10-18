import { supabase } from '../config/supabase.js'

// Configurable progressive lockout policy
export const LOCKOUT_CONFIG = {
  maxAttempts: 4,               // 4 consecutive failed attempts trigger lockout
  baseDurationSeconds: 120,     // Tier 1: 2 minutes (120 seconds)
  multiplier: 5,                // Duration multiplier for subsequent tiers (×5)
  maxDurationSeconds: 86400     // 24 hours cap (86,400 seconds)
}

// Authoritative database client (defaults to Supabase, configurable for test isolation)
let dbClient = supabase

export const setDatabaseClient = (client) => {
  dbClient = client
}

export const resetDatabaseClient = () => {
  dbClient = supabase
}

export const getDatabaseClient = () => dbClient

// In-memory fast cache and resilient offline layer
// Key: normalizedEmail -> { failedAttempts, lockoutTier, lockedUntil, lastFailedAt }
export const lockoutCache = new Map()

// In-process concurrency mutex per email to prevent race conditions during concurrent requests
const emailMutexes = new Map()

const withEmailMutex = async (email, fn) => {
  while (emailMutexes.has(email)) {
    try {
      await emailMutexes.get(email)
    } catch (_) {}
  }
  let release
  const promise = new Promise((resolve) => { release = resolve })
  emailMutexes.set(email, promise)
  try {
    return await fn()
  } finally {
    emailMutexes.delete(email)
    release()
  }
}

/**
 * Consistent email address normalization:
 * Trims surrounding whitespace and converts to lower case.
 */
export const normalizeEmail = (email) => {
  if (!email || typeof email !== 'string') return ''
  return email.trim().toLowerCase()
}

/**
 * Calculates progressive lockout duration for a given tier:
 * Tier 1: base (2 min)
 * Tier 2: base * 5 (10 min)
 * Tier 3: base * 25 (50 min)
 * Tier 4: base * 125 (250 min = ~4.16 hrs)
 * Tier 5: base * 625 (1250 min = ~20.83 hrs)
 * Tier 6+: capped at maxDurationSeconds (24 hrs)
 */
export const calculateLockoutDuration = (tier, config = LOCKOUT_CONFIG) => {
  if (!tier || tier <= 0) return 0
  const duration = config.baseDurationSeconds * Math.pow(config.multiplier, tier - 1)
  return Math.min(config.maxDurationSeconds, Math.floor(duration))
}

/**
 * Checks if an email is currently locked out.
 * Reads lockout state without altering failure counters or extending lockouts.
 * Fails closed if the database cannot be verified and no active memory lockout exists.
 */
export const checkLockout = async (rawEmail) => {
  const email = normalizeEmail(rawEmail)
  if (!email) {
    return { isLocked: false, isVerified: true, remainingSeconds: 0, lockedUntil: null, lockoutTier: 0, failedAttempts: 0 }
  }

  const now = new Date()
  let dbVerified = false

  // 1. Primary: Query via database RPC if available
  try {
    if (typeof dbClient.rpc === 'function') {
      const { data, error } = await dbClient.rpc('check_login_lockout', { p_email: email })
      if (!error && data) {
        dbVerified = true
        const isLocked = Boolean(data.is_locked)
        const lockedUntil = data.locked_until ? new Date(data.locked_until) : null
        const remainingSeconds = data.remaining_seconds || 0

        // Synchronize in-memory cache
        lockoutCache.set(email, {
          failedAttempts: data.failed_attempts || 0,
          lockoutTier: data.lockout_tier || 0,
          lockedUntil,
          lastFailedAt: now
        })

        return {
          isLocked,
          isVerified: true,
          remainingSeconds,
          lockedUntil,
          lockoutTier: data.lockout_tier || 0,
          failedAttempts: data.failed_attempts || 0
        }
      }
    }
  } catch (rpcErr) {
    // Non-fatal: fall through to direct DB or in-memory fallback
  }

  // 2. Secondary: Query auth_lockouts table directly via PostgREST
  try {
    if (typeof dbClient.from === 'function') {
      const { data, error } = await dbClient
        .from('auth_lockouts')
        .select('failed_attempts, lockout_tier, locked_until')
        .eq('email', email)
        .maybeSingle()

      if (!error) {
        dbVerified = true
        if (data) {
          const lockedUntil = data.locked_until ? new Date(data.locked_until) : null
          const isLocked = Boolean(lockedUntil && lockedUntil > now)
          const remainingSeconds = isLocked
            ? Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000))
            : 0

          lockoutCache.set(email, {
            failedAttempts: data.failed_attempts || 0,
            lockoutTier: data.lockout_tier || 0,
            lockedUntil: isLocked ? lockedUntil : null,
            lastFailedAt: now
          })

          return {
            isLocked,
            isVerified: true,
            remainingSeconds,
            lockedUntil: isLocked ? lockedUntil : null,
            lockoutTier: data.lockout_tier || 0,
            failedAttempts: data.failed_attempts || 0
          }
        } else {
          // No record exists in auth_lockouts table: user has 0 failures and is unlocked
          lockoutCache.delete(email)
          return {
            isLocked: false,
            isVerified: true,
            remainingSeconds: 0,
            lockedUntil: null,
            lockoutTier: 0,
            failedAttempts: 0
          }
        }
      }
    }
  } catch (dbErr) {
    // Non-fatal: fall through to in-memory cache
  }

  // 3. Fallback: In-memory cache
  const cached = lockoutCache.get(email)
  // If memory cache confirms an active lockout, we MUST enforce it to prevent bypass
  if (cached && cached.lockedUntil && cached.lockedUntil > now) {
    const remainingSeconds = Math.max(1, Math.ceil((cached.lockedUntil.getTime() - now.getTime()) / 1000))
    return {
      isLocked: true,
      isVerified: true,
      remainingSeconds,
      lockedUntil: cached.lockedUntil,
      lockoutTier: cached.lockoutTier || 0,
      failedAttempts: cached.failedAttempts || 0
    }
  }

  // If the database could not be queried and there is no active local lockout,
  // we CANNOT verify the account's state and must NOT assume it is unlocked.
  if (!dbVerified) {
    console.warn(
      `[SECURITY WARNING] Unable to verify login lockout state from Supabase for account: ${email}. Refusing to assume account is unlocked.`
    )
    return {
      isLocked: false,
      isVerified: false,
      status: 'unverified',
      remainingSeconds: 0,
      lockedUntil: null,
      lockoutTier: cached?.lockoutTier || 0,
      failedAttempts: cached?.failedAttempts || 0,
      error: 'Unable to verify lockout status from database'
    }
  }

  return {
    isLocked: false,
    isVerified: true,
    remainingSeconds: 0,
    lockedUntil: null,
    lockoutTier: cached?.lockoutTier || 0,
    failedAttempts: cached?.failedAttempts || 0
  }
}

/**
 * Atomically records a failed password login attempt.
 * Increments failed attempt count and escalates lockout tier if threshold is reached.
 * If currently locked out, does NOT extend or alter the existing lockout.
 */
export const recordFailedLogin = async (rawEmail, config = LOCKOUT_CONFIG) => {
  const email = normalizeEmail(rawEmail)
  if (!email) {
    return { isLocked: false, isVerified: false, remainingSeconds: 0, lockedUntil: null, lockoutTier: 0, failedAttempts: 0 }
  }

  return withEmailMutex(email, async () => {
    const now = new Date()
    let dbPersisted = false

    // 1. Primary: Use transaction-safe database RPC
    try {
      if (typeof dbClient.rpc === 'function') {
        const { data, error } = await dbClient.rpc('record_login_failure', {
          p_email: email,
          p_max_attempts: config.maxAttempts,
          p_base_duration_secs: config.baseDurationSeconds,
          p_multiplier: config.multiplier,
          p_max_duration_secs: config.maxDurationSeconds
        })

        if (!error && data) {
          dbPersisted = true
          const isLocked = Boolean(data.is_locked)
          const lockedUntil = data.locked_until ? new Date(data.locked_until) : null
          const remainingSeconds = data.remaining_seconds || 0

          lockoutCache.set(email, {
            failedAttempts: data.failed_attempts || 0,
            lockoutTier: data.lockout_tier || 0,
            lockedUntil,
            lastFailedAt: now
          })

          return {
            isLocked,
            remainingSeconds,
            lockedUntil,
            lockoutTier: data.lockout_tier || 0,
            failedAttempts: data.failed_attempts || 0,
            isVerified: true,
            persisted: true
          }
        }
      }
    } catch (rpcErr) {
      // Fall through to direct table / in-memory path
    }

    // 2. Secondary / Fallback: Atomic calculation using in-memory / direct DB state
    const current = lockoutCache.get(email) || {
      failedAttempts: 0,
      lockoutTier: 0,
      lockedUntil: null,
      lastFailedAt: null
    }

    // If currently locked out in memory, do not increment or extend lockout
    if (current.lockedUntil && current.lockedUntil > now) {
      const remainingSeconds = Math.max(1, Math.ceil((current.lockedUntil.getTime() - now.getTime()) / 1000))
      return {
        isLocked: true,
        remainingSeconds,
        lockedUntil: current.lockedUntil,
        lockoutTier: current.lockoutTier,
        failedAttempts: current.failedAttempts,
        isVerified: true,
        persisted: false
      }
    }

    // Lockout expired or never locked: increment failure counter
    const newFailedAttempts = (current.failedAttempts || 0) + 1
    let newTier = current.lockoutTier || 0
    let lockedUntil = null
    let isLocked = false
    let remainingSeconds = 0

    if (newFailedAttempts >= config.maxAttempts) {
      newTier += 1
      const durationSeconds = calculateLockoutDuration(newTier, config)
      lockedUntil = new Date(now.getTime() + durationSeconds * 1000)
      isLocked = true
      remainingSeconds = durationSeconds

      current.failedAttempts = 0 // Reset counter for next tier
      current.lockoutTier = newTier
      current.lockedUntil = lockedUntil
      current.lastFailedAt = now
    } else {
      current.failedAttempts = newFailedAttempts
      current.lockedUntil = null
      current.lastFailedAt = now
    }

    lockoutCache.set(email, current)

    // Persist to direct table if available
    try {
      if (typeof dbClient.from === 'function') {
        const { error: upsertErr } = await dbClient
          .from('auth_lockouts')
          .upsert({
            email,
            failed_attempts: current.failedAttempts,
            lockout_tier: current.lockoutTier,
            locked_until: current.lockedUntil ? current.lockedUntil.toISOString() : null,
            last_failed_at: now.toISOString(),
            updated_at: now.toISOString()
          })

        if (!upsertErr) {
          dbPersisted = true
        }
      }
    } catch (dbErr) {
      // Persisted in cache only
    }

    if (!dbPersisted) {
      console.warn(
        `[SECURITY WARNING] Failed to persist login lockout state to Supabase database for account: ${email}. Running in volatile local memory fallback; counter is not durable across restarts or shared instances.`
      )
    }

    return {
      isLocked,
      remainingSeconds,
      lockedUntil,
      lockoutTier: current.lockoutTier,
      failedAttempts: current.failedAttempts,
      isVerified: dbPersisted,
      persisted: dbPersisted
    }
  })
}

/**
 * Resets lockout failure count, tier, and timer upon successful login.
 */
export const resetLockout = async (rawEmail) => {
  const email = normalizeEmail(rawEmail)
  if (!email) return { success: false }

  return withEmailMutex(email, async () => {
    let dbReset = false

    // 1. Primary: Database RPC
    try {
      if (typeof dbClient.rpc === 'function') {
        const { error } = await dbClient.rpc('reset_login_lockout', { p_email: email })
        if (!error) {
          dbReset = true
        }
      }
    } catch (_) {}

    // 2. Direct table update
    try {
      if (typeof dbClient.from === 'function') {
        const { error } = await dbClient
          .from('auth_lockouts')
          .update({
            failed_attempts: 0,
            lockout_tier: 0,
            locked_until: null,
            updated_at: new Date().toISOString()
          })
          .eq('email', email)
        if (!error) {
          dbReset = true
        }
      }
    } catch (_) {}

    if (dbReset || (typeof dbClient.rpc !== 'function' && typeof dbClient.from !== 'function')) {
      // Clear in-memory cache when database was reset, or in mock in-memory testing mode
      lockoutCache.delete(email)
      return { success: true }
    } else {
      console.warn(
        `[SECURITY WARNING] Failed to reset login lockout state in database for account: ${email}. Persisted lockout could not be cleared.`
      )
      return { success: false, error: 'Database reset failed' }
    }
  })
}

/**
 * Clears all in-memory lockout records (useful for test lifecycle isolation).
 */
export const clearAllLockouts = () => {
  lockoutCache.clear()
  emailMutexes.clear()
}
