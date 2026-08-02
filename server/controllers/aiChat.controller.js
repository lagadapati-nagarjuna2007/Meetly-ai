import { supabase } from '../config/supabase.js'
import {
  getRemainingRequests,
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
      ? supabase.from('meetings').select('meeting_id, host_id, meeting_status').eq('meeting_id', meetingId)
      : supabase.from('meetings').select('meeting_id, host_id, meeting_status').eq('meeting_code', meetingId.trim().toUpperCase())

    const { data: meeting, error: mtgErr } = await query.maybeSingle()

    if (mtgErr) throw mtgErr
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' })
    }

    if (meeting.meeting_status === 'Ended') {
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

    // 3. Check remaining requests
    const remaining = getRemainingRequests(targetMeetingId, req.user.id)
    if (remaining <= 0) {
      return res.status(429).json({
        success: false,
        message: 'You have reached the maximum of 10 AI questions for this meeting.'
      })
    }

    // 4. Check if transcript is missing
    if (!transcript || transcript.trim() === '') {
      return res.status(400).json({ success: false, message: 'Transcript not available yet.' })
    }

    // 5. Call LLM Service
    const answer = await getAIChatResponse(transcript, question)

    // 6. Only increment counter after a successful response
    incrementRequestCounter(targetMeetingId, req.user.id)

    const updatedRemaining = getRemainingRequests(targetMeetingId, req.user.id)

    return res.status(200).json({
      success: true,
      answer,
      remainingQuestions: updatedRemaining
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
      ? supabase.from('meetings').select('meeting_id').eq('meeting_id', meetingId)
      : supabase.from('meetings').select('meeting_id').eq('meeting_code', meetingId.trim().toUpperCase())

    const { data: meeting, error: mtgErr } = await query.maybeSingle()
    if (mtgErr) throw mtgErr
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' })
    }

    const remaining = getRemainingRequests(meeting.meeting_id, req.user.id)
    return res.status(200).json({
      success: true,
      remainingQuestions: remaining
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
      ? supabase.from('meetings').select('meeting_id').eq('meeting_id', meetingId)
      : supabase.from('meetings').select('meeting_id').eq('meeting_code', meetingId.trim().toUpperCase())

    const { data: meeting, error: mtgErr } = await query.maybeSingle()
    if (mtgErr) throw mtgErr
    if (!meeting) {
      return res.status(404).json({ success: false, message: 'Meeting not found.' })
    }

    const targetMeetingId = meeting.meeting_id

    const { data: chunks, error: fetchErr } = await supabase
      .from('meeting_transcripts')
      .select('speaker_name, transcript')
      .eq('meeting_id', targetMeetingId)
      .order('created_at', { ascending: true })

    if (fetchErr) throw fetchErr

    const transcriptText = (chunks || [])
      .map(c => `${c.speaker_name}: ${c.transcript}`)
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
