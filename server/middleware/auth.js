import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

export const authenticateToken = (req, res, next) => {
  let token = null
  let tokenSource = null

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1]
    tokenSource = 'bearer_header'
  } else if (req.cookies && req.cookies.meetly_token) {
    token = req.cookies.meetly_token
    tokenSource = 'cookie'
  }

  if (!token) {
    return res.status(401).json({ message: 'Authentication required. Please sign in.' })
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decodedUser) => {
    if (err) {
      console.log(`[AUTH DEBUG] JWT verification failed on path ${req.path}: ${err.message}`)
      return res.status(403).json({ message: 'Session expired or invalid. Please sign in again.' })
    }
    req.user = decodedUser
    console.log(`[AUTH DEBUG] Request: ${req.method} ${req.path} | User ID: ${decodedUser.id} | Auth Source: ${tokenSource}`)
    next()
  })
}
