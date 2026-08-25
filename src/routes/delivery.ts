import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { notificationQueue } from '../lib/queue.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminOnly } from '../middleware/adminOnly.js'
import { requireRole } from '../middleware/requireRole.js'
import { AdminRole } from 'aroge-sdk'
import type { AuthVariables } from '../middleware/auth.js'

const delivery = new Hono<{ Variables: AuthVariables }>()

// ─── Public ──────────────────────────────────────────────────────────────────

delivery.get('/settings', async (c) => {
  const settings = await prisma.deliverySettings.findUnique({ where: { id: 'default' } })
  return ok(c, settings ?? { id: 'default', isEnabled: false, fee: 0 })
})

// ─── Protected (buyer/seller) ─────────────────────────────────────────────────

delivery.use('*', authMiddleware)

delivery.get('/orders/:orderId', async (c) => {
  const userId = c.get('userId')
  const orderId = c.req.param('orderId')

  const order = await prisma.order.findFirst({
    where: { id: orderId, OR: [{ buyerId: userId }, { sellerId: userId }] },
  })
  if (!order) return err(c, 'Order not found', 404)

  const item = await prisma.delivery.findUnique({ where: { orderId } })
  if (!item) return err(c, 'No delivery for this order', 404)

  return ok(c, item)
})

// ─── Admin ────────────────────────────────────────────────────────────────────

const adminDelivery = new Hono<{ Variables: AuthVariables }>()
adminDelivery.use('*', authMiddleware, adminOnly)

const settingsSchema = z.object({
  isEnabled: z.boolean().optional(),
  fee: z.number().nonnegative().optional(),
})

adminDelivery.patch('/settings',
  requireRole(), // platform-wide delivery fee config — SUPER_ADMIN only
  zValidator('json', settingsSchema),
  async (c) => {
    const body = c.req.valid('json')
    const settings = await prisma.deliverySettings.upsert({
      where: { id: 'default' },
      update: body,
      create: { id: 'default', isEnabled: body.isEnabled ?? false, fee: body.fee ?? 0 },
    })
    return ok(c, settings)
  }
)

adminDelivery.get('/pending', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Number(c.req.query('limit')) || 30)
  const skip = (page - 1) * limit

  const [items, total] = await Promise.all([
    prisma.delivery.findMany({
      where: { status: 'PENDING_APPROVAL' as any },
      include: {
        order: {
          include: {
            listing: { select: { id: true, title: true } },
            buyer: { select: { id: true, name: true } },
            seller: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      skip,
      take: limit,
    }),
    prisma.delivery.count({ where: { status: 'PENDING_APPROVAL' as any } }),
  ])
  return ok(c, { items, total, page, limit })
})

adminDelivery.post('/:deliveryId/approve', requireRole(AdminRole.MODERATOR), async (c) => {
  const adminId = c.get('userId')
  const deliveryId = c.req.param('deliveryId')

  const item = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    include: { order: true },
  })
  if (!item) return err(c, 'Delivery not found', 404)
  if (item.status !== 'PENDING_APPROVAL') return err(c, 'Not awaiting approval', 409)

  const updated = await prisma.delivery.update({
    where: { id: deliveryId },
    data: {
      status: 'REQUESTED' as any,
      approvedById: adminId,
      approvedAt: new Date(),
    },
  })

  await notificationQueue.add('delivery-approved', {
    userId: item.order.buyerId,
    type: 'DELIVERY_APPROVED',
    orderId: item.orderId,
  })

  return ok(c, updated)
})

adminDelivery.post('/:deliveryId/reject',
  requireRole(AdminRole.MODERATOR),
  zValidator('json', z.object({ reason: z.string().min(1) })),
  async (c) => {
    const adminId = c.get('userId')
    const deliveryId = c.req.param('deliveryId')
    const { reason } = c.req.valid('json')

    const item = await prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { order: true },
    })
    if (!item) return err(c, 'Delivery not found', 404)
    if (item.status !== 'PENDING_APPROVAL') return err(c, 'Not awaiting approval', 409)

    await prisma.$transaction(async (tx) => {
      await tx.delivery.update({
        where: { id: deliveryId },
        data: { status: 'REJECTED' as any, rejectedReason: reason },
      })
      // Revert order delivery fee and switch to meetup
      await tx.order.update({
        where: { id: item.orderId },
        data: {
          deliveryMethod: 'MEETUP' as any,
          deliveryFee: 0,
        },
      })
    })

    await notificationQueue.add('delivery-rejected', {
      userId: item.order.buyerId,
      type: 'DELIVERY_REJECTED',
      orderId: item.orderId,
      reason,
    })

    return ok(c, null)
  }
)

delivery.route('/admin', adminDelivery)

export { delivery as deliveryRoutes }
