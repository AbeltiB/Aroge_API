import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import { checkoutCart } from '../lib/cartCheckout.js'
import type { AuthVariables } from '../middleware/auth.js'

// Defined locally rather than in @arogenpm/sdk — that package's published
// npm version is currently stale (missing recent exports), so new schemas
// go here until it's republished. See infra notes from the Meilisearch work.
const addToCartSchema = z.object({ listingId: z.string().uuid() })

const checkoutSchema = z.object({
  listingIds: z.array(z.string().uuid()).optional(),
  deliveryMethod: z.enum(['AROGE_DELIVERY', 'MEETUP']),
  paymentMethod: z.enum(['TELEBIRR', 'CBE_BIRR', 'BANK_TRANSFER']),
  dropoffAddress: z.string().optional(),
})

const cart = new Hono<{ Variables: AuthVariables }>()

cart.use('*', authMiddleware)

cart.get('/', async (c) => {
  const buyerId = c.get('userId')

  const items = await prisma.cartItem.findMany({
    where: { buyerId, listing: { deletedAt: null } },
    include: {
      listing: {
        include: {
          photos: { where: { isPrimary: true }, take: 1 },
          category: true,
          seller: { select: { id: true, name: true, avatarUrl: true, verified: true, isTrusted: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return ok(c, items)
})

cart.post('/', zValidator('json', addToCartSchema), async (c) => {
  const buyerId = c.get('userId')
  const { listingId } = c.req.valid('json')

  const listing = await prisma.listing.findFirst({
    where: { id: listingId, deletedAt: null, status: 'ACTIVE' as any },
  })
  if (!listing) return err(c, 'Listing not found', 404)
  if (listing.sellerId === buyerId) return err(c, 'Cannot add your own listing to cart', 400)

  await prisma.cartItem.upsert({
    where: { buyerId_listingId: { buyerId, listingId } },
    update: {},
    create: { buyerId, listingId },
  })

  return ok(c, null)
})

cart.delete('/:listingId', async (c) => {
  const buyerId = c.get('userId')
  const listingId = c.req.param('listingId')
  await prisma.cartItem.deleteMany({ where: { buyerId, listingId } })
  return ok(c, null)
})

cart.post('/checkout', zValidator('json', checkoutSchema), async (c) => {
  const buyerId = c.get('userId')
  const body = c.req.valid('json')

  const result = await checkoutCart({
    buyerId,
    listingIds: body.listingIds,
    deliveryMethod: body.deliveryMethod,
    paymentMethod: body.paymentMethod,
    dropoffAddress: body.dropoffAddress,
  })

  return ok(c, result)
})

export { cart as cartRoutes }
