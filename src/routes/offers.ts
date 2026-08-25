import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { prisma } from '../lib/prisma.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import { NOTIFY } from '../lib/notify.js'
import { createOfferSchema, offerActionSchema } from 'aroge-sdk'
import type { AuthVariables } from '../middleware/auth.js'

const offers = new Hono<{ Variables: AuthVariables }>()

offers.use('*', authMiddleware)

offers.post('/listings/:listingId/offers',
  zValidator('json', createOfferSchema),
  async (c) => {
    const buyerId = c.get('userId')
    const listingId = c.req.param('listingId')
    const { amount } = c.req.valid('json')

    const listing = await prisma.listing.findFirst({
      where: { id: listingId, deletedAt: null, status: 'ACTIVE' as any },
    })
    if (!listing) return err(c, 'Listing not found', 404)
    if (listing.sellerId === buyerId) return err(c, 'Cannot offer on your own listing', 400)
    if (!listing.negotiable) return err(c, 'This listing does not accept offers', 400)

    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000)
    const offer = await prisma.offer.create({
      data: { listingId, buyerId, amount, expiresAt, status: 'PENDING' as any },
    })

    void NOTIFY.offerReceived(listing.sellerId, amount, listing.title, offer.id)

    return ok(c, offer)
  }
)

offers.get('/mine', async (c) => {
  const sellerId = c.get('userId')

  const items = await prisma.offer.findMany({
    where: { status: 'PENDING' as any, listing: { sellerId } },
    include: {
      buyer: { select: { id: true, name: true, avatarUrl: true } },
      listing: { select: { id: true, title: true, price: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  return ok(c, items)
})

// The buyer's own submitted offers across all listings, any status, as a flat
// list (a negotiation is a chain of rows linked by parentOfferId — the
// client groups these into one row per chain, showing whichever offer is
// the current "tip").
offers.get('/buying', async (c) => {
  const buyerId = c.get('userId')

  const items = await prisma.offer.findMany({
    where: { buyerId },
    include: {
      listing: { select: { id: true, title: true, price: true, sellerId: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  return ok(c, items)
})

offers.get('/listings/:listingId/offers', async (c) => {
  const userId = c.get('userId')
  const listingId = c.req.param('listingId')

  const listing = await prisma.listing.findFirst({ where: { id: listingId, sellerId: userId } })
  if (!listing) return err(c, 'Not authorized', 403)

  const items = await prisma.offer.findMany({
    where: { listingId, parentOfferId: null },
    include: { buyer: { select: { id: true, name: true, avatarUrl: true } }, counters: true },
    orderBy: { createdAt: 'desc' },
  })
  return ok(c, items)
})

offers.patch('/:id',
  zValidator('json', offerActionSchema),
  async (c) => {
    const userId = c.get('userId')
    const offerId = c.req.param('id')
    const { action, amount } = c.req.valid('json')

    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      include: { listing: true },
    })
    if (!offer) return err(c, 'Offer not found', 404)

    const isSeller = offer.listing.sellerId === userId
    const isBuyer = offer.buyerId === userId
    if (!isSeller && !isBuyer) return err(c, 'Not authorized', 403)
    if (offer.status !== 'PENDING') return err(c, 'Offer is no longer pending', 409)
    if (new Date() > offer.expiresAt) return err(c, 'Offer has expired', 410)

    if (action === 'ACCEPT') {
      const updated = await prisma.offer.update({
        where: { id: offerId },
        data: { status: 'ACCEPTED' as any },
      })
      void NOTIFY.offerAccepted(offer.buyerId, offer.listing.title, offerId)
      return ok(c, updated)
    }

    if (action === 'REJECT') {
      const updated = await prisma.offer.update({
        where: { id: offerId },
        data: { status: 'REJECTED' as any },
      })
      void NOTIFY.offerRejected(offer.buyerId, offer.listing.title, offerId)
      return ok(c, updated)
    }

    if (action === 'COUNTER') {
      if (!amount) return err(c, 'Counter amount required', 400)

      await prisma.offer.update({ where: { id: offerId }, data: { status: 'COUNTERED' as any } })

      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000)
      const counter = await prisma.offer.create({
        data: {
          listingId: offer.listingId,
          buyerId: offer.buyerId,
          amount,
          parentOfferId: offerId,
          expiresAt,
          status: 'PENDING' as any,
        },
      })

      const notifyUserId = isSeller ? offer.buyerId : offer.listing.sellerId
      void NOTIFY.offerCountered(notifyUserId, offer.listing.title, counter.id)

      return ok(c, counter)
    }

    return err(c, 'Invalid action', 400)
  }
)

export { offers as offerRoutes }
