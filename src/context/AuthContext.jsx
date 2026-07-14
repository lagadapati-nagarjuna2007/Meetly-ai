import { createContext, useContext, useState } from 'react'

const AuthContext = createContext(null)

const DEFAULT_USERS = [
  {
    name: 'Nagarjuna Sai',
    email: 'nagarjuna@meetly.ai',
    password: 'password',
    role: 'Student',
    avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'
  }
]

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const savedUser = localStorage.getItem('meetly_user')
    return savedUser ? JSON.parse(savedUser) : null
  })
  
  const [registeredUsers, setRegisteredUsers] = useState(() => {
    const saved = localStorage.getItem('meetly_registered_users')
    if (saved) {
      return JSON.parse(saved)
    } else {
      localStorage.setItem('meetly_registered_users', JSON.stringify(DEFAULT_USERS))
      return DEFAULT_USERS
    }
  })

  const [isLoading, setIsLoading] = useState(false)

  const login = async (email, password) => {
    setIsLoading(true)
    await new Promise((resolve) => setTimeout(resolve, 800))
    
    // Check if user exists in the mock list and matches password
    const foundUser = registeredUsers.find(
      (u) => u.email.toLowerCase() === email.toLowerCase() && u.password === password
    )

    if (foundUser) {
      // Exclude password from the session user state
      const { password: _, ...sessionUser } = foundUser
      setUser(sessionUser)
      localStorage.setItem('meetly_user', JSON.stringify(sessionUser))
      setIsLoading(false)
      return true
    } else {
      setIsLoading(false)
      throw new Error('Invalid email or password')
    }
  }

  const register = async (name, email, password) => {
    setIsLoading(true)
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Check if email already exists
    const exists = registeredUsers.some(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    )

    if (exists) {
      setIsLoading(false)
      throw new Error('An account with this email already exists')
    }

    const newUser = {
      name,
      email,
      password,
      role: 'Student',
      avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&h=150&q=80'
    }

    const updatedList = [...registeredUsers, newUser]
    setRegisteredUsers(updatedList)
    localStorage.setItem('meetly_registered_users', JSON.stringify(updatedList))
    
    setIsLoading(false)
    return true
  }

  const logout = () => {
    setUser(null)
    localStorage.removeItem('meetly_user')
  }

  const updateProfile = (name, email) => {
    if (!user) return
    
    // Update active session
    const updatedSessionUser = { ...user, name, email }
    setUser(updatedSessionUser)
    localStorage.setItem('meetly_user', JSON.stringify(updatedSessionUser))

    // Update in registered list
    const updatedList = registeredUsers.map((u) => {
      if (u.email.toLowerCase() === user.email.toLowerCase()) {
        return { ...u, name, email }
      }
      return u
    })
    setRegisteredUsers(updatedList)
    localStorage.setItem('meetly_registered_users', JSON.stringify(updatedList))
  }

  return (
    <AuthContext.Provider value={{ user, login, register, logout, updateProfile, isLoading }}>
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
