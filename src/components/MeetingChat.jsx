import React, { useState, useEffect, useRef, useMemo } from 'react'
import {
  Send,
  Smile,
  Paperclip,
  Bold,
  Italic,
  Underline as UnderlineIcon,
  List,
  ListOrdered,
  MoreVertical,
  X,
  Download,
  FileText,
  Check,
  Search,
  Users,
  Lock,
  MessageSquare,
  Shield
} from 'lucide-react'

// Ephemeral attachment size limit: 3 MB
const MAX_ATTACHMENT_SIZE_BYTES = 3 * 1024 * 1024

const CHAT_POLICIES = {
  NO_ONE: 'no_one',
  HOST_AND_COHOST: 'host_and_cohost',
  EVERYONE: 'everyone',
  EVERYONE_AND_DIRECT: 'everyone_and_direct'
}

const POLICY_LABELS = [
  {
    id: CHAT_POLICIES.NO_ONE,
    title: 'No one',
    desc: 'Participants cannot send group or direct messages'
  },
  {
    id: CHAT_POLICIES.HOST_AND_COHOST,
    title: 'Host and co-hosts',
    desc: 'Participants can only direct message the host and co-hosts'
  },
  {
    id: CHAT_POLICIES.EVERYONE,
    title: 'Everyone',
    desc: 'Participants can send group messages, but not direct messages'
  },
  {
    id: CHAT_POLICIES.EVERYONE_AND_DIRECT,
    title: 'Everyone and anyone directly',
    desc: 'Participants can send group messages and direct 1:1 messages'
  }
]

// Common emojis for quick reaction & typing in meetings
const EMOJI_LIST = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
  '🙂', '😉', '😌', '😍', '🥰', '😘', '😋', '😎', '🤓', '🥳',
  '🤩', '🤔', '🤫', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒',
  '👍', '👎', '👏', '🙌', '👐', '🙏', '✌️', '🤞', '🤝', '👋',
  '👌', '🤙', '💪', '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥',
  '✨', '🎉', '🎊', '🚀', '💡', '💯', '⭐', '☕', '👀', '🧠'
]

const formatFileSize = (bytes) => {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i] || 'MB'}`
}

const formatTimestamp = (isoString) => {
  if (!isoString) return ''
  try {
    const d = new Date(isoString)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/**
 * Safely parse text containing basic markdown (bold, italic, underline, lists)
 * into safe React nodes without using dangerouslySetInnerHTML.
 */
const renderFormattedText = (text) => {
  if (!text) return null

  const lines = text.split('\n')
  const elements = []
  let currentList = null // { type: 'ul' | 'ol', items: [] }

  const flushList = () => {
    if (currentList) {
      if (currentList.type === 'ul') {
        elements.push(
          <ul key={`ul-${elements.length}`} className="list-disc list-inside space-y-0.5 my-1 text-left">
            {currentList.items.map((item, idx) => (
              <li key={idx} className="break-words">{parseInline(item)}</li>
            ))}
          </ul>
        )
      } else {
        elements.push(
          <ol key={`ol-${elements.length}`} className="list-decimal list-inside space-y-0.5 my-1 text-left">
            {currentList.items.map((item, idx) => (
              <li key={idx} className="break-words">{parseInline(item)}</li>
            ))}
          </ol>
        )
      }
      currentList = null
    }
  }

  // Parses inline formatting: **bold**, *italic*, <u>underline</u>, __underline__
  const parseInline = (lineText) => {
    // Regex splits by:
    // 1) **bold**
    // 2) *italic*
    // 3) <u>underline</u> or __underline__
    const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|<u>.*?<\/u>|__[^_]+__)/g
    const parts = lineText.split(regex)

    return parts.map((part, pIdx) => {
      if (!part) return null

      if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
        return <strong key={pIdx} className="font-bold text-white">{part.slice(2, -2)}</strong>
      }
      if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
        return <em key={pIdx} className="italic text-gray-200">{part.slice(1, -1)}</em>
      }
      if (part.startsWith('<u>') && part.endsWith('</u>') && part.length >= 7) {
        return <span key={pIdx} className="underline underline-offset-2">{part.slice(3, -4)}</span>
      }
      if (part.startsWith('__') && part.endsWith('__') && part.length >= 4) {
        return <span key={pIdx} className="underline underline-offset-2">{part.slice(2, -2)}</span>
      }

      return <span key={pIdx}>{part}</span>
    })
  }

  lines.forEach((line, lineIdx) => {
    const trimmed = line.trim()

    // Bullet list item
    if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
      const content = trimmed.replace(/^[-•*]\s+/, '')
      if (currentList && currentList.type !== 'ul') flushList()
      if (!currentList) currentList = { type: 'ul', items: [] }
      currentList.items.push(content)
      return
    }

    // Numbered list item
    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)/)
    if (numMatch) {
      const content = numMatch[2]
      if (currentList && currentList.type !== 'ol') flushList()
      if (!currentList) currentList = { type: 'ol', items: [] }
      currentList.items.push(content)
      return
    }

    // Normal line or paragraph
    flushList()
    if (trimmed === '') {
      elements.push(<div key={`br-${lineIdx}`} className="h-1.5" />)
    } else {
      elements.push(
        <div key={`p-${lineIdx}`} className="break-words leading-relaxed">
          {parseInline(line)}
        </div>
      )
    }
  })

  flushList()
  return elements
}

export const mergeAndSortMessages = (existing = [], incoming = []) => {
  const byId = new Map()
  for (const m of existing) {
    if (m && m.id) byId.set(m.id, m)
  }
  for (const m of incoming) {
    if (m && m.id) byId.set(m.id, m)
  }
  return Array.from(byId.values()).sort((a, b) => {
    const seqA = Number(a.seq || 0)
    const seqB = Number(b.seq || 0)
    if (seqA && seqB && seqA !== seqB) return seqA - seqB
    const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0
    const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0
    if (timeA !== timeB) return timeA - timeB
    return String(a.id).localeCompare(String(b.id))
  })
}

export default function MeetingChat({
  meetingData,
  user,
  localParticipant,
  participants = [],
  dbParticipants = [],
  socket,
  socketReady = 0,
  isHost,
  showToast,
  messages: controlledMessages,
  setMessages: setControlledMessages,
  policy: controlledPolicy,
  setPolicy: setControlledPolicy,
  activeChatTab: controlledActiveTab,
  setActiveChatTab: setControlledActiveTab,
  selectedRecipient: controlledSelectedRecipient,
  setSelectedRecipient: setControlledSelectedRecipient
}) {
  // In-memory chat messages strictly in React state + temporary server memory (Zero persistent storage)
  const [internalMessages, setInternalMessages] = useState([])
  const [internalActiveTab, setInternalActiveTab] = useState('everyone') // 'everyone' | 'direct' | 'picker'
  const [internalSelectedRecipient, setInternalSelectedRecipient] = useState(null) // { userId, name, role }
  const [internalPolicy, setInternalPolicy] = useState(CHAT_POLICIES.EVERYONE_AND_DIRECT)

  const messages = controlledMessages !== undefined ? controlledMessages : internalMessages
  const setMessages = setControlledMessages || setInternalMessages
  const activeTab = controlledActiveTab !== undefined ? controlledActiveTab : internalActiveTab
  const setActiveTab = setControlledActiveTab || setInternalActiveTab
  const selectedRecipient = controlledSelectedRecipient !== undefined ? controlledSelectedRecipient : internalSelectedRecipient
  const setSelectedRecipient = setControlledSelectedRecipient || setInternalSelectedRecipient
  const policy = controlledPolicy !== undefined ? controlledPolicy : internalPolicy
  const setPolicy = setControlledPolicy || setInternalPolicy

  const [inputText, setInputText] = useState('')
  const [pendingAttachment, setPendingAttachment] = useState(null) // { name, size, type, dataUrl }

  // Toolbar & popover states
  const [showFormattingBar, setShowFormattingBar] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showSettingsMenu, setShowSettingsMenu] = useState(false)
  const [participantSearch, setParticipantSearch] = useState('')

  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
  const settingsMenuRef = useRef(null)
  const emojiPickerRef = useRef(null)

  // Resolve authenticated user ID (do not fall back to email identity)
  const currentUserId = useMemo(() => {
    if (user?.id) return user.id
    if (localParticipant?.metadata) {
      try {
        const meta = typeof localParticipant.metadata === 'string'
          ? JSON.parse(localParticipant.metadata)
          : localParticipant.metadata
        if (meta?.userId) return meta.userId
      } catch {}
    }
    return null
  }, [user?.id, localParticipant?.metadata])

  const currentUserName = user?.full_name || user?.name || localParticipant?.name || 'You'

  // Host IDs from meeting record
  const originalHostId = meetingData?.host_id || meetingData?.hostId
  const activeHostId = meetingData?.active_host_id
  const assignedHostId = meetingData?.assigned_host_id

  const isUserHostOrCoHost = React.useCallback((uid) => {
    if (!uid) return false
    const uLower = String(uid).trim().toLowerCase()
    const origLower = String(originalHostId || '').trim().toLowerCase()
    const actLower = String(activeHostId || '').trim().toLowerCase()
    const assLower = String(assignedHostId || '').trim().toLowerCase()
    return uLower === origLower || uLower === actLower || uLower === assLower
  }, [originalHostId, activeHostId, assignedHostId])

  // Resolve user ID for any participant
  const getParticipantUserId = React.useCallback((p) => {
    if (!p) return null
    if (p.metadata) {
      try {
        const meta = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata
        if (meta?.userId) return meta.userId
      } catch {}
    }
    if (p.userId) return p.userId
    if (p.identity) {
      const match = (dbParticipants || []).find((dbP) => {
        return (
          String(dbP.user_id || '').toLowerCase() === String(p.identity).toLowerCase() ||
          String(dbP.user?.email || '').toLowerCase() === String(p.identity).toLowerCase()
        )
      })
      if (match?.user_id) return match.user_id
      return p.identity
    }
    return null
  }, [dbParticipants])

  // List of other participants available for 1:1 chat (LiveKit + admitted DB participants + restored DM peers)
  const eligibleRecipients = useMemo(() => {
    const list = []
    const seen = new Set()
    const myIdLower = String(currentUserId || '').trim().toLowerCase()

    const addCandidate = (uid, name, identity) => {
      if (!uid) return
      const key = String(uid).trim().toLowerCase()
      if (!key || key === myIdLower || seen.has(key)) return
      seen.add(key)

      const isTargetHost = isUserHostOrCoHost(uid)
      list.push({
        userId: uid,
        name: name || identity || 'Participant',
        identity: identity || uid,
        isHost: isTargetHost,
        role: isTargetHost ? 'Host' : 'Participant'
      })
    }

    // 1. LiveKit participants currently in room
    for (const p of participants || []) {
      const pUserId = getParticipantUserId(p)
      if (!pUserId) continue
      addCandidate(pUserId, p.name || p.identity, p.identity)
    }

    // 2. Admitted database participants (ensures peers are immediately available right after page refresh)
    for (const dbP of dbParticipants || []) {
      if (dbP.status && !['joined', 'active', 'disconnected'].includes(dbP.status)) continue
      const pUserId = dbP.user_id
      const pName = dbP.user?.full_name || dbP.user?.name || dbP.user?.email || 'Participant'
      addCandidate(pUserId, pName, dbP.user?.email || pUserId)
    }

    // 3. Peers from restored in-memory direct conversations
    for (const m of messages || []) {
      if (!m?.isDirect) continue
      const senderLower = String(m.senderId || '').trim().toLowerCase()
      const recipientLower = String(m.recipientId || '').trim().toLowerCase()
      if (senderLower === myIdLower && m.recipientId) {
        addCandidate(m.recipientId, m.recipientName || 'Participant', m.recipientId)
      } else if (recipientLower === myIdLower && m.senderId) {
        addCandidate(m.senderId, m.senderName || 'Participant', m.senderId)
      }
    }

    return list
  }, [participants, dbParticipants, messages, currentUserId, getParticipantUserId, isUserHostOrCoHost])

  const filteredRecipients = useMemo(() => {
    const query = participantSearch.trim().toLowerCase()
    if (!query) return eligibleRecipients
    return eligibleRecipients.filter((p) => p.name.toLowerCase().includes(query))
  }, [eligibleRecipients, participantSearch])

  // Check if current user can chat under current policy
  const canSendCurrent = useMemo(() => {
    if (isHost) return { allowed: true }

    switch (policy) {
      case CHAT_POLICIES.NO_ONE:
        return { allowed: false, reason: 'The host has disabled chat for participants.' }

      case CHAT_POLICIES.HOST_AND_COHOST:
        if (activeTab === 'everyone') {
          return {
            allowed: false,
            reason: 'Group chat is disabled. You can only direct message the host and co-hosts.'
          }
        }
        if (selectedRecipient && !selectedRecipient.isHost) {
          return {
            allowed: false,
            reason: 'You can only message the host and co-hosts under current settings.'
          }
        }
        return { allowed: true }

      case CHAT_POLICIES.EVERYONE:
        if (activeTab === 'direct') {
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
  }, [isHost, policy, activeTab, selectedRecipient])

  // Scroll message list to bottom
  const scrollToBottom = () => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }

  // Request authoritative in-memory chat history from server only once roomName AND currentUserId are ready
  const syncChatHistory = React.useCallback(() => {
    const s = socket?.current
    const roomName = meetingData?.room_name
    if (!s || !roomName || !currentUserId) return

    const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
    const recipientId = selectedRecipient?.userId || null

    s.emit(
      'chat:sync',
      { roomName, userId: currentUserId, recipientId, token },
      (res) => {
        if (res?.ended) {
          setMessages([])
          setSelectedRecipient(null)
          setActiveTab('everyone')
          return
        }
        if (res?.success) {
          if (res.policy) setPolicy(res.policy)
          const incoming = [
            ...(Array.isArray(res.messages) ? res.messages : []),
            ...(Array.isArray(res.groupMessages) ? res.groupMessages : []),
            ...(Array.isArray(res.directMessages) ? res.directMessages : []),
            ...(Array.isArray(res.selectedDirectMessages) ? res.selectedDirectMessages : [])
          ]
          setMessages((prev) => mergeAndSortMessages(prev, incoming))
        } else if (res?.error) {
          console.warn('[MeetingChat] History sync warning:', res.error)
        }
      }
    )
  }, [
    socket,
    meetingData?.room_name,
    currentUserId,
    selectedRecipient?.userId,
    setMessages,
    setPolicy,
    setSelectedRecipient,
    setActiveTab
  ])

  // Socket listener setup for chat messages, reconnect sync, and policy changes
  useEffect(() => {
    const s = socket?.current
    if (!s) return

    const handleInit = (data) => {
      if (data?.policy) setPolicy(data.policy)
      const incoming = [
        ...(Array.isArray(data?.messages) ? data.messages : []),
        ...(Array.isArray(data?.groupMessages) ? data.groupMessages : []),
        ...(Array.isArray(data?.directMessages) ? data.directMessages : []),
        ...(Array.isArray(data?.selectedDirectMessages) ? data.selectedDirectMessages : [])
      ]
      if (incoming.length > 0) {
        setMessages((prev) => mergeAndSortMessages(prev, incoming))
      }
    }

    const handleMessage = (msg) => {
      if (!msg?.id) return
      setMessages((prev) => mergeAndSortMessages(prev, [msg]))
    }

    const handlePolicyUpdated = (data) => {
      if (data?.policy) {
        setPolicy(data.policy)
        const label = POLICY_LABELS.find((l) => l.id === data.policy)?.title || data.policy
        if (showToast) {
          showToast(`Chat settings updated: ${label}`, 'info')
        }
      }
    }

    const handleCleared = () => {
      // Authoritative meeting-end ephemeral wipe
      setMessages([])
      setSelectedRecipient(null)
      setActiveTab('everyone')
      setInputText('')
      setPendingAttachment(null)
    }

    const handleError = (data) => {
      if (showToast && data?.error) {
        showToast(data.error, 'error')
      }
    }

    const handleReconnect = () => {
      syncChatHistory()
    }

    s.on('chat:init', handleInit)
    s.on('chat:message', handleMessage)
    s.on('chat:policy_updated', handlePolicyUpdated)
    s.on('chat:cleared', handleCleared)
    s.on('chat:error', handleError)
    s.on('connect', handleReconnect)

    // Perform handshake after listener registration once roomName and currentUserId are available
    syncChatHistory()

    return () => {
      s.off('chat:init', handleInit)
      s.off('chat:message', handleMessage)
      s.off('chat:policy_updated', handlePolicyUpdated)
      s.off('chat:cleared', handleCleared)
      s.off('chat:error', handleError)
      s.off('connect', handleReconnect)
    }
  }, [socket, socketReady, showToast, syncChatHistory, setMessages, setPolicy, setSelectedRecipient, setActiveTab])

  // Scroll to bottom on new message
  useEffect(() => {
    scrollToBottom()
  }, [messages, activeTab, selectedRecipient])

  // Close menus on outside click or Escape
  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target)) {
        setShowSettingsMenu(false)
      }
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target)) {
        setShowEmojiPicker(false)
      }
    }
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        setShowSettingsMenu(false)
        setShowEmojiPicker(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [])

  // Filter messages for currently active conversation
  const displayedMessages = useMemo(() => {
    if (activeTab === 'everyone') {
      return messages.filter((m) => !m.isDirect || !m.recipientId)
    }
    if (activeTab === 'direct' && selectedRecipient) {
      const recIdLower = String(selectedRecipient.userId).toLowerCase()
      const myIdLower = String(currentUserId || '').toLowerCase()

      return messages.filter((m) => {
        if (!m.isDirect) return false
        const senderLower = String(m.senderId).toLowerCase()
        const recipientLower = String(m.recipientId || '').toLowerCase()
        return (
          (senderLower === myIdLower && recipientLower === recIdLower) ||
          (senderLower === recIdLower && recipientLower === myIdLower)
        )
      })
    }
    return []
  }, [messages, activeTab, selectedRecipient, currentUserId])

  // Host policy change
  const handleSelectPolicy = (newPolicy) => {
    if (!isHost) return
    setShowSettingsMenu(false)
    const s = socket?.current
    if (s && meetingData?.room_name) {
      const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
      s.emit('chat:set_policy', {
        roomName: meetingData.room_name,
        policy: newPolicy,
        userId: currentUserId,
        token
      }, (res) => {
        if (!res?.success && showToast) {
          showToast(res?.error || 'Failed to update chat policy.', 'error')
        }
      })
    }
  }

  // Handle file selection (ephemeral base64 in memory only)
  const handleFileChange = (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      if (showToast) {
        showToast(`File exceeds 3 MB limit for ephemeral transfer (${formatFileSize(file.size)}).`, 'error')
      }
      e.target.value = ''
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      setPendingAttachment({
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        dataUrl: reader.result
      })
    }
    reader.onerror = () => {
      if (showToast) showToast('Failed to read file.', 'error')
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  // Insert formatting tag into textarea
  const handleFormatText = (type) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const start = textarea.selectionStart || 0
    const end = textarea.selectionEnd || 0
    const selected = inputText.slice(start, end)
    let replacement = ''
    let cursorOffset = 0

    switch (type) {
      case 'bold':
        replacement = selected ? `**${selected}**` : '**bold text**'
        cursorOffset = selected ? replacement.length : 2
        break
      case 'italic':
        replacement = selected ? `*${selected}*` : '*italic text*'
        cursorOffset = selected ? replacement.length : 1
        break
      case 'underline':
        replacement = selected ? `<u>${selected}</u>` : '<u>underlined text</u>'
        cursorOffset = selected ? replacement.length : 3
        break
      case 'bullet':
        replacement = selected ? selected.split('\n').map((l) => `- ${l}`).join('\n') : '- list item'
        cursorOffset = replacement.length
        break
      case 'number':
        replacement = selected ? selected.split('\n').map((l, i) => `${i + 1}. ${l}`).join('\n') : '1. list item'
        cursorOffset = replacement.length
        break
      default:
        return
    }

    const nextText = inputText.slice(0, start) + replacement + inputText.slice(end)
    setInputText(nextText)

    setTimeout(() => {
      textarea.focus()
      textarea.setSelectionRange(start + cursorOffset, start + cursorOffset)
    }, 0)
  }

  // Insert emoji into textarea
  const handleInsertEmoji = (emoji) => {
    const textarea = textareaRef.current
    if (!textarea) {
      setInputText((prev) => prev + emoji)
      return
    }
    const start = textarea.selectionStart || inputText.length
    const end = textarea.selectionEnd || inputText.length
    const nextText = inputText.slice(0, start) + emoji + inputText.slice(end)
    setInputText(nextText)
    setTimeout(() => {
      textarea.focus()
      const newPos = start + emoji.length
      textarea.setSelectionRange(newPos, newPos)
    }, 0)
    setShowEmojiPicker(false)
  }

  // Send message
  const handleSendMessage = (e) => {
    if (e) e.preventDefault()
    if (!canSendCurrent.allowed) {
      if (showToast) showToast(canSendCurrent.reason || 'You cannot send messages right now.', 'warning')
      return
    }

    const trimmed = inputText.trim()
    if (!trimmed && !pendingAttachment) return

    const isDirect = activeTab === 'direct' && Boolean(selectedRecipient)
    const recipientId = isDirect ? selectedRecipient.userId : null
    const recipientName = isDirect ? selectedRecipient.name : null

    const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
    const payload = {
      roomName: meetingData?.room_name,
      text: trimmed,
      formatted: trimmed.includes('*') || trimmed.includes('<u>') || trimmed.includes('- ') || trimmed.includes('1. '),
      attachment: pendingAttachment,
      recipientId,
      recipientName,
      isDirect,
      senderId: currentUserId,
      senderName: currentUserName,
      token
    }

    const s = socket?.current
    if (s && meetingData?.room_name) {
      s.emit('chat:send_message', payload, (res) => {
        if (!res?.success && showToast) {
          showToast(res?.error || 'Failed to send message.', 'error')
          return
        }
        if (res?.message?.id) {
          setMessages((prev) => mergeAndSortMessages(prev, [res.message]))
        }
      })
    }

    setInputText('')
    setPendingAttachment(null)
  }

  // Key handler for Enter to send, Shift+Enter for newline
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  return (
    <div className="flex flex-col h-full bg-[#080913] text-white select-none">
      {/* ── Top Header Bar ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-white/5 pb-2.5 mb-2 relative">
        {/* Navigation Tabs */}
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={() => setActiveTab('everyone')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeTab === 'everyone'
                ? 'bg-purple-600/30 text-purple-300 border border-purple-500/40 shadow-sm'
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }`}
          >
            Everyone
          </button>

          {activeTab === 'direct' && selectedRecipient ? (
            <div className="flex items-center gap-1.5 px-2 py-0.5 bg-brand-purple/20 border border-brand-purple/40 rounded-lg text-xs font-semibold text-purple-200">
              <span className="truncate max-w-[120px]">To: {selectedRecipient.name}</span>
              <button
                type="button"
                onClick={() => {
                  setSelectedRecipient(null)
                  setActiveTab('picker')
                }}
                className="hover:text-white p-0.5 rounded cursor-pointer"
                title="Change recipient"
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setActiveTab('picker')}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'picker'
                  ? 'bg-purple-600/30 text-purple-300 border border-purple-500/40 shadow-sm'
                  : 'text-gray-400 hover:text-white hover:bg-white/5'
              }`}
            >
              New chat
            </button>
          )}
        </div>

        {/* Host Settings Three-Dot Menu (Host/Co-host Only) */}
        {isHost && (
          <div className="relative" ref={settingsMenuRef}>
            <button
              type="button"
              onClick={() => setShowSettingsMenu((prev) => !prev)}
              className="p-1 text-gray-400 hover:text-white rounded-lg hover:bg-white/5 cursor-pointer transition-colors"
              title="Chat permissions and settings"
            >
              <MoreVertical size={16} />
            </button>

            {showSettingsMenu && (
              <div className="absolute right-0 top-8 z-50 w-72 bg-slate-900/95 border border-purple-500/30 rounded-xl p-2.5 shadow-2xl backdrop-blur-md">
                <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-bold text-gray-400 uppercase tracking-wider border-b border-white/5 mb-1.5">
                  <Shield size={12} className="text-purple-400" />
                  <span>Participant can chat with:</span>
                </div>
                <div className="flex flex-col gap-1">
                  {POLICY_LABELS.map((item) => {
                    const isSelected = policy === item.id
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleSelectPolicy(item.id)}
                        className={`w-full flex items-start gap-2.5 p-2 rounded-lg text-left transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-purple-600/20 border border-purple-500/40 text-white'
                            : 'hover:bg-white/5 text-gray-300'
                        }`}
                      >
                        <div className="pt-0.5 shrink-0 text-purple-400">
                          {isSelected ? <Check size={14} /> : <div className="w-3.5 h-3.5 rounded-full border border-gray-600" />}
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="text-xs font-semibold">{item.title}</span>
                          <span className="text-[10px] text-gray-400 leading-tight mt-0.5">{item.desc}</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Main Chat Area ────────────────────────────────────────────────── */}
      {activeTab === 'picker' ? (
        /* Participant Selector (New chat) */
        <div className="flex-1 flex flex-col min-h-0">
          <div className="relative mb-2.5">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              placeholder="Search participant..."
              value={participantSearch}
              onChange={(e) => setParticipantSearch(e.target.value)}
              className="w-full bg-slate-900/60 border border-white/10 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
            />
            {participantSearch && (
              <button
                type="button"
                onClick={() => setParticipantSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white text-xs cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto space-y-1 pr-1">
            {filteredRecipients.length === 0 ? (
              <div className="py-8 text-center text-gray-500 text-xs select-none">
                {eligibleRecipients.length === 0
                  ? 'No other participants in meeting.'
                  : 'No matching participants found.'}
              </div>
            ) : (
              filteredRecipients.map((p) => (
                <button
                  key={p.userId}
                  type="button"
                  onClick={() => {
                    setSelectedRecipient(p)
                    setActiveTab('direct')
                  }}
                  className="w-full flex items-center justify-between p-2 rounded-xl bg-white/2 hover:bg-white/5 border border-white/5 transition-all cursor-pointer text-left"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-purple-600/20 border border-purple-500/30 flex items-center justify-center text-xs font-bold text-purple-300 shrink-0">
                      {p.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-semibold text-white truncate">{p.name}</span>
                      <span className="text-[10px] text-gray-400 capitalize">{p.role}</span>
                    </div>
                  </div>
                  <MessageSquare size={13} className="text-gray-500" />
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        /* Messages Feed */
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto space-y-3 pr-1 py-1">
            {displayedMessages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-4 text-gray-500 select-none">
                <div className="w-10 h-10 rounded-full bg-white/3 border border-white/5 flex items-center justify-center text-gray-400 mb-2">
                  <MessageSquare size={20} />
                </div>
                <p className="text-xs font-semibold text-gray-300">
                  {activeTab === 'everyone' ? 'No messages yet' : `Chat with ${selectedRecipient?.name}`}
                </p>
                <p className="text-[11px] text-gray-500 mt-0.5 max-w-[200px]">
                  {activeTab === 'everyone'
                    ? 'Send a message to everyone in the meeting.'
                    : 'Messages in this thread are private and visible only to both of you.'}
                </p>
              </div>
            ) : (
              displayedMessages.map((msg) => {
                const isMe = String(msg.senderId).toLowerCase() === String(currentUserId || '').toLowerCase()

                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col text-xs ${isMe ? 'items-end' : 'items-start'}`}
                  >
                    {/* Sender & Timestamp Header */}
                    <div className="flex items-center gap-1.5 mb-1 px-1 text-[10px] text-gray-400">
                      <span className="font-bold text-gray-300">
                        {isMe ? 'You' : msg.senderName}
                      </span>
                      {msg.senderRole === 'host' && (
                        <span className="px-1 py-0.2 bg-purple-500/20 text-purple-300 rounded text-[9px] font-bold">
                          Host
                        </span>
                      )}
                      {msg.isDirect && (
                        <span className="px-1 py-0.2 bg-blue-500/20 text-blue-300 rounded text-[9px] font-bold">
                          Direct
                        </span>
                      )}
                      <span>•</span>
                      <span>{formatTimestamp(msg.timestamp)}</span>
                    </div>

                    {/* Bubble Content */}
                    <div
                      className={`max-w-[85%] rounded-2xl p-2.5 border text-xs ${
                        isMe
                          ? 'bg-purple-600/30 border-purple-500/40 text-purple-50 rounded-tr-sm'
                          : 'bg-white/4 border-white/5 text-gray-200 rounded-tl-sm'
                      }`}
                    >
                      {/* Formatted Text */}
                      {msg.text && (
                        <div className="space-y-0.5 text-left">
                          {renderFormattedText(msg.text)}
                        </div>
                      )}

                      {/* Ephemeral Attachment Display */}
                      {msg.attachment && (
                        <div className={`flex items-center justify-between gap-2 p-2 rounded-xl mt-1.5 bg-black/40 border border-white/10 ${
                          msg.text ? 'pt-1.5' : ''
                        }`}>
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="p-1.5 rounded-lg bg-purple-500/20 text-purple-300 shrink-0">
                              <FileText size={15} />
                            </div>
                            <div className="flex flex-col min-w-0 text-left">
                              <span className="text-[11px] font-semibold text-white truncate max-w-[130px]">
                                {msg.attachment.name}
                              </span>
                              <span className="text-[9px] text-gray-400">
                                {formatFileSize(msg.attachment.size)}
                              </span>
                            </div>
                          </div>
                          <a
                            href={msg.attachment.dataUrl}
                            download={msg.attachment.name}
                            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white transition-colors cursor-pointer shrink-0"
                            title="Download attachment"
                          >
                            <Download size={13} />
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}

      {/* ── Audience Info Strip ("Who can see your messages?") ────────────── */}
      <div className="py-1 px-1.5 mt-2 border-t border-white/5 flex items-center justify-between text-[10px] text-gray-400 bg-white/2 rounded-lg">
        <div className="flex items-center gap-1.5 truncate">
          <Users size={11} className="text-gray-500 shrink-0" />
          <span className="truncate">
            {activeTab === 'everyone'
              ? 'Who can see your messages? Everyone in the meeting'
              : selectedRecipient
              ? `Who can see your messages? Only you and ${selectedRecipient.name}`
              : 'Select a participant to start a direct message'}
          </span>
        </div>
        {!canSendCurrent.allowed && (
          <span className="flex items-center gap-1 text-amber-400 font-semibold shrink-0">
            <Lock size={10} />
            <span>Disabled</span>
          </span>
        )}
      </div>

      {/* ── Pending Ephemeral Attachment Preview ──────────────────────────── */}
      {pendingAttachment && (
        <div className="flex items-center justify-between p-2 mt-1.5 bg-purple-950/30 border border-purple-500/30 rounded-xl">
          <div className="flex items-center gap-2 min-w-0">
            <FileText size={14} className="text-purple-400 shrink-0" />
            <div className="flex flex-col min-w-0 text-left">
              <span className="text-[11px] font-semibold text-white truncate max-w-[170px]">
                {pendingAttachment.name}
              </span>
              <span className="text-[9px] text-gray-400">{formatFileSize(pendingAttachment.size)}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setPendingAttachment(null)}
            className="text-gray-400 hover:text-white p-1 rounded cursor-pointer"
            title="Remove attachment"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* ── Text Formatting Toolbar ('T' toggle) ──────────────────────────── */}
      {showFormattingBar && canSendCurrent.allowed && (
        <div className="flex items-center gap-1 p-1 mt-1.5 bg-slate-900/90 border border-white/10 rounded-xl">
          <button
            type="button"
            onClick={() => handleFormatText('bold')}
            className="p-1.5 rounded hover:bg-white/10 text-gray-300 hover:text-white cursor-pointer"
            title="Bold (**text**)"
          >
            <Bold size={13} />
          </button>
          <button
            type="button"
            onClick={() => handleFormatText('italic')}
            className="p-1.5 rounded hover:bg-white/10 text-gray-300 hover:text-white cursor-pointer"
            title="Italic (*text*)"
          >
            <Italic size={13} />
          </button>
          <button
            type="button"
            onClick={() => handleFormatText('underline')}
            className="p-1.5 rounded hover:bg-white/10 text-gray-300 hover:text-white cursor-pointer"
            title="Underline (<u>text</u>)"
          >
            <UnderlineIcon size={13} />
          </button>
          <div className="w-[1px] h-3.5 bg-white/10 mx-0.5" />
          <button
            type="button"
            onClick={() => handleFormatText('bullet')}
            className="p-1.5 rounded hover:bg-white/10 text-gray-300 hover:text-white cursor-pointer"
            title="Bulleted list (- item)"
          >
            <List size={13} />
          </button>
          <button
            type="button"
            onClick={() => handleFormatText('number')}
            className="p-1.5 rounded hover:bg-white/10 text-gray-300 hover:text-white cursor-pointer"
            title="Numbered list (1. item)"
          >
            <ListOrdered size={13} />
          </button>
        </div>
      )}

      {/* ── Emoji Picker Popover ──────────────────────────────────────────── */}
      {showEmojiPicker && (
        <div
          ref={emojiPickerRef}
          className="p-2 mt-1.5 bg-slate-900/95 border border-purple-500/30 rounded-xl shadow-xl max-h-40 overflow-y-auto grid grid-cols-8 gap-1"
        >
          {EMOJI_LIST.map((emoji, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleInsertEmoji(emoji)}
              className="p-1 text-base hover:bg-white/10 rounded cursor-pointer transition-transform hover:scale-110"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      {/* ── Message Composer ──────────────────────────────────────────────── */}
      <form onSubmit={handleSendMessage} className="mt-2 flex flex-col gap-1.5">
        <div className="relative bg-slate-900/60 border border-white/10 focus-within:border-purple-500 rounded-xl p-2 transition-all">
          <textarea
            ref={textareaRef}
            rows={2}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!canSendCurrent.allowed}
            placeholder={
              !canSendCurrent.allowed
                ? canSendCurrent.reason
                : activeTab === 'everyone'
                ? 'Message everyone (Enter to send, Shift+Enter for new line)...'
                : selectedRecipient
                ? `Message ${selectedRecipient.name}...`
                : 'Choose a recipient above...'
            }
            className="w-full bg-transparent text-xs text-white placeholder-gray-500 focus:outline-none resize-none disabled:opacity-50 disabled:cursor-not-allowed"
          />

          {/* Action Bar (T, Emoji, Attachment, Send) */}
          <div className="flex items-center justify-between pt-1 border-t border-white/5">
            <div className="flex items-center gap-1">
              {/* 'T' Formatting button */}
              <button
                type="button"
                onClick={() => setShowFormattingBar((prev) => !prev)}
                className={`px-1.5 py-0.5 rounded text-xs font-bold font-serif transition-colors cursor-pointer ${
                  showFormattingBar
                    ? 'bg-purple-600/30 text-purple-300'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`}
                title="Format text"
              >
                T
              </button>

              {/* Emoji Picker button */}
              <button
                type="button"
                onClick={() => setShowEmojiPicker((prev) => !prev)}
                className={`p-1 rounded transition-colors cursor-pointer ${
                  showEmojiPicker
                    ? 'bg-purple-600/30 text-purple-300'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`}
                title="Insert emoji"
              >
                <Smile size={14} />
              </button>

              {/* Ephemeral File Attachment button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="p-1 rounded text-gray-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
                title="Attach file (ephemeral in-memory, max 3 MB)"
              >
                <Paperclip size={14} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            {/* Send Button */}
            <button
              type="submit"
              disabled={(!inputText.trim() && !pendingAttachment) || !canSendCurrent.allowed}
              className="p-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-30 disabled:hover:bg-purple-600 text-white rounded-lg transition-all cursor-pointer disabled:cursor-not-allowed"
              title="Send message"
            >
              <Send size={13} />
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
