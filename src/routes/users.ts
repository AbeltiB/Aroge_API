import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import type { AuthVariables } from '../middleware/auth.js'

const users = new Hono<{ Variables: AuthVariables }>()

users.use('*', authMiddleware)

users.get('/me', async (c) => {
  const userId = c.get('userId')
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, telegramId: true, name: true, avatarUrl: true,
      city: true, subCity: true, verified: true, createdAt: true,
    },
  })
  if (!user) return err(c, 'User not found', 404)
  return ok(c, user)
})

users.patch('/me',
  zValidator('json', z.object({
    name: z.string().min(1).max(80).optional(),
    city: z.string().optional(),
    subCity: z.string().optional(),
    expoPushToken: z.string().optional(),
  })),
  async (c) => {
    const userId = c.get('userId')
    const body = c.req.valid('json')
    const user = await prisma.user.update({
      where: { id: userId },
      data: body,
    })
    return ok(c, user)
  }
)

users.post('/:id/follow', async (c) => {
  const followerId = c.get('userId')
  const followedId = c.req.param('id')
  if (followerId === followedId) return err(c, 'Cannot follow yourself', 400)

  await prisma.follow.upsert({
    where: { followerId_followedId: { followerId, followedId } },
    update: {},
    create: { followerId, followedId },
  })
  return ok(c, null)
})

users.delete('/:id/follow', async (c) => {
  const followerId = c.get('userId')
  const followedId = c.req.param('id')
  await prisma.follow.deleteMany({ where: { followerId, followedId } })
  return ok(c, null)
})

users.post('/:id/block', async (c) => {
  const blockerId = c.get('userId')
  const blockedId = c.req.param('id')
  if (blockerId === blockedId) return err(c, 'Cannot block yourself', 400)

  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    update: {},
    create: { blockerId, blockedId },
  })
  return ok(c, null)
})

users.delete('/:id/block', async (c) => {
  const blockerId = c.get('userId')
  const blockedId = c.req.param('id')
  await prisma.block.deleteMany({ where: { blockerId, blockedId } })
  return ok(c, null)
})

users.get('/:id/profile', async (c) => {
  const viewerId = c.get('userId')
  const id = c.req.param('id')

  const user = await prisma.user.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true, name: true, avatarUrl: true, city: true, subCity: true,
      verified: true, isTrusted: true, createdAt: true,
      businesses: { where: { verifiedAt: { not: null } }, select: { id: true, name: true } },
      _count: { select: { listings: { where: { deletedAt: null, status: 'ACTIVE' as any } }, followers: true } },
    },
  })
  if (!user) return err(c, 'User not found', 404)

  const [ratingAgg, isFollowing, isBlocked] = await Promise.all([
    prisma.review.aggregate({
      where: { revieweeId: id, revealedAt: { not: null } },
      _avg: { rating: true },
      _count: true,
    }),
    prisma.follow.findUnique({
      where: { followerId_followedId: { followerId: viewerId, followedId: id } },
    }),
    prisma.block.findUnique({
      where: { blockerId_blockedId: { blockerId: viewerId, blockedId: id } },
    }),
  ])

  return ok(c, {
    id: user.id,
    name: user.name,
    avatarUrl: user.avatarUrl,
    city: user.city,
    subCity: user.subCity,
    verified: user.verified,
    isTrusted: user.isTrusted,
    memberSince: user.createdAt,
    business: user.businesses[0] ?? null,
    activeListingCount: user._count.listings,
    followerCount: user._count.followers,
    isFollowing: !!isFollowing,
    isBlocked: !!isBlocked,
    rating: { average: ratingAgg._avg.rating ?? 0, count: ratingAgg._count },
  })
})

users.get('/:id/listings', async (c) => {
  const sellerId = c.req.param('id')
  const listings = await prisma.listing.findMany({
    where: { sellerId, deletedAt: null, status: { not: 'ARCHIVED' } },
    include: { photos: { where: { isPrimary: true }, take: 1 }, category: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  return ok(c, listings)
})

// ─── Holiday Mode ─────────────────────────────────────────────────────────────

users.get('/me/holiday-mode', async (c) => {
  const userId = c.get('userId')
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { holidayMode: true, holidayModeCount: true, holidayModeAt: true },
  })
  if (!user) return err(c, 'User not found', 404)
  return ok(c, user)
})

users.patch('/me/holiday-mode',
  zValidator('json', z.object({ enabled: z.boolean(), note: z.string().max(200).optional() })),
  async (c) => {
    const userId = c.get('userId')
    const { enabled, note } = c.req.valid('json')

    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { holidayMode: true, holidayModeCount: true },
    })
    if (!current) return err(c, 'User not found', 404)

    // No-op if already in the requested state
    if (current.holidayMode === enabled) {
      return ok(c, { holidayMode: enabled, holidayModeCount: current.holidayModeCount, holidayModeAt: null })
    }

    const [user] = await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          holidayMode: enabled,
          holidayModeAt: enabled ? new Date() : null,
          holidayModeCount: enabled ? { increment: 1 } : undefined,
        },
        select: { holidayMode: true, holidayModeCount: true, holidayModeAt: true },
      }),
      prisma.holidayModeLog.create({
        data: { userId, action: enabled ? 'ON' : 'OFF', note },
      }),
    ])

    return ok(c, user)
  }
)

users.get('/me/holiday-mode/logs', async (c) => {
  const userId = c.get('userId')
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(50, Number(c.req.query('limit')) || 20)
  const skip = (page - 1) * limit

  const [items, total] = await Promise.all([
    prisma.holidayModeLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip, take: limit,
    }),
    prisma.holidayModeLog.count({ where: { userId } }),
  ])
  return ok(c, { items, total, page, limit })
})

export { users as userRoutes }
