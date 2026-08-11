import { google } from 'googleapis'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

/**
 * Creates and configures the Google OAuth2 client and Gmail API instance.
 */
const getGmailClient = () => {
  const clientId = process.env.GMAIL_CLIENT_ID
  const clientSecret = process.env.GMAIL_CLIENT_SECRET
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    const missing = []
    if (!clientId) missing.push('GMAIL_CLIENT_ID')
    if (!clientSecret) missing.push('GMAIL_CLIENT_SECRET')
    if (!refreshToken) missing.push('GMAIL_REFRESH_TOKEN')
    console.error(`[Email Service Error] Missing required Gmail OAuth credentials: ${missing.join(', ')}`)
    throw new Error(`Email service configuration error: Missing environment variables (${missing.join(', ')}).`)
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret)
  oauth2Client.setCredentials({ refresh_token: refreshToken })

  return google.gmail({ version: 'v1', auth: oauth2Client })
}

/**
 * Helper to encode raw RFC 2822 email text into URL-safe Base64 (base64url) format.
 */
const encodeBase64Url = (str) => {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Sends an OTP email to the specified recipient via Gmail API.
 * 
 * @param {string} email - Recipient email address
 * @param {string} name - Recipient full name
 * @param {string} otp - 6-digit OTP code
 * @param {boolean} isPasswordReset - True if for forgot-password, false for signup/resend
 */
export const sendOtpEmail = async (email, name, otp, isPasswordReset = false) => {
  const senderEmail = process.env.GMAIL_SENDER_EMAIL || 'me'
  const subject = isPasswordReset ? 'Reset your Meetly AI Password' : 'Verify your Meetly AI Account'

  const htmlContent = `
    <div style="font-family: 'Segoe UI', Roboto, sans-serif; background-color: #070814; color: #f3f4f6; padding: 40px; border-radius: 20px; max-width: 480px; margin: auto; border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: 0.5px;">Meetly <span style="color: #8b5cf6;">AI</span></span>
      </div>
      <p style="font-size: 14px; color: #d1d5db; line-height: 1.6; margin-bottom: 12px;">Hello ${name || 'User'},</p>
      <p style="font-size: 14px; color: #d1d5db; line-height: 1.6; margin-bottom: 16px;">Welcome to Meetly AI.</p>
      <p style="font-size: 14px; color: #9ca3af; line-height: 1.6; margin-bottom: 8px;">Your verification code is:</p>
      <div style="text-align: center; margin: 24px 0;">
        <span style="font-size: 32px; font-weight: 800; letter-spacing: 4px; color: #c084fc; background-color: rgba(124, 58, 237, 0.1); padding: 12px 28px; border-radius: 12px; border: 1px solid rgba(124, 58, 237, 0.25); display: inline-block;">${otp}</span>
      </div>
      <p style="font-size: 12px; color: #6b7280; line-height: 1.6; margin-bottom: 16px;">This code expires in 5 minutes.</p>
      <p style="font-size: 12px; color: #6b7280; line-height: 1.6;">If you didn't request this account, ignore this email.</p>
      <div style="border-top: 1px solid rgba(255, 255, 255, 0.05); margin-top: 32px; padding-top: 20px; font-size: 11px; color: #4b5563; text-align: center;">
        <p style="margin: 0 0 4px 0;">Regards,</p>
        <p style="margin: 0; font-weight: 700; color: #9ca3af;">Meetly AI Team</p>
      </div>
    </div>
  `

  // Build standard RFC 2822 message string
  const rfc2822Message = [
    `From: Meetly AI <${senderEmail}>`,
    `To: ${email}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlContent
  ].join('\r\n')

  try {
    console.log(`[Email Service] Preparing Gmail API request for recipient: ${email}...`)
    const gmail = getGmailClient()
    const rawEncoded = encodeBase64Url(rfc2822Message)

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: rawEncoded
      }
    })

    console.log(`[Email Service] Gmail API email sent successfully to ${email} (Message ID: ${response.data.id})`)
    return response.data
  } catch (err) {
    console.error(`[Email Service Error] Failed to send OTP email to ${email}:`, err.message || err)
    if (err.response && err.response.data) {
      console.error('[Email Service Error Details]', err.response.data.error || err.response.data)
    }
    throw new Error(err.message || 'Failed to send verification email via Gmail API.')
  }
}
