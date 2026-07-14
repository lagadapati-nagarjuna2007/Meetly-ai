import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { MeetingProvider } from './context/MeetingContext'
import { ToastProvider } from './components/Toast'
import AppRoutes from './routes'
import './App.css'

function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <MeetingProvider>
            <AppRoutes />
          </MeetingProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  )
}

export default App
