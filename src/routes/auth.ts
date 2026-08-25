import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { zValidator } from '@hono/zod-validator'
import { prisma } from '../lib/prisma.js'
import { verifyTelegramAuth } from '../lib/telegram.js'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt.js'
import { ok, err } from '../lib/response.js'
import { env } from '../config/env.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { telegramAuthSchema } from 'aroge-sdk'

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
