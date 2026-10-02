import { createContext, useContext, useState, useEffect, useRef } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

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
  const isExchangingRef = useRef(false)

  // Exchange Supabase OAuth token with Meetly backend to establish Meetly JWT & session
  const exchangeSupabaseToken = async (accessToken) => {
    if (isExchangingRef.current) return null
    isExchangingRef.current = true
    try {
      const res = await fetch(`${API_URL}/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supabaseAccessToken: accessToken }),
        credentials: 'include'
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.message || 'Google authentication failed on server')
      }

      if (data.token) {
        sessionStorage.setItem('meetly_auth_token', data.token)
      }
      setUser(data.user)
      return data.user
    } finally {
      isExchangingRef.current = false
    }
  }

  // 1. Restore session on mount using Supabase session or Meetly cookie/token
  useEffect(() => {
    let isMounted = true

    const checkSession = async () => {
      // Check for OAuth cancellation or error params in URL
      const urlParams = new URLSearchParams(window.location.search)
      const hashParams = new URLSearchParams(window.location.hash.substring(1))
      const oauthError = urlParams.get('error_description') || hashParams.get('error_description') || urlParams.get('error')
      if (oauthError) {
        console.warn('[AuthContext] OAuth error or cancellation detected:', oauthError)
        window.history.replaceState({}, document.title, window.location.pathname)
      }

      // Check for Supabase session (e.g. returning from Google OAuth redirect)
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.access_token) {
          const googleUser = await exchangeSupabaseToken(session.access_token)
          if (googleUser && isMounted) {
            setUser(googleUser)
            setIsLoading(false)
            if (window.location.hash || window.location.search.includes('code=')) {
              window.history.replaceState({}, document.title, window.location.pathname)
            }
            return
          }
        }
      } catch (sbErr) {
        console.warn('[AuthContext] Supabase session check error:', sbErr)
      }

      // Existing check: Restore session from Meetly token / cookie
      try {
        const res = await fetch(`${API_URL}/me`, {
          method: 'GET',
          headers: getAuthHeaders(),
          credentials: 'include'
        })
        if (res.ok) {
          const data = await res.json()
          if (isMounted) setUser(data.user)
        } else {
          if (isMounted) setUser(null)
        }
      } catch (err) {
        console.error('Session check failed:', err)
        if (isMounted) setUser(null)
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    checkSession()

    // Listen for Supabase OAuth state changes (e.g. OAuth login redirect completion)
    const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.access_token) {
        try {
          const googleUser = await exchangeSupabaseToken(session.access_token)
          if (googleUser && isMounted) {
            setUser(googleUser)
            setIsLoading(false)
            if (window.location.hash || window.location.search.includes('code=')) {
              window.history.replaceState({}, document.title, window.location.pathname)
            }
          }
        } catch (err) {
          console.error('[AuthContext] onAuthStateChange exchange error:', err)
        }
      }
    })

    return () => {
      isMounted = false
      authListener?.subscription?.unsubscribe()
    }
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
      try {
        await supabase.auth.signOut()
      } catch (sbErr) {
        console.warn('[AuthContext] Supabase signOut error:', sbErr)
      }
      sessionStorage.removeItem('meetly_auth_token')
      setUser(null)
    }
  }

  // 9. GOOGLE SIGN IN VIA SUPABASE OAUTH
  const signInWithGoogle = async () => {
    if (!isSupabaseConfigured) {
      throw new Error('Google Sign-In is not configured yet. Please ensure VITE_SUPABASE_ANON_KEY is set in your environment.')
    }

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin
      }
    })

    if (error) {
      console.error('[AuthContext] signInWithOAuth error:', error)
      throw error
    }

    return data
  }

  const updateProfile = async (name, email) => {
    if (!user) return
    const updated = { ...user, name, email }
    setUser(updated)

    try {
      const res = await fetch(`${API_URL}/profile`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ name, email }),
        credentials: 'include'
      })
      const data = await res.json()
      if (res.ok && data.token) {
        sessionStorage.setItem('meetly_auth_token', data.token)
        if (data.user) {
          setUser(data.user)
        }
      } else if (!res.ok) {
        console.warn('[AuthContext] Backend profile update returned error:', data.message)
      }
    } catch (err) {
      console.error('[AuthContext] Failed to persist profile update to backend:', err)
    }
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
        updateProfile,
        signInWithGoogle
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