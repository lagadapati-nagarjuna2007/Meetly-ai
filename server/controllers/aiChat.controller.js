import { supabase } from '../config/supabase.js'
import {
  getRemainingRequests,
  reserveQuestionQuota,
  releaseQuestionQuota,
  completeQuestionReservation,
  incrementRequestCounter,
  getAIChatResponse
} from '../services/aiChat.service.js'

const isUuid = (str) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return uuidRegex.test(str)
}

/**
 * Handle POST /api/meetings/:meetingId/ai-chat
 * Process an AI Chat Assistant question using the meeting transcript
 */
export const handleAIChatRequest = async (req, res) => {
  try {
    const { meetingId } = req.params
    const { transcript, question } = req.body

    if (!meetingId) {
      return res.status(400).json({ success: false, message: 'Meeting ID is required.' })
    }

    if (!question || question.trim() === '') {
      return res.status(400).json({ success: false, message: 'Question is required.' })
    }

    // 1. Verify the meeting exists
    const query = isUuid(meetingId)
      ? supabase.from('meetings').select('meeting_id, host_id, meeting_status, is_deleted').eq('meeting_id', meetingId)
      : supabase.from('meetings').select('meeting_id, host_id, meeting_status, is_deleted').eq('meeting_code', meetingId.trim().toUpperCase())

    const { data: meeting, error: mtgErr } = await query.maybeSingle()

    if (mtgErr) throw mtgErr
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' })
    }

    if (meeting.meeting_status === 'Ended' || meeting.is_deleted === true) {
      console.log('[Meeting Validation] Ignoring request because meeting has ended.')
      return res.status(400).json({ success: false, message: 'This meeting has already ended.' })
    }

    const targetMeetingId = meeting.meeting_id

    // 2. Verify participant/host belongs to the meeting
    const isHost = meeting.host_id === req.user.id
    let isParticipant = isHost

    if (!isParticipant) {
      const { data: part, error: partErr } = await supabase
        .from('participants')
        .select('participant_id')
        .eq('meeting_id', targetMeetingId)
        .eq('user_id', req.user.id)
        .maybeSingle()

      if (partErr) throw partErr
      if (part) {
        isParticipant = true
      }
    }

    if (!isParticipant) {
      return res.status(403).json({ success: false, message: 'Access denied. You do not belong to this meeting.' })
    }

    // 3. Atomically check and reserve one question from the participant's quota BEFORE calling AI provider
    const reservation = await reserveQuestionQuota(targetMeetingId, req.user.id, req.user.email)
    if (!reservation.allowed) {
      return res.status(429).json({
        success: false,
        message: reservation.message || 'You have used all 10 AI Assistant questions for this meeting.',
        remainingQuestions: 0,
        questionsUsed: reservation.questionsUsed ?? 10
      })
    }

    // 4. Check if transcript is missing; if missing, refund reserved question
    if (!transcript || transcript.trim() === '') {
      await releaseQuestionQuota(targetMeetingId, req.user.id, reservation.reservationId)
      return res.status(400).json({ success: false, message: 'Transcript not available yet.' })
    }

    // 5. Call LLM Service
    let answer
    try {
      answer = await getAIChatResponse(transcript, question)
      // Settle reservation as completed on confirmed success so it cannot be refunded
      if (reservation.reservationId) {
        await completeQuestionReservation(targetMeetingId, req.user.id, reservation.reservationId)
      }
    } catch (providerErr) {
      console.error('[AI Chat Provider Error]:', providerErr.message)
      // Idempotently release reservation on confirmed provider failure
      await releaseQuestionQuota(targetMeetingId, req.user.id, reservation.reservationId)
      return res.status(500).json({
        success: false,
        message: providerErr.message || 'An error occurred with the AI model provider. Please try again.'
      })
    }

    return res.status(200).json({
      success: true,
      answer,
      remainingQuestions: reservation.remainingQuestions,
      questionsUsed: reservation.questionsUsed
    })
  } catch (err) {
    console.error('[AI Chat Controller Error]:', err)
    return res.status(500).json({
      success: false,
      message: err.message || 'An internal server error occurred while processing your AI question.'
    })
  }
}

/**
 * Handle GET /api/meetings/:meetingId/ai-chat/remaining
 * Fetch the current user's remaining questions count
 */
export const handleGetRemainingRequests = async (req, res) => {
  try {
    const { meetingId } = req.params

    if (!meetingId) {
      return res.status(400).json({ success: false, message: 'Meeting ID is required.' })
    }

    const query = isUuid(meetingId)
      ? supabase.from('meetings').select('meeting_id, meeting_status, is_deleted').eq('meeting_id', meetingId)
      : supabase.from('meetings').select('meeting_id, meeting_status, is_deleted').eq('meeting_code', meetingId.trim().toUpperCase())

    const { data: meeting, error: mtgErr } = await query.maybeSingle()
    if (mtgErr) throw mtgErr
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found.', remainingQuestions: 0 })
    }

    if (meeting.meeting_status === 'Ended' || meeting.is_deleted === true) {
      return res.status(200).json({
        success: true,
        remainingQuestions: 0,
        questionsUsed: 10,
        maxQuestions: 10,
        meetingEnded: true
      })
    }

    const remaining = await getRemainingRequests(meeting.meeting_id, req.user.id)
    return res.status(200).json({
      success: true,
      remainingQuestions: remaining,
      questionsUsed: Math.max(0, 10 - remaining),
      maxQuestions: 10
    })
  } catch (err) {
    console.error('[AI Chat Get Remaining Error]:', err)
    return res.status(500).json({ success: false, message: 'Server error retrieving remaining questions count.' })
  }
}

/**
 * Handle GET /api/meetings/:meetingId/transcript
 * Retrieve the accumulated meeting transcript text
 */
export const getMeetingTranscriptText = async (req, res) => {
  try {
    const { meetingId } = req.params

    if (!meetingId) {
      return res.status(400).json({ success: false, message: 'Meeting ID is required.' })
    }

    const query = isUuid(meetingId)
      ? supabase.from('meetings').select('meeting_id, host_id, meeting_status').eq('meeting_id', meetingId)
      : supabase.from('meetings').select('meeting_id, host_id, meeting_status').eq('meeting_code', meetingId.trim().toUpperCase())

    const { data: meeting, error: mtgErr } = await query.maybeSingle()
    if (mtgErr) throw mtgErr
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' })
    }

    const targetMeetingId = meeting.meeting_id
    const isOriginalHost = String(meeting.host_id || '').toLowerCase() === String(req.user?.id || '').toLowerCase()

    if (meeting.meeting_status === 'Ended') {
      // Completed meeting: Only the permanent Original Host can access transcript history
      if (!isOriginalHost) {
        return res.status(403).json({ success: false, message: 'Access denied. Only the Original Host can access completed meeting transcripts.' })
      }
    } else {
      // Live meeting: Either the Original Host or a participant can fetch transcript for AI chat
      if (!isOriginalHost) {
        const { data: part, error: partErr } = await supabase
          .from('participants')
          .select('participant_id')
          .eq('meeting_id', targetMeetingId)
          .eq('user_id', req.user?.id)
          .maybeSingle()

        if (partErr) throw partErr
        if (!part) {
          return res.status(403).json({ success: false, message: 'Access denied. You do not belong to this meeting.' })
        }
      }
    }

    const { data: chunks, error: fetchErr } = await supabase
      .from('meeting_transcripts')
      .select('speaker_name, transcript, english_transcript')
      .eq('meeting_id', targetMeetingId)
      .order('created_at', { ascending: true })

    if (fetchErr) throw fetchErr

    // Prefer english_transcript for AI chat context so the LLM sees clean English.
    // Falls back to raw transcript for old rows or chunks where translation was unavailable.
    const transcriptText = (chunks || [])
      .map(c => `${c.speaker_name}: ${c.english_transcript || c.transcript}`)
      .join('\n')

    return res.status(200).json({
      success: true,
      transcript: transcriptText
    })
  } catch (err) {
    console.error('[AI Chat Transcript Get Error]:', err)
    return res.status(500).json({ success: false, message: 'Server error retrieving meeting transcript.' })
  }
}
