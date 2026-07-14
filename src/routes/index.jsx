import { Routes, Route, Navigate } from 'react-router-dom'
import DashboardLayout from '../layouts/DashboardLayout'
import AuthLayout from '../layouts/AuthLayout'
import Login from '../pages/Login'
import Register from '../pages/Register'
import VerifyOtp from '../pages/VerifyOtp'
import ForgotPassword from '../pages/ForgotPassword'
import ResetPassword from '../pages/ResetPassword'
import Home from '../pages/Home'
import History from '../pages/History'
import AIAssistant from '../pages/AIAssistant'
import Profile from '../pages/Profile'
import Settings from '../pages/Settings'
import MeetingRoom from '../pages/MeetingRoom'
import Report from '../pages/Report'

export default function AppRoutes() {
  return (
    <Routes>
      {/* Auth Routes */}
      <Route
        path="/login"
        element={
          <AuthLayout>
            <Login />
          </AuthLayout>
        }
      />
      <Route
        path="/register"
        element={
          <AuthLayout>
            <Register />
          </AuthLayout>
        }
      />
      <Route
        path="/verify-otp"
        element={
          <AuthLayout>
            <VerifyOtp />
          </AuthLayout>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <AuthLayout>
            <ForgotPassword />
          </AuthLayout>
        }
      />
      <Route
        path="/reset-password"
        element={
          <AuthLayout>
            <ResetPassword />
          </AuthLayout>
        }
      />

      {/* Fullscreen Meeting Room (Immersive, no sidebar) */}
      <Route path="/meeting/:id" element={<MeetingRoom />} />

      {/* Authenticated Dashboard Routes */}
      <Route element={<DashboardLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/meetings" element={<History />} />
        <Route path="/history" element={<History />} />
        <Route path="/ai-assistant" element={<AIAssistant />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/report/:id" element={<Report />} />
      </Route>

      {/* Fallback Catch-all Redirect */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
