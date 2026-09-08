import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { prisma } from '../lib/prisma.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import { createBundleSchema } from '@arogenpm/sdk'
import type { AuthVariables } from '../middleware/auth.js'

const bundles = new Hono<{ Variables: AuthVariables }>()

const BUNDLE_ITEMS_INCLUDE = {
  items: {
    include: {
      listing: { include: { photos: { where: { isPrimary: true }, take: 1 } } },
    },
  },
} as const

// Registered before the public /:id route below — Hono matches these by
// registration order, and a static path like "mine" would otherwise be
// swallowed as a bundle id (see FR notes on the equivalent listings.ts bug).
bundles.get('/mine', authMiddleware, async (c) => {
  const sellerId = c.get('userId')
  const items = await prisma.bundle.findMany({
    where: { sellerId },
    include: BUNDLE_ITEMS_INCLUDE,
    orderBy: { createdAt: 'desc' },
  })
  return ok(c, items)
})

bundles.get('/:id', async (c) => {
  const bundle = await prisma.bundle.findUnique({
    where: { id: c.req.param('id') },
    include: {
      ...BUNDLE_ITEMS_INCLUDE,
      seller: { select: { id: true, name: true, avatarUrl: true, verified: true, isTrusted: true } },
    },
  })
  if (!bundle) return err(c, 'Bundle not found', 404)
  return ok(c, bundle)
})

bundles.use('/*', authMiddleware)

bundles.post('/',
  zValidator('json', createBundleSchema),
  async (c) => {
    const sellerId = c.get('userId')
    const { listingIds, price } = c.req.valid('json')

    const uniqueIds = Array.from(new Set(listingIds))
    const listings = await prisma.listing.findMany({
      where: { id: { in: uniqueIds }, deletedAt: null },
    })

    if (listings.length !== uniqueIds.length) {
      return err(c, 'One or more listings were not found', 404)
    }
    if (listings.some((l) => l.sellerId !== sellerId)) {
      return err(c, 'You can only bundle your own listings', 403)
    }
    if (listings.some((l) => l.status !== 'ACTIVE')) {
      return err(c, 'All listings in a bundle must be Active', 400)
    }

    const bundle = await prisma.bundle.create({
      data: {
        sellerId,
        price,
        items: { create: uniqueIds.map((listingId) => ({ listingId })) },
      },
      include: BUNDLE_ITEMS_INCLUDE,
    })

    return ok(c, bundle)
  }
)

bundles.delete('/:id', async (c) => {
  const sellerId = c.get('userId')
  const id = c.req.param('id')

  const bundle = await prisma.bundle.findFirst({ where: { id, sellerId } })
  if (!bundle) return err(c, 'Bundle not found', 404)
  if (bundle.status !== 'ACTIVE') return err(c, 'Only an active bundle can be cancelled', 400)

  await prisma.bundle.update({ where: { id }, data: { status: 'ARCHIVED' } })
  return ok(c, null)
})

export { bundles as bundleRoutes }
