import { createContext, useContext, useState, useEffect } from 'react'

const AuthContext = createContext(null)
const API_URL = `${import.meta.env.VITE_API_URL}/api/auth`

const getAuthHeaders = () => {
  const token = typeof window !== 'undefined' ? sessionStorage.getItem('meetly_auth_token') : null
  const headers = { 'Content-Type': 'application/json' }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [isLoading, setIsLoading] = useState(true)

  // 1. Restore session on mount using cookie or bearer credentials
  useEffect(() => {
    const checkSession = async () => {
      try {
        const res = await fetch(`${API_URL}/me`, {
          method: 'GET',
          headers: getAuthHeaders(),
          credentials: 'include'
        })
        if (res.ok) {
          const data = await res.json()
          setUser(data.user)
        } else {
          setUser(null)
        }
      } catch (err) {
        console.error('Session check failed:', err)
        setUser(null)
      } finally {
        setIsLoading(false)
      }
    }
    checkSession()
  }, [])

  // 2. SIGN IN
  const login = async (email, password) => {
    setIsLoading(true)
    try {
      const res = await fetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'include'
      })

      const data = await res.json()
      
      if (!res.ok) {
        throw new Error(data.message || 'Invalid Email or Password')
      }

      if (data.token) {
        sessionStorage.setItem('meetly_auth_token', data.token)
      }

      setUser(data.user)
      setIsLoading(false)
      return true
    } catch (err) {
      setIsLoading(false)
      throw err
    }
  }

  // 3. SIGN UP (Calls backend signup - does not log in)
  const register = async (name, email, password) => {
    setIsLoading(true)
    try {
      const res = await fetch(`${API_URL}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: name, email, password }),
        credentials: 'include'
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.message || 'Registration failed')
      }

      setIsLoading(false)
      return true
    } catch (err) {
      setIsLoading(false)
      throw err
    }
  }

  // 4. VERIFY OTP
  const verifyOtp = async (email, otp) => {
    setIsLoading(true)
    try {
      const res = await fetch(`${API_URL}/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
        credentials: 'include'
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.message || 'Verification failed')
      }

      setIsLoading(false)
      return true
    } catch (err) {
      setIsLoading(false)
      throw err
    }
  }

  // 5. RESEND OTP
  const resendOtp = async (email) => {
    const res = await fetch(`${API_URL}/resend-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      credentials: 'include'
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data.message || 'Failed to resend code')
    }

    return true
  }

  // 6. FORGOT PASSWORD
  const forgotPassword = async (email) => {
    setIsLoading(true)
    try {
      const res = await fetch(`${API_URL}/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
        credentials: 'include'
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.message || 'Failed to send recovery code')
      }

      setIsLoading(false)
      return true
    } catch (err) {
      setIsLoading(false)
      throw err
    }
  }

  // 7. RESET PASSWORD
  const resetPassword = async (email, otp, newPassword) => {
    setIsLoading(true)
    try {
      const res = await fetch(`${API_URL}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp, newPassword }),
        credentials: 'include'
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.message || 'Failed to reset password')
      }

      setIsLoading(false)
      return true
    } catch (err) {
      setIsLoading(false)
      throw err
    }
  }

  // 8. LOG OUT
  const logout = async () => {
    try {
      await fetch(`${API_URL}/logout`, {
        method: 'POST',
        headers: getAuthHeaders(),
        credentials: 'include'
      })
    } catch (err) {
      console.error('Logout request error:', err)
    } finally {
      sessionStorage.removeItem('meetly_auth_token')
      setUser(null)
    }
  }

  const updateProfile = (name, email) => {
    if (!user) return
    const updated = { ...user, name, email }
    setUser(updated)
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        login,
        register,
        verifyOtp,
        resendOtp,
        forgotPassword,
        resetPassword,
        logout,
        updateProfile
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}