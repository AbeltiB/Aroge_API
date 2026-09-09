import { createHash } from 'node:crypto'

export const TOKEN_TTL_SECONDS = 5 * 60

export function pendingLoginKey(token: string): string {
  return `telegram_login:${token}`
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
