import type { User } from '@/generated/prisma/index.js'

// ─── Hono Context Variables ───────────────────────────────────────────────────

export type AppVariables = {
  userId: string
  user: User
}

// ─── API Response ─────────────────────────────────────────────────────────────

export type ApiSuccess<T = unknown> = {
  success: true
  data: T
  message?: string
}

export type ApiError = {
  success: false
  error: string
  code?: string
  details?: unknown
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError

// ─── Auth ─────────────────────────────────────────────────────────────────────

export type TokenPair = {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export type JwtPayload = {
  sub: string     // userId
  phone: string
  role: string
  iat: number
  exp: number
}

// ─── OTP ──────────────────────────────────────────────────────────────────────

export type OtpData = {
  code: string
  attempts: number
  createdAt: number
}

export type OtpStatus =
  | 'sent'
  | 'already_sent'         // within cooldown, resent
  | 'rate_limited'
  | 'no_telegram_linked'  // user exists but no Telegram chatId

export type OtpSendResult = {
  status: OtpStatus
  retryAfterSeconds?: number
  expiresInSeconds?: number
}

// ─── Notifications ────────────────────────────────────────────────────────────

export type NotificationChannel = 'telegram' | 'sms' | 'whatsapp' | 'email'

export type OtpMessage = {
  phone: string
  code: string
  expiresInSeconds: number
}