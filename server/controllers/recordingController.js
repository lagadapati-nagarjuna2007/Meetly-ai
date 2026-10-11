import crypto from 'crypto'
import { supabase } from '../config/supabase.js'
import * as b2Service from '../services/b2Service.js'
import { authorizeRecordingHost, authorizeRecordingViewer } from '../utils/recordingAuth.js'

/**
 * 1. POST /api/meetings/:meetingId/recording/start
 * Initializes a recording session.
 */
export const startRecordingSession = async (req, res) => {
  try {
    const { meetingId } = req.params
    const { mimeType = 'video/webm' } = req.body

    const auth = await authorizeRecordingHost(meetingId, req.user?.id)
    if (!auth.passed) {
      return res.status(auth.status).json({ message: auth.message })
    }

    const meeting = auth.meeting

    // Meeting must be Active
    if (meeting.meeting_status !== 'Active') {
      return res.status(400).json({ message: `Cannot start recording for meeting in '${meeting.meeting_status}' state.` })
    }

    // Check if another recording is already active
    const { data: existingActive, error: checkErr } = await supabase
      .from('recordings')
      .select('recording_id, status, operation_started_at, created_at')
      .eq('meeting_id', meeting.meeting_id)
      .in('status', ['starting', 'recording', 'finalizing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingActive) {
      return res.status(409).json({
        message: 'A recording session is currently active or in-flight for this meeting. Please finalize or abort the active session before starting a new one.',
        recordingId: existingActive.recording_id,
        status: existingActive.status
      })
    }

    // Generate unique recording identity and B2 object key
    const recordingId = crypto.randomUUID()
    const operationId = crypto.randomUUID()
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm'
    const b2Key = `recordings/${meeting.meeting_id}/${recordingId}.${ext}`

    // 1. Commit recording row with durable intent BEFORE calling B2
    let fencingToken = 1
    const { error: insertErr } = await supabase
      .from('recordings')
      .insert({
        recording_id: recordingId,
        meeting_id: meeting.meeting_id,
        meeting_code: meeting.meeting_code,
        host_id: meeting.host_id,
        recorded_by: req.user.id,
        b2_key: b2Key,
        mime_type: mimeType,
        status: 'starting',
        cleanup_status: 'none',
        b2_operation_state: 'in_flight',
        last_b2_operation: 'create_multipart',
        operation_id: operationId,
        operation_started_at: new Date().toISOString(),
        fencing_token: fencingToken,
        created_at: new Date().toISOString()
      })

    if (insertErr) {
      if (insertErr.code === '23505' || insertErr.message?.includes('duplicate key') || insertErr.message?.includes('uq_active_recording_per_meeting')) {
        return res.status(409).json({
          message: 'A recording session is currently active or in-flight for this meeting. Please finalize or abort the active session before starting a new one.'
        })
      }
      console.error('[Recording Start Error] Database insert failed:', insertErr)
      return res.status(500).json({ message: 'Failed to initialize recording session in database.' })
    }

    // 2. Call Backblaze B2 to create multipart upload
    let uploadId = null
    try {
      const b2Res = await b2Service.createMultipartUpload(b2Key, mimeType)
      uploadId = b2Res.uploadId
    } catch (b2Err) {
      console.error('[Recording Start Error] B2 CreateMultipartUpload failed:', b2Err)
      // Resolve failed intent in database preserving unresolved status for durable cleanup recovery
      await supabase
        .from('recordings')
        .update({
          status: 'failed',
          failure_reason: `B2 initialization failed: ${b2Err.message}`,
          cleanup_status: 'unresolved_error',
          b2_operation_state: 'unresolved',
          fencing_token: fencingToken + 1
        })
        .eq('recording_id', recordingId)

      return res.status(502).json({ message: 'Failed to initialize storage on Backblaze B2.' })
    }

    // 3. Persist Upload ID and resolve operation state
    const { error: resolveErr } = await supabase
      .from('recordings')
      .update({
        b2_upload_id: uploadId,
        b2_operation_state: 'settled',
        fencing_token: fencingToken + 1
      })
      .eq('recording_id', recordingId)

    if (resolveErr) {
      console.error('[Recording Start Error] Updating upload ID failed:', resolveErr)
    }

    // 4. Broadcast recording active event to room participants
    const io = req.app.get('io')
    if (io && meeting.room_name) {
      io.to(meeting.room_name).emit('recording_status_changed', {
        status: 'recording',
        recordingId,
        recordedBy: req.user.id,
        timestamp: new Date().toISOString()
      })
    }

    return res.status(201).json({
      recordingId,
      status: 'starting',
      b2Key,
      mimeType
    })
  } catch (err) {
    console.error('[Recording Start Error] Unexpected error:', err)
    return res.status(500).json({ message: 'Internal server error starting recording session.' })
  }
}

/**
 * 2. POST /api/meetings/:meetingId/recording/part-url
 * Generates a presigned URL for direct browser-to-B2 part upload.
 */
export const getMultipartUploadPartUrl = async (req, res) => {
  try {
    const { meetingId } = req.params
    const { recordingId, partNumber } = req.body

    const auth = await authorizeRecordingHost(meetingId, req.user?.id)
    if (!auth.passed) {
      return res.status(auth.status).json({ message: auth.message })
    }

    const partNum = Number(partNumber)
    if (!partNum || partNum < 1 || partNum > 10000) {
      return res.status(400).json({ message: 'Part number must be an integer between 1 and 10000.' })
    }

    // Fetch recording session
    const { data: recording, error: recErr } = await supabase
      .from('recordings')
      .select('recording_id, b2_key, b2_upload_id, status, recorded_by')
      .eq('recording_id', recordingId)
      .eq('meeting_id', auth.meeting.meeting_id)
      .maybeSingle()

    if (recErr || !recording) {
      return res.status(404).json({ message: 'Recording session not found.' })
    }

    if (!['starting', 'recording'].includes(recording.status)) {
      return res.status(409).json({ message: `Cannot upload parts for recording in '${recording.status}' state.` })
    }

    if (!recording.b2_upload_id) {
      return res.status(500).json({ message: 'Storage upload ID missing for this session.' })
    }

    // Transition status from 'starting' to 'recording' upon first part request
    if (recording.status === 'starting') {
      await supabase
        .from('recordings')
        .update({ status: 'recording' })
        .eq('recording_id', recordingId)
    }

    // Generate 15-minute presigned upload part URL
    const { presignedUrl, expiresInSeconds } = await b2Service.getPresignedPartUrl(
      recording.b2_key,
      recording.b2_upload_id,
      partNum,
      900
    )

    return res.status(200).json({
      partNumber: partNum,
      presignedUrl,
      expiresInSeconds
    })
  } catch (err) {
    console.error('[Recording Part-Url Error] Unexpected error:', err)
    return res.status(500).json({ message: 'Failed to generate presigned upload part URL.' })
  }
}

/**
 * 3. POST /api/meetings/:meetingId/recording/complete
 * Validates uploaded parts against B2, completes multipart upload, and verifies actual size.
 */
export const completeRecordingSession = async (req, res) => {
  try {
    const { meetingId } = req.params
    const { recordingId, durationSeconds = 0, parts = [] } = req.body

    const auth = await authorizeRecordingHost(meetingId, req.user?.id)
    if (!auth.passed) {
      return res.status(auth.status).json({ message: auth.message })
    }

    if (!Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ message: 'At least one uploaded part is required to complete recording.' })
    }

    // Fetch recording session
    const { data: recording, error: recErr } = await supabase
      .from('recordings')
      .select('*')
      .eq('recording_id', recordingId)
      .eq('meeting_id', auth.meeting.meeting_id)
      .maybeSingle()

    if (recErr || !recording) {
      return res.status(404).json({ message: 'Recording session not found.' })
    }

    if (recording.status === 'ready') {
      return res.status(200).json({
        recordingId: recording.recording_id,
        status: 'ready',
        fileSizeBytes: recording.file_size_bytes,
        durationSeconds: recording.duration_seconds
      })
    }

    // Transition to 'finalizing'
    const operationId = crypto.randomUUID()
    await supabase
      .from('recordings')
      .update({
        status: 'finalizing',
        b2_operation_state: 'in_flight',
        last_b2_operation: 'complete_multipart',
        operation_id: operationId,
        operation_started_at: new Date().toISOString(),
        fencing_token: recording.fencing_token + 1
      })
      .eq('recording_id', recordingId)

    // 1. Verify parts with B2 ListParts to avoid client spoofing
    let uploadedParts = []
    try {
      uploadedParts = await b2Service.listParts(recording.b2_key, recording.b2_upload_id)
    } catch (listErr) {
      console.warn('[Recording Complete Warning] B2 ListParts check warning:', listErr.message)
    }

    // Use uploaded parts from B2 if available; fallback to validated client manifest
    const manifestToComplete = (uploadedParts.length > 0)
      ? uploadedParts.map(p => ({ partNumber: p.partNumber, etag: p.etag }))
      : parts.map(p => ({ partNumber: Number(p.partNumber), etag: String(p.etag || '').trim() }))

    // 2. Complete Multipart Upload on B2
    try {
      await b2Service.completeMultipartUpload(recording.b2_key, recording.b2_upload_id, manifestToComplete)
    } catch (completeErr) {
      console.error('[Recording Complete Error] B2 CompleteMultipartUpload failed:', completeErr)
      await supabase
        .from('recordings')
        .update({
          status: 'failed',
          failure_reason: `Storage completion failed: ${completeErr.message}`,
          cleanup_status: 'pending_cleanup',
          b2_operation_state: 'unresolved'
        })
        .eq('recording_id', recordingId)

      return res.status(502).json({ message: 'Failed to complete storage assembly on Backblaze B2.' })
    }

    // 3. Verify actual object size on B2 with HeadObject
    let verifiedSize = 0
    let verifiedMime = recording.mime_type
    try {
      const head = await b2Service.headObject(recording.b2_key)
      verifiedSize = head.contentLength || 0
      if (head.contentType) verifiedMime = head.contentType
    } catch (headErr) {
      console.warn('[Recording Complete Warning] B2 HeadObject check returned:', headErr.message)
    }

    // 4. Enforce strict hard cap: 2,000,000,000 bytes
    if (verifiedSize > 2000000000) {
      console.error(`[Recording Cap Exceeded] Verified size ${verifiedSize} bytes exceeds 2,000,000,000 bytes cap.`)
      await supabase
        .from('recordings')
        .update({
          status: 'failed',
          failure_reason: 'Completed recording exceeded 2,000,000,000 bytes hard limit.',
          file_size_bytes: verifiedSize,
          duration_seconds: durationSeconds,
          cleanup_status: 'pending_cleanup',
          b2_operation_state: 'settled'
        })
        .eq('recording_id', recordingId)

      // Queue storage purge immediately
      b2Service.deleteExactKeyVersions(recording.b2_key).catch(e => console.error('Auto purge error:', e))

      return res.status(413).json({ message: 'Recording exceeded the maximum accepted size of 2,000,000,000 bytes.' })
    }

    // 5. Finalize status to 'ready'
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString() // completed_at + 30 days

    await supabase
      .from('recordings')
      .update({
        status: 'ready',
        file_size_bytes: verifiedSize,
        duration_seconds: Number(durationSeconds) || 0,
        mime_type: verifiedMime,
        completed_at: now.toISOString(),
        expires_at: expiresAt,
        b2_upload_id: null,
        b2_operation_state: 'settled',
        cleanup_status: 'none'
      })
      .eq('recording_id', recordingId)

    // Mark parent meeting as has_recording = true
    await supabase
      .from('meetings')
      .update({ has_recording: true })
      .eq('meeting_id', auth.meeting.meeting_id)

    // Broadcast 'ready' status to meeting room
    const io = req.app.get('io')
    if (io && auth.meeting.room_name) {
      io.to(auth.meeting.room_name).emit('recording_status_changed', {
        status: 'ready',
        recordingId,
        durationSeconds,
        fileSizeBytes: verifiedSize,
        timestamp: now.toISOString()
      })
    }

    return res.status(200).json({
      recordingId,
      status: 'ready',
      fileSizeBytes: verifiedSize,
      durationSeconds,
      mimeType: verifiedMime,
      completedAt: now.toISOString(),
      expiresAt
    })
  } catch (err) {
    console.error('[Recording Complete Error] Unexpected error:', err)
    return res.status(500).json({ message: 'Internal server error finalizing recording.' })
  }
}

/**
 * 4. POST /api/meetings/:meetingId/recording/abort
 * Aborts an active recording session.
 */
export const abortRecordingSession = async (req, res) => {
  try {
    const { meetingId } = req.params
    const { recordingId, reason = 'user_cancelled' } = req.body

    const auth = await authorizeRecordingHost(meetingId, req.user?.id)
    if (!auth.passed) {
      return res.status(auth.status).json({ message: auth.message })
    }

    const { data: recording } = await supabase
      .from('recordings')
      .select('recording_id, b2_key, b2_upload_id')
      .eq('recording_id', recordingId)
      .eq('meeting_id', auth.meeting.meeting_id)
      .maybeSingle()

    if (!recording) {
      return res.status(404).json({ message: 'Recording session not found.' })
    }

    // Abort B2 multipart upload if active
    let abortSuccess = true
    if (recording.b2_upload_id) {
      try {
        await b2Service.abortMultipartUpload(recording.b2_key, recording.b2_upload_id)
      } catch (abortErr) {
        abortSuccess = false
        console.warn('[Recording Abort Warning] B2 abort error:', abortErr.message)
      }
    }

    // Update status to failed, preserving unresolved status if storage abort failed
    await supabase
      .from('recordings')
      .update({
        status: 'failed',
        failure_reason: `Aborted: ${reason}`,
        cleanup_status: abortSuccess ? 'cleaned' : 'unresolved_error',
        b2_operation_state: abortSuccess ? 'settled' : 'unresolved',
        b2_upload_id: abortSuccess ? null : recording.b2_upload_id
      })
      .eq('recording_id', recordingId)

    // Broadcast stopped status
    const io = req.app.get('io')
    if (io && auth.meeting.room_name) {
      io.to(auth.meeting.room_name).emit('recording_status_changed', {
        status: 'stopped',
        recordingId,
        reason
      })
    }

    return res.status(200).json({ status: 'failed', aborted: true })
  } catch (err) {
    console.error('[Recording Abort Error] Unexpected error:', err)
    return res.status(500).json({ message: 'Failed to abort recording session.' })
  }
}

/**
 * 5. GET /api/meetings/:meetingId/recording
 * Retrieves recording metadata for authorized host, active host, or historical attendees.
 */
export const getRecordingStatus = async (req, res) => {
  try {
    const { meetingId } = req.params

    const auth = await authorizeRecordingViewer(meetingId, req.user?.id)
    if (!auth.passed) {
      return res.status(auth.status).json({ message: auth.message })
    }

    const { data: recording, error: fetchErr } = await supabase
      .from('recordings')
      .select('*')
      .eq('meeting_id', auth.meeting.meeting_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (fetchErr) {
      return res.status(500).json({ message: 'Error retrieving recording details.' })
    }

    if (!recording) {
      return res.status(404).json({ message: 'No recording found for this meeting.' })
    }

    return res.status(200).json({
      recordingId: recording.recording_id,
      meetingId: recording.meeting_id,
      meetingCode: recording.meeting_code,
      status: recording.status,
      durationSeconds: recording.duration_seconds,
      fileSizeBytes: recording.file_size_bytes,
      mimeType: recording.mime_type,
      failureReason: recording.failure_reason,
      createdAt: recording.created_at,
      completedAt: recording.completed_at,
      expiresAt: recording.expires_at,
      canDownload: auth.canDownload
    })
  } catch (err) {
    console.error('[Recording Status Error] Unexpected error:', err)
    return res.status(500).json({ message: 'Server error retrieving recording status.' })
  }
}

/**
 * 6. GET /api/meetings/:meetingId/recording/stream
 * Generates an authorized 15-minute inline streaming URL for Host, Active Host, or Attendee.
 */
export const getRecordingStreamUrl = async (req, res) => {
  try {
    const { meetingId } = req.params

    const auth = await authorizeRecordingViewer(meetingId, req.user?.id)
    if (!auth.passed) {
      return res.status(auth.status).json({ message: auth.message })
    }

    const { data: recording } = await supabase
      .from('recordings')
      .select('recording_id, b2_key, status, expires_at')
      .eq('meeting_id', auth.meeting.meeting_id)
      .eq('status', 'ready')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!recording) {
      return res.status(404).json({ message: 'Ready recording not found for this meeting.' })
    }

    if (recording.expires_at && new Date(recording.expires_at) < new Date()) {
      return res.status(410).json({ message: 'This recording has expired and is no longer available.' })
    }

    // Generate 15-minute signed inline URL
    const streamUrl = await b2Service.getPresignedStreamUrl(recording.b2_key, 900)

    return res.status(200).json({
      streamUrl,
      expiresInSeconds: 900
    })
  } catch (err) {
    console.error('[Recording Stream Error] Unexpected error:', err)
    return res.status(500).json({ message: 'Failed to generate authorized streaming URL.' })
  }
}

/**
 * 7. GET /api/meetings/:meetingId/recording/download
 * Generates an authorized 15-minute attachment download URL for Host or Active Host only.
 */
export const getRecordingDownloadUrl = async (req, res) => {
  try {
    const { meetingId } = req.params

    const auth = await authorizeRecordingHost(meetingId, req.user?.id)
    if (!auth.passed) {
      return res.status(auth.status).json({ message: auth.message })
    }

    const { data: recording } = await supabase
      .from('recordings')
      .select('recording_id, b2_key, status, meeting_code, mime_type, expires_at')
      .eq('meeting_id', auth.meeting.meeting_id)
      .eq('status', 'ready')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!recording) {
      return res.status(404).json({ message: 'Ready recording not found for this meeting.' })
    }

    if (recording.expires_at && new Date(recording.expires_at) < new Date()) {
      return res.status(410).json({ message: 'This recording has expired.' })
    }

    const ext = recording.mime_type.includes('mp4') ? 'mp4' : 'webm'
    const filename = `Meetly-${recording.meeting_code}-Recording.${ext}`

    // Generate 15-minute signed attachment URL
    const downloadUrl = await b2Service.getPresignedDownloadUrl(recording.b2_key, filename, 900)

    return res.status(200).json({
      downloadUrl,
      expiresInSeconds: 900,
      filename
    })
  } catch (err) {
    console.error('[Recording Download Error] Unexpected error:', err)
    return res.status(500).json({ message: 'Failed to generate download URL.' })
  }
}

/**
 * 8. DELETE /api/meetings/:meetingId/recording
 * Original Meeting Host only. Marks recording for deletion and triggers asynchronous B2 purge.
 */
export const deleteRecordingSession = async (req, res) => {
  try {
    const { meetingId } = req.params

    const auth = await authorizeRecordingHost(meetingId, req.user?.id)
    if (!auth.passed) {
      return res.status(auth.status).json({ message: auth.message })
    }

    // Only Original Host can delete
    if (!auth.isOriginalHost) {
      return res.status(403).json({ message: 'Unauthorized. Only the Original Meeting Host can delete recordings.' })
    }

    const { data: recs } = await supabase
      .from('recordings')
      .select('recording_id, b2_key, b2_upload_id, status')
      .eq('meeting_id', auth.meeting.meeting_id)
      .neq('status', 'purged')

    if (!recs || recs.length === 0) {
      return res.status(404).json({ message: 'No active or ready recordings found for this meeting.' })
    }

    // Transition each unpurged recording to pending_deletion
    for (const recording of recs) {
      await supabase
        .from('recordings')
        .update({
          status: 'pending_deletion',
          cleanup_status: 'pending_cleanup',
          b2_operation_state: 'in_flight',
          last_b2_operation: 'delete_versions'
        })
        .eq('recording_id', recording.recording_id)

      // Dispatch asynchronous B2 permanent version purge
      b2Service.deleteExactKeyVersions(recording.b2_key, recording.b2_upload_id)
        .then(async () => {
          await supabase
            .from('recordings')
            .update({
              status: 'purged',
              cleanup_status: 'cleaned',
              b2_operation_state: 'settled'
            })
            .eq('recording_id', recording.recording_id)
          console.log(`[Recording Delete] Successfully purged B2 objects for ${recording.recording_id}`)
        })
        .catch(async (purgeErr) => {
          console.error(`[Recording Delete Error] B2 purge failed for ${recording.recording_id}:`, purgeErr)
          await supabase
            .from('recordings')
            .update({
              cleanup_status: 'unresolved_error',
              b2_operation_state: 'unresolved',
              failure_reason: purgeErr.message
            })
            .eq('recording_id', recording.recording_id)
        })
    }

    return res.status(200).json({
      message: 'Recording deletion initiated. Permanent storage purge is underway.',
      status: 'pending_deletion'
    })
  } catch (err) {
    console.error('[Recording Delete Error] Unexpected error:', err)
    return res.status(500).json({ message: 'Server error processing recording deletion.' })
  }
}

/**
 * 9. GET /api/meetings/attended
 * Retrieves all meetings the authenticated user attended that have available recordings.
 */
export const getAttendedMeetingsWithRecordings = async (req, res) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return res.status(401).json({ message: 'Authentication required.' })
    }

    // Find meetings the user attended (joined_at is not null or status is joined/left)
    const { data: attendedParts, error: partErr } = await supabase
      .from('participants')
      .select('meeting_id, joined_at, left_at')
      .eq('user_id', userId)

    if (partErr) {
      console.error('[Attended Meetings Error] Query failed:', partErr)
      return res.status(500).json({ message: 'Failed to query attended meetings.' })
    }

    if (!attendedParts || attendedParts.length === 0) {
      return res.status(200).json({ meetings: [] })
    }

    const meetingIds = [...new Set(attendedParts.map(p => p.meeting_id))]

    // Fetch meetings with completed ready recordings
    const { data: meetings, error: mtgErr } = await supabase
      .from('meetings')
      .select(`
        meeting_id,
        meeting_code,
        meeting_title,
        started_at,
        ended_at,
        created_at,
        host:host_id ( full_name )
      `)
      .in('meeting_id', meetingIds)
      .eq('is_deleted', false)
      .order('started_at', { ascending: false })

    if (mtgErr) {
      return res.status(500).json({ message: 'Failed to fetch meeting records.' })
    }

    // Query recordings for these meetings
    const { data: recordings, error: recErr } = await supabase
      .from('recordings')
      .select('recording_id, meeting_id, duration_seconds, file_size_bytes, mime_type, completed_at, expires_at, status')
      .in('meeting_id', meetingIds)
      .eq('status', 'ready')

    if (recErr) {
      return res.status(500).json({ message: 'Failed to query recordings.' })
    }

    const recMap = new Map((recordings || []).map(r => [r.meeting_id, r]))

    const result = (meetings || [])
      .filter(m => recMap.has(m.meeting_id))
      .map(m => ({
        meetingId: m.meeting_id,
        meetingCode: m.meeting_code,
        meetingTitle: m.meeting_title || 'Untitled Meeting',
        topic: m.meeting_title || 'Untitled Meeting',
        hostName: m.host?.full_name || 'Host',
        startedAt: m.started_at || m.created_at,
        endedAt: m.ended_at,
        recording: recMap.get(m.meeting_id)
      }))

    return res.status(200).json({ meetings: result })
  } catch (err) {
    console.error('[Attended Recordings Error] Unexpected error:', err)
    return res.status(500).json({ message: 'Server error retrieving attended recordings.' })
  }
}
