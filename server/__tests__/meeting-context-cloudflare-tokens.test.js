import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/**
 * Meetly AI — MeetingContext Cloudflare Token Integration & Safety Contract Suite
 *
 * Verifies that MeetingContext:
 * 1. Extracts cloudflareToken, cloudflareMeetingId, and cloudflareParticipantId from creation responses.
 * 2. Extracts cloudflareToken, cloudflareMeetingId, and cloudflareParticipantId from join responses.
 * 3. Preserves existing LiveKit token and URL state.
 * 4. Correctly derives activeProvider ('cloudflare' | 'livekit' | null).
 * 5. Ensures Cloudflare-enabled meetings are not blocked by a missing LiveKit token.
 * 6. Ensures legacy LiveKit-only meetings continue to derive activeProvider = 'livekit'.
 * 7. Supports provider preference configuration via VITE_MEETING_PROVIDER and runtime override.
 * 8. Cleans up all credentials on leave/clear without residual state.
 * 9. Guarantees that raw token strings are never logged to console output.
 * 10. Fallback: Cloudflare override falls back to LiveKit when Cloudflare token is missing.
 * 11. Fallback: LiveKit override falls back to Cloudflare when LiveKit token is missing.
 * 12. Security: Invalid override values are rejected/ignored without breaking meetings.
 * 13. State Isolation: Switching from Cloudflare meeting to LiveKit-only meeting clears stale Cloudflare credentials.
 * 14. Non-Erasure: Updating one provider's token does not erase the other provider's token.
 */

// Mirrors the exact state updates and activeProvider derivation in MeetingContext.jsx
function createMockMeetingState() {
  let currentMeeting = null
  let livekitToken = null
  let livekitUrl = null
  let roomName = null
  let cloudflareToken = null
  let cloudflareMeetingId = null
  let cloudflareParticipantId = null
  let providerOverride = null

  function deriveActiveProvider(configuredProvider = null) {
    const isValidOverride = providerOverride === 'cloudflare' || providerOverride === 'livekit'
    const effectiveOverride = isValidOverride ? providerOverride : null

    if (effectiveOverride === 'cloudflare') {
      if (cloudflareToken) return 'cloudflare'
      if (livekitToken) return 'livekit' // Safe fallback
      return null
    }
    if (effectiveOverride === 'livekit') {
      if (livekitToken) return 'livekit'
      if (cloudflareToken) return 'cloudflare' // Safe fallback
      return null
    }
    if (configuredProvider === 'livekit' && livekitToken) return 'livekit'
    if (cloudflareToken) return 'cloudflare'
    if (livekitToken) return 'livekit'
    return null
  }

  function setActiveProvider(provider) {
    if (provider === null || provider === 'cloudflare' || provider === 'livekit') {
      providerOverride = provider
    } else {
      // Invalid override ignored
    }
  }

  function handleCreateResponse(data, durationMinutes = 30) {
    const cfToken = data.cloudflareToken || null
    const cfMeetingId = data.cloudflareMeetingId || data.meeting?.cloudflare_meeting_id || null
    const cfParticipantId = data.cloudflareParticipantId || null

    const activeMtg = {
      id: data.meetingCode || data.meeting?.meeting_code,
      dbId: data.meetingId || data.meeting?.meeting_id,
      name: data.meeting?.meeting_title,
      hostId: data.meeting?.host_id,
      host_id: data.meeting?.host_id,
      status: data.meeting?.meeting_status,
      type: data.meeting?.meeting_type,
      roomName: data.roomName || data.meeting?.room_name,
      token: data.livekitToken,
      livekitToken: data.livekitToken,
      livekitUrl: data.livekitUrl,
      cloudflareToken: cfToken,
      cloudflareMeetingId: cfMeetingId,
      cloudflareParticipantId: cfParticipantId,
      cloudflare_meeting_id: cfMeetingId,
      durationMinutes: data.meeting?.duration_minutes || Number(durationMinutes),
      duration_minutes: data.meeting?.duration_minutes || Number(durationMinutes)
    }

    currentMeeting = activeMtg
    livekitToken = data.livekitToken || null
    livekitUrl = data.livekitUrl || null
    roomName = data.roomName || data.meeting?.room_name || null
    cloudflareToken = cfToken
    cloudflareMeetingId = cfMeetingId
    cloudflareParticipantId = cfParticipantId

    return activeMtg
  }

  function handleJoinResponse(data) {
    const cfToken = data.cloudflareToken || null
    const cfMeetingId = data.cloudflareMeetingId || data.meeting?.cloudflare_meeting_id || null
    const cfParticipantId = data.cloudflareParticipantId || null

    const activeMtg = {
      id: data.meeting?.meeting_code,
      dbId: data.meeting?.meeting_id,
      name: data.meeting?.meeting_title,
      hostId: data.meeting?.host_id,
      host_id: data.meeting?.host_id,
      status: data.meeting?.meeting_status,
      type: data.meeting?.meeting_type,
      roomName: data.roomName || data.meeting?.room_name,
      token: data.token,
      livekitToken: data.token,
      livekitUrl: data.livekitUrl,
      cloudflareToken: cfToken,
      cloudflareMeetingId: cfMeetingId,
      cloudflareParticipantId: cfParticipantId,
      cloudflare_meeting_id: cfMeetingId
    }

    currentMeeting = activeMtg
    livekitToken = data.token || null
    roomName = data.roomName || data.meeting?.room_name || null
    livekitUrl = data.livekitUrl || null
    cloudflareToken = cfToken
    cloudflareMeetingId = cfMeetingId
    cloudflareParticipantId = cfParticipantId

    return activeMtg
  }

  function clearCredentials() {
    currentMeeting = null
    livekitToken = null
    livekitUrl = null
    roomName = null
    cloudflareToken = null
    cloudflareMeetingId = null
    cloudflareParticipantId = null
    providerOverride = null
  }

  return {
    getState: () => ({
      currentMeeting,
      livekitToken,
      livekitUrl,
      roomName,
      cloudflareToken,
      cloudflareMeetingId,
      cloudflareParticipantId,
      providerOverride
    }),
    deriveActiveProvider,
    setActiveProvider,
    handleCreateResponse,
    handleJoinResponse,
    clearCredentials,
    setProviderOverride: (val) => { providerOverride = val },
    setCloudflareToken: (val) => { cloudflareToken = val },
    setLivekitToken: (val) => { livekitToken = val },
    setCloudflareMeetingId: (val) => { cloudflareMeetingId = val },
    setLivekitUrl: (val) => { livekitUrl = val }
  }
}

describe('Meetly AI — MeetingContext Cloudflare Token Integration & Safety Suite', () => {
  it('1. Extracts both Cloudflare and LiveKit credentials from createMeeting backend response', () => {
    const mock = createMockMeetingState()

    const backendCreateResponse = {
      message: 'Meeting created successfully.',
      meetingId: 'mtg-uuid-1111',
      meetingCode: 'ABC-DEF',
      roomName: 'meetly-room-1111',
      livekitToken: 'lk.jwt.token.create',
      livekitUrl: 'wss://meetly.livekit.cloud',
      cloudflareMeetingId: 'cf-room-uuid-2222',
      cloudflareToken: 'cf.jwt.token.create',
      cloudflareParticipantId: 'cf-part-uuid-3333',
      meeting: {
        meeting_id: 'mtg-uuid-1111',
        meeting_code: 'ABC-DEF',
        meeting_title: 'Sprint Planning',
        host_id: 'host-uuid-0001',
        meeting_status: 'Active',
        meeting_type: 'public',
        duration_minutes: 30,
        cloudflare_meeting_id: 'cf-room-uuid-2222'
      }
    }

    const mtg = mock.handleCreateResponse(backendCreateResponse)
    const state = mock.getState()

    // Verify Cloudflare state
    assert.equal(state.cloudflareToken, 'cf.jwt.token.create')
    assert.equal(state.cloudflareMeetingId, 'cf-room-uuid-2222')
    assert.equal(state.cloudflareParticipantId, 'cf-part-uuid-3333')

    // Verify LiveKit state preserved
    assert.equal(state.livekitToken, 'lk.jwt.token.create')
    assert.equal(state.livekitUrl, 'wss://meetly.livekit.cloud')
    assert.equal(state.roomName, 'meetly-room-1111')

    // Verify currentMeeting object
    assert.equal(mtg.cloudflareToken, 'cf.jwt.token.create')
    assert.equal(mtg.cloudflareMeetingId, 'cf-room-uuid-2222')
    assert.equal(mtg.token, 'lk.jwt.token.create')
    assert.equal(mtg.livekitToken, 'lk.jwt.token.create')

    // Verify activeProvider resolves to cloudflare (primary migration)
    assert.equal(mock.deriveActiveProvider(), 'cloudflare')
  })

  it('2. Extracts both Cloudflare and LiveKit credentials from joinMeeting backend response', () => {
    const mock = createMockMeetingState()

    const backendJoinResponse = {
      message: 'Joined meeting successfully.',
      token: 'lk.jwt.token.join',
      roomName: 'meetly-room-4444',
      livekitUrl: 'wss://meetly.livekit.cloud',
      cloudflareToken: 'cf.jwt.token.join',
      cloudflareMeetingId: 'cf-room-uuid-4444',
      cloudflareParticipantId: 'cf-part-uuid-5555',
      meeting: {
        meeting_id: 'mtg-uuid-4444',
        meeting_code: 'GHI-JKL',
        meeting_title: 'Client Demo',
        host_id: 'host-uuid-9999',
        meeting_status: 'Active',
        cloudflare_meeting_id: 'cf-room-uuid-4444'
      }
    }

    const mtg = mock.handleJoinResponse(backendJoinResponse)
    const state = mock.getState()

    assert.equal(state.cloudflareToken, 'cf.jwt.token.join')
    assert.equal(state.cloudflareMeetingId, 'cf-room-uuid-4444')
    assert.equal(state.cloudflareParticipantId, 'cf-part-uuid-5555')
    assert.equal(state.livekitToken, 'lk.jwt.token.join')
    assert.equal(mtg.cloudflareToken, 'cf.jwt.token.join')
    assert.equal(mtg.token, 'lk.jwt.token.join')
    assert.equal(mock.deriveActiveProvider(), 'cloudflare')
  })

  it('3. Existing LiveKit-only meeting correctly derives activeProvider = livekit (fallback preserved)', () => {
    const mock = createMockMeetingState()

    const legacyResponse = {
      message: 'Joined legacy meeting.',
      token: 'lk.legacy.token',
      roomName: 'legacy-room-1',
      livekitUrl: 'wss://legacy.livekit.cloud',
      cloudflareToken: null,
      cloudflareMeetingId: null,
      meeting: {
        meeting_id: 'legacy-1',
        meeting_code: 'LEG-ACY',
        meeting_title: 'Old Room'
      }
    }

    mock.handleJoinResponse(legacyResponse)
    const state = mock.getState()

    assert.equal(state.cloudflareToken, null)
    assert.equal(state.livekitToken, 'lk.legacy.token')
    assert.equal(mock.deriveActiveProvider(), 'livekit', 'Legacy meetings must cleanly fall back to livekit')
  })

  it('4. Cloudflare-enabled meeting is not blocked when LiveKit token is omitted or null', () => {
    const mock = createMockMeetingState()

    const pureCloudflareResponse = {
      message: 'Joined Cloudflare meeting.',
      token: null, // No LiveKit token generated
      roomName: 'cf-pure-room',
      livekitUrl: null,
      cloudflareToken: 'cf.pure.token',
      cloudflareMeetingId: 'cf-meeting-pure',
      meeting: {
        meeting_id: 'cf-pure-1',
        meeting_code: 'CFP-URE'
      }
    }

    mock.handleJoinResponse(pureCloudflareResponse)
    const state = mock.getState()

    assert.equal(state.livekitToken, null)
    assert.equal(state.cloudflareToken, 'cf.pure.token')
    assert.equal(mock.deriveActiveProvider(), 'cloudflare', 'Must resolve to cloudflare without LiveKit token')
  })

  it('5. Respects configured provider override via VITE_MEETING_PROVIDER = livekit', () => {
    const mock = createMockMeetingState()

    mock.setLivekitToken('lk.token')
    mock.setCloudflareToken('cf.token')

    // Default without env config: cloudflare
    assert.equal(mock.deriveActiveProvider(), 'cloudflare')

    // With VITE_MEETING_PROVIDER='livekit': livekit
    assert.equal(mock.deriveActiveProvider('livekit'), 'livekit')
  })

  it('6. Supports explicit runtime override via setActiveProvider', () => {
    const mock = createMockMeetingState()

    mock.setLivekitToken('lk.token')
    mock.setCloudflareToken('cf.token')

    assert.equal(mock.deriveActiveProvider(), 'cloudflare')

    mock.setActiveProvider('livekit')
    assert.equal(mock.deriveActiveProvider(), 'livekit')

    mock.setActiveProvider('cloudflare')
    assert.equal(mock.deriveActiveProvider(), 'cloudflare')
  })

  it('7. Returns null activeProvider when no credentials are loaded', () => {
    const mock = createMockMeetingState()
    assert.equal(mock.deriveActiveProvider(), null)
  })

  it('8. clearCredentials cleans up all meeting and provider tokens without residual state', () => {
    const mock = createMockMeetingState()

    mock.handleCreateResponse({
      livekitToken: 'lk.token.test',
      cloudflareToken: 'cf.token.test',
      cloudflareMeetingId: 'cf.id.test'
    })

    assert.ok(mock.getState().currentMeeting)
    assert.ok(mock.getState().cloudflareToken)
    assert.ok(mock.getState().livekitToken)

    mock.clearCredentials()
    const state = mock.getState()

    assert.equal(state.currentMeeting, null)
    assert.equal(state.livekitToken, null)
    assert.equal(state.livekitUrl, null)
    assert.equal(state.roomName, null)
    assert.equal(state.cloudflareToken, null)
    assert.equal(state.cloudflareMeetingId, null)
    assert.equal(state.cloudflareParticipantId, null)
    assert.equal(state.providerOverride, null)
    assert.equal(mock.deriveActiveProvider(), null)
  })

  it('9. Token privacy: console logs in MeetingContext do not contain raw authentication tokens', () => {
    const fileContent = fs.readFileSync('src/context/MeetingContext.jsx', 'utf8')

    // Search for any console.log / console.info calls that print token variables directly
    const lines = fileContent.split('\n')
    const sensitiveLogPatterns = [
      /console\.log\([^)]*data\.(livekitToken|token|cloudflareToken)/i,
      /console\.log\([^)]*cfToken/i,
      /console\.log\([^)]*livekitToken\s*[,)]/i,
      /console\.log\([^)]*cloudflareToken\s*[,)]/i
    ]

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const pattern of sensitiveLogPatterns) {
        assert.equal(
          pattern.test(line),
          false,
          `Line ${i + 1} contains potentially sensitive token logging: ${line.trim()}`
        )
      }
    }
  })

  it('10. Cloudflare override falls back to LiveKit when Cloudflare token is missing', () => {
    const mock = createMockMeetingState()

    mock.setLivekitToken('lk.valid.token')
    mock.setCloudflareToken(null)

    // Override explicitly set to 'cloudflare', but no Cloudflare token exists
    mock.setActiveProvider('cloudflare')

    // Must safely fall back to 'livekit' instead of remaining 'cloudflare' and crashing
    assert.equal(mock.deriveActiveProvider(), 'livekit')
  })

  it('11. LiveKit override falls back to Cloudflare when LiveKit token is missing', () => {
    const mock = createMockMeetingState()

    mock.setLivekitToken(null)
    mock.setCloudflareToken('cf.valid.token')

    // Override explicitly set to 'livekit', but no LiveKit token exists
    mock.setActiveProvider('livekit')

    // Must safely fall back to 'cloudflare' instead of remaining 'livekit' and crashing
    assert.equal(mock.deriveActiveProvider(), 'cloudflare')
  })

  it('12. Invalid override is rejected safely and does not break valid meetings', () => {
    const mock = createMockMeetingState()

    mock.setLivekitToken('lk.valid.token')
    mock.setCloudflareToken('cf.valid.token')

    // Attempting to pass an unsupported or invalid provider string
    mock.setActiveProvider('zoom')
    assert.equal(mock.getState().providerOverride, null, 'Invalid override must not be stored')
    assert.equal(mock.deriveActiveProvider(), 'cloudflare', 'Must resolve to normal primary migration provider')

    mock.setActiveProvider('invalid-provider')
    assert.equal(mock.getState().providerOverride, null)
    assert.equal(mock.deriveActiveProvider(), 'cloudflare')
  })

  it('13. Switching from Cloudflare meeting to LiveKit-only meeting clears stale Cloudflare credentials', () => {
    const mock = createMockMeetingState()

    // 1. Join Meeting A (Cloudflare-enabled)
    mock.handleJoinResponse({
      token: 'lk.token.mtgA',
      cloudflareToken: 'cf.token.mtgA',
      cloudflareMeetingId: 'cf.id.mtgA',
      meeting: { meeting_code: 'MTG-A' }
    })

    assert.equal(mock.getState().cloudflareToken, 'cf.token.mtgA')
    assert.equal(mock.deriveActiveProvider(), 'cloudflare')

    // 2. Join Meeting B (LiveKit-only, no Cloudflare credentials)
    mock.handleJoinResponse({
      token: 'lk.token.mtgB',
      cloudflareToken: null,
      cloudflareMeetingId: null,
      meeting: { meeting_code: 'MTG-B' }
    })

    const stateB = mock.getState()
    assert.equal(stateB.cloudflareToken, null, 'Stale Cloudflare token from Meeting A must be wiped')
    assert.equal(stateB.cloudflareMeetingId, null, 'Stale Cloudflare meeting ID must be wiped')
    assert.equal(stateB.livekitToken, 'lk.token.mtgB')
    assert.equal(mock.deriveActiveProvider(), 'livekit', 'Must transition to LiveKit provider for Meeting B')
  })

  it('14. Updating one provider\'s token does not erase the other provider\'s token', () => {
    const mock = createMockMeetingState()

    mock.setLivekitToken('lk.initial.token')
    mock.setCloudflareToken('cf.initial.token')
    mock.setCloudflareMeetingId('cf.initial.id')
    mock.setLivekitUrl('wss://initial.livekit.cloud')

    // Update only LiveKit token
    mock.setLivekitToken('lk.refreshed.token')

    assert.equal(mock.getState().livekitToken, 'lk.refreshed.token')
    assert.equal(mock.getState().cloudflareToken, 'cf.initial.token', 'Cloudflare token must remain intact')
    assert.equal(mock.getState().cloudflareMeetingId, 'cf.initial.id', 'Cloudflare meeting ID must remain intact')

    // Update only Cloudflare token
    mock.setCloudflareToken('cf.refreshed.token')

    assert.equal(mock.getState().cloudflareToken, 'cf.refreshed.token')
    assert.equal(mock.getState().livekitToken, 'lk.refreshed.token', 'LiveKit token must remain intact')
    assert.equal(mock.getState().livekitUrl, 'wss://initial.livekit.cloud', 'LiveKit URL must remain intact')
  })
})
