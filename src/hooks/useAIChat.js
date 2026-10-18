import { useState, useCallback } from 'react'

const optimizeTranscript = (fullTranscript, question) => {
  if (!fullTranscript || fullTranscript.length < 8000) {
    return fullTranscript
  }

  const lines = fullTranscript.split('\n')
  
  // Extract keywords, stripping punctuation and filtering common stop words
  const stopWords = ['what', 'when', 'where', 'explained', 'about', 'meeting', 'today', 'professor', 'explain', 'showed', 'there', 'their', 'about', 'would', 'could', 'should']
  const keywords = question.toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.includes(w))

  if (keywords.length === 0) {
    // If no specific keywords match, fallback to the last 100 lines of discussion
    return lines.slice(-100).join('\n')
  }

  const matchedIndices = new Set()
  lines.forEach((line, idx) => {
    const lowerLine = line.toLowerCase()
    const matches = keywords.some(word => lowerLine.includes(word))
    if (matches) {
      // Fetch matching line plus surrounding context (2 lines before and after)
      for (let i = Math.max(0, idx - 2); i <= Math.min(lines.length - 1, idx + 2); i++) {
        matchedIndices.add(i)
      }
    }
  })

  // Always append the last 15 lines of the transcript to preserve current chat state
  const lastLinesStart = Math.max(0, lines.length - 15)
  for (let i = lastLinesStart; i < lines.length; i++) {
    matchedIndices.add(i)
  }

  const optimizedText = Array.from(matchedIndices)
    .sort((a, b) => a - b)
    .map(idx => lines[idx])
    .join('\n')

  return optimizedText
}

const getAuthHeaders = () => {
  const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
  const headers = { 'Content-Type': 'application/json' }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

const useAIChat = () => {
  const [messages, setMessages] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [remainingQuestions, setRemainingQuestions] = useState(10)
  const [error, setError] = useState(null)

  const fetchRemainingQuestions = useCallback(async (meetingId) => {
    if (!meetingId) return
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000'
    try {
      const res = await fetch(`${apiUrl}/api/meetings/${meetingId}/ai-chat/remaining`, {
        method: 'GET',
        headers: getAuthHeaders(),
        credentials: 'include'
      })
      if (res.ok) {
        const data = await res.json()
        setRemainingQuestions(data.remainingQuestions ?? 10)
      }
    } catch (err) {
      console.error('[AI Chat] Failed to fetch remaining questions limit:', err)
    }
  }, [])

  const askQuestion = useCallback(async (meetingId, question) => {
    if (!meetingId || !question || question.trim() === '') return

    setIsLoading(true)
    setError(null)

    const userMessage = {
      sender: 'user',
      text: question,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    }

    setMessages((prev) => [...prev, userMessage])

    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000'

    try {
      // 1. Submit question to AI Chat Assistant endpoint (server uses authoritative stored transcript)
      console.log('[AI Chat] Sending question to backend AI Assistant...')
      const chatRes = await fetch(`${apiUrl}/api/meetings/${meetingId}/ai-chat`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          meetingId,
          question
        }),
        credentials: 'include'
      })

      const chatData = await chatRes.json()

      if (!chatRes.ok) {
        if (chatRes.status === 429) {
          const limitMsg = chatData.message || 'You have used all 10 AI Assistant questions for this meeting.'
          setError(limitMsg)
          setRemainingQuestions(0)
          const aiResponse = {
            sender: 'ai',
            text: limitMsg,
            timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          }
          setMessages((prev) => [...prev, aiResponse])
          setIsLoading(false)
          return
        }

        if (chatRes.status === 400 && chatData.message === 'Transcript not available yet.') {
          const aiResponse = {
            sender: 'ai',
            text: 'Transcript not available yet.',
            timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          }
          setMessages((prev) => [...prev, aiResponse])
          setIsLoading(false)
          return
        }

        throw new Error(chatData.message || 'An error occurred during your AI Chat request.')
      }

      const aiResponse = {
        sender: 'ai',
        text: chatData.answer || "I couldn't find that information in this meeting.",
        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      }

      setMessages((prev) => [...prev, aiResponse])
      setRemainingQuestions(chatData.remainingQuestions ?? 0)
    } catch (err) {
      console.error('[AI Chat Error]:', err)
      const friendlyMessage = err.message || 'Friendly error. Connection issues or invalid API configuration.'
      setError(friendlyMessage)
      
      const aiResponse = {
        sender: 'ai',
        text: friendlyMessage,
        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      }
      setMessages((prev) => [...prev, aiResponse])
    } finally {
      setIsLoading(false)
    }
  }, [])

  return {
    messages,
    isLoading,
    remainingQuestions,
    error,
    fetchRemainingQuestions,
    askQuestion
  }
}

export default useAIChat
