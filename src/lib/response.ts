import type { Context } from 'hono'
import type { ApiSuccess, ApiError } from 'aroge-sdk'

export const ok = <T>(c: Context, data: T): Response =>
  c.json<ApiSuccess<T>>({ success: true, data })

export const err = (c: Context, message: string, status = 400): Response =>
  c.json<ApiError>({ success: false, message }, status as 400 | 401 | 403 | 404 | 409 | 422 | 500)
