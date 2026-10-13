import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHAT_POLICIES,
  getOrCreateRoomChat,
  getChatPolicy,
  setChatPolicy,
  isUserHostOrCoHost,
  canUserSendMessage,
  addRoomMessage,
  getUserVisibleMessages,
  clearMeetingChat,
  resetAllMeetingChats,
  getMeetingChatStats
} from '../services/meetingChatService.js'

describe('Zoom-Style Ephemeral Meeting Chat System', () => {
  const ROOM = 'test-room-uuid-1234'
  const HOST_ID = 'host-uuid-1111'
  const COHOST_ID = 'cohost-uuid-2222'
  const USER_A = 'user-uuid-aaaa'
  const USER_B = 'user-uuid-bbbb'
  const USER_C = 'user-uuid-cccc'

  const mockMeeting = {
    host_id: HOST_ID,
    assigned_host_id: COHOST_ID,
    active_host_id: HOST_ID
  }

  beforeEach(() => {
    resetAllMeetingChats()
  })

  describe('1. Everyone Group Chat & Room Lifecycle', () => {
    it('initializes a room with default policy "everyone_and_direct"', () => {
      const room = getOrCreateRoomChat(ROOM)
      assert.ok(room)
      assert.equal(room.policy, CHAT_POLICIES.EVERYONE_AND_DIRECT)
      assert.equal(room.messages.length, 0)
    })

    it('allows everyone in room to post and view group messages', () => {
      const msg1 = addRoomMessage(ROOM, {
        senderId: USER_A,
        senderName: 'Alice',
        text: 'Hello everyone!',
        isDirect: false
      })

      const msg2 = addRoomMessage(ROOM, {
        senderId: USER_B,
        senderName: 'Bob',
        text: 'Hey Alice!',
        isDirect: false
      })

      assert.equal(msg1.text, 'Hello everyone!')
      assert.equal(msg2.text, 'Hey Alice!')

      // Both Alice, Bob, and third party Charlie can see group messages
      const aliceView = getUserVisibleMessages(ROOM, USER_A)
      const bobView = getUserVisibleMessages(ROOM, USER_B)
      const charlieView = getUserVisibleMessages(ROOM, USER_C)

      assert.equal(aliceView.length, 2)
      assert.equal(bobView.length, 2)
      assert.equal(charlieView.length, 2)
    })

    it('enforces FIFO cap to prevent unbounded in-memory growth', () => {
      for (let i = 0; i < 505; i++) {
        addRoomMessage(ROOM, {
          senderId: USER_A,
          senderName: 'Alice',
          text: `Message ${i}`,
          isDirect: false
        })
      }

      const stats = getMeetingChatStats(ROOM)
      assert.equal(stats.messageCount, 500, 'Must cap messages in memory to 500')
      const visible = getUserVisibleMessages(ROOM, USER_A)
      assert.equal(visible[0].text, 'Message 5')
      assert.equal(visible[visible.length - 1].text, 'Message 504')
    })
  })

  describe('2. Private 1:1 Direct Messaging Privacy & Strict Isolation', () => {
    it('isolates direct messages between sender and recipient', () => {
      // Alice sends direct message to Bob
      const dmAliceToBob = addRoomMessage(ROOM, {
        senderId: USER_A,
        senderName: 'Alice',
        recipientId: USER_B,
        recipientName: 'Bob',
        isDirect: true,
        text: 'Hey Bob, secret project discussion'
      })

      // Bob replies to Alice
      const dmBobToAlice = addRoomMessage(ROOM, {
        senderId: USER_B,
        senderName: 'Bob',
        recipientId: USER_A,
        recipientName: 'Alice',
        isDirect: true,
        text: 'Got it Alice, looks great'
      })

      // Public message to Everyone
      addRoomMessage(ROOM, {
        senderId: USER_C,
        senderName: 'Charlie',
        isDirect: false,
        text: 'Public announcement for all'
      })

      // Alice sees 2 DMs + 1 public = 3 messages
      const aliceView = getUserVisibleMessages(ROOM, USER_A)
      assert.equal(aliceView.length, 3)

      // Bob sees 2 DMs + 1 public = 3 messages
      const bobView = getUserVisibleMessages(ROOM, USER_B)
      assert.equal(bobView.length, 3)

      // Charlie (unrelated participant) sees ONLY the 1 public message!
      // Charlie must NEVER see Alice and Bob's private DMs
      const charlieView = getUserVisibleMessages(ROOM, USER_C)
      assert.equal(charlieView.length, 1)
      assert.equal(charlieView[0].text, 'Public announcement for all')
    })
  })

  describe('3. Host-Only Chat Settings & Permission Matrix (4 Options)', () => {
    it('correctly identifies Host and Assigned Host/Co-host', () => {
      assert.equal(isUserHostOrCoHost(mockMeeting, HOST_ID), true)
      assert.equal(isUserHostOrCoHost(mockMeeting, COHOST_ID), true)
      assert.equal(isUserHostOrCoHost(mockMeeting, USER_A), false)
      assert.equal(isUserHostOrCoHost(mockMeeting, USER_B), false)
    })

    it('Option 1: "no_one" policy blocks participants from sending any chat', () => {
      setChatPolicy(ROOM, CHAT_POLICIES.NO_ONE)
      assert.equal(getChatPolicy(ROOM), CHAT_POLICIES.NO_ONE)

      // Participant trying to send to everyone
      const checkEveryone = canUserSendMessage({
        roomName: ROOM,
        senderId: USER_A,
        isSenderHost: false,
        isDirect: false
      })
      assert.equal(checkEveryone.allowed, false)
      assert.match(checkEveryone.reason, /disabled chat/i)

      // Participant trying to send direct message
      const checkDirect = canUserSendMessage({
        roomName: ROOM,
        senderId: USER_A,
        isSenderHost: false,
        isDirect: true,
        recipientId: USER_B,
        isRecipientHost: false
      })
      assert.equal(checkDirect.allowed, false)

      // Host is still allowed to send messages
      const checkHost = canUserSendMessage({
        roomName: ROOM,
        senderId: HOST_ID,
        isSenderHost: true,
        isDirect: false
      })
      assert.equal(checkHost.allowed, true)
    })

    it('Option 2: "host_and_cohost" policy restricts participants to messaging hosts only', () => {
      setChatPolicy(ROOM, CHAT_POLICIES.HOST_AND_COHOST)

      // Participant trying to message Everyone -> BLOCKED
      const checkEveryone = canUserSendMessage({
        roomName: ROOM,
        senderId: USER_A,
        isSenderHost: false,
        isDirect: false
      })
      assert.equal(checkEveryone.allowed, false)
      assert.match(checkEveryone.reason, /only message the host/i)

      // Participant trying to DM regular peer User B -> BLOCKED
      const checkPeerDM = canUserSendMessage({
        roomName: ROOM,
        senderId: USER_A,
        isSenderHost: false,
        isDirect: true,
        recipientId: USER_B,
        isRecipientHost: false
      })
      assert.equal(checkPeerDM.allowed, false)

      // Participant DMing Host -> ALLOWED
      const checkHostDM = canUserSendMessage({
        roomName: ROOM,
        senderId: USER_A,
        isSenderHost: false,
        isDirect: true,
        recipientId: HOST_ID,
        isRecipientHost: true
      })
      assert.equal(checkHostDM.allowed, true)

      // Participant DMing Co-Host -> ALLOWED
      const checkCohostDM = canUserSendMessage({
        roomName: ROOM,
        senderId: USER_A,
        isSenderHost: false,
        isDirect: true,
        recipientId: COHOST_ID,
        isRecipientHost: true
      })
      assert.equal(checkCohostDM.allowed, true)
    })

    it('Option 3: "everyone" policy allows group messages but blocks direct 1:1 messages', () => {
      setChatPolicy(ROOM, CHAT_POLICIES.EVERYONE)

      // Participant posting to Everyone -> ALLOWED
      const checkEveryone = canUserSendMessage({
        roomName: ROOM,
        senderId: USER_A,
        isSenderHost: false,
        isDirect: false
      })
      assert.equal(checkEveryone.allowed, true)

      // Participant sending direct message -> BLOCKED
      const checkDirect = canUserSendMessage({
        roomName: ROOM,
        senderId: USER_A,
        isSenderHost: false,
        isDirect: true,
        recipientId: USER_B,
        isRecipientHost: false
      })
      assert.equal(checkDirect.allowed, false)
      assert.match(checkDirect.reason, /Direct 1:1 messaging between participants is disabled/i)

      // Host can still send direct message
      const checkHostDirect = canUserSendMessage({
        roomName: ROOM,
        senderId: HOST_ID,
        isSenderHost: true,
        isDirect: true,
        recipientId: USER_B,
        isRecipientHost: false
      })
      assert.equal(checkHostDirect.allowed, true)
    })

    it('Option 4: "everyone_and_direct" policy allows group and direct messages for all', () => {
      setChatPolicy(ROOM, CHAT_POLICIES.EVERYONE_AND_DIRECT)

      const checkEveryone = canUserSendMessage({
        roomName: ROOM,
        senderId: USER_A,
        isSenderHost: false,
        isDirect: false
      })
      assert.equal(checkEveryone.allowed, true)

      const checkDirect = canUserSendMessage({
        roomName: ROOM,
        senderId: USER_A,
        isSenderHost: false,
        isDirect: true,
        recipientId: USER_B,
        isRecipientHost: false
      })
      assert.equal(checkDirect.allowed, true)
    })
  })

  describe('4. Ephemeral File Attachments (In-Memory Only)', () => {
    it('accepts valid ephemeral attachments under 3 MB', () => {
      const smallDataUrl = 'data:text/plain;base64,SGVsbG8gTWVldGx5'
      const msg = addRoomMessage(ROOM, {
        senderId: USER_A,
        senderName: 'Alice',
        text: 'Here is the meeting notes text file',
        attachment: {
          name: 'notes.txt',
          size: 1024,
          type: 'text/plain',
          dataUrl: smallDataUrl
        }
      })

      assert.ok(msg.attachment)
      assert.equal(msg.attachment.name, 'notes.txt')
      assert.equal(msg.attachment.size, 1024)
      assert.equal(msg.attachment.dataUrl, smallDataUrl)
    })

    it('rejects oversized attachments exceeding 3 MB limit', () => {
      assert.throws(() => {
        addRoomMessage(ROOM, {
          senderId: USER_A,
          senderName: 'Alice',
          text: 'Oversized file',
          attachment: {
            name: 'large_video.mp4',
            size: 4 * 1024 * 1024, // 4 MB > 3 MB limit
            type: 'video/mp4',
            dataUrl: 'data:video/mp4;base64,AAAA'
          }
        })
      }, /Attachment exceeds maximum ephemeral size limit/)
    })
  })

  describe('5. Zero Persistent Storage & Meeting-End Cleanup', () => {
    it('completely purges all in-memory chat state when meeting ends', () => {
      // Add multiple messages
      addRoomMessage(ROOM, {
        senderId: USER_A,
        senderName: 'Alice',
        text: 'Group message 1',
        isDirect: false
      })
      addRoomMessage(ROOM, {
        senderId: USER_B,
        senderName: 'Bob',
        recipientId: USER_A,
        text: 'Private DM',
        isDirect: true
      })

      assert.equal(getMeetingChatStats(ROOM).messageCount, 2)

      // Meeting concludes: trigger clearMeetingChat
      const cleared = clearMeetingChat(ROOM)
      assert.equal(cleared, true)

      // Verification: stats return null and visible messages array is empty
      assert.equal(getMeetingChatStats(ROOM), null)
      assert.equal(getUserVisibleMessages(ROOM, USER_A).length, 0)
      assert.equal(getUserVisibleMessages(ROOM, USER_B).length, 0)
    })

    it('guarantees complete isolation between different meeting rooms', () => {
      const ROOM_1 = 'room-1111'
      const ROOM_2 = 'room-2222'

      addRoomMessage(ROOM_1, {
        senderId: USER_A,
        senderName: 'Alice',
        text: 'Message in Room 1'
      })

      addRoomMessage(ROOM_2, {
        senderId: USER_B,
        senderName: 'Bob',
        text: 'Message in Room 2'
      })

      const room1Messages = getUserVisibleMessages(ROOM_1, USER_A)
      const room2Messages = getUserVisibleMessages(ROOM_2, USER_B)

      assert.equal(room1Messages.length, 1)
      assert.equal(room1Messages[0].text, 'Message in Room 1')

      assert.equal(room2Messages.length, 1)
      assert.equal(room2Messages[0].text, 'Message in Room 2')

      // Clearing Room 1 leaves Room 2 unaffected
      clearMeetingChat(ROOM_1)
      assert.equal(getMeetingChatStats(ROOM_1), null)
      assert.equal(getMeetingChatStats(ROOM_2).messageCount, 1)
    })
  })
})
