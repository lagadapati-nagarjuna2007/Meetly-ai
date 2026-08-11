import { google } from 'googleapis'
import http from 'http'
import url from 'url'
import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../.env') })

// Try loading credentials from env or credentials.json
let clientId = process.env.GMAIL_CLIENT_ID
let clientSecret = process.env.GMAIL_CLIENT_SECRET
let redirectUri = process.env.GMAIL_REDIRECT_URI || 'http://localhost:5000/oauth2callback'

const credPath = path.resolve(__dirname, '../credentials.json')
if (fs.existsSync(credPath)) {
  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'))
    const details = creds.installed || creds.web
    if (details) {
      clientId = clientId || details.client_id
      clientSecret = clientSecret || details.client_secret
      if (details.redirect_uris && details.redirect_uris.length > 0) {
        redirectUri = details.redirect_uris[0]
      }
    }
  } catch (e) {
    console.warn('[Gmail Auth Setup] Failed to parse credentials.json:', e.message)
  }
}

if (!clientId || !clientSecret) {
  console.error('\n❌ ERROR: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are required.')
  console.error('Please add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to your .env file')
  console.error('OR place your downloaded Google Cloud OAuth credentials.json in the project root.\n')
  process.exit(1)
}

let PORT = 5000
try {
  const parsedRedirect = new url.URL(redirectUri)
  PORT = Number(parsedRedirect.port) || 5000
} catch (e) {}

const oauth2Client = new google.auth.OAuth2(
  clientId,
  clientSecret,
  redirectUri
)

const SCOPES = ['https://www.googleapis.com/auth/gmail.send']

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent' // Forces Google to issue a refresh token
})

console.log('\n==================================================')
console.log('       MEETLY AI - GMAIL OAUTH SETUP HELPER       ')
console.log('==================================================\n')
console.log('1. Open the following URL in your browser to authorize Meetly AI:\n')
console.log(authUrl)
console.log('\n2. Log in with your sender Gmail account and grant permissions.')
console.log(`\nWaiting for authorization callback on ${redirectUri} ...\n`)

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new url.URL(req.url, `http://localhost:${PORT}`)
    if (reqUrl.pathname === '/oauth2callback' || reqUrl.pathname === '/') {
      const code = reqUrl.searchParams.get('code')
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<div style="font-family:sans-serif;padding:40px;text-align:center;"><h2>✅ Authorization Successful!</h2><p>You can close this tab and check your terminal for the GMAIL_REFRESH_TOKEN.</p></div>')
        
        console.log('\n✅ AUTHORIZATION CODE RECEIVED! Exchanging code for tokens...\n')
        const { tokens } = await oauth2Client.getToken(code)

        if (!tokens.refresh_token) {
          console.warn('⚠️ WARNING: No refresh token returned. Ensure prompt: "consent" was set and try again.')
        }

        console.log('==================================================')
        console.log('YOUR GMAIL OAUTH CONFIGURATION FOR RENDER & .ENV')
        console.log('==================================================\n')
        console.log(`GMAIL_CLIENT_ID=${clientId}`)
        console.log(`GMAIL_CLIENT_SECRET=${clientSecret}`)
        console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token || 'NO_REFRESH_TOKEN_RETURNED'}`)
        console.log(`GMAIL_SENDER_EMAIL=<your-authorized-gmail-address@gmail.com>\n`)
        console.log('==================================================')
        console.log('Copy the above values into your Render Environment Variables dashboard!\n')

        server.close(() => process.exit(0))
      }
    }
  } catch (err) {
    console.error('Error handling OAuth callback:', err)
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Error handling authorization callback.')
  }
})

server.listen(PORT, () => {
  console.log(`[OAuth Helper] Listening for callback on port ${PORT}...`)
})
