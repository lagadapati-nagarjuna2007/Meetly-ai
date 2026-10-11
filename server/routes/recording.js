import express from 'express'
import {
  startRecordingSession,
  getMultipartUploadPartUrl,
  completeRecordingSession,
  abortRecordingSession,
  getRecordingStatus,
  getRecordingStreamUrl,
  getRecordingDownloadUrl,
  deleteRecordingSession
} from '../controllers/recordingController.js'

// mergeParams: true allows accessing :meetingId from the parent router
const router = express.Router({ mergeParams: true })

router.post('/start', startRecordingSession)
router.post('/part-url', getMultipartUploadPartUrl)
router.post('/complete', completeRecordingSession)
router.post('/abort', abortRecordingSession)
router.get('/', getRecordingStatus)
router.get('/stream', getRecordingStreamUrl)
router.get('/download', getRecordingDownloadUrl)
router.delete('/', deleteRecordingSession)

export default router
