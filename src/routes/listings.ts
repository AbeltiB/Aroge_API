import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { cloudinary } from '../lib/cloudinary.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import { verifyAccessToken } from '../lib/jwt.js'
import { createListingSchema, updateListingSchema, listingStatusSchema } from 'aroge-sdk'
import type { AuthVariables } from '../middleware/auth.js'

const listings = new Hono<{ Variables: AuthVariables }>()

const SELLER_PUBLIC_SELECT = { id: true, name: true, avatarUrl: true, verified: true, isTrusted: true }

// Public routes
listings.get('/', async (c) => {
  const query = c.req.query()
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(50, Number(query.limit) || 20)
  const skip = (page - 1) * limit

  // Only ACTIVE listings are ever publicly browsable — DRAFT/ARCHIVED/FLAGGED
  // must never be reachable by an unauthenticated caller via a status override.
  const where: any = { deletedAt: null, seller: { holidayMode: false }, status: 'ACTIVE' }
  if (query.categoryId) where.categoryId = query.categoryId
  if (query.city) where.city = query.city
  if (query.condition) where.condition = query.condition
  if (query.minPrice) where.price = { ...where.price, gte: Number(query.minPrice) }
  if (query.maxPrice) where.price = { ...where.price, lte: Number(query.maxPrice) }
  if (query.sellerId) where.sellerId = query.sellerId

  const [items, total] = await Promise.all([
    prisma.listing.findMany({
      where,
      include: {
        photos: { where: { isPrimary: true }, take: 1 },
        category: true,
        seller: { select: SELLER_PUBLIC_SELECT },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.listing.count({ where }),
  ])

  return ok(c, { items, total, page, limit, pages: Math.ceil(total / limit) })
})

// Seller's own listings — holiday mode is irrelevant here.
// Registered before the /:id catch-all below so "mine"/"saved" aren't
// swallowed as a listing id (Hono matches these routes in registration order).
listings.get('/mine', authMiddleware, async (c) => {
  const sellerId = c.get('userId')
  const query = c.req.query()
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(50, Number(query.limit) || 20)
  const skip = (page - 1) * limit

  const where: any = { sellerId, deletedAt: null }
  if (query.status) where.status = query.status

  const [items, total] = await Promise.all([
    prisma.listing.findMany({
      where,
      include: { photos: { where: { isPrimary: true }, take: 1 }, category: true },
      orderBy: { createdAt: 'desc' },
      skip, take: limit,
    }),
    prisma.listing.count({ where }),
  ])
  return ok(c, { items, total, page, limit, pages: Math.ceil(total / limit) })
})

listings.get('/saved', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const query = c.req.query()
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(50, Number(query.limit) || 20)
  const skip = (page - 1) * limit

  const [saved, total] = await Promise.all([
    prisma.savedItem.findMany({
      where: { userId, listing: { deletedAt: null } },
      include: {
        listing: {
          include: {
            photos: { where: { isPrimary: true }, take: 1 },
            category: true,
            seller: { select: SELLER_PUBLIC_SELECT },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip, take: limit,
    }),
    prisma.savedItem.count({ where: { userId, listing: { deletedAt: null } } }),
  ])

  const items = saved.map((s) => s.listing)
  return ok(c, { items, total, page, limit, pages: Math.ceil(total / limit) })
})

listings.get('/:id', async (c) => {
  const listing = await prisma.listing.findFirst({
    where: { id: c.req.param('id'), deletedAt: null },
    include: {
      photos: { orderBy: { orderIndex: 'asc' } },
      category: true,
      seller: { select: { id: true, name: true, avatarUrl: true, verified: true, isTrusted: true, city: true, holidayMode: true } },
    },
  })
  if (!listing) return err(c, 'Listing not found', 404)

  // DRAFT/ARCHIVED/FLAGGED are never publicly viewable, even by direct link —
  // only the owner (editing their own listing) may see it in those states.
  if (!['ACTIVE', 'RESERVED', 'SOLD'].includes(listing.status)) {
    const authHeader = c.req.header('Authorization')
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    const payload = token ? await verifyAccessToken(token).catch(() => null) : null
    if (!payload || payload.sub !== listing.sellerId) return err(c, 'Listing not found', 404)
  }
  // Hide from public when seller is in holiday mode
  if ((listing.seller as any).holidayMode) return err(c, 'Listing not available', 404)
  return ok(c, listing)
})

// Protected routes
listings.use('/*', authMiddleware)

/** A listing may only be tagged with a business the caller is the registered rep of. */
async function assertBusinessOwnership(businessId: string | undefined, userId: string): Promise<string | null> {
  if (!businessId) return null
  const business = await prisma.business.findUnique({ where: { id: businessId } })
  if (!business) return 'Business not found'
  if (business.repUserId !== userId) return 'You are not the representative for this business'
  return null
}

listings.post('/',
  zValidator('json', createListingSchema),
  async (c) => {
    const userId = c.get('userId')
    const body = c.req.valid('json')

    const businessError = await assertBusinessOwnership(body.businessId, userId)
    if (businessError) return err(c, businessError, 403)

    const listing = await prisma.listing.create({
      data: { ...body as any, sellerId: userId, status: 'DRAFT' },
    })
    return ok(c, listing)
  }
)

listings.patch('/:id',
  zValidator('json', updateListingSchema),
  async (c) => {
    const userId = c.get('userId')
    const id = c.req.param('id')
    const existing = await prisma.listing.findFirst({ where: { id, sellerId: userId, deletedAt: null } })
    if (!existing) return err(c, 'Listing not found', 404)

    const body = c.req.valid('json')
    const businessError = await assertBusinessOwnership(body.businessId, userId)
    if (businessError) return err(c, businessError, 403)

    const listing = await prisma.listing.update({
      where: { id },
      data: body as any,
    })
    return ok(c, listing)
  }
)

listings.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const existing = await prisma.listing.findFirst({ where: { id, sellerId: userId, deletedAt: null } })
  if (!existing) return err(c, 'Listing not found', 404)
  if (existing.status === 'FLAGGED') {
    return err(c, 'This listing was flagged by a moderator and cannot be changed until reviewed', 403)
  }

  await prisma.listing.update({
    where: { id },
    data: { deletedAt: new Date(), status: 'ARCHIVED' as any },
  })
  return ok(c, null)
})

listings.patch('/:id/status',
  zValidator('json', listingStatusSchema),
  async (c) => {
    const userId = c.get('userId')
    const id = c.req.param('id')
    const { status } = c.req.valid('json')

    const existing = await prisma.listing.findFirst({ where: { id, sellerId: userId, deletedAt: null } })
    if (!existing) return err(c, 'Listing not found', 404)
    if (existing.status === 'FLAGGED') {
      return err(c, 'This listing was flagged by a moderator and cannot be changed until reviewed', 403)
    }

    const listing = await prisma.listing.update({
      where: { id },
      data: { status: status as any },
    })
    return ok(c, listing)
  }
)

listings.post('/:id/photos', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const existing = await prisma.listing.findFirst({ where: { id, sellerId: userId, deletedAt: null } })
  if (!existing) return err(c, 'Listing not found', 404)

  const photoCount = await prisma.listingPhoto.count({ where: { listingId: id } })
  if (photoCount >= 10) return err(c, 'Maximum 10 photos per listing', 400)

  const formData = await c.req.formData()
  const file = formData.get('photo') as File | null
  if (!file) return err(c, 'No photo provided', 400)

  const buffer = Buffer.from(await file.arrayBuffer())
  try {
    const uploadResult = await new Promise<any>((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: `aroge/listings/${id}`, format: 'webp', transformation: [{ width: 1200, crop: 'limit' }] },
        (error, result) => (error ? reject(error) : resolve(result))
      ).end(buffer)
    })

    const isPrimary = photoCount === 0
    const photo = await prisma.listingPhoto.create({
      data: {
        listingId: id,
        cloudinaryKey: uploadResult.public_id,
        orderIndex: photoCount,
        isPrimary,
      },
    })
    return ok(c, photo)
  } catch (e: any) {
    console.error(`[listing photo] upload failed for listing ${id}:`, e?.message)
    return err(c, 'Upload failed — please try again later', 500)
  }
})

listings.delete('/:id/photos/:photoId', async (c) => {
  const userId = c.get('userId')
  const { id, photoId } = c.req.param()

  const listing = await prisma.listing.findFirst({ where: { id, sellerId: userId, deletedAt: null } })
  if (!listing) return err(c, 'Listing not found', 404)

  const photo = await prisma.listingPhoto.findFirst({ where: { id: photoId, listingId: id } })
  if (!photo) return err(c, 'Photo not found', 404)

  await cloudinary.uploader.destroy(photo.cloudinaryKey)
  await prisma.listingPhoto.delete({ where: { id: photoId } })
  return ok(c, null)
})

listings.post('/:id/save', async (c) => {
  const userId = c.get('userId')
  const listingId = c.req.param('id')
  await prisma.savedItem.upsert({
    where: { userId_listingId: { userId, listingId } },
    update: {},
    create: { userId, listingId },
  })
  return ok(c, null)
})

listings.delete('/:id/save', async (c) => {
  const userId = c.get('userId')
  const listingId = c.req.param('id')
  await prisma.savedItem.deleteMany({ where: { userId, listingId } })
  return ok(c, null)
})

export { listings as listingRoutes }
