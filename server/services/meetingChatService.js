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

// Map<roomName, { policy: string, messages: Array<ChatMessage> }>
const meetingChatRooms = new Map()

/**
 * Gets or creates the in-memory chat state for a meeting room.
 * Default policy is 'everyone_and_direct'.
 */
export const getOrCreateRoomChat = (roomName) => {
  if (!roomName) return null
  if (!meetingChatRooms.has(roomName)) {
    meetingChatRooms.set(roomName, {
      policy: CHAT_POLICIES.EVERYONE_AND_DIRECT,
      messages: []
    })
  }
  return meetingChatRooms.get(roomName)
}

/**
 * Gets the current chat policy for a meeting room.
 */
export const getChatPolicy = (roomName) => {
  const room = getOrCreateRoomChat(roomName)
  return room ? room.policy : CHAT_POLICIES.EVERYONE_AND_DIRECT
}

/**
 * Updates the chat policy for a meeting room.
 */
export const setChatPolicy = (roomName, policy) => {
  if (!roomName) return false
  const validPolicies = Object.values(CHAT_POLICIES)
  if (!validPolicies.includes(policy)) {
    throw new Error(`Invalid chat policy: ${policy}. Must be one of: ${validPolicies.join(', ')}`)
  }
  const room = getOrCreateRoomChat(roomName)
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
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const timestamp = new Date().toISOString()

  const message = {
    id: messageId,
    roomName,
    senderId: String(senderId),
    senderName: String(senderName || 'Anonymous'),
    senderRole: String(senderRole || 'participant'),
    recipientId: recipientId ? String(recipientId) : null,
    recipientName: recipientName ? String(recipientName) : null,
    isDirect: Boolean(isDirect || recipientId),
    text: trimmedText,
    formatted: Boolean(formatted),
    attachment: safeAttachment,
    timestamp
  }

  room.messages.push(message)

  // Enforce FIFO cap to prevent unbounded memory growth
  if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
    room.messages.shift()
  }

  return message
}

/**
 * Returns messages visible to a specific user.
 * - Everyone messages (recipientId === null)
 * - Direct messages where user is sender OR recipient
 * NEVER returns direct messages belonging to other peers.
 */
export const getUserVisibleMessages = (roomName, userId) => {
  if (!roomName || !userId) return []
  const room = meetingChatRooms.get(roomName)
  if (!room) return []

  const userLower = String(userId).trim().toLowerCase()

  return room.messages.filter((msg) => {
    if (!msg.isDirect || !msg.recipientId) {
      // Group message — visible to everyone
      return true
    }
    const senderLower = String(msg.senderId).trim().toLowerCase()
    const recipientLower = String(msg.recipientId).trim().toLowerCase()

    // Direct message — visible ONLY if user is sender or recipient
    return senderLower === userLower || recipientLower === userLower
  })
}

/**
 * Purges all in-memory chat state for a meeting room.
 * Called strictly on meeting conclusion or empty-room cleanup.
 */
export const clearMeetingChat = (roomName) => {
  if (!roomName) return false
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
  meetingChatRooms.clear()
}

/**
 * Returns diagnostic stats for testing and monitoring.
 */
export const getMeetingChatStats = (roomName) => {
  const room = meetingChatRooms.get(roomName)
  if (!room) return null
  return {
    policy: room.policy,
    messageCount: room.messages.length
  }
}
