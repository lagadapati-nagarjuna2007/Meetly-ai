/**
 * In-Memory Ephemeral Meeting Chat Service
 *
 * MANDATORY PRIVACY RULE (NON-NEGOTIABLE):
 * - Chat messages and conversation history must NEVER be stored permanently.
 * - ZERO database tables, ZERO migrations, ZERO file writes, ZERO S3/B2 uploads.
 * - Messages and ephemeral attachments exist solely in memory while the meeting is active.
 * - When the meeting ends, all in-memory state for the room is completely purged.
 */

const MAX_MESSAGES_PER_ROOM = 500
const MAX_ATTACHMENT_SIZE_BYTES = 3 * 1024 * 1024 // 3 MB in-memory attachment limit

export const CHAT_POLICIES = {
  NO_ONE: 'no_one',
  HOST_AND_COHOST: 'host_and_cohost',
  EVERYONE: 'everyone',
  EVERYONE_AND_DIRECT: 'everyone_and_direct'
}

// Map<roomName, { policy: string, seq: number, groupMessages: Array<ChatMessage>, directConversations: Map<string, Array<ChatMessage>> }>
const meetingChatRooms = new Map()

// Set<roomName> tracking rooms whose meetings have ended so history cannot be restored after meeting end
const endedMeetingRooms = new Set()

/**
 * Generates a canonical, order-independent conversation key for two participant user IDs.
 */
export const getDirectConversationKey = (userIdA, userIdB) => {
  if (!userIdA || !userIdB) return null
  const a = String(userIdA).trim().toLowerCase()
  const b = String(userIdB).trim().toLowerCase()
  if (!a || !b) return null
  return [a, b].sort().join('::')
}

/**
 * Returns true if the given room's meeting chat has been permanently cleared/ended.
 */
export const isRoomChatEnded = (roomName) => {
  if (!roomName) return false
  return endedMeetingRooms.has(roomName)
}

/**
 * Gets or creates the in-memory chat state for an active meeting room.
 * Default policy is 'everyone_and_direct'.
 * Returns null if roomName is missing or if the meeting has already ended.
 */
export const getOrCreateRoomChat = (roomName) => {
  if (!roomName || endedMeetingRooms.has(roomName)) return null
  if (!meetingChatRooms.has(roomName)) {
    const roomState = {
      policy: CHAT_POLICIES.EVERYONE_AND_DIRECT,
      seq: 0,
      groupMessages: [],
      directConversations: new Map()
    }
    Object.defineProperty(roomState, 'messages', {
      get() {
        const allDirect = []
        for (const conv of roomState.directConversations.values()) {
          allDirect.push(...conv)
        }
        return [...roomState.groupMessages, ...allDirect].sort((a, b) => (a.seq || 0) - (b.seq || 0))
      },
      enumerable: true
    })
    meetingChatRooms.set(roomName, roomState)
  }
  return meetingChatRooms.get(roomName)
}

/**
 * Gets the current chat policy for a meeting room.
 */
export const getChatPolicy = (roomName) => {
  if (!roomName || endedMeetingRooms.has(roomName)) return CHAT_POLICIES.NO_ONE
  const room = getOrCreateRoomChat(roomName)
  return room ? room.policy : CHAT_POLICIES.EVERYONE_AND_DIRECT
}

/**
 * Updates the chat policy for a meeting room.
 */
export const setChatPolicy = (roomName, policy) => {
  if (!roomName || endedMeetingRooms.has(roomName)) return false
  const validPolicies = Object.values(CHAT_POLICIES)
  if (!validPolicies.includes(policy)) {
    throw new Error(`Invalid chat policy: ${policy}. Must be one of: ${validPolicies.join(', ')}`)
  }
  const room = getOrCreateRoomChat(roomName)
  if (!room) return false
  room.policy = policy
  return true
}

/**
 * Checks if a user is a host or co-host based on meeting metadata.
 */
export const isUserHostOrCoHost = (meeting, userId) => {
  if (!meeting || !userId) return false
  const userLower = String(userId).trim().toLowerCase()
  const origHost = String(meeting.host_id || meeting.hostId || '').trim().toLowerCase()
  const activeHost = String(meeting.active_host_id || meeting.activeHostId || '').trim().toLowerCase()
  const assignedHost = String(meeting.assigned_host_id || meeting.assignedHostId || '').trim().toLowerCase()

  return userLower === origHost || userLower === activeHost || userLower === assignedHost
}

/**
 * Evaluates whether a user is allowed to send a chat message under the room's policy.
 *
 * @param {object} params
 * @param {string} params.roomName
 * @param {string} params.senderId
 * @param {boolean} params.isSenderHost - true if sender is host or co-host
 * @param {boolean} params.isDirect - true if 1:1 message, false if group (Everyone)
 * @param {string} [params.recipientId] - target user ID for direct message
 * @param {boolean} [params.isRecipientHost] - true if recipient is host or co-host
 * @returns {{ allowed: boolean, reason?: string }}
 */
export const canUserSendMessage = ({
  roomName,
  senderId,
  isSenderHost = false,
  isDirect = false,
  recipientId = null,
  isRecipientHost = false
}) => {
  if (roomName && endedMeetingRooms.has(roomName)) {
    return { allowed: false, reason: 'This meeting has ended.' }
  }

  if (!senderId) {
    return { allowed: false, reason: 'Sender identification is required.' }
  }

  if (isDirect && !recipientId) {
    return { allowed: false, reason: 'Direct message recipient is required.' }
  }

  // Hosts and co-hosts can always message anyone and everyone
  if (isSenderHost) {
    return { allowed: true }
  }

  const policy = getChatPolicy(roomName)

  switch (policy) {
    case CHAT_POLICIES.NO_ONE:
      return {
        allowed: false,
        reason: 'The host has disabled chat for participants.'
      }

    case CHAT_POLICIES.HOST_AND_COHOST:
      if (!isDirect) {
        return {
          allowed: false,
          reason: 'Group chat is disabled. Participants can only message the host and co-hosts.'
        }
      }
      if (!isRecipientHost) {
        return {
          allowed: false,
          reason: 'Under the current meeting settings, you can only send direct messages to the host and co-hosts.'
        }
      }
      return { allowed: true }

    case CHAT_POLICIES.EVERYONE:
      if (isDirect) {
        return {
          allowed: false,
          reason: 'Direct 1:1 messaging between participants is disabled by the host.'
        }
      }
      return { allowed: true }

    case CHAT_POLICIES.EVERYONE_AND_DIRECT:
    default:
      return { allowed: true }
  }
}

/**
 * Adds an ephemeral message to the in-memory room store.
 * Group messages are stored in `room.groupMessages`.
 * Direct 1:1 messages are stored separately in `room.directConversations` under the pair key.
 */
export const addRoomMessage = (roomName, {
  senderId,
  senderName,
  senderRole = 'participant',
  recipientId = null,
  recipientName = null,
  isDirect = false,
  text = '',
  formatted = false,
  attachment = null
}) => {
  if (!roomName) throw new Error('roomName is required')
  if (endedMeetingRooms.has(roomName)) {
    throw new Error('Cannot send message: this meeting has already ended.')
  }
  if (!senderId) throw new Error('senderId is required')

  const trimmedText = typeof text === 'string' ? text.trim() : ''

  // Must have text or attachment
  if (!trimmedText && !attachment) {
    throw new Error('Message must contain text or an attachment')
  }

  // Validate attachment if present
  let safeAttachment = null
  if (attachment) {
    if (!attachment.name || !attachment.dataUrl) {
      throw new Error('Invalid attachment format')
    }
    // Check approximate byte size of base64
    const approxSize = attachment.size || Math.round((attachment.dataUrl.length * 3) / 4)
    if (approxSize > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new Error(`Attachment exceeds maximum ephemeral size limit (${MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024)} MB)`)
    }
    safeAttachment = {
      name: String(attachment.name).slice(0, 255),
      size: Number(attachment.size) || approxSize,
      type: attachment.type || 'application/octet-stream',
      dataUrl: String(attachment.dataUrl)
    }
  }

  const room = getOrCreateRoomChat(roomName)
  if (!room) {
    throw new Error('Meeting chat room is not available.')
  }

  const seq = ++room.seq
  const messageId = `msg_${Date.now()}_${seq}_${Math.random().toString(36).slice(2, 7)}`
  const timestamp = new Date().toISOString()
  const isDirectMessage = Boolean(isDirect || recipientId)

  if (isDirectMessage && !recipientId) {
    throw new Error('Direct message recipientId is required')
  }

  const message = {
    id: messageId,
    seq,
    roomName,
    senderId: String(senderId),
    senderName: String(senderName || 'Anonymous'),
    senderRole: String(senderRole || 'participant'),
    recipientId: isDirectMessage ? String(recipientId) : null,
    recipientName: isDirectMessage && recipientName ? String(recipientName) : null,
    isDirect: isDirectMessage,
    text: trimmedText,
    formatted: Boolean(formatted),
    attachment: safeAttachment,
    timestamp
  }

  if (isDirectMessage) {
    const convKey = getDirectConversationKey(message.senderId, message.recipientId)
    if (!room.directConversations.has(convKey)) {
      room.directConversations.set(convKey, [])
    }
    const convMessages = room.directConversations.get(convKey)
    convMessages.push(message)
    if (convMessages.length > MAX_MESSAGES_PER_ROOM) {
      convMessages.shift()
    }
  } else {
    room.groupMessages.push(message)
    if (room.groupMessages.length > MAX_MESSAGES_PER_ROOM) {
      room.groupMessages.shift()
    }
  }

  return message
}

/**
 * Returns Everyone group messages for a room.
 * Never includes private direct messages.
 */
export const getGroupMessages = (roomName) => {
  if (!roomName || endedMeetingRooms.has(roomName)) return []
  const room = meetingChatRooms.get(roomName)
  if (!room) return []
  return [...room.groupMessages]
}

/**
 * Returns the 1:1 private conversation messages between two specific participants.
 */
export const getDirectConversationMessages = (roomName, userIdA, userIdB) => {
  if (!roomName || !userIdA || !userIdB || endedMeetingRooms.has(roomName)) return []
  const room = meetingChatRooms.get(roomName)
  if (!room) return []
  const convKey = getDirectConversationKey(userIdA, userIdB)
  if (!convKey || !room.directConversations.has(convKey)) return []
  return [...room.directConversations.get(convKey)]
}

/**
 * Returns all direct messages in the room where `userId` is either the sender or the intended recipient.
 * Never exposes private conversations between other participants.
 */
export const getUserDirectMessages = (roomName, userId) => {
  if (!roomName || !userId || endedMeetingRooms.has(roomName)) return []
  const room = meetingChatRooms.get(roomName)
  if (!room) return []

  const userLower = String(userId).trim().toLowerCase()
  const directList = []

  for (const convMessages of room.directConversations.values()) {
    for (const msg of convMessages) {
      const senderLower = String(msg.senderId).trim().toLowerCase()
      const recipientLower = String(msg.recipientId || '').trim().toLowerCase()
      if (senderLower === userLower || recipientLower === userLower) {
        directList.push(msg)
      }
    }
  }

  return directList.sort((a, b) => (a.seq || 0) - (b.seq || 0))
}

/**
 * Returns all messages visible to a specific authorized user, sorted in chronological order:
 * - Everyone messages (from groupMessages buffer)
 * - Direct messages where user is sender OR recipient (from directConversations buffer)
 * NEVER returns direct messages belonging to other peers.
 */
export const getUserVisibleMessages = (roomName, userId) => {
  if (!roomName || !userId || endedMeetingRooms.has(roomName)) return []
  const room = meetingChatRooms.get(roomName)
  if (!room) return []

  const groupMsgs = getGroupMessages(roomName)
  const directMsgs = getUserDirectMessages(roomName, userId)

  const combined = [...groupMsgs, ...directMsgs].sort((a, b) => {
    if ((a.seq || 0) !== (b.seq || 0)) {
      return (a.seq || 0) - (b.seq || 0)
    }
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  })

  // Deduplicate by message ID
  const seen = new Set()
  return combined.filter((msg) => {
    if (seen.has(msg.id)) return false
    seen.add(msg.id)
    return true
  })
}

/**
 * Restores the in-memory chat session for a participant upon browser refresh or socket reconnect.
 * Enforces meeting-active check, participant membership check, and strict conversation isolation.
 */
export const restoreParticipantChatSession = ({
  roomName,
  userId,
  recipientId = null,
  meeting = null,
  isParticipantAuthorized = true
}) => {
  if (!roomName || !userId) {
    return {
      authorized: false,
      allowed: false,
      ended: false,
      reason: 'Room name and authenticated user ID are required.',
      policy: CHAT_POLICIES.EVERYONE_AND_DIRECT,
      groupMessages: [],
      directMessages: [],
      selectedDirectMessages: [],
      messages: []
    }
  }

  if (endedMeetingRooms.has(roomName) || (meeting && meeting.meeting_status === 'Ended')) {
    return {
      authorized: false,
      allowed: false,
      ended: true,
      reason: 'This meeting has ended. Chat history has been permanently cleared.',
      policy: CHAT_POLICIES.NO_ONE,
      groupMessages: [],
      directMessages: [],
      selectedDirectMessages: [],
      messages: []
    }
  }

  const isHost = meeting ? isUserHostOrCoHost(meeting, userId) : false
  if (!isParticipantAuthorized && !isHost) {
    return {
      authorized: false,
      allowed: false,
      ended: false,
      reason: 'You are not an authorized participant in this meeting.',
      policy: getChatPolicy(roomName),
      groupMessages: [],
      directMessages: [],
      selectedDirectMessages: [],
      messages: []
    }
  }

  const policy = getChatPolicy(roomName)
  const groupMessages = getGroupMessages(roomName)
  const directMessages = getUserDirectMessages(roomName, userId)
  const selectedDirectMessages = recipientId
    ? getDirectConversationMessages(roomName, userId, recipientId)
    : []
  const messages = getUserVisibleMessages(roomName, userId)

  return {
    authorized: true,
    allowed: true,
    ended: false,
    isHost,
    policy,
    groupMessages,
    directMessages,
    selectedDirectMessages,
    messages
  }
}

/**
 * Purges all in-memory chat state (group buffer + all direct conversations) for a meeting room.
 * Called strictly on meeting conclusion or empty-room cleanup.
 */
export const clearMeetingChat = (roomName) => {
  if (!roomName) return false
  endedMeetingRooms.add(roomName)
  const room = meetingChatRooms.get(roomName)
  if (room) {
    room.groupMessages.length = 0
    for (const conv of room.directConversations.values()) {
      conv.length = 0
    }
    room.directConversations.clear()
  }
  const existed = meetingChatRooms.delete(roomName)
  if (existed) {
    console.log(`[MeetingChat] Ephemeral chat data completely cleared from memory for room: ${roomName}`)
  }
  return existed
}

/**
 * Resets all rooms — strictly for testing environments.
 */
export const resetAllMeetingChats = () => {
  for (const room of meetingChatRooms.values()) {
    room.groupMessages.length = 0
    for (const conv of room.directConversations.values()) {
      conv.length = 0
    }
    room.directConversations.clear()
  }
  meetingChatRooms.clear()
  endedMeetingRooms.clear()
}

/**
 * Returns diagnostic stats for testing and monitoring.
 */
export const getMeetingChatStats = (roomName) => {
  if (!roomName || endedMeetingRooms.has(roomName)) return null
  const room = meetingChatRooms.get(roomName)
  if (!room) return null
  return {
    policy: room.policy,
    groupMessageCount: room.groupMessages.length,
    directConversationCount: room.directConversations.size,
    messageCount: room.messages.length
  }
}

