import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import { sessionReconciliationQueue } from '../lib/queue.js'
import { ensureListingItemCode } from '../lib/liveItemCode.js'
import {
  createLiveSessionSchema,
  updateLiveSessionStatusSchema,
  createLiveItemSchema,
} from '@arogenpm/sdk'
import type { AuthVariables } from '../middleware/auth.js'

const liveSessions = new Hono<{ Variables: AuthVariables }>()

liveSessions.use('*', authMiddleware)

async function requireOwnedSession(sellerId: string, id: string) {
  return prisma.liveSession.findFirst({ where: { id, sellerId } })
}

liveSessions.post('/', zValidator('json', createLiveSessionSchema), async (c) => {
  const sellerId = c.get('userId')
  const { claimWindowMinutes } = c.req.valid('json')

  const session = await prisma.liveSession.create({
    data: {
      sellerId,
      slug: randomUUID().slice(0, 8),
      ...(claimWindowMinutes ? { claimWindowMinutes } : {}),
    },
  })
  return ok(c, session)
})

liveSessions.get('/mine', async (c) => {
  const sellerId = c.get('userId')
  const sessions = await prisma.liveSession.findMany({
    where: { sellerId },
    orderBy: { createdAt: 'desc' },
  })
  return ok(c, sessions)
})

liveSessions.get('/:id', async (c) => {
  const sellerId = c.get('userId')
  const session = await requireOwnedSession(sellerId, c.req.param('id'))
  if (!session) return err(c, 'Live session not found', 404)
  return ok(c, session)
})

liveSessions.patch('/:id/status', zValidator('json', updateLiveSessionStatusSchema), async (c) => {
  const sellerId = c.get('userId')
  const id = c.req.param('id')
  const { status } = c.req.valid('json')

  const existing = await requireOwnedSession(sellerId, id)
  if (!existing) return err(c, 'Live session not found', 404)

  const session = await prisma.liveSession.update({
    where: { id },
    data: {
      status: status as any,
      ...(status === 'LIVE' && !existing.startedAt ? { startedAt: new Date() } : {}),
      ...(status === 'ENDED' ? { endedAt: new Date() } : {}),
    },
  })

  if (status === 'ENDED') {
    await sessionReconciliationQueue.add('reconcile', { liveSessionId: id }, { jobId: `reconcile-${id}` })
  }

  return ok(c, session)
})

liveSessions.post('/:id/items', zValidator('json', createLiveItemSchema), async (c) => {
  const sellerId = c.get('userId')
  const liveSessionId = c.req.param('id')
  const { listingId, code, priceOverride } = c.req.valid('json')

  const session = await requireOwnedSession(sellerId, liveSessionId)
  if (!session) return err(c, 'Live session not found', 404)

  const listing = await prisma.listing.findFirst({ where: { id: listingId, sellerId, deletedAt: null } })
  if (!listing) return err(c, 'Listing not found', 404)

  await ensureListingItemCode(listingId)

  try {
    const item = await prisma.liveItem.create({
      data: {
        liveSessionId,
        listingId,
        code: code.toUpperCase(),
        stockAtStart: 1,
        priceOverride,
      },
    })
    return ok(c, item)
  } catch (e: any) {
    if (e.code === 'P2002') return err(c, 'That code is already used in this session', 409)
    throw e
  }
})

liveSessions.get('/:id/items', async (c) => {
  const sellerId = c.get('userId')
  const liveSessionId = c.req.param('id')
  const session = await requireOwnedSession(sellerId, liveSessionId)
  if (!session) return err(c, 'Live session not found', 404)

  const items = await prisma.liveItem.findMany({
    where: { liveSessionId },
    include: { listing: { select: { id: true, title: true, price: true } } },
  })
  return ok(c, items)
})

liveSessions.patch('/:id/items/:itemId/reveal', async (c) => {
  const sellerId = c.get('userId')
  const liveSessionId = c.req.param('id')
  const session = await requireOwnedSession(sellerId, liveSessionId)
  if (!session) return err(c, 'Live session not found', 404)

  const item = await prisma.liveItem.findFirst({ where: { id: c.req.param('itemId'), liveSessionId } })
  if (!item) return err(c, 'Item not found', 404)

  const updated = await prisma.liveItem.update({ where: { id: item.id }, data: { revealed: true } })
  return ok(c, updated)
})

liveSessions.get('/:id/queue', async (c) => {
  const sellerId = c.get('userId')
  const liveSessionId = c.req.param('id')
  const session = await requireOwnedSession(sellerId, liveSessionId)
  if (!session) return err(c, 'Live session not found', 404)

  const claims = await prisma.claim.findMany({
    where: { liveSessionId },
    include: { liveItem: { include: { listing: { select: { id: true, title: true } } } } },
    orderBy: { createdAt: 'desc' },
  })

  const grouped = {
    claimed: claims.filter((cl) => cl.status === 'CLAIMED'),
    waitlisted: claims.filter((cl) => cl.status === 'WAITLISTED'),
    converted: claims.filter((cl) => cl.status === 'CONVERTED'),
    expired: claims.filter((cl) => cl.status === 'EXPIRED'),
    cancelled: claims.filter((cl) => cl.status === 'CANCELLED'),
  }
  return ok(c, grouped)
})

liveSessions.get('/:id/summary', async (c) => {
  const sellerId = c.get('userId')
  const liveSessionId = c.req.param('id')
  const session = await requireOwnedSession(sellerId, liveSessionId)
  if (!session) return err(c, 'Live session not found', 404)

  // Fresh cached summary (written by the session-reconciliation worker job
  // when the session ends) — fall back to computing it inline so the
  // endpoint still works for a session that hasn't been reconciled yet.
  if (session.summary && session.summaryComputedAt) {
    return ok(c, session.summary)
  }

  const orders = await prisma.order.findMany({
    where: { liveSessionId },
    include: { payment: true, listing: { select: { id: true, title: true } } },
  })

  const ordersCount = orders.length
  const revenue = orders.reduce((sum, o) => sum + o.amount, 0)
  const paid = orders.filter((o) => o.payment?.status === 'HELD' || o.payment?.status === 'RELEASED').reduce((sum, o) => sum + o.amount, 0)
  const outstanding = revenue - paid

  const salesByListing = new Map<string, { listingId: string; title: string; unitsSold: number }>()
  for (const o of orders) {
    if (!o.listing) continue
    const existing = salesByListing.get(o.listing.id)
    if (existing) existing.unitsSold += 1
    else salesByListing.set(o.listing.id, { listingId: o.listing.id, title: o.listing.title, unitsSold: 1 })
  }
  const bestSellers = [...salesByListing.values()].sort((a, b) => b.unitsSold - a.unitsSold).slice(0, 5)

  const summary = { ordersCount, revenue, paid, outstanding, itemsSold: ordersCount, bestSellers }
  return ok(c, summary)
})

export { liveSessions as liveSessionRoutes }
