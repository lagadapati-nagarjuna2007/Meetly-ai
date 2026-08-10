import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import { sendOtpEmail } from '../services/emailService.js'

const JWT_EXPIRATION = 24 * 60 * 60 * 1000 // 24 hours in milliseconds

// Helper to get environment-specific cookie configuration
const getCookieConfig = () => {
  const isProduction = process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    // secure: true is required in production for cross-site cookies
    secure: isProduction,
    // sameSite: "none" is required in production for cross-site cookie usage, "lax" for dev
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: JWT_EXPIRATION,
    path: '/'
  }
}

// 1. SIGNUP
export const signup = async (req, res) => {
  try {
    const { fullName, email, password } = req.body

    if (!fullName || !email || !password) {
      return res.status(400).json({ message: 'All fields are required.' })
    }

    // Check if email already exists in users
    const { data: existingUser, error: checkErr } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .maybeSingle()

    if (checkErr) throw checkErr

    if (existingUser) {
      return res.status(400).json({ message: 'Email already registered.' })
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10)

    // Generate random 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString()

    // Hash the OTP before saving
    const otpHash = await bcrypt.hash(otp, 10)
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString() // 5 minutes expiration

    // Clean up any existing OTP verifications for this email first
    await supabase.from('otp_verifications').delete().eq('email', email.toLowerCase())

    // Store in otp_verifications
    const { error: insertErr } = await supabase
      .from('otp_verifications')
      .insert([
        {
          email: email.toLowerCase(),
          full_name: fullName,
          password_hash: passwordHash,
          otp_hash: otpHash,
          expires_at: expiresAt,
          verification_attempts: 0
        }
      ])

    if (insertErr) throw insertErr

    // Send OTP via email
    await sendOtpEmail(email.toLowerCase(), fullName, otp)

    return res.status(200).json({ message: 'OTP verification code sent to your email.' })
  } catch (err) {
    console.error('Signup error:', err)
    return res.status(500).json({ message: 'Server error during signup.' })
  }
}

// 2. VERIFY OTP
export const verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and verification code are required.' })
    }

    const emailLower = email.toLowerCase()

    // 1. Delete expired OTP records for this email
    const now = new Date().toISOString()
    await supabase
      .from('otp_verifications')
      .delete()
      .eq('email', emailLower)
      .lt('expires_at', now)

    // 2. Retrieve OTP verification record
    const { data: verificationRecord, error: fetchErr } = await supabase
      .from('otp_verifications')
      .select('*')
      .eq('email', emailLower)
      .maybeSingle()

    if (fetchErr) throw fetchErr

    if (!verificationRecord) {
      return res.status(400).json({ message: 'Verification request expired or not found. Please register again.' })
    }

    // 3. Check verification attempts
    if (verificationRecord.verification_attempts >= 5) {
      await supabase.from('otp_verifications').delete().eq('email', emailLower)
      return res.status(400).json({ message: 'Too many failed verification attempts. Please sign up again.' })
    }

    // 4. Compare OTP
    const isMatch = await bcrypt.compare(otp, verificationRecord.otp_hash)

    if (!isMatch) {
      // Increment attempts
      const newAttempts = verificationRecord.verification_attempts + 1
      await supabase
        .from('otp_verifications')
        .update({ verification_attempts: newAttempts })
        .eq('id', verificationRecord.id)

      return res.status(400).json({ message: 'Invalid verification code.' })
    }

    // 5. Create user record
    const { error: createUserErr } = await supabase
      .from('users')
      .insert([
        {
          full_name: verificationRecord.full_name,
          email: emailLower,
          password_hash: verificationRecord.password_hash
        }
      ])

    if (createUserErr) throw createUserErr

    // 6. Delete OTP verification record immediately on success
    await supabase.from('otp_verifications').delete().eq('email', emailLower)

    return res.status(200).json({ message: 'Verification successful. You can now log in.' })
  } catch (err) {
    console.error('Verify OTP error:', err)
    return res.status(500).json({ message: 'Server error during verification.' })
  }
}

// 3. RESEND OTP
export const resendOtp = async (req, res) => {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ message: 'Email address is required.' })
    }

    const emailLower = email.toLowerCase()

    // Check if email already registered
    const { data: existingUser, error: checkErr } = await supabase
      .from('users')
      .select('id')
      .eq('email', emailLower)
      .maybeSingle()

    if (checkErr) throw checkErr

    if (existingUser) {
      return res.status(400).json({ message: 'Email already registered.' })
    }

    // Fetch active verification record
    const { data: verificationRecord, error: fetchErr } = await supabase
      .from('otp_verifications')
      .select('*')
      .eq('email', emailLower)
      .maybeSingle()

    if (fetchErr) throw fetchErr

    if (!verificationRecord) {
      return res.status(400).json({ message: 'No pending verification found. Please register first.' })
    }

    // Generate new OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const otpHash = await bcrypt.hash(otp, 10)
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

    // Update DB record
    const { error: updateErr } = await supabase
      .from('otp_verifications')
      .update({
        otp_hash: otpHash,
        expires_at: expiresAt,
        verification_attempts: 0
      })
      .eq('id', verificationRecord.id)

    if (updateErr) throw updateErr

    // Send email
    await sendOtpEmail(emailLower, verificationRecord.full_name, otp)

    return res.status(200).json({ message: 'New verification code sent to your email.' })
  } catch (err) {
    console.error('Resend OTP error:', err)
    return res.status(500).json({ message: 'Server error while resending verification code.' })
  }
}

// 4. LOGIN
export const login = async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' })
    }

    const emailLower = email.toLowerCase()

    // Find user
    const { data: user, error: fetchErr } = await supabase
      .from('users')
      .select('*')
      .eq('email', emailLower)
      .maybeSingle()

    if (fetchErr) throw fetchErr

    if (!user) {
      return res.status(400).json({ message: 'Invalid Email or Password' })
    }

    // Match password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash)
    if (!isPasswordValid) {
      return res.status(400).json({ message: 'Invalid Email or Password' })
    }

    // Generate JWT
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        name: user.full_name,
        role: 'Student'
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    )

    console.log(`[AUTH DEBUG] Login success. User ID: ${user.id}, Email: ${user.email}`)

    // Set secure HTTP-only cookie
    res.cookie('meetly_token', token, getCookieConfig())

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        role: 'Student',
        avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'
      }
    })
  } catch (err) {
    console.error('Login error:', err)
    return res.status(500).json({ message: 'Server error during login.' })
  }
}

// 5. FORGOT PASSWORD
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ message: 'Email address is required.' })
    }

    const emailLower = email.toLowerCase()

    // Verify user exists
    const { data: user, error: fetchErr } = await supabase
      .from('users')
      .select('id, full_name')
      .eq('email', emailLower)
      .maybeSingle()

    if (fetchErr) throw fetchErr

    if (!user) {
      return res.status(400).json({ message: 'No account registered with this email.' })
    }

    // Generate OTP and hash it
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const otpHash = await bcrypt.hash(otp, 10)
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

    // Clean up existing recovery records for this email
    await supabase.from('otp_verifications').delete().eq('email', emailLower)

    // Save temporary reset record (password_hash is empty for recovery logs)
    const { error: insertErr } = await supabase
      .from('otp_verifications')
      .insert([
        {
          email: emailLower,
          full_name: 'PASSWORD_RESET',
          password_hash: '',
          otp_hash: otpHash,
          expires_at: expiresAt,
          verification_attempts: 0
        }
      ])

    if (insertErr) throw insertErr

    // Send email
    await sendOtpEmail(emailLower, user.full_name, otp, true)

    return res.status(200).json({ message: 'Verification code sent to your email.' })
  } catch (err) {
    console.error('Forgot password error:', err)
    return res.status(500).json({ message: 'Server error while processing password reset request.' })
  }
}

// 6. RESET PASSWORD
export const resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ message: 'All fields are required.' })
    }

    const emailLower = email.toLowerCase()

    // 1. Delete expired OTP records for this email
    const now = new Date().toISOString()
    await supabase
      .from('otp_verifications')
      .delete()
      .eq('email', emailLower)
      .lt('expires_at', now)

    // 2. Fetch active verification record
    const { data: verificationRecord, error: fetchErr } = await supabase
      .from('otp_verifications')
      .select('*')
      .eq('email', emailLower)
      .maybeSingle()

    if (fetchErr) throw fetchErr

    if (!verificationRecord || verificationRecord.full_name !== 'PASSWORD_RESET') {
      return res.status(400).json({ message: 'Verification request expired or not found. Please try again.' })
    }

    // 3. Check attempts
    if (verificationRecord.verification_attempts >= 5) {
      await supabase.from('otp_verifications').delete().eq('email', emailLower)
      return res.status(400).json({ message: 'Too many failed verification attempts. Please try again.' })
    }

    // 4. Compare OTP
    const isMatch = await bcrypt.compare(otp, verificationRecord.otp_hash)

    if (!isMatch) {
      const newAttempts = verificationRecord.verification_attempts + 1
      await supabase
        .from('otp_verifications')
        .update({ verification_attempts: newAttempts })
        .eq('id', verificationRecord.id)

      return res.status(400).json({ message: 'Invalid verification code.' })
    }

    // 5. Update user password
    const newPasswordHash = await bcrypt.hash(newPassword, 10)
    const { error: updateErr } = await supabase
      .from('users')
      .update({ password_hash: newPasswordHash, updated_at: now })
      .eq('email', emailLower)

    if (updateErr) throw updateErr

    // 6. Delete OTP verification record
    await supabase.from('otp_verifications').delete().eq('email', emailLower)

    return res.status(200).json({ message: 'Password reset successful. You can now log in.' })
  } catch (err) {
    console.error('Reset password error:', err)
    return res.status(500).json({ message: 'Server error during password reset.' })
  }
}

// 7. LOGOUT
export const logout = async (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production'
  console.log(`[AUTH DEBUG] Logout request for User ID: ${req.user?.id || 'unknown'}`)
  res.clearCookie('meetly_token', {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/'
  })
  return res.status(200).json({ message: 'Logged out successfully.' })
}

// 8. GET ME
export const getMe = async (req, res) => {
  try {
    console.log(`[AUTH DEBUG] GET /me request for User ID: ${req.user?.id}`)
    const { data: user, error: fetchErr } = await supabase
      .from('users')
      .select('id, full_name, email')
      .eq('id', req.user.id)
      .maybeSingle()

    if (fetchErr) throw fetchErr

    if (!user) {
      return res.status(404).json({ message: 'User session not found.' })
    }

    return res.status(200).json({
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        role: 'Student',
        avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'
      }
    })
  } catch (err) {
    console.error('GetMe error:', err)
    return res.status(500).json({ message: 'Server error while checking session.' })
  }
}
