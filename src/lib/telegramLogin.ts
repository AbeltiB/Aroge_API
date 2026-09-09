import { createHash } from 'node:crypto'
import { prisma } from './prisma.js'
import { redis } from './redis.js'

export const TOKEN_TTL_SECONDS = 5 * 60

export function pendingLoginKey(token: string): string {
  return `telegram_login:${token}`
}

export type TelegramIdentity = {
  telegramId: string
  first_name: string
  last_name?: string
  username?: string
}

// Shared by both ways a pending login token can get confirmed: the bot
// webhook (/start login_<token> typed in the Telegram app) and the
// oauth.telegram.org callback (the "Continue with Telegram" full-page
// redirect). Both just need to know whether an admin-intent login is
// actually allowed before marking the token verified.
export async function resolvePendingLogin(
  token: string,
  identity: TelegramIdentity
): Promise<'verified' | 'denied' | 'not-found'> {
  const key = pendingLoginKey(token)
  const raw = await redis.get(key)
  if (!raw) return 'not-found'

  const record = JSON.parse(raw)

  if (record.intent === 'admin') {
    const admin = await prisma.adminUser.findUnique({ where: { telegramId: identity.telegramId } })
    if (!admin) {
      await redis.set(
        key,
        JSON.stringify({ ...record, status: 'denied', reason: 'This Telegram account is not registered as an admin' }),
        'EX', TOKEN_TTL_SECONDS
      )
      return 'denied'
    }
  }

  await redis.set(
    key,
    JSON.stringify({ ...record, status: 'verified', telegram: identity }),
    'EX', TOKEN_TTL_SECONDS
  )
  return 'verified'
}

// Telegram's webhook secret_token only allows A-Z a-z 0-9 _ - (1-256 chars).
// Render's `generateValue: true` produces base64 (+, /, =), which Telegram
// silently rejects setWebhook for — so derive a compliant token from
// whatever raw value ends up in TELEGRAM_WEBHOOK_SECRET instead of relying
// on it already being in the right charset. Used identically to both
// register the webhook and validate the inbound header, so the source
// value's actual characters never matter.
export function toWebhookSecretToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}
