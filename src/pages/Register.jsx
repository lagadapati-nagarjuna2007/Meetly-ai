import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/Toast'
import { User, Mail, Lock, Eye, EyeOff, ArrowRight } from 'lucide-react'
import Input from '../components/Input'
import Button from '../components/Button'

export default function Register() {
  const { register, isLoading } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!name) {
      setError('Full Name is required')
      return
    }
    if (!email) {
      setError('Email address is required')
      return
    }
    if (!password) {
      setError('Password is required')
      return
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    try {
      const success = await register(name, email, password)
      if (success) {
        showToast('Verification code sent to your email!', 'success')
        navigate(`/verify-otp?email=${encodeURIComponent(email)}`)
      }
    } catch (err) {
      showToast(err.message || 'Registration failed', 'error')
    }
  }

  return (
    <div className="flex flex-col gap-4 text-left w-full max-w-[340px] mx-auto relative h-full justify-between">
      {/* Upper content */}
      <div className="flex flex-col gap-4">
        {/* Title */}
        <div>
          <h1 className="text-xl font-bold text-white tracking-wide mb-1 leading-normal">Create Your Account</h1>
          <p className="text-[11px] text-gray-500 font-semibold">
            Join <span className="text-[#8b5cf6] font-bold">Meetly AI</span> and transform the way you meet.
          </p>
        </div>

        {/* Registration Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {/* Full Name */}
          <Input
            label="Full Name"
            type="text"
            icon={User}
            placeholder="Enter your full name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          {/* Email Address */}
          <Input
            label="Email Address"
            type="email"
            icon={Mail}
            placeholder="Enter your email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          {/* Password */}
          <div className="relative">
            <Input
              label="Password"
              type={showPassword ? 'text' : 'password'}
              icon={Lock}
              placeholder="Create a password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
              label="Confirm Password"
              type={showConfirmPassword ? 'text' : 'password'}
              icon={Lock}
              placeholder="Confirm your password"
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

          {/* Sign Up Button */}
          <Button type="submit" disabled={isLoading} className="w-full py-3 shadow-lg shadow-purple-900/10 text-xs font-bold gap-2 mt-1">
            <span>Sign Up</span>
            <ArrowRight size={14} />
          </Button>
        </form>

        {/* Divider */}
        <div className="flex items-center gap-2.5 my-0.5">
          <div className="h-px bg-white/5 flex-1" />
          <span className="text-[9px] text-gray-600 font-bold uppercase tracking-wider select-none">or continue with</span>
          <div className="h-px bg-white/5 flex-1" />
        </div>

        {/* Social SSO Row */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => {
              register('Nagarjuna Sai', 'nagarjuna@meetly.ai', 'password')
              showToast('Registered with Google', 'success')
              navigate('/login')
            }}
            className="flex items-center justify-center gap-2 py-2.5 px-4 bg-[#0a0b12]/50 hover:bg-white/5 border border-white/5 rounded-xl text-[11px] font-bold text-gray-300 transition-all duration-200 cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.85z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.85c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            <span>Google</span>
          </button>

          <button
            type="button"
            onClick={() => {
              register('Nagarjuna Sai', 'nagarjuna@meetly.ai', 'password')
              showToast('Registered with Microsoft', 'success')
              navigate('/login')
            }}
            className="flex items-center justify-center gap-2 py-2.5 px-4 bg-[#0a0b12]/50 hover:bg-white/5 border border-white/5 rounded-xl text-[11px] font-bold text-gray-300 transition-all duration-200 cursor-pointer"
          >
            <svg className="w-3 h-3" viewBox="0 0 23 23">
              <path fill="#f35325" d="M0 0h11v11H0z" />
              <path fill="#81bc06" d="M12 0h11v11H12z" />
              <path fill="#05a6f0" d="M0 12h11v11H0z" />
              <path fill="#ffba08" d="M12 12h11v11H12z" />
            </svg>
            <span>Microsoft</span>
          </button>
        </div>

        {/* Sign in link */}
        <div className="text-center text-[11px] text-gray-500 font-semibold select-none">
          <span>Already have an account? </span>
          <Link to="/login" className="text-[#8b5cf6] hover:text-[#a78bfa] font-bold transition-colors duration-200">
            Sign in
          </Link>
        </div>
      </div>

      {/* Spacing buffer */}
      <div className="pt-2" />

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
