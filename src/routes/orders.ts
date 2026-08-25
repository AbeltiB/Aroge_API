import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { notificationQueue, escrowQueue, deliveryQueue } from '../lib/queue.js'
import { ok, err } from '../lib/response.js'
import { NOTIFY } from '../lib/notify.js'
import { authMiddleware } from '../middleware/auth.js'
import { createOrderSchema } from 'aroge-sdk'
import { getPaymentGateway } from '../lib/payments/registry.js'
import { setOrderListingsStatus } from '../lib/orderListings.js'
import type { AuthVariables } from '../middleware/auth.js'

const orders = new Hono<{ Variables: AuthVariables }>()

orders.use('*', authMiddleware)

orders.post('/',
  zValidator('json', createOrderSchema),
  async (c) => {
    const buyerId = c.get('userId')
    const body = c.req.valid('json')

    let sellerId: string
    let amount: number
    let title: string

    if (body.listingId) {
      const listing = await prisma.listing.findFirst({
        where: { id: body.listingId, deletedAt: null, status: 'ACTIVE' as any },
      })
      if (!listing) return err(c, 'Listing not found', 404)
      if (listing.sellerId === buyerId) return err(c, 'Cannot order your own listing', 400)

      amount = listing.price
      if (body.offerId) {
        const offer = await prisma.offer.findFirst({
          where: { id: body.offerId, buyerId, listingId: body.listingId, status: 'ACCEPTED' as any },
        })
        if (!offer) return err(c, 'Accepted offer not found', 404)
        amount = offer.amount
      }
      sellerId = listing.sellerId
      title = listing.title
    } else {
      const bundle = await prisma.bundle.findFirst({
        where: { id: body.bundleId, status: 'ACTIVE' as any },
        include: { items: true },
      })
      if (!bundle) return err(c, 'Bundle not found', 404)
      if (bundle.sellerId === buyerId) return err(c, 'Cannot order your own bundle', 400)

      amount = bundle.price
      sellerId = bundle.sellerId
      title = `Bundle (${bundle.items.length} items)`
    }

    // Delivery: read live settings, validate enabled, snapshot fee
    let deliveryFee = 0
    if (body.deliveryMethod === 'AROGE_DELIVERY') {
      const deliverySettings = await prisma.deliverySettings.findUnique({ where: { id: 'default' } })
      if (!deliverySettings?.isEnabled) return err(c, 'Delivery service is not currently available', 400)
      deliveryFee = deliverySettings.fee
    }

    // Fetch active buyer-facing fees and snapshot them at order time
    const activeFees = await prisma.platformFee.findMany({
      where: { isActive: true, visibleTo: { in: ['BUYER', 'BOTH'] } },
      orderBy: { displayOrder: 'asc' },
    })

    const feeSnapshot = activeFees.map((fee) => ({
      feeId: fee.id,
      name: fee.name,
      type: fee.type,
      value: fee.value,
      amount:
        fee.type === 'PERCENTAGE'
          ? Math.round(amount * (fee.value / 100) * 100) / 100
          : fee.value,
    }))

    const serviceFee = feeSnapshot.reduce((sum, f) => sum + f.amount, 0)
    const totalAmount = amount + deliveryFee + serviceFee

    const idempotencyKey = randomUUID()

    const order = await prisma.order.create({
      data: {
        listingId: body.listingId ?? null,
        bundleId: body.bundleId ?? null,
        buyerId,
        sellerId,
        amount,
        deliveryFee,
        serviceFee,
        feeSnapshot,
        deliveryMethod: body.deliveryMethod as any,
        paymentMethod: body.paymentMethod as any,
        idempotencyKey,
      },
    })

    // If delivery was requested, create it in PENDING_APPROVAL state immediately
    if (body.deliveryMethod === 'AROGE_DELIVERY') {
      const seller = await prisma.user.findUnique({
        where: { id: sellerId },
        select: { city: true, subCity: true },
      })
      const pickupAddress =
        body.pickupAddress?.trim() ||
        [seller?.subCity, seller?.city].filter(Boolean).join(', ') ||
        ''

      await prisma.delivery.create({
        data: {
          orderId: order.id,
          fee: deliveryFee,
          status: 'PENDING_APPROVAL' as any,
          pickupAddress,
          dropoffAddress: body.dropoffAddress!.trim(),
        },
      })
    }

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        gateway: body.paymentMethod as any,
        amount: totalAmount,
        idempotencyKey,
      },
    })

    const gateway = getPaymentGateway(body.paymentMethod as any)
    const charge = await gateway.initiateCharge({
      orderId: order.id,
      paymentId: payment.id,
      amount: totalAmount,
      idempotencyKey,
    })

    if (charge.gatewayRef) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { gatewayRef: charge.gatewayRef },
      })
    }

    // Notify seller of new order (fire-and-forget)
    void NOTIFY.orderPlaced(sellerId, title, order.id)

    return ok(c, {
      order,
      feeSnapshot,
      totalAmount,
      checkout: { gatewayRef: charge.gatewayRef, checkoutUrl: charge.checkoutUrl, reference: idempotencyKey },
    })
  }
)

orders.get('/mine', async (c) => {
  const buyerId = c.get('userId')
  const items = await prisma.order.findMany({
    where: { buyerId },
    include: {
      listing: { include: { photos: { where: { isPrimary: true }, take: 1 } } },
      bundle: { include: { items: { include: { listing: true } } } },
      payment: true,
    },
    orderBy: { createdAt: 'desc' },
  })
  return ok(c, items)
})

orders.get('/selling', async (c) => {
  const sellerId = c.get('userId')
  const items = await prisma.order.findMany({
    where: { sellerId },
    include: {
      listing: { include: { photos: { where: { isPrimary: true }, take: 1 } } },
      bundle: { include: { items: { include: { listing: true } } } },
      buyer: { select: { id: true, name: true, avatarUrl: true } },
      payment: true,
    },
    orderBy: { createdAt: 'desc' },
  })
  return ok(c, items)
})

orders.get('/:id', async (c) => {
  const userId = c.get('userId')
  const order = await prisma.order.findFirst({
    where: { id: c.req.param('id'), OR: [{ buyerId: userId }, { sellerId: userId }] },
    include: {
      listing: { include: { photos: { orderBy: { orderIndex: 'asc' } } } },
      bundle: { include: { items: { include: { listing: true } } } },
      payment: true,
      delivery: true,
      escrowEvents: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!order) return err(c, 'Order not found', 404)
  return ok(c, order)
})

orders.patch('/:id/confirm-receipt', async (c) => {
  const buyerId = c.get('userId')
  const orderId = c.req.param('id')

  const order = await prisma.order.findFirst({
    where: { id: orderId, buyerId, orderStatus: 'PAID_ESCROWED' as any },
  })
  if (!order) return err(c, 'Order not found or not in escrow', 404)

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: { orderStatus: 'COMPLETED' as any, paymentStatus: 'RELEASED' as any },
    })
    await tx.payment.update({
      where: { orderId },
      data: { status: 'RELEASED' as any },
    })
    await tx.escrowEvent.create({
      data: {
        orderId,
        eventType: 'RELEASED' as any,
        amount: order.amount,
        actorId: buyerId,
        note: 'Buyer confirmed receipt',
      },
    })
    await setOrderListingsStatus(tx, order, 'SOLD')
  })

  void NOTIFY.escrowReleased(order.sellerId, order.amount, orderId)
  void NOTIFY.orderCompleted(order.buyerId, orderId)

  // Check badge eligibility for both parties (fire-and-forget)
  void checkBadgeEligibility(order.buyerId)
  void checkBadgeEligibility(order.sellerId)

  return ok(c, null)
})

async function checkBadgeEligibility(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isTrusted: true, badgePendingReview: true },
  })
  if (!user || user.isTrusted || user.badgePendingReview) return

  const criteria = await prisma.badgeCriteria.findUnique({ where: { id: 'default' } })
  const { minSales = 5, minPurchases = 3, requireBoth = false } = criteria ?? {}

  const [sales, purchases] = await Promise.all([
    prisma.order.count({ where: { sellerId: userId, orderStatus: 'COMPLETED' as any } }),
    prisma.order.count({ where: { buyerId: userId, orderStatus: 'COMPLETED' as any } }),
  ])

  const meetsThreshold = requireBoth
    ? sales >= minSales && purchases >= minPurchases
    : sales >= minSales || purchases >= minPurchases

  if (meetsThreshold) {
    await prisma.user.update({ where: { id: userId }, data: { badgePendingReview: true } })
  }
}

export { orders as orderRoutes }
