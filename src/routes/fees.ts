import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'
import { ok } from '../lib/response.js'

const fees = new Hono()

// Public: returns active fees filtered by viewer role
fees.get('/', async (c) => {
  const role = c.req.query('role') // 'buyer' | 'seller'
  const where: any = { isActive: true }
  if (role === 'buyer') where.visibleTo = { in: ['BUYER', 'BOTH'] }
  else if (role === 'seller') where.visibleTo = { in: ['SELLER', 'BOTH'] }

  const items = await prisma.platformFee.findMany({
    where,
    orderBy: { displayOrder: 'asc' },
    select: { id: true, name: true, type: true, value: true, visibleTo: true, displayOrder: true },
  })
  return ok(c, items)
})

export { fees as feeRoutes }
