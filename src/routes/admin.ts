import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { broadcastQueue } from '../lib/queue.js'
import { cloudinary } from '../lib/cloudinary.js'
import { ok, err } from '../lib/response.js'
import { notify } from '../lib/notify.js'
import { markPaymentHeld } from '../lib/markPaymentHeld.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminOnly } from '../middleware/adminOnly.js'
import { requireRole } from '../middleware/requireRole.js'
import { AdminRole, bankAccountSchema } from '@arogenpm/sdk'
import type { AuthVariables } from '../middleware/auth.js'

const feeSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(['PERCENTAGE', 'FLAT']),
  value: z.number().positive(),
  visibleTo: z.enum(['BUYER', 'SELLER', 'BOTH']),
  isActive: z.boolean().optional(),
  displayOrder: z.number().int().optional(),
})

const admin = new Hono<{ Variables: AuthVariables }>()

admin.use('*', authMiddleware, adminOnly)

admin.get('/users', async (c) => {
  const query = c.req.query()
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(100, Number(query.limit) || 30)
  const skip = (page - 1) * limit

  const where: any = {}
  if (query.q) {
    where.OR = [
      { name: { contains: query.q, mode: 'insensitive' } },
      { telegramId: { contains: query.q } },
    ]
  }
  if (query.trusted === 'true') where.isTrusted = true

  const select = query.trusted === 'true' ? {
    id: true, name: true, avatarUrl: true, city: true, trustedAt: true, isTrusted: true,
    _count: { select: { buyerOrders: { where: { orderStatus: 'COMPLETED' as any } }, sellerOrders: { where: { orderStatus: 'COMPLETED' as any } } } },
  } : undefined

  const [items, total] = await Promise.all([
    prisma.user.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' }, ...(select ? { select } : {}) }),
    prisma.user.count({ where }),
  ])
  return ok(c, { items, total, page, limit })
})

admin.patch('/users/:id/ban', requireRole(AdminRole.MODERATOR), async (c) => {
  const adminId = c.get('userId')
  const id = c.req.param('id')
  const user = await prisma.user.findUnique({ where: { id } })
  if (!user) return err(c, 'User not found', 404)

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { deletedAt: new Date() } })
    await tx.adminAction.create({
      data: { adminId, actionType: 'BAN_USER', targetType: 'user', targetId: id },
    })
  })
  return ok(c, null)
})

admin.patch('/users/:id/unban', requireRole(AdminRole.MODERATOR), async (c) => {
  const adminId = c.get('userId')
  const id = c.req.param('id')
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { deletedAt: null } })
    await tx.adminAction.create({
      data: { adminId, actionType: 'UNBAN_USER', targetType: 'user', targetId: id },
    })
  })
  return ok(c, null)
})

admin.get('/listings', async (c) => {
  const query = c.req.query()
  const showRemoved = query.removed === 'true'
  const status = (query.status as any) || (showRemoved ? undefined : 'ACTIVE')
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(100, Number(query.limit) || 30)
  const skip = (page - 1) * limit

  const where: any = { deletedAt: showRemoved ? { not: null } : null }
  if (status) where.status = status

  const [items, total] = await Promise.all([
    prisma.listing.findMany({
      where,
      include: { seller: { select: { id: true, name: true } }, photos: { where: { isPrimary: true }, take: 1 } },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.listing.count({ where }),
  ])
  return ok(c, { items, total, page, limit })
})

admin.patch('/listings/:id/remove', requireRole(AdminRole.MODERATOR), async (c) => {
  const adminId = c.get('userId')
  const id = c.req.param('id')
  await prisma.$transaction(async (tx) => {
    await tx.listing.update({ where: { id }, data: { deletedAt: new Date(), status: 'ARCHIVED' as any } })
    await tx.adminAction.create({
      data: { adminId, actionType: 'REMOVE_LISTING', targetType: 'listing', targetId: id },
    })
  })
  return ok(c, null)
})

// ─── Listing Moderation (flag / approve / restore) ──────────────────────────

admin.patch('/listings/:id/flag',
  requireRole(AdminRole.MODERATOR),
  zValidator('json', z.object({ reason: z.string().min(3).max(500).optional() })),
  async (c) => {
    const adminId = c.get('userId')
    const id = c.req.param('id')
    const { reason } = c.req.valid('json')

    const existing = await prisma.listing.findUnique({ where: { id } })
    if (!existing || existing.deletedAt) return err(c, 'Listing not found', 404)
    if (existing.status === 'FLAGGED') return err(c, 'Listing is already flagged', 400)

    await prisma.$transaction(async (tx) => {
      await tx.listing.update({ where: { id }, data: { status: 'FLAGGED' as any } })
      await tx.adminAction.create({
        data: { adminId, actionType: 'FLAG_LISTING', targetType: 'listing', targetId: id, reason },
      })
    })
    return ok(c, null)
  }
)

admin.patch('/listings/:id/approve', requireRole(AdminRole.MODERATOR), async (c) => {
  const adminId = c.get('userId')
  const id = c.req.param('id')

  const existing = await prisma.listing.findUnique({ where: { id } })
  if (!existing) return err(c, 'Listing not found', 404)
  if (existing.status !== 'FLAGGED') return err(c, 'Listing is not currently flagged', 400)

  await prisma.$transaction(async (tx) => {
    await tx.listing.update({ where: { id }, data: { status: 'ACTIVE' as any } })
    await tx.adminAction.create({
      data: { adminId, actionType: 'APPROVE_LISTING', targetType: 'listing', targetId: id },
    })
  })
  return ok(c, null)
})

admin.patch('/listings/:id/restore', requireRole(AdminRole.MODERATOR), async (c) => {
  const adminId = c.get('userId')
  const id = c.req.param('id')

  const existing = await prisma.listing.findUnique({ where: { id } })
  if (!existing) return err(c, 'Listing not found', 404)
  if (existing.status !== 'ARCHIVED' || !existing.deletedAt) {
    return err(c, 'Only removed listings can be restored', 400)
  }

  await prisma.$transaction(async (tx) => {
    await tx.listing.update({ where: { id }, data: { status: 'ACTIVE' as any, deletedAt: null } })
    await tx.adminAction.create({
      data: { adminId, actionType: 'RESTORE_LISTING', targetType: 'listing', targetId: id },
    })
  })
  return ok(c, null)
})

admin.get('/orders', async (c) => {
  const query = c.req.query()
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(100, Number(query.limit) || 30)
  const skip = (page - 1) * limit
  const where: any = {}
  if (query.status) where.orderStatus = query.status

  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        buyer: { select: { id: true, name: true } },
        seller: { select: { id: true, name: true } },
        payment: true,
      },
      skip, take: limit, orderBy: { createdAt: 'desc' },
    }),
    prisma.order.count({ where }),
  ])
  return ok(c, { items, total, page, limit })
})

admin.get('/orders/:id', async (c) => {
  const id = c.req.param('id')
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      buyer: { select: { id: true, name: true, avatarUrl: true, city: true } },
      seller: { select: { id: true, name: true, avatarUrl: true, city: true } },
      listing: { include: { photos: { where: { isPrimary: true }, take: 1 } } },
      bundle: { include: { items: { include: { listing: true } } } },
      payment: true,
      delivery: true,
      escrowEvents: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!order) return err(c, 'Order not found', 404)
  return ok(c, order)
})

// Full buyer↔seller conversation for this order — dispute resolution
// previously only showed escrow events and the written dispute reason, with
// no way to see the actual negotiation/complaint context.
admin.get('/orders/:id/messages', async (c) => {
  const id = c.req.param('id')
  const order = await prisma.order.findUnique({
    where: { id },
    select: { buyerId: true, sellerId: true, listingId: true, bundleId: true },
  })
  if (!order) return err(c, 'Order not found', 404)

  let listingIds: string[]
  if (order.listingId) {
    listingIds = [order.listingId]
  } else if (order.bundleId) {
    const items = await prisma.bundleItem.findMany({
      where: { bundleId: order.bundleId },
      select: { listingId: true },
    })
    listingIds = items.map((i) => i.listingId)
  } else {
    listingIds = []
  }

  if (listingIds.length === 0) return ok(c, [])

  const messages = await prisma.message.findMany({
    where: {
      listingId: { in: listingIds },
      OR: [
        { senderId: order.buyerId, receiverId: order.sellerId },
        { senderId: order.sellerId, receiverId: order.buyerId },
      ],
    },
    include: { sender: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return ok(c, messages)
})

// ─── Payments Ledger ─────────────────────────────────────────────────────────

admin.get('/payments', async (c) => {
  const query = c.req.query()
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(100, Number(query.limit) || 30)
  const skip = (page - 1) * limit

  const where: any = {}
  if (query.status) where.status = query.status
  if (query.gateway) where.gateway = query.gateway

  const [items, total, totals] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        order: {
          select: {
            id: true, amount: true, deliveryFee: true, serviceFee: true,
            orderStatus: true, listingId: true, bundleId: true,
            buyer: { select: { id: true, name: true } },
            seller: { select: { id: true, name: true } },
            listing: { select: { id: true, title: true } },
            bundle: { select: { id: true } },
          },
        },
      },
      skip, take: limit, orderBy: { createdAt: 'desc' },
    }),
    prisma.payment.count({ where }),
    prisma.payment.groupBy({ by: ['status'], _sum: { amount: true }, _count: true }),
  ])
  return ok(c, { items, total, page, limit, totals })
})

// Presigned view of a bank-transfer proof image (never exposed publicly)
admin.get('/payments/:id/proof-url', requireRole(AdminRole.MODERATOR), async (c) => {
  const id = c.req.param('id')
  const payment = await prisma.payment.findUnique({ where: { id }, select: { proofKey: true } })
  if (!payment?.proofKey) return err(c, 'No proof on file', 404)

  const url = cloudinary.utils.private_download_url(payment.proofKey, undefined, {
    type: 'authenticated',
    resource_type: 'image',
    expires_at: Math.floor(Date.now() / 1000) + 5 * 60,
  })
  return ok(c, { url })
})

admin.post('/payments/:id/verify', requireRole(AdminRole.MODERATOR), async (c) => {
  const adminId = c.get('userId')
  const id = c.req.param('id')

  const payment = await prisma.payment.findUnique({ where: { id } })
  if (!payment) return err(c, 'Payment not found', 404)
  if (payment.gateway !== 'BANK_TRANSFER') return err(c, 'Only bank transfer payments need manual verification', 400)
  if (payment.status !== 'PENDING') return err(c, 'This payment is not awaiting verification', 400)
  if (!payment.proofUploadedAt) return err(c, 'Buyer has not uploaded a transfer proof yet', 400)

  await markPaymentHeld(payment, `Bank transfer verified by admin ${adminId}`, adminId)
  await prisma.adminAction.create({
    data: { adminId, actionType: 'VERIFY_BANK_TRANSFER', targetType: 'payment', targetId: id },
  })
  return ok(c, null)
})

admin.post('/payments/:id/reject', requireRole(AdminRole.MODERATOR), async (c) => {
  const adminId = c.get('userId')
  const id = c.req.param('id')

  const payment = await prisma.payment.findUnique({ where: { id } })
  if (!payment) return err(c, 'Payment not found', 404)
  if (payment.gateway !== 'BANK_TRANSFER') return err(c, 'Only bank transfer payments can be rejected here', 400)
  if (payment.status !== 'PENDING') return err(c, 'This payment is not awaiting verification', 400)

  await prisma.payment.update({
    where: { id },
    data: { proofKey: null, proofUploadedAt: null },
  })
  await prisma.adminAction.create({
    data: { adminId, actionType: 'REJECT_BANK_TRANSFER', targetType: 'payment', targetId: id },
  })

  const order = await prisma.order.findUnique({ where: { id: payment.orderId }, select: { buyerId: true } })
  if (order) {
    await notify({
      userId: order.buyerId,
      type: 'PAYMENT_PROOF_REJECTED',
      title: 'Your transfer proof was rejected',
      body: 'We could not verify your bank transfer. Please double-check the amount and upload a clearer proof.',
    })
  }

  return ok(c, null)
})

admin.get('/disputes', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Number(c.req.query('limit')) || 30)
  const skip = (page - 1) * limit

  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where: { orderStatus: 'DISPUTED' as any },
      include: {
        buyer: { select: { id: true, name: true } },
        seller: { select: { id: true, name: true } },
        listing: { select: { id: true, title: true } },
        escrowEvents: { orderBy: { createdAt: 'asc' } },
        payment: true,
      },
      skip, take: limit, orderBy: { updatedAt: 'desc' },
    }),
    prisma.order.count({ where: { orderStatus: 'DISPUTED' as any } }),
  ])
  return ok(c, { items, total, page, limit })
})

admin.get('/businesses', async (c) => {
  const query = c.req.query()
  const unverifiedOnly = query.unverified === 'true'
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(100, Number(query.limit) || 30)
  const skip = (page - 1) * limit

  const where: any = {}
  if (unverifiedOnly) where.verifiedAt = null

  const [items, total] = await Promise.all([
    prisma.business.findMany({
      where,
      include: { rep: { select: { id: true, name: true, telegramId: true } } },
      skip, take: limit, orderBy: { createdAt: 'desc' },
    }),
    prisma.business.count({ where }),
  ])
  return ok(c, { items, total, page, limit })
})

admin.get('/analytics', async (c) => {
  const snapshots = await prisma.analyticsSnapshot.findMany({
    orderBy: { date: 'desc' },
    take: 30,
  })
  const rawTotals = await prisma.$queryRaw<[{ gmv: number; orders: bigint; disputes: bigint }]>`
    SELECT
      COALESCE(SUM(amount), 0) AS gmv,
      COUNT(*) AS orders,
      COUNT(*) FILTER (WHERE order_status = 'DISPUTED') AS disputes
    FROM orders
  `
  const totals = {
    gmv: rawTotals[0].gmv,
    orders: Number(rawTotals[0].orders),
    disputes: Number(rawTotals[0].disputes),
  }
  return ok(c, { snapshots, totals })
})

// ─── Audit Log ───────────────────────────────────────────────────────────────

admin.get('/audit-log', async (c) => {
  const query = c.req.query()
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(100, Number(query.limit) || 30)
  const skip = (page - 1) * limit

  const where: any = {}
  if (query.actionType) where.actionType = query.actionType
  if (query.targetType) where.targetType = query.targetType
  if (query.adminId) where.adminId = query.adminId

  const [items, total] = await Promise.all([
    prisma.adminAction.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { admin: { select: { id: true, name: true, telegramId: true } } },
    }),
    prisma.adminAction.count({ where }),
  ])
  return ok(c, { items, total, page, limit })
})

// ─── Trusted Badge ───────────────────────────────────────────────────────────

admin.get('/badge-criteria', async (c) => {
  const criteria = await prisma.badgeCriteria.findUnique({ where: { id: 'default' } })
  return ok(c, criteria ?? { id: 'default', minSales: 5, minPurchases: 3, requireBoth: false })
})

admin.patch('/badge-criteria',
  requireRole(), // platform policy config — SUPER_ADMIN only
  zValidator('json', z.object({
    minSales: z.number().int().nonnegative().optional(),
    minPurchases: z.number().int().nonnegative().optional(),
    requireBoth: z.boolean().optional(),
  })),
  async (c) => {
    const body = c.req.valid('json')
    const criteria = await prisma.badgeCriteria.upsert({
      where: { id: 'default' },
      update: body,
      create: { id: 'default', minSales: body.minSales ?? 5, minPurchases: body.minPurchases ?? 3, requireBoth: body.requireBoth ?? false },
    })
    return ok(c, criteria)
  }
)

admin.get('/badge-reviews', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Number(c.req.query('limit')) || 30)
  const skip = (page - 1) * limit

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where: { badgePendingReview: true, isTrusted: false, deletedAt: null },
      select: {
        id: true, name: true, avatarUrl: true, city: true, createdAt: true,
        isTrusted: true, badgePendingReview: true,
        _count: {
          select: {
            buyerOrders: { where: { orderStatus: 'COMPLETED' as any } },
            sellerOrders: { where: { orderStatus: 'COMPLETED' as any } },
          },
        },
      },
      skip, take: limit, orderBy: { updatedAt: 'desc' },
    }),
    prisma.user.count({ where: { badgePendingReview: true, isTrusted: false, deletedAt: null } }),
  ])
  return ok(c, { items, total, page, limit })
})

admin.post('/badge-reviews/:userId/grant', requireRole(AdminRole.MODERATOR), async (c) => {
  const adminId = c.get('userId')
  const userId = c.req.param('userId')

  await prisma.user.update({
    where: { id: userId },
    data: { isTrusted: true, trustedAt: new Date(), trustedGrantedBy: adminId, badgePendingReview: false },
  })

  await notify({
    userId, type: 'BADGE_GRANTED',
    title: 'You earned the Aroge Trusted Badge!',
    body: "You've been recognised as a trusted community member. The አ badge is now on your profile.",
    isPopup: true,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  })

  await prisma.adminAction.create({
    data: { adminId, actionType: 'GRANT_BADGE', targetType: 'user', targetId: userId },
  })
  return ok(c, null)
})

admin.post('/badge-reviews/:userId/dismiss', requireRole(AdminRole.MODERATOR), async (c) => {
  const userId = c.req.param('userId')
  await prisma.user.update({ where: { id: userId }, data: { badgePendingReview: false } })
  return ok(c, null)
})

admin.post('/badge-reviews/:userId/revoke', requireRole(AdminRole.MODERATOR), async (c) => {
  const adminId = c.get('userId')
  const userId = c.req.param('userId')
  await prisma.user.update({
    where: { id: userId },
    data: { isTrusted: false, trustedAt: null, trustedGrantedBy: null, badgePendingReview: false },
  })
  await prisma.adminAction.create({
    data: { adminId, actionType: 'REVOKE_BADGE', targetType: 'user', targetId: userId },
  })
  return ok(c, null)
})

// ─── Broadcasts ───────────────────────────────────────────────────────────────

const broadcastSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(500),
  channels: z.array(z.enum(['IN_APP', 'PUSH', 'SMS', 'EMAIL', 'POPUP'])).min(1),
  targetType: z.enum(['ALL', 'BUYERS', 'SELLERS', 'SELECTED']),
  targetIds: z.array(z.string()).optional().default([]),
  isPopup: z.boolean().optional().default(false),
  expiresAt: z.string().optional(),
})

admin.get('/broadcasts', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(50, Number(c.req.query('limit')) || 20)
  const skip = (page - 1) * limit

  const [items, total] = await Promise.all([
    prisma.adminBroadcast.findMany({
      include: { admin: { select: { name: true, telegramId: true } } },
      orderBy: { createdAt: 'desc' },
      skip, take: limit,
    }),
    prisma.adminBroadcast.count(),
  ])
  return ok(c, { items, total, page, limit })
})

admin.post('/broadcasts',
  requireRole(), // mass messaging (cost + reputational risk) — SUPER_ADMIN only
  zValidator('json', broadcastSchema),
  async (c) => {
    const adminId = c.get('userId')
    const body = c.req.valid('json')

    const broadcast = await prisma.adminBroadcast.create({
      data: {
        title: body.title,
        body: body.body,
        channels: body.channels,
        targetType: body.targetType,
        targetIds: body.targetIds,
        isPopup: body.isPopup,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        adminId,
        status: 'QUEUED',
      },
    })

    await broadcastQueue.add('process', { broadcastId: broadcast.id }, { attempts: 2 })
    return ok(c, broadcast)
  }
)

// ─── Holiday Mode ─────────────────────────────────────────────────────────────

admin.get('/holiday-mode', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Number(c.req.query('limit')) || 30)
  const skip = (page - 1) * limit

  const [active, logs, total] = await Promise.all([
    prisma.user.findMany({
      where: { holidayMode: true, deletedAt: null },
      select: {
        id: true, name: true, avatarUrl: true, city: true,
        holidayModeCount: true, holidayModeAt: true,
        _count: { select: { listings: { where: { deletedAt: null, status: 'ACTIVE' as any } } } },
      },
      orderBy: { holidayModeAt: 'desc' },
    }),
    prisma.holidayModeLog.findMany({
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' },
      skip, take: limit,
    }),
    prisma.holidayModeLog.count(),
  ])
  return ok(c, { active, logs, total, page, limit })
})

// Admin can forcibly turn off holiday mode for a seller (e.g. inactive account)
admin.post('/holiday-mode/:userId/disable', requireRole(AdminRole.MODERATOR), async (c) => {
  const adminId = c.get('userId')
  const userId = c.req.param('userId')

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { holidayMode: true } })
  if (!user) return err(c, 'User not found', 404)
  if (!user.holidayMode) return ok(c, null) // already off

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { holidayMode: false, holidayModeAt: null },
    }),
    prisma.holidayModeLog.create({
      data: { userId, action: 'OFF', note: `Disabled by admin ${adminId}` },
    }),
    prisma.adminAction.create({
      data: { adminId, actionType: 'DISABLE_HOLIDAY_MODE', targetType: 'user', targetId: userId },
    }),
  ])
  return ok(c, null)
})

// ─── Platform Fees CRUD ──────────────────────────────────────────────────────

admin.get('/fees', async (c) => {
  const items = await prisma.platformFee.findMany({ orderBy: { displayOrder: 'asc' } })
  return ok(c, items)
})

admin.post('/fees',
  requireRole(), // financial config — SUPER_ADMIN only
  zValidator('json', feeSchema),
  async (c) => {
    const body = c.req.valid('json')
    const fee = await prisma.platformFee.create({ data: body as any })
    return ok(c, fee)
  }
)

admin.patch('/fees/:id',
  requireRole(), // financial config — SUPER_ADMIN only
  zValidator('json', feeSchema.partial()),
  async (c) => {
    const id = c.req.param('id')
    const existing = await prisma.platformFee.findUnique({ where: { id } })
    if (!existing) return err(c, 'Fee not found', 404)
    const fee = await prisma.platformFee.update({ where: { id }, data: c.req.valid('json') as any })
    return ok(c, fee)
  }
)

admin.delete('/fees/:id', requireRole(), async (c) => { // financial config — SUPER_ADMIN only
  const id = c.req.param('id')
  const existing = await prisma.platformFee.findUnique({ where: { id } })
  if (!existing) return err(c, 'Fee not found', 404)
  await prisma.platformFee.delete({ where: { id } })
  return ok(c, null)
})

// ─── Bank Accounts (for BANK_TRANSFER checkout) ─────────────────────────────

admin.get('/bank-accounts', async (c) => {
  const items = await prisma.bankAccount.findMany({ orderBy: { createdAt: 'asc' } })
  return ok(c, items)
})

admin.post('/bank-accounts',
  requireRole(), // financial config — SUPER_ADMIN only
  zValidator('json', bankAccountSchema),
  async (c) => {
    const body = c.req.valid('json')
    const account = await prisma.bankAccount.create({ data: body })
    return ok(c, account)
  }
)

admin.patch('/bank-accounts/:id',
  requireRole(), // financial config — SUPER_ADMIN only
  zValidator('json', bankAccountSchema.partial()),
  async (c) => {
    const id = c.req.param('id')
    const existing = await prisma.bankAccount.findUnique({ where: { id } })
    if (!existing) return err(c, 'Bank account not found', 404)
    const account = await prisma.bankAccount.update({ where: { id }, data: c.req.valid('json') })
    return ok(c, account)
  }
)

admin.delete('/bank-accounts/:id', requireRole(), async (c) => { // financial config — SUPER_ADMIN only
  const id = c.req.param('id')
  const existing = await prisma.bankAccount.findUnique({ where: { id } })
  if (!existing) return err(c, 'Bank account not found', 404)
  await prisma.bankAccount.delete({ where: { id } })
  return ok(c, null)
})

export { admin as adminRoutes }
