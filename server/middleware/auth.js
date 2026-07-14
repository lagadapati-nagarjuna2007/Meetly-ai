import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

export const authenticateToken = (req, res, next) => {
  // Read token from secure cookie
  const token = req.cookies.meetly_token

  if (!token) {
    return res.status(401).json({ message: 'Authentication required. Please sign in.' })
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decodedUser) => {
    if (err) {
      return res.status(403).json({ message: 'Session expired or invalid. Please sign in again.' })
    }
    req.user = decodedUser
    next()
  })
}
