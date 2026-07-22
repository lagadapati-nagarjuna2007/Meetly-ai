import express from 'express'
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
  getMeetingHistory
} from '../controllers/meetingController.js'
import { authenticateToken } from '../middleware/auth.js'

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
