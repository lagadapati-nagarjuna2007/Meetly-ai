import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config()

const secret = process.env.JWT_SECRET

async function run() {
  console.log('JWT Secret:', secret ? 'found' : 'missing')

  // Generate host token
  const hostToken = jwt.sign(
    {
      id: 'b13076aa-6dc0-4431-9cf0-e65d6b36069b', // host ID
      email: 'lagadapati.nagesh@gmail.com',
      name: 'sai nagarjuna',
      role: 'Student'
    },
    secret
  )

  console.log('Testing GET pending requests with host token...')
  const getRes = await fetch('http://localhost:5000/api/meetings/security/pending/1PYZVKCD', {
    headers: {
      cookie: `meetly_token=${hostToken}`
    }
  })
  console.log('GET Pending requests status:', getRes.status)
  console.log('GET Pending requests body:', await getRes.json())

  console.log('\nTesting POST remove participant with host token...')
  const removeRes = await fetch('http://localhost:5000/api/meetings/security/remove', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `meetly_token=${hostToken}`
    },
    body: JSON.stringify({
      meetingCode: '1PYZVKCD',
      userId: '9c47a4c6-8321-4b1a-bcea-bf7412f387da' // participant ID
    })
  })
  console.log('POST Remove participant status:', removeRes.status)
  console.log('POST Remove participant body:', await removeRes.json())

  console.log('\nTesting POST toggle auto admit with host token...')
  const toggleRes = await fetch('http://localhost:5000/api/meetings/security/toggle-auto-admit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `meetly_token=${hostToken}`
    },
    body: JSON.stringify({
      meetingId: '441baaf0-fc87-47ca-a439-4f90912e2bd5',
      autoAdmit: false
    })
  })
  console.log('POST Toggle auto admit status:', toggleRes.status)
  console.log('POST Toggle auto admit body:', await toggleRes.json())
}

run()
