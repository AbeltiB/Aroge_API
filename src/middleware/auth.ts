import { createMiddleware } from 'hono/factory'
import { verifyAccessToken } from '../lib/jwt.js'
import { err } from '../lib/response.js'
import type { JwtPayload } from '@arogenpm/sdk'

export type AuthVariables = {
  user: JwtPayload
  userId: string
}

export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return err(c, 'Missing or invalid Authorization header', 401)
  }

  const token = authHeader.slice(7)
  let payload: JwtPayload
  try {
    payload = await verifyAccessToken(token)
  } catch {
    return err(c, 'Invalid or expired token', 401)
  }

  c.set('user', payload)
  c.set('userId', payload.sub)
  await next()
})
