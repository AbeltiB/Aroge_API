import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { AdminRole } from '@arogenpm/sdk'
import { authMiddleware, type AuthVariables } from '../../src/middleware/auth.js'
import { adminOnly } from '../../src/middleware/adminOnly.js'
import { requireRole } from '../../src/middleware/requireRole.js'
import { userToken, adminToken } from '../factories.js'

function testApp() {
  const app = new Hono<{ Variables: AuthVariables }>()
  app.get('/whoami', authMiddleware, (c) => c.json({ userId: c.get('userId') }))
  app.get('/admin-only', authMiddleware, adminOnly, (c) => c.json({ ok: true }))
  app.get('/super-admin-only', authMiddleware, adminOnly, requireRole(), (c) => c.json({ ok: true }))
  app.get('/support-or-super', authMiddleware, adminOnly, requireRole(AdminRole.SUPPORT), (c) => c.json({ ok: true }))
  return app
}

describe('authMiddleware', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await testApp().request('/whoami')
    expect(res.status).toBe(401)
  })

  it('rejects a malformed Authorization header (missing Bearer prefix)', async () => {
    const res = await testApp().request('/whoami', { headers: { Authorization: 'not-a-bearer-token' } })
    expect(res.status).toBe(401)
  })

  it('rejects an invalid/garbage token', async () => {
    const res = await testApp().request('/whoami', { headers: { Authorization: 'Bearer garbage' } })
    expect(res.status).toBe(401)
  })

  it('accepts a valid user token and sets userId', async () => {
    const token = await userToken('user-42')
    const res = await testApp().request('/whoami', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ userId: 'user-42' })
  })
})

describe('adminOnly', () => {
  it('rejects a regular user token', async () => {
    const token = await userToken('user-1')
    const res = await testApp().request('/admin-only', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(403)
  })

  it('accepts any admin token', async () => {
    const token = await adminToken('admin-1', AdminRole.MODERATOR, 'tg-1')
    const res = await testApp().request('/admin-only', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
  })
})

describe('requireRole', () => {
  it('SUPER_ADMIN passes requireRole() with no allowed roles listed', async () => {
    const token = await adminToken('admin-1', AdminRole.SUPER_ADMIN, 'tg-1')
    const res = await testApp().request('/super-admin-only', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
  })

  it('MODERATOR is rejected by requireRole() with no allowed roles listed', async () => {
    const token = await adminToken('admin-1', AdminRole.MODERATOR, 'tg-1')
    const res = await testApp().request('/super-admin-only', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(403)
  })

  it('SUPER_ADMIN always passes even when not in the explicitly allowed list', async () => {
    const token = await adminToken('admin-1', AdminRole.SUPER_ADMIN, 'tg-1')
    const res = await testApp().request('/support-or-super', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
  })

  it('SUPPORT passes requireRole(SUPPORT)', async () => {
    const token = await adminToken('admin-1', AdminRole.SUPPORT, 'tg-1')
    const res = await testApp().request('/support-or-super', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
  })

  it('MODERATOR is rejected by requireRole(SUPPORT)', async () => {
    const token = await adminToken('admin-1', AdminRole.MODERATOR, 'tg-1')
    const res = await testApp().request('/support-or-super', { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(403)
  })
})
