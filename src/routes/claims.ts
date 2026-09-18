import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import { claimExpiryQueue } from '../lib/queue.js'
import { createOrderFromListing, OrderCreationError } from '../lib/orderCreation.js'
import { markPaymentHeld } from '../lib/markPaymentHeld.js'
import { promoteNextWaitlistedClaim } from '../lib/claimPromotion.js'
import { createClaimSchema } from '@arogenpm/sdk'
import type { AuthVariables } from '../middleware/auth.js'

const claims = new Hono<{ Variables: AuthVariables }>()

claims.use('*', authMiddleware)

// Every claims route acts on behalf of the seller running the session — the
// claim's parent LiveSession must belong to the caller. No separate staff
// identity in v1 (see the Aroge Live integration plan for why).
async function requireOwnedClaim(sellerId: string, claimId: string) {
  return prisma.claim.findFirst({
    where: { id: claimId, liveSession: { sellerId } },
    include: { liveItem: true, liveSession: true },
  })
}

claims.post('/', zValidator('json', createClaimSchema.extend({ liveSessionId: z.string().uuid() })), async (c) => {
  const sellerId = c.get('userId')
  const { liveSessionId, code, customerPhone } = c.req.valid('json')

  const session = await prisma.liveSession.findFirst({ where: { id: liveSessionId, sellerId } })
  if (!session) return err(c, 'Live session not found', 404)

  const item = await prisma.liveItem.findFirst({ where: { liveSessionId, code: code.toUpperCase() } })
  if (!item) return err(c, 'No item with that code in this session', 404)
  if (!item.revealed) return err(c, 'This item has not been revealed yet', 400)

  const activeClaim = await prisma.claim.findFirst({
    where: { liveItemId: item.id, status: 'CLAIMED' as any },
  })

  if (!activeClaim) {
    const claim = await prisma.claim.create({
      data: {
        liveSessionId,
        liveItemId: item.id,
        customerPhone,
        expiresAt: new Date(Date.now() + session.claimWindowMinutes * 60_000),
      },
    })
    await claimExpiryQueue.add(
      'claim-expiry',
      { claimId: claim.id },
      { delay: session.claimWindowMinutes * 60_000, jobId: `claim-${claim.id}` }
    )
    return ok(c, claim)
  }

  const waitlistCount = await prisma.claim.count({
    where: { liveItemId: item.id, status: 'WAITLISTED' as any },
  })
  const claim = await prisma.claim.create({
    data: {
      liveSessionId,
      liveItemId: item.id,
      customerPhone,
      status: 'WAITLISTED' as any,
      expiresAt: activeClaim.expiresAt, // informational only while waitlisted
      waitlistPosition: waitlistCount + 1,
    },
  })
  return ok(c, claim)
})

claims.post('/:id/convert', async (c) => {
  const sellerId = c.get('userId')
  const claim = await requireOwnedClaim(sellerId, c.req.param('id'))
  if (!claim) return err(c, 'Claim not found', 404)
  if (claim.status !== 'CLAIMED') return err(c, 'This claim is not active', 409)
  if (!claim.buyerId) return err(c, 'Waiting for the buyer to confirm via Telegram before this can be converted', 409)

  const listing = await prisma.listing.findUnique({ where: { id: claim.liveItem.listingId } })
  if (!listing) return err(c, 'Listing no longer exists', 404)

  let result
  try {
    result = await createOrderFromListing({
      buyerId: claim.buyerId,
      sellerId,
      listingId: listing.id,
      title: listing.title,
      amount: claim.liveItem.priceOverride ?? listing.price,
      deliveryMethod: 'MEETUP',
      paymentMethod: 'BANK_TRANSFER',
      source: 'LIVE',
      liveSessionId: claim.liveSessionId,
      skipGatewayCharge: true,
    })
  } catch (e) {
    if (e instanceof OrderCreationError) return err(c, e.message, 400)
    throw e
  }

  const updated = await prisma.claim.update({
    where: { id: claim.id },
    data: { status: 'CONVERTED' as any, orderId: result.order.id },
  })
  await claimExpiryQueue.remove(`claim-${claim.id}`).catch(() => {})

  return ok(c, { claim: updated, order: result.order })
})

claims.post('/:id/cancel', async (c) => {
  const sellerId = c.get('userId')
  const claim = await requireOwnedClaim(sellerId, c.req.param('id'))
  if (!claim) return err(c, 'Claim not found', 404)
  if (claim.status !== 'CLAIMED' && claim.status !== 'WAITLISTED') {
    return err(c, 'This claim can no longer be cancelled', 409)
  }

  let promotedClaimId: string | null = null
  await prisma.$transaction(async (tx) => {
    await tx.claim.update({ where: { id: claim.id }, data: { status: 'CANCELLED' as any } })
    if (claim.status === 'CLAIMED') {
      promotedClaimId = await promoteNextWaitlistedClaim(tx, claim.liveItemId, claim.liveSession.claimWindowMinutes)
    }
  })
  await claimExpiryQueue.remove(`claim-${claim.id}`).catch(() => {})
  if (promotedClaimId) {
    await claimExpiryQueue.add(
      'claim-expiry',
      { claimId: promotedClaimId },
      { delay: claim.liveSession.claimWindowMinutes * 60_000, jobId: `claim-${promotedClaimId}` }
    )
  }

  return ok(c, null)
})

claims.post('/:id/mark-paid', async (c) => {
  const sellerId = c.get('userId')
  const claim = await requireOwnedClaim(sellerId, c.req.param('id'))
  if (!claim) return err(c, 'Claim not found', 404)
  if (claim.status !== 'CONVERTED' || !claim.orderId) return err(c, 'This claim has not been converted to an order yet', 409)

  const payment = await prisma.payment.findUnique({ where: { orderId: claim.orderId } })
  if (!payment) return err(c, 'Payment not found for this order', 404)
  if (payment.status !== 'PENDING') return err(c, 'This payment has already been processed', 409)

  await markPaymentHeld(payment, 'Marked paid by seller from an Aroge Live claim', sellerId)
  return ok(c, null)
})

export { claims as claimRoutes }
