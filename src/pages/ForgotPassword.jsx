import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/Toast'
import { Mail, ArrowRight, ArrowLeft } from 'lucide-react'
import Input from '../components/Input'
import Button from '../components/Button'

export default function ForgotPassword() {
  const { forgotPassword, isLoading } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()
  
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    
    if (!email) {
      setError('Email address is required')
      return
    }

    try {
      const success = await forgotPassword(email)
      if (success) {
        showToast('Password recovery code sent to your email!', 'success')
        navigate(`/reset-password?email=${encodeURIComponent(email)}`)
      }
    } catch (err) {
      setError(err.message || 'Failed to process request')
      showToast(err.message || 'Failed to process request', 'error')
    }
  }

  return (
    <div className="flex flex-col gap-5.5 text-left w-full max-w-[340px] mx-auto relative h-full justify-between">
      {/* Upper content */}
      <div className="flex flex-col gap-5">
        {/* Back link */}
        <div className="flex select-none">
          <Link to="/login" className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors duration-200">
            <ArrowLeft size={13} />
            <span>Back to Sign In</span>
          </Link>
        </div>

        {/* Title */}
        <div>
          <h1 className="text-xl font-bold text-white tracking-wide mb-1 leading-normal">Reset Password</h1>
          <p className="text-[11px] text-gray-500 font-semibold leading-relaxed">
            Enter your email address and we will send you a verification code to reset your password.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          <Input
            label="Email Address"
            type="email"
            icon={Mail}
            placeholder="Enter your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          {error && <p className="text-[10px] text-red-500 pl-0.5 mt-0.5">{error}</p>}

          <Button type="submit" disabled={isLoading} className="w-full py-3 shadow-lg shadow-purple-900/10 text-xs font-bold gap-2 mt-2">
            <span>{isLoading ? 'Sending Code...' : 'Send Reset Code'}</span>
            <ArrowRight size={14} />
          </Button>
        </form>
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
