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
import { TOKEN_TTL_SECONDS, pendingLoginKey, resolvePendingLogin } from '../lib/telegramLogin.js'

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

// Token-based login: the client requests a token, then completes it one of
// two ways — (a) the bot deep link (t.me/<bot>?start=login_<token>), resolved
// by the webhook in routes/telegramWebhook.ts, or (b) the oauth.telegram.org
// full-page redirect below, resolved by POST /telegram/bot/oauth-callback.
// Either path writes the same Redis record, and the client polls
// GET /telegram/bot/poll/:token until it resolves.
const startBotLoginSchema = z.object({
  intent: z.enum(['user', 'admin']).default('user'),
  // Set when this login is really an Aroge Live buyer confirming a claim
  // (see resolvePendingLogin) — the seller's app calls this with the claim
  // they just created, not the buyer, so the resulting deep link can be
  // shared out of band instead of polled locally.
  claimId: z.string().uuid().optional(),
})

auth.post('/telegram/bot/start',
  rateLimit(20, 60),
  zValidator('json', startBotLoginSchema),
  async (c) => {
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      return err(c, 'Bot login is not configured on this server', 503)
    }

    const { intent, claimId } = c.req.valid('json')

    // A claim-confirmation link gets shared out of band (WhatsApp, a TikTok
    // DM) and may not get tapped within the normal 5-minute login window —
    // give it as long as the claim itself stays active instead.
    let ttlSeconds = TOKEN_TTL_SECONDS
    if (claimId) {
      const claim = await prisma.claim.findUnique({
        where: { id: claimId },
        select: { liveSession: { select: { claimWindowMinutes: true } } },
      })
      if (claim) ttlSeconds = Math.max(TOKEN_TTL_SECONDS, claim.liveSession.claimWindowMinutes * 60)
    }

    const token = randomBytes(16).toString('hex')
    await redis.set(
      pendingLoginKey(token),
      JSON.stringify({ status: 'pending', intent, ...(claimId ? { claimId } : {}) }),
      'EX', ttlSeconds
    )

    return ok(c, {
      token,
      // Numeric bot ID (public info — Telegram exposes it in every widget's
      // rendered HTML too) needed to build the oauth.telegram.org URL.
      botId: env.TELEGRAM_BOT_TOKEN.split(':')[0],
      deepLink: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=login_${token}`,
      expiresIn: ttlSeconds,
    })
  }
)

// Completes (b): oauth.telegram.org redirects the browser back to our own
// callback page with the signed Telegram payload as query params; that page
// POSTs them here for verification before the polling tab is allowed to
// treat the login as done.
//
// Mirrors telegramAuthSchema's shape rather than calling .extend() on it —
// the SDK bundles its own zod v3 internally, and mixing that with this
// project's zod v4 via .extend() breaks at runtime (different internal
// ZodObject implementations).
const oauthCallbackSchema = z.object({
  token: z.string().min(1),
  id: z.number(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().optional(),
  auth_date: z.number(),
  hash: z.string(),
})

auth.post('/telegram/bot/oauth-callback',
  rateLimit(20, 60),
  zValidator('json', oauthCallbackSchema),
  async (c) => {
    const { token, ...data } = c.req.valid('json')

    if (!verifyTelegramAuth(data as any, env.TELEGRAM_BOT_TOKEN)) {
      return err(c, 'Invalid Telegram auth data', 401)
    }

    const result = await resolvePendingLogin(token, {
      telegramId: String(data.id),
      first_name: data.first_name,
      last_name: data.last_name,
      username: data.username,
    })

    if (result.status === 'not-found') return err(c, 'Login request expired or not found', 404)
    if (result.status === 'denied') return err(c, 'This Telegram account is not registered as an admin', 403)
    return ok(c, { received: true, claimId: result.claimId ?? null })
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

  // Also returned in the body (admin's response deliberately omits this) —
  // the mobile app has no browser cookie jar to persist it across app
  // restarts, so it stores this itself and resends it as a Cookie header
  // manually on /refresh. The web admin panel relies on the httpOnly cookie
  // only and never touches this field.
  return ok(c, { status: 'verified' as const, accessToken, refreshToken, user })
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
