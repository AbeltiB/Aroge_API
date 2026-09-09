import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { sendTelegramMessage, sendLoginButton } from '../lib/telegramBot.js'
import { redis } from '../lib/redis.js'
import { ok, err } from '../lib/response.js'
import { env } from '../config/env.js'
import { pendingLoginKey, toWebhookSecretToken } from '../lib/telegramLogin.js'

const telegramWebhook = new Hono()

function secretMatches(given: string): boolean {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return false
  const givenBuf = Buffer.from(given)
  const expectedBuf = Buffer.from(toWebhookSecretToken(env.TELEGRAM_WEBHOOK_SECRET))
  return givenBuf.length === expectedBuf.length && timingSafeEqual(givenBuf, expectedBuf)
}

// Deliberately does NOT resolve the login itself from this update's `from`
// field, even though a webhook update is authentic (Telegram-signed via the
// secret token) — the point of the Login URL button is the explicit,
// native Log in/Decline confirmation. Resolution happens only when that
// button is tapped and Telegram calls back /login/callback with its own
// signed payload (see POST /auth/telegram/bot/oauth-callback).
async function handleStartCommand(chatId: number, token: string) {
  const raw = await redis.get(pendingLoginKey(token))
  if (!raw) {
    await sendTelegramMessage(chatId, 'This login link has expired. Please go back to Aroge and tap "Continue with Telegram" again.')
    return
  }

  // The callback page lives on the admin web domain (the only one
  // registered via @BotFather /setdomain) regardless of who's logging in,
  // but it behaves differently per intent: admin completes sign-in and
  // lands on the dashboard there; user (mobile) just confirms and tells
  // the person to switch back to the app, leaving the mobile app's own
  // poll loop to actually consume the token — it isn't a browser session
  // Aroge Web can complete on the marketplace user's behalf.
  const { intent } = JSON.parse(raw) as { intent: 'user' | 'admin' }
  const loginUrl = `${env.ADMIN_WEB_URL}/login/callback?token=${token}&intent=${intent}`
  await sendLoginButton(chatId, 'Tap below to finish signing in to Aroge.', loginUrl)
}

telegramWebhook.post('/webhook', async (c) => {
  const given = c.req.header('x-telegram-bot-api-secret-token') ?? ''
  if (!secretMatches(given)) return err(c, 'Not found', 404)

  const update = await c.req.json().catch(() => null)
  const message = update?.message
  const text: string | undefined = message?.text

  if (text && message?.chat?.id && text.startsWith('/start login_')) {
    const token = text.slice('/start login_'.length).trim()
    if (token) {
      try {
        await handleStartCommand(message.chat.id, token)
      } catch (e) {
        console.error('[telegram webhook] failed to handle /start:', e)
      }
    }
  }

  return ok(c, { received: true })
})

export { telegramWebhook as telegramWebhookRoutes }
