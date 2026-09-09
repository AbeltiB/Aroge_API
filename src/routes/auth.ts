import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { verifyTelegramAuth } from '../lib/telegram.js'
import { redis } from '../lib/redis.js'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt.js'
import { ok, err } from '../lib/response.js'
import { env } from '../config/env.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { telegramAuthSchema } from '@arogenpm/sdk'
import { TOKEN_TTL_SECONDS, pendingLoginKey } from '../lib/telegramLogin.js'

const auth = new Hono()

const REFRESH_COOKIE = 'aroge_refresh'
const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'Strict' as const,
  path: '/api/v1/auth',
  maxAge: 60 * 60 * 24 * 30,
}

// Marketplace (mobile) login — any Telegram account may sign in; a User row
// is created on first login.
auth.post('/telegram',
  rateLimit(10, 60),
  zValidator('json', telegramAuthSchema),
  async (c) => {
    const data = c.req.valid('json')

    if (!verifyTelegramAuth(data as any, env.TELEGRAM_BOT_TOKEN)) {
      return err(c, 'Invalid Telegram auth data', 401)
    }

    const telegramId = String(data.id)
    const user = await prisma.user.upsert({
      where: { telegramId },
      update: {
        name: [data.first_name, data.last_name].filter(Boolean).join(' '),
        avatarUrl: data.photo_url ?? null,
      },
      create: {
        telegramId,
        name: [data.first_name, data.last_name].filter(Boolean).join(' '),
        avatarUrl: data.photo_url ?? null,
      },
    })

    const accessToken = await signAccessToken({ sub: user.id, telegramId, type: 'user' })
    const refreshToken = await signRefreshToken(user.id, 'user')
    setCookie(c, REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTS)

    return ok(c, { accessToken, user })
  }
)

// Admin (backoffice) login — Telegram accounts must already be provisioned as
// an AdminUser (see prisma/seed.ts or scripts/promote-admin.ts); no self-signup.
auth.post('/telegram/admin',
  rateLimit(10, 60),
  zValidator('json', telegramAuthSchema),
  async (c) => {
    const data = c.req.valid('json')

    if (!verifyTelegramAuth(data as any, env.TELEGRAM_BOT_TOKEN)) {
      return err(c, 'Invalid Telegram auth data', 401)
    }

    const telegramId = String(data.id)
    const admin = await prisma.adminUser.findUnique({ where: { telegramId } })
    if (!admin) return err(c, 'This Telegram account is not registered as an admin', 403)

    const updated = await prisma.adminUser.update({
      where: { telegramId },
      data: {
        name: [data.first_name, data.last_name].filter(Boolean).join(' '),
        avatarUrl: data.photo_url ?? null,
      },
    })

    const accessToken = await signAccessToken({ sub: updated.id, telegramId, role: updated.role as any, type: 'admin' })
    const refreshToken = await signRefreshToken(updated.id, 'admin')
    setCookie(c, REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTS)

    return ok(c, { accessToken, admin: updated })
  }
)

// Bot-based login (used by both web and mobile instead of the Telegram
// Login Widget / oauth.telegram.org): the client never touches Telegram's
// own web login screen (which falls back to asking for a phone number when
// the browser has no active Telegram Web session). Instead the user
// confirms inside their already-logged-in Telegram app, and the client
// polls until the bot webhook (see routes/telegramWebhook.ts) marks the
// token verified.
const startBotLoginSchema = z.object({ intent: z.enum(['user', 'admin']).default('user') })

auth.post('/telegram/bot/start',
  rateLimit(20, 60),
  zValidator('json', startBotLoginSchema),
  async (c) => {
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      return err(c, 'Bot login is not configured on this server', 503)
    }

    const { intent } = c.req.valid('json')
    const token = randomBytes(16).toString('hex')
    await redis.set(pendingLoginKey(token), JSON.stringify({ status: 'pending', intent }), 'EX', TOKEN_TTL_SECONDS)

    return ok(c, {
      token,
      deepLink: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=login_${token}`,
      expiresIn: TOKEN_TTL_SECONDS,
    })
  }
)

auth.get('/telegram/bot/poll/:token', rateLimit(60, 60), async (c) => {
  const token = c.req.param('token')
  const raw = await redis.get(pendingLoginKey(token))
  if (!raw) return err(c, 'Login request expired or not found', 404)

  const record = JSON.parse(raw)
  if (record.status === 'pending') return ok(c, { status: 'pending' as const })

  await redis.del(pendingLoginKey(token))

  if (record.status === 'denied') {
    return err(c, record.reason ?? 'Login denied', 403)
  }

  const { telegramId, first_name, last_name } = record.telegram as { telegramId: string; first_name: string; last_name?: string }
  const name = [first_name, last_name].filter(Boolean).join(' ')

  if (record.intent === 'admin') {
    const admin = await prisma.adminUser.findUnique({ where: { telegramId } })
    if (!admin) return err(c, 'This Telegram account is not registered as an admin', 403)

    const updated = await prisma.adminUser.update({ where: { telegramId }, data: { name } })
    const accessToken = await signAccessToken({ sub: updated.id, telegramId, role: updated.role as any, type: 'admin' })
    const refreshToken = await signRefreshToken(updated.id, 'admin')
    setCookie(c, REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTS)

    return ok(c, { status: 'verified' as const, accessToken, admin: updated })
  }

  const user = await prisma.user.upsert({
    where: { telegramId },
    update: { name },
    create: { telegramId, name },
  })
  const accessToken = await signAccessToken({ sub: user.id, telegramId, type: 'user' })
  const refreshToken = await signRefreshToken(user.id, 'user')
  setCookie(c, REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTS)

  return ok(c, { status: 'verified' as const, accessToken, user })
})

auth.post('/refresh', async (c) => {
  const refreshToken = getCookie(c, REFRESH_COOKIE)
  if (!refreshToken) return err(c, 'No refresh token', 401)

  try {
    const { sub, type } = await verifyRefreshToken(refreshToken)

    if (type === 'user') {
      const user = await prisma.user.findUnique({ where: { id: sub } })
      if (!user || user.deletedAt) return err(c, 'User not found', 401)

      const accessToken = await signAccessToken({ sub: user.id, telegramId: user.telegramId, type: 'user' })
      const newRefresh = await signRefreshToken(user.id, 'user')
      setCookie(c, REFRESH_COOKIE, newRefresh, REFRESH_COOKIE_OPTS)

      return ok(c, { accessToken })
    }

    if (type === 'admin') {
      const admin = await prisma.adminUser.findUnique({ where: { id: sub } })
      if (!admin) return err(c, 'Admin not found', 401)

      const accessToken = await signAccessToken({ sub: admin.id, telegramId: admin.telegramId, role: admin.role as any, type: 'admin' })
      const newRefresh = await signRefreshToken(admin.id, 'admin')
      setCookie(c, REFRESH_COOKIE, newRefresh, REFRESH_COOKIE_OPTS)

      return ok(c, { accessToken })
    }

    return err(c, 'Invalid token type', 401)
  } catch {
    return err(c, 'Invalid or expired refresh token', 401)
  }
})

auth.post('/logout', (c) => {
  deleteCookie(c, REFRESH_COOKIE, { path: '/api/v1/auth' })
  return ok(c, null)
})

export { auth as authRoutes }
