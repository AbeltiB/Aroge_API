import { createMiddleware } from 'hono/factory'
import { err } from '../lib/response.js'
import type { AuthVariables } from './auth.js'

export const adminOnly = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const user = c.get('user')
  if (!user || user.type !== 'admin') {
    return err(c, 'Admin access required', 403)
  }
  await next()
})
