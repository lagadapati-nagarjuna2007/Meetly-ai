import express from 'express'
import multer from 'multer'
import {
  createMeeting,
  joinMeeting,
  activateMeeting,
  leaveMeeting,
  endMeeting,
  lockMeeting,
  getMeetingDetails,
  getMeetingParticipants,
  renameMeeting,
  deleteMeeting,
  getRecentMeetings,
  getMeetingHistory,
  submitTranscriptChunk,
  generateSummary,
  submitAttendance,
  getAttendanceReport,
  deleteAttendanceRecords
} from '../controllers/meetingController.js'
import {
  getPendingRequests,
  acceptJoinRequest,
  rejectJoinRequest,
  banDevice,
  toggleAutoAdmit,
  removeParticipant
} from '../controllers/securityController.js'
import { authenticateToken } from '../middleware/auth.js'

const upload = multer({ storage: multer.memoryStorage() })

const router = express.Router()

// Secure all endpoints with authentication middleware
router.use(authenticateToken)

// Meeting lifecycle and management routes
router.post('/create', createMeeting)
router.post('/join', joinMeeting)
router.post('/activate', activateMeeting)
router.post('/leave', leaveMeeting)
router.get('/leave', leaveMeeting) // Support for navigator.sendBeacon
router.post('/end', endMeeting)
router.post('/lock', lockMeeting)
router.post('/transcript', upload.single('file'), submitTranscriptChunk)
router.post('/summary/generate', generateSummary)
router.post('/attendance', submitAttendance)
router.get('/attendance/report/:meetingId', getAttendanceReport)
router.delete('/attendance/report/:meetingId', deleteAttendanceRecords)

// Meeting Security management routes
router.get('/security/pending/:meetingCode', getPendingRequests)
router.post('/security/accept', acceptJoinRequest)
router.post('/security/reject', rejectJoinRequest)
router.post('/security/ban-device', banDevice)
router.post('/security/toggle-auto-admit', toggleAutoAdmit)
router.post('/security/remove', removeParticipant)

// Details and metadata endpoints
router.get('/details/:meetingId', getMeetingDetails)
router.get('/participants/:meetingId', getMeetingParticipants)

// Parameter-based endpoints (backward compatibility and dashboard controls)
router.get('/', getRecentMeetings)
router.get('/history', getMeetingHistory)
router.get('/:id', getMeetingDetails)
router.put('/:id', renameMeeting)
router.delete('/:id', deleteMeeting)

export default router
