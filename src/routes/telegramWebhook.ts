import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { redis } from '../lib/redis.js'
import { sendTelegramMessage } from '../lib/telegramBot.js'
import { ok, err } from '../lib/response.js'
import { env } from '../config/env.js'
import { TOKEN_TTL_SECONDS, pendingLoginKey } from '../lib/telegramLogin.js'

const telegramWebhook = new Hono()

function secretMatches(given: string): boolean {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return false
  const givenBuf = Buffer.from(given)
  const expectedBuf = Buffer.from(env.TELEGRAM_WEBHOOK_SECRET)
  return givenBuf.length === expectedBuf.length && timingSafeEqual(givenBuf, expectedBuf)
}

async function handleStartCommand(chatId: number, from: { id: number; first_name?: string; last_name?: string; username?: string }, token: string) {
  const key = pendingLoginKey(token)
  const raw = await redis.get(key)
  if (!raw) {
    await sendTelegramMessage(chatId, 'This login link has expired. Please go back to Aroge and tap "Continue with Telegram" again.')
    return
  }

  const record = JSON.parse(raw)
  const telegramId = String(from.id)

  if (record.intent === 'admin') {
    const admin = await prisma.adminUser.findUnique({ where: { telegramId } })
    if (!admin) {
      await redis.set(
        key,
        JSON.stringify({ ...record, status: 'denied', reason: 'This Telegram account is not registered as an admin' }),
        'EX', TOKEN_TTL_SECONDS
      )
      await sendTelegramMessage(chatId, '🚫 This Telegram account is not registered as an Aroge admin.')
      return
    }
  }

  await redis.set(
    key,
    JSON.stringify({
      ...record,
      status: 'verified',
      telegram: {
        telegramId,
        first_name: from.first_name ?? '',
        last_name: from.last_name,
        username: from.username,
      },
    }),
    'EX', TOKEN_TTL_SECONDS
  )
  await sendTelegramMessage(chatId, "✅ You're logged in to Aroge! Return to the site to continue.")
}

telegramWebhook.post('/webhook', async (c) => {
  const given = c.req.header('x-telegram-bot-api-secret-token') ?? ''
  if (!secretMatches(given)) return err(c, 'Not found', 404)

  const update = await c.req.json().catch(() => null)
  const message = update?.message
  const text: string | undefined = message?.text
  const from = message?.from

  if (text && from && text.startsWith('/start login_')) {
    const token = text.slice('/start login_'.length).trim()
    if (token) {
      try {
        await handleStartCommand(message.chat.id, from, token)
      } catch (e) {
        console.error('[telegram webhook] failed to handle /start:', e)
      }
    }
  }

  return ok(c, { received: true })
})

export { telegramWebhook as telegramWebhookRoutes }
