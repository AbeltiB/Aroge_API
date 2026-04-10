import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // JWT — require strong secrets in production
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  JWT_ACCESS_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(900),   // 15 min
  JWT_REFRESH_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(2592000), // 30 days

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  // Telegram bot
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16, 'TELEGRAM_WEBHOOK_SECRET must be at least 16 chars'),

  // OTP config
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_EXPIRY_SECONDS: z.coerce.number().int().positive().default(300),       // 5 min
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  OTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(3),         // max sends/window
  OTP_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600), // 1 hr
})

export type Env = z.infer<typeof envSchema>

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const errors = parsed.error.flatten().fieldErrors
  console.error('❌ Invalid environment variables:')
  for (const [key, messages] of Object.entries(errors)) {
    console.error(`  ${key}: ${messages?.join(', ')}`)
  }
  process.exit(1)
}

export const env = parsed.data