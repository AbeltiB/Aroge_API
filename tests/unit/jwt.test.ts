import { describe, it, expect } from 'vitest'
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from '../../src/lib/jwt.js'

describe('jwt', () => {
  it('round-trips a user access token', async () => {
    const token = await signAccessToken({ sub: 'user-1', telegramId: '123', type: 'user' })
    const payload = await verifyAccessToken(token)
    expect(payload.sub).toBe('user-1')
    expect(payload.type).toBe('user')
  })

  it('round-trips an admin access token with its role', async () => {
    const token = await signAccessToken({ sub: 'admin-1', telegramId: '456', role: 'SUPER_ADMIN' as any, type: 'admin' })
    const payload: any = await verifyAccessToken(token)
    expect(payload.sub).toBe('admin-1')
    expect(payload.type).toBe('admin')
    expect(payload.role).toBe('SUPER_ADMIN')
  })

  it('round-trips a refresh token', async () => {
    const token = await signRefreshToken('user-1', 'user')
    const payload = await verifyRefreshToken(token)
    expect(payload.sub).toBe('user-1')
    expect(payload.type).toBe('user')
  })

  it('rejects a tampered access token', async () => {
    const token = await signAccessToken({ sub: 'user-1', type: 'user' })
    const tampered = token.slice(0, -2) + (token.slice(-2) === 'AA' ? 'BB' : 'AA')
    await expect(verifyAccessToken(tampered)).rejects.toThrow()
  })

  it('rejects an access token signature-verified with the wrong secret', async () => {
    // A refresh token is signed with a different secret than an access
    // token — verifying it as an access token should fail exactly like a
    // token forged without knowing JWT_ACCESS_SECRET would.
    const refreshToken = await signRefreshToken('user-1', 'user')
    await expect(verifyAccessToken(refreshToken)).rejects.toThrow()
  })

  it('rejects garbage input', async () => {
    await expect(verifyAccessToken('not-a-real-token')).rejects.toThrow()
  })
})
