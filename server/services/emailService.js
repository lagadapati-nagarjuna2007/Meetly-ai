import nodemailer from 'nodemailer'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
})

export const sendOtpEmail = async (email, name, otp, isPasswordReset = false) => {
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

  const mailOptions = {
    from: `"Meetly AI" <${process.env.EMAIL_USER}>`,
    to: email,
    subject,
    html: htmlContent
  }

  return transporter.sendMail(mailOptions)
}
