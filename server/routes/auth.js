import express from 'express'
import {
  signup,
  verifyOtp,
  resendOtp,
  login,
  forgotPassword,
  resetPassword,
  logout,
  getMe
} from '../controllers/authController.js'
import { authenticateToken } from '../middleware/auth.js'
import rateLimit from 'express-rate-limit'

const router = express.Router()

// Handler for rate limit responses (HTTP 429)
const limitHandler = (req, res) => {
  res.status(429).json({ message: 'Too many requests. Please try again later.' })
}

// Route-specific rate limiters
const signupLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, handler: limitHandler })
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, handler: limitHandler })
const forgotPasswordLimiter = rateLimit({ windowMs: 60 * 1000, max: 3, handler: limitHandler })
const resendOtpLimiter = rateLimit({ windowMs: 60 * 1000, max: 1, handler: limitHandler })
const verifyOtpLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, handler: limitHandler })

// API Route definitions
router.post('/signup', signupLimiter, signup)
router.post('/verify-otp', verifyOtpLimiter, verifyOtp)
router.post('/resend-otp', resendOtpLimiter, resendOtp)
router.post('/login', loginLimiter, login)
router.post('/forgot-password', forgotPasswordLimiter, forgotPassword)
router.post('/reset-password', verifyOtpLimiter, resetPassword)
router.post('/logout', logout)

// Protected Session Route
router.get('/me', authenticateToken, getMe)

export default router
