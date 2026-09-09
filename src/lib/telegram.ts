import { createHmac, createHash } from 'node:crypto'
import type { TelegramAuthData } from '@arogenpm/sdk'

// Deliberately lives here rather than in the shared SDK: it uses Node's
// crypto module, which Metro can't bundle for the React Native app. The SDK
// is imported by both server and mobile code, so anything server-only that
// needs a Node built-in has to stay out of it entirely — even an unused
// export breaks mobile's Metro bundle, since the whole package resolves as
// one file.
export function verifyTelegramAuth(data: TelegramAuthData, botToken: string): boolean {
  const { hash, ...rest } = data

  const checkString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${(rest as Record<string, unknown>)[k]}`)
    .join('\n')

  const secretKey = createHash('sha256').update(botToken).digest()
  const expected = createHmac('sha256', secretKey).update(checkString).digest('hex')

  const age = Math.floor(Date.now() / 1000) - data.auth_date
  if (age > 86400) return false

  return expected === hash
}
