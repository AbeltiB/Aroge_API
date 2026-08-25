import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import type { AuthVariables } from '../middleware/auth.js'

const reviews = new Hono<{ Variables: AuthVariables }>()

reviews.use('*', authMiddleware)

const reviewSchema = z.object({
  orderId: z.string().uuid(),
  revieweeId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
})

reviews.post('/', zValidator('json', reviewSchema), async (c) => {
  const reviewerId = c.get('userId')
  const body = c.req.valid('json')

  const order = await prisma.order.findFirst({
    where: {
      id: body.orderId,
      orderStatus: 'COMPLETED' as any,
      OR: [{ buyerId: reviewerId }, { sellerId: reviewerId }],
    },
  })
  if (!order) return err(c, 'Completed order not found', 404)

  const existing = await prisma.review.findFirst({
    where: { orderId: body.orderId, reviewerId },
  })
  if (existing) return err(c, 'Review already submitted', 409)

  const review = await prisma.review.create({
    data: {
      orderId: body.orderId,
      reviewerId,
      revieweeId: body.revieweeId,
      rating: body.rating,
      comment: body.comment,
    },
  })

  const bothReviewed = await prisma.review.count({ where: { orderId: body.orderId } })
  if (bothReviewed >= 2) {
    await prisma.review.updateMany({
      where: { orderId: body.orderId },
      data: { revealedAt: new Date() },
    })
  }

  return ok(c, review)
})

reviews.get('/orders/:orderId', async (c) => {
  const userId = c.get('userId')
  const orderId = c.req.param('orderId')

  const order = await prisma.order.findFirst({
    where: { id: orderId, OR: [{ buyerId: userId }, { sellerId: userId }] },
  })
  if (!order) return err(c, 'Order not found', 404)

  const items = await prisma.review.findMany({
    where: { orderId, revealedAt: { not: null } },
    include: { reviewer: { select: { id: true, name: true, avatarUrl: true } } },
  })
  return ok(c, items)
})

reviews.get('/users/:userId', async (c) => {
  const userId = c.req.param('userId')
  const items = await prisma.review.findMany({
    where: { revieweeId: userId, revealedAt: { not: null } },
    include: { reviewer: { select: { id: true, name: true, avatarUrl: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return ok(c, items)
})

export { reviews as reviewRoutes }
