import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { notificationQueue } from '../lib/queue.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminOnly } from '../middleware/adminOnly.js'
import { requireRole } from '../middleware/requireRole.js'
import { setOrderListingsStatus } from '../lib/orderListings.js'
import { disputeSchema } from 'aroge-sdk'
import type { AuthVariables } from '../middleware/auth.js'

const escrow = new Hono<{ Variables: AuthVariables }>()

escrow.use('*', authMiddleware)

escrow.get('/orders/:orderId/events', async (c) => {
  const userId = c.get('userId')
  const user = c.get('user')
  const orderId = c.req.param('orderId')

  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      ...(user.type !== 'admin' ? { OR: [{ buyerId: userId }, { sellerId: userId }] } : {}),
    },
  })
  if (!order) return err(c, 'Order not found', 404)

  const events = await prisma.escrowEvent.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
  })
  return ok(c, events)
})

escrow.post('/orders/:orderId/dispute',
  zValidator('json', disputeSchema),
  async (c) => {
    const userId = c.get('userId')
    const orderId = c.req.param('orderId')
    const { reason } = c.req.valid('json')

    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        orderStatus: 'PAID_ESCROWED' as any,
        OR: [{ buyerId: userId }, { sellerId: userId }],
      },
    })
    if (!order) return err(c, 'Order not found or cannot be disputed', 404)

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { orderStatus: 'DISPUTED' as any },
      })
      await tx.escrowEvent.create({
        data: {
          orderId,
          eventType: 'DISPUTED' as any,
          amount: order.amount,
          actorId: userId,
          note: reason,
        },
      })
    })

    return ok(c, null)
  }
)

escrow.post('/orders/:orderId/release', adminOnly, requireRole(), async (c) => { // real money movement — SUPER_ADMIN only
  const adminId = c.get('userId')
  const orderId = c.req.param('orderId')

  const order = await prisma.order.findFirst({
    where: { id: orderId, orderStatus: 'DISPUTED' as any },
  })
  if (!order) return err(c, 'Order not found or not in dispute', 404)

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: { orderStatus: 'COMPLETED' as any, paymentStatus: 'RELEASED' as any },
    })
    await tx.payment.update({ where: { orderId }, data: { status: 'RELEASED' as any } })
    await tx.escrowEvent.create({
      data: {
        orderId,
        eventType: 'ADMIN_DECISION' as any,
        amount: order.amount,
        actorId: adminId,
        note: 'Admin released to seller',
      },
    })
  })

  await notificationQueue.add('escrow-admin-decision', {
    userId: order.sellerId,
    type: 'ESCROW_RELEASED',
    orderId,
  })

  return ok(c, null)
})

escrow.post('/orders/:orderId/refund', adminOnly, requireRole(), async (c) => { // real money movement — SUPER_ADMIN only
  const adminId = c.get('userId')
  const orderId = c.req.param('orderId')

  const order = await prisma.order.findFirst({
    where: { id: orderId, orderStatus: 'DISPUTED' as any },
  })
  if (!order) return err(c, 'Order not found or not in dispute', 404)

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: { orderStatus: 'REFUNDED' as any, paymentStatus: 'REFUNDED' as any },
    })
    await tx.payment.update({ where: { orderId }, data: { status: 'REFUNDED' as any } })
    await setOrderListingsStatus(tx, order, 'ACTIVE')
    await tx.escrowEvent.create({
      data: {
        orderId,
        eventType: 'REFUNDED' as any,
        amount: order.amount,
        actorId: adminId,
        note: 'Admin refunded to buyer',
      },
    })
  })

  await notificationQueue.add('escrow-refunded', {
    userId: order.buyerId,
    type: 'ESCROW_REFUNDED',
    orderId,
  })

  return ok(c, null)
})

export { escrow as escrowRoutes }
