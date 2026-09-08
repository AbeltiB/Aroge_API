import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { cloudinary } from '../lib/cloudinary.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminOnly } from '../middleware/adminOnly.js'
import { requireRole } from '../middleware/requireRole.js'
import { AdminRole } from '@arogenpm/sdk'
import type { AuthVariables } from '../middleware/auth.js'

const businesses = new Hono<{ Variables: AuthVariables }>()

businesses.use('*', authMiddleware)

const businessSchema = z.object({
  name: z.string().min(2).max(120),
  type: z.string().min(1).max(60),
  tin: z.string().optional(),
  city: z.string().optional(),
})

businesses.post('/', zValidator('json', businessSchema), async (c) => {
  const repUserId = c.get('userId')
  const body = c.req.valid('json')
  const business = await prisma.business.create({
    data: { ...body, repUserId },
  })
  return ok(c, business)
})

businesses.get('/:id', async (c) => {
  // License/TIN are never returned here — not shown publicly, and not even
  // to the owner through this endpoint. See /:id/license-url for the
  // admin-only, presigned access path (FR-023).
  const business = await prisma.business.findUnique({
    where: { id: c.req.param('id') },
    select: {
      id: true, repUserId: true, name: true, type: true, city: true,
      verifiedAt: true, createdAt: true, updatedAt: true,
      rep: { select: { id: true, name: true, avatarUrl: true } },
    },
  })
  if (!business) return err(c, 'Business not found', 404)
  return ok(c, business)
})

businesses.patch('/:id', zValidator('json', businessSchema.partial()), async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const existing = await prisma.business.findFirst({ where: { id, repUserId: userId } })
  if (!existing) return err(c, 'Business not found', 404)
  const business = await prisma.business.update({ where: { id }, data: c.req.valid('json') as any })
  return ok(c, business)
})

// Owner-only upload. Stored with Cloudinary's `authenticated` delivery type —
// the resulting public_id cannot be viewed via a plain URL, only via a
// signed, time-limited link (see /:id/license-url below).
businesses.post('/:id/license', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')

  const business = await prisma.business.findFirst({ where: { id, repUserId: userId } })
  if (!business) return err(c, 'Business not found', 404)

  const formData = await c.req.formData()
  const file = formData.get('license') as File | null
  if (!file) return err(c, 'No file provided', 400)

  const buffer = Buffer.from(await file.arrayBuffer())
  try {
    const uploadResult = await new Promise<any>((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: `aroge/business-licenses/${id}`, type: 'authenticated', resource_type: 'auto' },
        (error, result) => (error ? reject(error) : resolve(result))
      ).end(buffer)
    })
    await prisma.business.update({ where: { id }, data: { licenseUrl: uploadResult.public_id } })
    return ok(c, { uploaded: true })
  } catch (e: any) {
    console.error(`[license] upload failed for business ${id}:`, e?.message)
    return err(c, 'Upload failed — please try again later', 500)
  }
})

// Admin-only — generates a short-lived signed URL rather than exposing the
// document directly (FR-023: license/TIN docs must not be publicly accessible).
businesses.get('/:id/license-url', adminOnly, requireRole(AdminRole.MODERATOR), async (c) => {
  const id = c.req.param('id')
  const business = await prisma.business.findUnique({ where: { id }, select: { licenseUrl: true } })
  if (!business?.licenseUrl) return err(c, 'No license on file', 404)

  const url = cloudinary.utils.private_download_url(business.licenseUrl, undefined, {
    type: 'authenticated',
    resource_type: 'image',
    expires_at: Math.floor(Date.now() / 1000) + 5 * 60, // 5 minutes
  })
  return ok(c, { url })
})

businesses.post('/:id/verify', adminOnly, requireRole(AdminRole.MODERATOR), async (c) => {
  const id = c.req.param('id')
  const existing = await prisma.business.findUnique({ where: { id } })
  if (!existing) return err(c, 'Business not found', 404)
  const business = await prisma.business.update({
    where: { id },
    data: { verifiedAt: new Date() },
  })
  return ok(c, business)
})

export { businesses as businessRoutes }
