import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/Toast'
import { ShieldCheck, Lock, Eye, EyeOff, ArrowRight, RefreshCw, ArrowLeft } from 'lucide-react'
import Input from '../components/Input'
import Button from '../components/Button'

export default function ResetPassword() {
  const { resetPassword, resendOtp, isLoading } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const email = searchParams.get('email') || ''

  const [otp, setOtp] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [error, setError] = useState('')
  const [countdown, setCountdown] = useState(60)

  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!otp || otp.length !== 6) {
      setError('Please enter the 6-digit verification code')
      return
    }
    if (!newPassword) {
      setError('New password is required')
      return
    }
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    try {
      const success = await resetPassword(email, otp, newPassword)
      if (success) {
        showToast('Password reset successfully! Please sign in.', 'success')
        navigate('/login')
      }
    } catch (err) {
      setError(err.message || 'Failed to reset password')
      showToast(err.message || 'Failed to reset password', 'error')
    }
  }

  const handleResend = async () => {
    try {
      await resendOtp(email)
      showToast('New verification code sent!', 'success')
      setCountdown(60)
    } catch (err) {
      showToast(err.message || 'Failed to resend code', 'error')
    }
  }

  return (
    <div className="flex flex-col gap-5.5 text-left w-full max-w-[340px] mx-auto relative h-full justify-between">
      {/* Upper content */}
      <div className="flex flex-col gap-4">
        {/* Back Link */}
        <div className="flex select-none">
          <Link to="/forgot-password" className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors duration-200">
            <ArrowLeft size={13} />
            <span>Back</span>
          </Link>
        </div>

        {/* Title */}
        <div>
          <h1 className="text-xl font-bold text-white tracking-wide mb-1 leading-normal">Reset Password</h1>
          <p className="text-[11px] text-gray-500 font-semibold leading-normal">
            Enter the code sent to <span className="text-gray-300 font-bold">{email}</span> and your new password.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Input
            label="Verification Code"
            type="text"
            maxLength={6}
            placeholder="e.g. 483291"
            icon={ShieldCheck}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          />

          {/* New Password */}
          <div className="relative">
            <Input
              label="New Password"
              type={showPassword ? 'text' : 'password'}
              icon={Lock}
              placeholder="Create a new password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3.5 bottom-3.5 text-gray-500 hover:text-white cursor-pointer transition-colors duration-200"
            >
              {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>

          {/* Confirm Password */}
          <div className="relative">
            <Input
              label="Confirm New Password"
              type={showConfirmPassword ? 'text' : 'password'}
              icon={Lock}
              placeholder="Confirm your new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              className="absolute right-3.5 bottom-3.5 text-gray-500 hover:text-white cursor-pointer transition-colors duration-200"
            >
              {showConfirmPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>

          {error && <p className="text-[10px] text-red-500 pl-0.5 mt-0.5">{error}</p>}

          <Button type="submit" disabled={isLoading} className="w-full py-3 shadow-lg shadow-purple-900/10 text-xs font-bold gap-2 mt-2">
            <span>{isLoading ? 'Resetting...' : 'Reset Password'}</span>
            <ArrowRight size={14} />
          </Button>
        </form>

        {/* Resend actions */}
        <div className="flex items-center justify-between text-[11px] font-semibold text-gray-500 select-none pl-0.5 mt-1">
          <span>Didn't receive a code?</span>
          {countdown > 0 ? (
            <span className="text-gray-400">Resend in {countdown}s</span>
          ) : (
            <button
              onClick={handleResend}
              className="text-[#8b5cf6] hover:text-[#a78bfa] font-bold flex items-center gap-1.5 transition-colors duration-200 cursor-pointer"
            >
              <RefreshCw size={12} />
              <span>Resend OTP</span>
            </button>
          )}
        </div>
      </div>

      <div className="pt-4" />

      {/* Footer secure lock */}
      <div className="flex items-center justify-center gap-2 text-[10px] text-gray-600 font-semibold select-none border-t border-white/3 pt-3">
        <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
          <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 6h2v2h-2V7zm0 4h2v6h-2v-6z" />
        </svg>
        <span>Your data is secure and encrypted</span>
      </div>
    </div>
  )
}
