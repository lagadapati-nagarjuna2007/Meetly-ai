import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/Toast'
import { Mail, Lock, Eye, EyeOff, ArrowRight } from 'lucide-react'
import Input from '../components/Input'
import Button from '../components/Button'

export default function Login() {
  const { login, isLoading } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()
  
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    
    if (!email) {
      setError('Email address is required')
      return
    }
    if (!password) {
      setError('Password is required')
      return
    }

    try {
      const success = await login(email, password)
      if (success) {
        showToast('Successfully signed in!', 'success')
        navigate('/')
      }
    } catch (err) {
      showToast(err.message || 'Authentication failed', 'error')
    }
  }

  return (
    <div className="flex flex-col gap-5.5 text-left w-full max-w-[340px] mx-auto relative h-full justify-between">
      {/* Upper content */}
      <div className="flex flex-col gap-5">
        {/* Title */}
        <div>
          <h1 className="text-xl font-bold text-white tracking-wide mb-1 leading-normal">Welcome Back 👋</h1>
          <p className="text-[11px] text-gray-500 font-semibold">Sign in to continue to your account</p>
        </div>

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          {/* Email Address */}
          <Input
            label="Email Address"
            type="email"
            icon={Mail}
            placeholder="Enter your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          {/* Password */}
          <div className="relative">
            <Input
              label="Password"
              type={showPassword ? 'text' : 'password'}
              icon={Lock}
              placeholder="Enter your password"
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

          {/* Forgot Password Link */}
          <div className="flex justify-end pr-0.5">
            <Link to="/forgot-password" className="text-[11px] font-bold text-[#8b5cf6] hover:text-[#a78bfa] transition-colors duration-200">
              Forgot Password?
            </Link>
          </div>

          {error && <p className="text-[10px] text-red-500 pl-0.5 mt-0.5">{error}</p>}

          {/* Sign In Button */}
          <Button type="submit" disabled={isLoading} className="w-full py-3 shadow-lg shadow-purple-900/10 text-xs font-bold gap-2">
            <span>Sign In</span>
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
              login('nagarjuna@meetly.ai', 'password')
              showToast('Signed in with Google', 'success')
              navigate('/')
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
              login('nagarjuna@meetly.ai', 'password')
              showToast('Signed in with Microsoft', 'success')
              navigate('/')
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

        {/* Register link */}
        <div className="text-center text-[11px] text-gray-500 font-semibold select-none">
          <span>Don't have an account? </span>
          <Link to="/register" className="text-[#8b5cf6] hover:text-[#a78bfa] font-bold transition-colors duration-200">
            Sign up
          </Link>
        </div>
      </div>

      {/* Padding spacing buffer */}
      <div className="pt-2 md:pt-4" />

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
