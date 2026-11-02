import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveEffectiveProvider,
  shouldMountProvider,
  validateSharedAdapterProps
} from '../../src/components/meeting/providerSelectionUtils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const meetingRoomPath = path.resolve(__dirname, '../../src/pages/MeetingRoom.jsx')

describe('Meetly AI — MeetingRoom Cloudflare RealtimeKit Sole Provider Integration Suite', () => {

  it('1. Cloudflare provider selection with valid Cloudflare credentials', () => {
    const provider = resolveEffectiveProvider({
      activeProvider: 'cloudflare',
      cloudflareToken: 'cf-valid-token-12345'
    })
    assert.strictEqual(provider, 'cloudflare', 'Effective provider must be cloudflare')

    const mount = shouldMountProvider({
      effectiveProvider: provider,
      cloudflareToken: 'cf-valid-token-12345'
    })
    assert.strictEqual(mount.mountCloudflare, true, 'Cloudflare branch must mount')
    assert.strictEqual(mount.mountLiveKit, false, 'LiveKit branch must NOT mount')
    assert.strictEqual(mount.hasUsableCredentials, true, 'Usable credentials must be true')
    assert.strictEqual(mount.selectedProvider, 'cloudflare')
  })

  it('2. LiveKit is decommissioned: absent Cloudflare credentials results in null provider', () => {
    const provider = resolveEffectiveProvider({
      activeProvider: 'livekit',
      cloudflareToken: null
    })
    assert.strictEqual(provider, null, 'Provider must be null when cloudflare token is absent')

    const mount = shouldMountProvider({
      effectiveProvider: provider,
      cloudflareToken: null
    })
    assert.strictEqual(mount.mountCloudflare, false, 'Cloudflare branch must NOT mount')
    assert.strictEqual(mount.mountLiveKit, false, 'LiveKit branch must NOT mount')
    assert.strictEqual(mount.hasUsableCredentials, false, 'Usable credentials must be false')
    assert.strictEqual(mount.selectedProvider, null)
  })

  it('3. Missing Cloudflare token prevents mounting', () => {
    const provider = resolveEffectiveProvider({
      activeProvider: 'cloudflare',
      cloudflareToken: null
    })
    assert.strictEqual(provider, null, 'Must be null when cloudflare token is missing')

    const mount = shouldMountProvider({
      effectiveProvider: provider,
      cloudflareToken: null
    })
    assert.strictEqual(mount.mountCloudflare, false)
    assert.strictEqual(mount.mountLiveKit, false)
    assert.strictEqual(mount.selectedProvider, null)
  })

  it('4. Cloudflare credentials resolve to cloudflare provider', () => {
    const provider = resolveEffectiveProvider({
      cloudflareToken: 'cf-token-888'
    })
    assert.strictEqual(provider, 'cloudflare', 'Must resolve to cloudflare when token is present')

    const mount = shouldMountProvider({
      effectiveProvider: provider,
      cloudflareToken: 'cf-token-888'
    })
    assert.strictEqual(mount.mountCloudflare, true)
    assert.strictEqual(mount.mountLiveKit, false)
    assert.strictEqual(mount.selectedProvider, 'cloudflare')
  })

  it('5. Neither provider having valid credentials: does not mount either provider and flags missing credentials', () => {
    const provider = resolveEffectiveProvider({
      activeProvider: null,
      cloudflareToken: null
    })
    assert.strictEqual(provider, null, 'Effective provider must be null when neither token exists')

    const mount = shouldMountProvider({
      effectiveProvider: provider,
      cloudflareToken: null
    })
    assert.strictEqual(mount.mountCloudflare, false, 'Must not mount Cloudflare')
    assert.strictEqual(mount.mountLiveKit, false, 'Must not mount LiveKit')
    assert.strictEqual(mount.hasUsableCredentials, false, 'Usable credentials must be false')
    assert.strictEqual(mount.selectedProvider, null)
  })

  it('6. Cloudflare RealtimeKit is sole mounted provider: LiveKit never mounts', () => {
    const provider = resolveEffectiveProvider({
      activeProvider: 'cloudflare',
      cloudflareToken: 'cf-tok-1'
    })
    assert.strictEqual(provider, 'cloudflare')

    const mount = shouldMountProvider({
      effectiveProvider: provider,
      cloudflareToken: 'cf-tok-1'
    })
    assert.strictEqual(mount.mountCloudflare, true)
    assert.strictEqual(mount.mountLiveKit, false)
    assert.strictEqual(mount.mountCloudflare && mount.mountLiveKit, false, 'Both providers can NEVER mount simultaneously')
  })

  it('7. Session provider management: resets cleanly when credentials are cleared', () => {
    let cloudflareToken = 'cf-tok-active'

    let provider = resolveEffectiveProvider({
      activeProvider: 'cloudflare',
      cloudflareToken
    })
    assert.strictEqual(provider, 'cloudflare', 'Active provider is cloudflare')

    // On intentional leave or credential clear
    cloudflareToken = null
    provider = resolveEffectiveProvider({
      activeProvider: null,
      cloudflareToken
    })
    assert.strictEqual(provider, null, 'Resetting credentials clears provider')
  })

  it('8. LiveKitRoom and RoomAudioRenderer are completely removed from MeetingRoom.jsx', () => {
    const source = fs.readFileSync(meetingRoomPath, 'utf8')

    // Verify LiveKitRoom and RoomAudioRenderer are not present
    assert.doesNotMatch(
      source,
      /<LiveKitRoom/,
      'LiveKitRoom must NOT exist in MeetingRoom.jsx'
    )
    assert.doesNotMatch(
      source,
      /<RoomAudioRenderer/,
      'RoomAudioRenderer must NOT exist in MeetingRoom.jsx'
    )

    // Verify RealtimeKitAdapter is mounted directly
    assert.match(
      source,
      /<RealtimeKitAdapter/,
      'MeetingRoom.jsx must mount RealtimeKitAdapter directly'
    )
  })

  it('9. MeetingRoomView receives the correct normalized props across adapter', () => {
    const mockProps = {
      meetingData: { meeting_id: 'm-123' },
      setMeetingData: () => {},
      isHost: true,
      handleLeave: () => {},
      handleEndMeeting: () => {},
      handleDeleteMeeting: () => {},
      handleRename: () => {},
      handleCopyCode: () => {},
      handleCopyLink: () => {},
      lockMeeting: () => {},
      activateMeeting: () => {},
      showToast: () => {},
      user: { id: 'u-1' },
      attendanceConsent: 'Granted',
      endMeeting: () => {},
      expireMeeting: () => {},
      socket: { current: null },
      socketReady: 1,
      chatMessages: [],
      setChatMessages: () => {},
      ephemeralChatMessages: [],
      setEphemeralChatMessages: () => {},
      ephemeralChatPolicy: 'everyone',
      setEphemeralChatPolicy: () => {},
      activeChatConvTab: 'everyone',
      setActiveChatConvTab: () => {},
      selectedChatRecipient: null,
      setSelectedChatRecipient: () => {},
      typingUsers: {},
      setTypingUsers: () => {},
      handleLeaveWithAttendanceRef: { current: null },
      waitingRequests: [],
      fetchWaitingRequests: () => {},
      isIntentionalLeaveRef: { current: false },
      dbParticipants: []
    }

    const validation = validateSharedAdapterProps(mockProps)
    assert.strictEqual(validation.isValid, true, 'All shared adapter props must be present')
    assert.deepStrictEqual(validation.missing, [])

    // Verify MeetingRoom.jsx passes sharedAdapterProps to RealtimeKitAdapter and LiveKitAdapter is gone
    const source = fs.readFileSync(meetingRoomPath, 'utf8')
    assert.match(source, /<RealtimeKitAdapter[\s\S]*?\.\.\.sharedAdapterProps/, 'RealtimeKitAdapter receives sharedAdapterProps')
    assert.doesNotMatch(source, /<LiveKitAdapter/, 'LiveKitAdapter must not exist in MeetingRoom.jsx')
  })

  it('10. Existing waiting-room and leave behavior remains intact in MeetingRoom.jsx', () => {
    const source = fs.readFileSync(meetingRoomPath, 'utf8')

    // Waiting room approval check
    assert.match(source, /if\s*\(\s*isWaitingForApproval\s*\)/, 'Waiting room approval screen must be preserved')

    // Intentional leave check
    assert.match(source, /if\s*\(\s*isIntentionalLeaveRef\.current\s*\)\s*\{\s*return null/, 'Intentional leave must exit immediately')

    // Socket.IO participant_accepted listener
    assert.match(source, /socket\.current\.on\('participant_accepted'/, 'participant_accepted socket listener must be preserved')

    // Socket.IO participant_banned and removed listeners with credential clearing
    assert.match(source, /socket\.current\.on\('participant_banned'/, 'participant_banned socket listener must be preserved')
    assert.match(source, /socket\.current\.on\('participant_removed'/, 'participant_removed socket listener must be preserved')
  })
})
