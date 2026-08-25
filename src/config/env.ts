import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),

  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_BOT_USERNAME: z.string().default('aroge_telegram_bot'),

  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  TELEBIRR_API_URL: z.string().optional(),
  TELEBIRR_APP_ID: z.string().optional(),
  TELEBIRR_APP_KEY: z.string().optional(),
  CBE_BIRR_API_URL: z.string().optional(),
  CBE_BIRR_MERCHANT_ID: z.string().optional(),

  // Optional — bank-transfer reference verification degrades to manual
  // proof-photo review (already built) when unset.
  VERIFY_ET_API_KEY: z.string().optional(),
  VERIFY_ET_BASE_URL: z.string().default('https://verify.et'),
  VERIFY_ET_WEBHOOK_SECRET: z.string().optional(),

  // Gates GET /warm (a DB+Redis-touching keep-alive endpoint for an uptime
  // monitor) — unset means anyone could trigger it, harmless but unthrottled.
  WARM_PING_SECRET: z.string().optional(),
}).refine(
  (data) => !data.VERIFY_ET_API_KEY || !!data.VERIFY_ET_WEBHOOK_SECRET,
  {
    // Without a webhook secret, POST /payments/webhook/verify-et accepts any
    // caller's claim of "verified: true" — a buyer could forge a webhook call
    // for their own verifyRequestId and get an unpaid order confirmed.
    message: 'VERIFY_ET_WEBHOOK_SECRET is required whenever VERIFY_ET_API_KEY is set — otherwise the webhook endpoint has no authentication',
    path: ['VERIFY_ET_WEBHOOK_SECRET'],
  }
)

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