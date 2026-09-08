import { createMiddleware } from 'hono/factory'
import { err } from '../lib/response.js'
import type { AuthVariables } from './auth.js'
import { AdminRole } from '@arogenpm/sdk'

/**
 * Restricts a route to specific admin roles. Must run after `adminOnly`.
 * SUPER_ADMIN always passes, regardless of the roles listed.
 */
export function requireRole(...allowed: AdminRole[]) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const user = c.get('user')
    const role = user && 'role' in user ? (user.role as AdminRole) : undefined

    if (role === AdminRole.SUPER_ADMIN || (role && allowed.includes(role))) {
      await next()
      return
    }

    return err(c, 'You do not have permission to perform this action', 403)
  })
}
