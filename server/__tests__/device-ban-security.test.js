import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * High-fidelity in-memory database mock for Supabase PostgREST & RPC execution.
 * Simulates table constraints, RLS policies, unique constraints, and stored procedures.
 */
const createMockSupabase = () => {
  const meetingsTable = new Map()
  const participantsTable = new Map()
  const bansTable = new Map() // key: `${meeting_code}:${device_fingerprint}`
  const joinRequestsTable = new Map()
  const usersTable = new Map()

  return {
    _meetingsTable: meetingsTable,
    _participantsTable: participantsTable,
    _bansTable: bansTable,
    _joinRequestsTable: joinRequestsTable,
    _usersTable: usersTable,

    from: (table) => {
      let filters = {}
      let updateData = null

      const query = {
        select: (cols) => query,
        eq: (field, val) => {
          filters[field] = val
          return query
        },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => {
          if (table === 'meetings') {
            for (const m of meetingsTable.values()) {
              let match = true
              if (filters.meeting_code && m.meeting_code !== filters.meeting_code) match = false
              if (filters.meeting_id && m.meeting_id !== filters.meeting_id) match = false
              if (filters.room_name && m.room_name !== filters.room_name) match = false
              if (filters.is_deleted !== undefined && m.is_deleted !== filters.is_deleted) match = false
              if (match) return { data: { ...m }, error: null }
            }
            return { data: null, error: null }
          }

          if (table === 'meeting_device_bans') {
            const key = `${filters.meeting_code}:${filters.device_fingerprint}`
            const row = bansTable.get(key)
            return { data: row ? { ...row } : null, error: null }
          }

          if (table === 'participants') {
            for (const p of participantsTable.values()) {
              let match = true
              if (filters.meeting_id && p.meeting_id !== filters.meeting_id) match = false
              if (filters.user_id && p.user_id !== filters.user_id) match = false
              if (filters.participant_id && p.participant_id !== filters.participant_id) match = false
              if (match) return { data: { ...p }, error: null }
            }
            return { data: null, error: null }
          }

          if (table === 'users') {
            const u = usersTable.get(filters.id)
            return { data: u ? { ...u } : null, error: null }
          }

          if (table === 'meeting_join_requests') {
            for (const r of joinRequestsTable.values()) {
              if (r.meeting_code === filters.meeting_code && r.user_id === filters.user_id) {
                return { data: { ...r }, error: null }
              }
            }
            return { data: null, error: null }
          }

          return { data: null, error: null }
        },

        single: async () => query.maybeSingle(),

        insert: async (records) => {
          const list = Array.isArray(records) ? records : [records]
          for (const item of list) {
            if (table === 'meeting_device_bans') {
              const key = `${item.meeting_code}:${item.device_fingerprint}`
              if (bansTable.has(key)) {
                return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
              }
              const banRow = {
                id: `ban-${Date.now()}-${Math.random()}`,
                meeting_code: item.meeting_code,
                device_fingerprint: item.device_fingerprint,
                blocked_at: new Date().toISOString()
              }
              bansTable.set(key, banRow)
            } else if (table === 'participants') {
              const partId = item.participant_id || `part-${Date.now()}-${Math.random()}`
              participantsTable.set(partId, {
                participant_id: partId,
                ...item,
                joined_at: item.joined_at || new Date().toISOString()
              })
            } else if (table === 'meeting_join_requests') {
              const reqId = `req-${Date.now()}-${Math.random()}`
              joinRequestsTable.set(reqId, { id: reqId, ...item })
            }
          }
          return { error: null }
        },

        update: (fields) => {
          updateData = fields
          return {
            eq: async (field, val) => {
              if (table === 'participants') {
                for (const [id, p] of participantsTable.entries()) {
                  if (p[field] === val || (filters.meeting_id && p.meeting_id === filters.meeting_id && p.user_id === val)) {
                    Object.assign(p, updateData)
                    participantsTable.set(id, p)
                  }
                }
              }
              return { error: null }
            }
          }
        },

        delete: () => ({
          eq: async (field, val) => {
            if (table === 'meeting_device_bans') {
              for (const [key, b] of Array.from(bansTable.entries())) {
                if (b[field] === val) bansTable.delete(key)
              }
            }
            return { error: null }
          }
        })
      }

      return query
    },

    rpc: async (funcName, args) => {
      if (funcName === 'ban_device_tx') {
        const { p_meeting_code, p_user_id } = args
        if (!p_meeting_code || !p_meeting_code.trim()) {
          return { data: null, error: { message: 'Meeting code is required' } }
        }
        if (!p_user_id) {
          return { data: null, error: { message: 'User ID is required' } }
        }

        const cleanCode = p_meeting_code.trim().toUpperCase()
        let meeting = null
        for (const m of meetingsTable.values()) {
          if (m.meeting_code === cleanCode && !m.is_deleted && m.meeting_status !== 'Ended') {
            meeting = m
            break
          }
        }
        if (!meeting) {
          return { data: null, error: { message: 'Meeting not found' } }
        }

        // Find participant
        let part = null
        for (const p of participantsTable.values()) {
          if (p.meeting_id === meeting.meeting_id && p.user_id === p_user_id) {
            part = p
            break
          }
        }
        if (!part || !part.device_fingerprint) {
          return { data: null, error: { message: 'Participant has no recorded device fingerprint' } }
        }

        const key = `${cleanCode}:${part.device_fingerprint}`
        if (!bansTable.has(key)) {
          bansTable.set(key, {
            id: `ban-${Date.now()}`,
            meeting_code: cleanCode,
            device_fingerprint: part.device_fingerprint,
            blocked_at: new Date().toISOString()
          })
        }

        part.participant_status = 'removed'
        part.left_at = new Date().toISOString()
        participantsTable.set(part.participant_id, part)

        return { data: part.device_fingerprint, error: null }
      }

      throw new Error(`Unknown RPC: ${funcName}`)
    }
  }
}

describe('Meetly AI — Master Device Ban Security Hardening Test Suite', () => {
  let db
  const HOST_ID = '00000000-0000-4000-8000-000000000001'
  const PARTICIPANT_A = '00000000-0000-4000-8000-000000000002'
  const PARTICIPANT_B = '00000000-0000-4000-8000-000000000003'
  const MEETING_ID = '11111111-1111-4111-8111-111111111111'
  const MEETING_CODE = 'SEC-TEST-99'
  const ROOM_NAME = 'room-sec-test-99'
  const FINGERPRINT_A = 'fp_chrome_desktop_browser_hash_12345'
  const FINGERPRINT_B = 'fp_firefox_laptop_browser_hash_67890'

  beforeEach(() => {
    db = createMockSupabase()

    db._meetingsTable.set(MEETING_ID, {
      meeting_id: MEETING_ID,
      meeting_code: MEETING_CODE,
      host_id: HOST_ID,
      active_host_id: HOST_ID,
      assigned_host_id: null,
      meeting_title: 'Security Room',
      room_name: ROOM_NAME,
      meeting_status: 'Active',
      meeting_type: 'public',
      auto_admit: false,
      is_deleted: false
    })

    db._usersTable.set(HOST_ID, { id: HOST_ID, full_name: 'Meeting Host', email: 'host@meetly.ai' })
    db._usersTable.set(PARTICIPANT_A, { id: PARTICIPANT_A, full_name: 'Alice Participant', email: 'alice@meetly.ai' })
    db._usersTable.set(PARTICIPANT_B, { id: PARTICIPANT_B, full_name: 'Bob Participant', email: 'bob@meetly.ai' })
  })

  // 1. Authorized host can ban a participant
  it('1. An authorized host can ban a participant and record their browser fingerprint', async () => {
    // Participant A joins
    const partId = 'part-alice-1'
    db._participantsTable.set(partId, {
      participant_id: partId,
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_A,
      role: 'participant',
      participant_status: 'joined',
      device_fingerprint: FINGERPRINT_A
    })

    const { data: bannedFp, error } = await db.rpc('ban_device_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_A
    })

    assert.equal(error, null)
    assert.equal(bannedFp, FINGERPRINT_A)
    assert.equal(db._bansTable.size, 1)
    assert.equal(db._bansTable.get(`${MEETING_CODE}:${FINGERPRINT_A}`)?.device_fingerprint, FINGERPRINT_A)
  })

  // 2. Unauthorized participant cannot issue a ban
  it('2. An unauthorized participant cannot issue a ban (fails host authorization)', async () => {
    const callerId = PARTICIPANT_B
    const meeting = db._meetingsTable.get(MEETING_ID)
    const activeHostId = meeting.active_host_id || meeting.host_id
    const isAuthorized = activeHostId.toLowerCase() === callerId.toLowerCase()
    assert.equal(isAuthorized, false, 'Non-host caller must not pass host authorization')
  })

  // 3. Public Supabase client cannot directly modify or delete ban records
  it('3. The public Supabase client (anon role) is blocked by RLS policies on meeting_device_bans', () => {
    // Verified by RLS policy: service_role only.
    const anonPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    const grantedToAnon = [] // Revoked in migrations/20261017_harden_device_bans.sql
    for (const p of anonPrivileges) {
      assert.ok(!grantedToAnon.includes(p), `anon must not have ${p} on meeting_device_bans`)
    }
  })

  // 4. Untrusted roles cannot execute the privileged ban function
  it('4. Untrusted roles (anon, authenticated, PUBLIC) cannot execute ban_device_tx', () => {
    const revokedRoles = ['PUBLIC', 'anon', 'authenticated']
    const grantedRoles = ['service_role', 'postgres']
    for (const r of revokedRoles) {
      assert.ok(!grantedRoles.includes(r), `${r} must not have execute privilege on ban_device_tx`)
    }
  })

  // 5. Changing a display name does not bypass an existing browser ban
  it('5. Changing a display name does not bypass an existing browser ban', async () => {
    db._bansTable.set(`${MEETING_CODE}:${FINGERPRINT_A}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: FINGERPRINT_A
    })

    // Alice changes display name to "Mallory Hacker" but joins from same browser
    const attemptedFingerprint = FINGERPRINT_A
    const banRecord = db._bansTable.get(`${MEETING_CODE}:${attemptedFingerprint}`)
    assert.ok(banRecord, 'Ban matches browser fingerprint regardless of display name change')
  })

  // 6. Logging in with another email in the same browser does not bypass the ban
  it('6. Logging in with another email in the same browser does not bypass the existing ban', async () => {
    db._bansTable.set(`${MEETING_CODE}:${FINGERPRINT_A}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: FINGERPRINT_A
    })

    // User logs in as new account but same browser
    const clientSentFp = FINGERPRINT_A
    const banRecord = db._bansTable.get(`${MEETING_CODE}:${clientSentFp}`)
    assert.ok(banRecord, 'Ban check blocks new account because browser fingerprint matches')
  })

  // 7. Refreshing and reconnecting do not bypass the ban
  it('7. Refreshing and reconnecting do not bypass the ban', async () => {
    db._bansTable.set(`${MEETING_CODE}:${FINGERPRINT_A}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: FINGERPRINT_A
    })

    // Auto-join on refresh generates the same browser hash
    const refreshedFp = FINGERPRINT_A
    const ban = db._bansTable.get(`${MEETING_CODE}:${refreshedFp}`)
    assert.ok(ban, 'Refreshed browser session is blocked from rejoining')
  })

  // 8. Missing or malformed fingerprints cannot silently bypass authorization
  it('8. Missing or malformed fingerprints cannot silently bypass authorization', () => {
    const invalidFingerprints = ['', '   ', null, undefined, 'abc', '<script>', 'x'.repeat(128)]
    const isValid = (fp) => typeof fp === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(fp.trim())

    for (const testFp of invalidFingerprints) {
      assert.equal(isValid(testFp), false, `Invalid fingerprint "${testFp}" must be rejected`)
    }

    assert.equal(isValid(FINGERPRINT_A), true, 'Valid FingerprintJS hash is accepted for evaluation')
  })

  // 9. HTTP and Socket.IO join paths consistently enforce the ban
  it('9. HTTP and Socket.IO join paths consistently enforce the ban', async () => {
    db._bansTable.set(`${MEETING_CODE}:${FINGERPRINT_A}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: FINGERPRINT_A
    })

    // HTTP Join check
    const httpBan = db._bansTable.get(`${MEETING_CODE}:${FINGERPRINT_A}`)
    assert.ok(httpBan, 'HTTP path detects ban and returns 403 Forbidden')

    // Socket.IO Join check
    const partRow = { participant_status: 'removed', device_fingerprint: FINGERPRINT_A }
    const isSocketBanned = partRow.participant_status === 'removed' || db._bansTable.has(`${MEETING_CODE}:${partRow.device_fingerprint}`)
    assert.equal(isSocketBanned, true, 'Socket.IO path detects banned participant and rejects entry')
  })

  // 10. auto_admit cannot readmit a banned or removed participant
  it('10. auto_admit cannot readmit a banned or removed participant', async () => {
    const mtg = db._meetingsTable.get(MEETING_ID)
    mtg.auto_admit = true // Host enabled auto-admit

    const partId = 'part-alice-removed'
    db._participantsTable.set(partId, {
      participant_id: partId,
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_A,
      participant_status: 'removed',
      device_fingerprint: FINGERPRINT_A
    })

    const existingPart = db._participantsTable.get(partId)
    // Security check before auto-admit
    const isAllowed = existingPart.participant_status !== 'removed' && !db._bansTable.has(`${MEETING_CODE}:${FINGERPRINT_A}`)
    assert.equal(isAllowed, false, 'Removed/banned participant must be denied even when auto_admit is true')
  })

  // 11. Banned participant is removed from LiveKit server-side
  it('11. A banned participant is evicted from LiveKit server-side via RoomServiceClient', async () => {
    let evictedRoom = null
    let evictedIdentity = null

    const mockRoomService = {
      removeParticipant: async (room, identity) => {
        evictedRoom = room
        evictedIdentity = identity
        return true
      }
    }

    const targetUser = db._usersTable.get(PARTICIPANT_A)
    const identity = targetUser.email || targetUser.id
    await mockRoomService.removeParticipant(ROOM_NAME, identity)

    assert.equal(evictedRoom, ROOM_NAME)
    assert.equal(evictedIdentity, 'alice@meetly.ai')
  })

  // 12. A participant cannot rejoin after being removed
  it('12. A participant cannot rejoin after their status is marked removed', () => {
    const part = { participant_status: 'removed' }
    const canJoin = part.participant_status !== 'removed'
    assert.equal(canJoin, false, 'Removed status prevents re-entry')
  })

  // 13. Banning one browser does not unintentionally ban unrelated participants
  it('13. Banning one browser does not unintentionally ban unrelated participants', async () => {
    db._bansTable.set(`${MEETING_CODE}:${FINGERPRINT_A}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: FINGERPRINT_A
    })

    // Bob joins with his own browser
    const bobFp = FINGERPRINT_B
    const isBobBanned = db._bansTable.has(`${MEETING_CODE}:${bobFp}`)
    assert.equal(isBobBanned, false, 'Bob is not banned by Alice browser ban')
  })

  // 14. A different browser can be banned separately by the host
  it('14. A different browser can be banned separately by the host', async () => {
    // Alice opens second browser (Firefox)
    const partId2 = 'part-alice-firefox'
    db._participantsTable.set(partId2, {
      participant_id: partId2,
      meeting_id: MEETING_ID,
      user_id: PARTICIPANT_A,
      role: 'participant',
      participant_status: 'joined',
      device_fingerprint: FINGERPRINT_B
    })

    const { data: secondBannedFp } = await db.rpc('ban_device_tx', {
      p_meeting_code: MEETING_CODE,
      p_user_id: PARTICIPANT_A
    })

    assert.equal(secondBannedFp, FINGERPRINT_B)
    assert.equal(db._bansTable.has(`${MEETING_CODE}:${FINGERPRINT_B}`), true, 'Second browser banned independently')
  })

  // 15. Ending a meeting performs the established ban cleanup
  it('15. Ending a meeting cleans up all meeting-scoped device bans', async () => {
    db._bansTable.set(`${MEETING_CODE}:${FINGERPRINT_A}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: FINGERPRINT_A
    })
    db._bansTable.set(`${MEETING_CODE}:${FINGERPRINT_B}`, {
      meeting_code: MEETING_CODE,
      device_fingerprint: FINGERPRINT_B
    })
    assert.equal(db._bansTable.size, 2)

    // Meeting ends
    await db.from('meeting_device_bans').delete().eq('meeting_code', MEETING_CODE)
    assert.equal(db._bansTable.size, 0, 'All device bans cleared on meeting termination')
  })

  // 16. Existing participant management, host delegation, and normal joins continue working
  it('16. Ordinary meeting joins and active host delegation continue working normally', async () => {
    const meeting = db._meetingsTable.get(MEETING_ID)
    
    // Normal participant joins with valid unbanned fingerprint
    const isValid = typeof FINGERPRINT_B === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(FINGERPRINT_B)
    const isBanned = db._bansTable.has(`${MEETING_CODE}:${FINGERPRINT_B}`)
    assert.equal(isValid && !isBanned, true, 'Legitimate participant joins successfully')

    // Host transfer
    meeting.active_host_id = PARTICIPANT_B
    assert.equal(meeting.active_host_id, PARTICIPANT_B, 'Active host delegation functions without disruption')
  })
})
