import { createMiddleware } from 'hono/factory'
import { redis } from '../lib/redis.js'
import { err } from '../lib/response.js'

export function rateLimit(max: number, windowSeconds = 60) {
  return createMiddleware(async (c, next) => {
    const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown'
    // routePath is the registered pattern (e.g. "/payments/:id/verify-reference"),
    // not the resolved URL — using the resolved path would give every distinct
    // :id value its own rate-limit bucket, letting an attacker reset their
    // budget just by hitting a different id (confirmed live against
    // /payments/:id/verify-reference during testing).
    const route = c.req.routePath
    const key = `rl:${ip}:${route}`

    const now = Date.now()
    const windowMs = windowSeconds * 1000

    await redis.zremrangebyscore(key, 0, now - windowMs)
    const count = await redis.zcard(key)

    if (count >= max) {
      return err(c, 'Too many requests', 429 as 400)
    }

    await redis.zadd(key, now, `${now}-${Math.random()}`)
    await redis.pexpire(key, windowMs)

    await next()
  })
}
