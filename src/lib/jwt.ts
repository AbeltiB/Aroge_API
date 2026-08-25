import { SignJWT, jwtVerify } from 'jose'
import { env } from '../config/env.js'
import type { JwtPayload, JwtUserPayload, JwtAdminPayload } from 'aroge-sdk'

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET)
const refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET)

export async function signAccessToken(payload: JwtUserPayload | JwtAdminPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(accessSecret)
}

export async function signRefreshToken(sub: string, type: 'user' | 'admin'): Promise<string> {
  return new SignJWT({ sub, type })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(refreshSecret)
}

export async function verifyAccessToken(token: string): Promise<JwtPayload> {
  const { payload } = await jwtVerify(token, accessSecret)
  return payload as unknown as JwtPayload
}

export async function verifyRefreshToken(token: string): Promise<{ sub: string; type: 'user' | 'admin' }> {
  const { payload } = await jwtVerify(token, refreshSecret)
  return payload as { sub: string; type: 'user' | 'admin' }
}
