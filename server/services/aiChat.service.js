// In-memory request counter storage: Map<meetingId, Map<userId, count>>
export const aiRequestCounters = new Map()

/**
 * Get remaining questions count for a user in a meeting
 */
export const getRemainingRequests = (meetingId, userId) => {
  if (!meetingId || !userId) return 10
  const meetingMap = aiRequestCounters.get(meetingId)
  if (!meetingMap) return 10
  const count = meetingMap.get(userId) || 0
  return Math.max(0, 10 - count)
}

/**
 * Increment the request counter for a user in a meeting
 */
export const incrementRequestCounter = (meetingId, userId) => {
  if (!meetingId || !userId) return
  if (!aiRequestCounters.has(meetingId)) {
    aiRequestCounters.set(meetingId, new Map())
  }
  const meetingMap = aiRequestCounters.get(meetingId)
  const current = meetingMap.get(userId) || 0
  meetingMap.set(userId, current + 1)
  console.log(`[AI Chat Counter] Meeting ${meetingId} | User ${userId} count incremented to ${current + 1}`)
}

/**
 * Clear request counters for a specific meeting
 */
export const clearMeetingCounters = (meetingId) => {
  if (!meetingId) return
  if (aiRequestCounters.has(meetingId)) {
    aiRequestCounters.delete(meetingId)
    console.log(`[AI Chat Counter] In-memory request counters cleared for meeting ${meetingId}`)
  }
}

/**
 * Call the AI Chat Assistant API using the separate API key and model config.
 * Answers questions strictly using the provided transcript.
 */
export const getAIChatResponse = async (transcript, question) => {
  const apiKey = process.env.AI_CHAT_API_KEY
  const model = process.env.AI_CHAT_MODEL

  if (!apiKey) {
    throw new Error('AI_CHAT_API_KEY is not configured on the server.')
  }

  if (!model) {
    throw new Error('AI_CHAT_MODEL is not configured on the server.')
  }

  if (!transcript || transcript.trim() === '') {
    throw new Error('Transcript not available yet.')
  }

  // Limit transcript to approximately the last 15,000 characters to reduce latency/token usage
  let optimizedTranscript = transcript
  if (optimizedTranscript.length > 15000) {
    optimizedTranscript = optimizedTranscript.substring(optimizedTranscript.length - 15000)
  }

  const systemPrompt = `You are Meetly AI Assistant.
Answer ONLY using the meeting transcript provided below.
Rules:
- Do not invent facts.
- Do not answer using outside knowledge.
- If the transcript does not contain the answer, respond exactly: "I couldn't find that information in this meeting."
- Keep responses concise.
- If asked to summarize the meeting, generate a concise summary using ONLY the transcript.`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000) // 30 seconds timeout

  try {
    console.log(`[AI Chat Service] Dispatching LLM completions API request to Groq using model: ${model}`)
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Transcript:\n${optimizedTranscript}\n\nQuestion: ${question}` }
        ],
        temperature: 0.0
      })
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      if (response.status === 400) {
        throw new Error('Invalid AI Chat model configuration or request.')
      }
      if (response.status === 401) {
        throw new Error('Invalid AI Chat API key configuration.')
      }
      if (response.status === 429) {
        throw new Error('Rate limit exceeded by the model provider. Please try again later.')
      }
      const errText = await response.text()
      console.error(`[AI Chat LLM API Error] Status: ${response.status} | Details:`, errText)
      throw new Error('An error occurred with the AI model provider. Please try again.')
    }

    const data = await response.json()
    if (!data.choices || data.choices.length === 0 || !data.choices[0].message) {
      throw new Error('Invalid response structure received from model provider.')
    }

    const answer = data.choices[0].message.content || ''
    return answer.trim()
  } catch (err) {
    clearTimeout(timeoutId)
    if (err.name === 'AbortError') {
      throw new Error('AI response timed out (30 seconds limit reached).')
    }
    throw err
  }
}
