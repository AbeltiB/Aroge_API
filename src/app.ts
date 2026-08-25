import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { timingSafeEqual } from 'node:crypto'
import { ok, err } from './lib/response.js'
import { env } from './config/env.js'
import { prisma } from './lib/prisma.js'
import { redis } from './lib/redis.js'
import { authRoutes } from './routes/auth.js'
import { userRoutes } from './routes/users.js'
import { listingRoutes } from './routes/listings.js'
import { bundleRoutes } from './routes/bundles.js'
import { offerRoutes } from './routes/offers.js'
import { orderRoutes } from './routes/orders.js'
import { paymentRoutes } from './routes/payments.js'
import { escrowRoutes } from './routes/escrow.js'
import { messageRoutes } from './routes/messages.js'
import { deliveryRoutes } from './routes/delivery.js'
import { searchRoutes } from './routes/search.js'
import { categoryRoutes } from './routes/categories.js'
import { reviewRoutes } from './routes/reviews.js'
import { businessRoutes } from './routes/businesses.js'
import { reportRoutes } from './routes/reports.js'
import { adminRoutes } from './routes/admin.js'
import { feeRoutes } from './routes/fees.js'
import { notificationRoutes } from './routes/notifications.js'

export const app = new Hono()

app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
}))
app.use('*', logger())

app.get('/health', (c) => ok(c, 'ok'))

// Liveness-only — deliberately never touches Postgres/Redis so a slow
// dependency can't make Render think the whole process is unhealthy and
// restart it. Point Render's own healthCheckPath at this one.
//
// GET /warm is the one an uptime monitor (UptimeRobot etc.) should ping every
// ~10 min instead: it does a cheap round-trip to both Postgres and Redis,
// which is what actually prevents Neon/Upstash's own free-tier cold-starts —
// a plain HTTP ping alone only keeps this Render process awake, not the
// managed DB/cache behind it.
app.get('/warm', async (c) => {
  if (env.WARM_PING_SECRET) {
    const given = c.req.query('key') ?? ''
    const expected = env.WARM_PING_SECRET
    const givenBuf = Buffer.from(given)
    const expectedBuf = Buffer.from(expected)
    const valid = givenBuf.length === expectedBuf.length && timingSafeEqual(givenBuf, expectedBuf)
    if (!valid) return err(c, 'Not found', 404)
  }

  const [dbOk, redisOk] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    redis.ping().then(() => true).catch(() => false),
  ])

  return ok(c, { db: dbOk, redis: redisOk })
})

const api = app.basePath('/api/v1')

api.get('/health', (c) => ok(c, 'ok'))
api.route('/auth', authRoutes)
api.route('/users', userRoutes)
api.route('/listings', listingRoutes)
api.route('/bundles', bundleRoutes)
api.route('/offers', offerRoutes)
api.route('/orders', orderRoutes)
api.route('/payments', paymentRoutes)
api.route('/escrow', escrowRoutes)
api.route('/messages', messageRoutes)
api.route('/delivery', deliveryRoutes)
api.route('/search', searchRoutes)
api.route('/categories', categoryRoutes)
api.route('/reviews', reviewRoutes)
api.route('/businesses', businessRoutes)
api.route('/reports', reportRoutes)
api.route('/admin', adminRoutes)
api.route('/fees', feeRoutes)
api.route('/notifications', notificationRoutes)

app.onError((error, c) => {
  console.error(`[unhandled] ${c.req.method} ${c.req.path}:`, error)
  return err(c, 'Internal server error', 500)
})
