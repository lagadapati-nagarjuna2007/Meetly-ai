import express from 'express'
import {
  handleAIChatRequest,
  handleGetRemainingRequests,
  getMeetingTranscriptText
} from '../controllers/aiChat.controller.js'
import { authenticateToken } from '../middleware/auth.js'

const router = express.Router()

router.use(authenticateToken)

router.post('/:meetingId/ai-chat', handleAIChatRequest)
router.get('/:meetingId/ai-chat/remaining', handleGetRemainingRequests)
router.get('/:meetingId/transcript', getMeetingTranscriptText)

export default router
