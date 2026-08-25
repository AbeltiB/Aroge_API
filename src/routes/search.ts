import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'
import { ok } from '../lib/response.js'

const search = new Hono()

search.get('/', async (c) => {
  const query = c.req.query()
  const q = query.q ?? ''
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(50, Number(query.limit) || 20)
  const skip = (page - 1) * limit

  const where: any = {
    deletedAt: null,
    status: 'ACTIVE',
    seller: { holidayMode: false },
  }

  if (q) {
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ]
  }

  if (query.categoryId) where.categoryId = query.categoryId
  if (query.city) where.city = query.city
  if (query.condition) where.condition = query.condition
  if (query.minPrice || query.maxPrice) {
    where.price = {}
    if (query.minPrice) where.price.gte = Number(query.minPrice)
    if (query.maxPrice) where.price.lte = Number(query.maxPrice)
  }
  if (query.negotiable === 'true') where.negotiable = true
  if (query.sellerType === 'business') where.businessId = { not: null }
  if (query.sellerType === 'individual') where.businessId = null

  const orderBy: any =
    query.sort === 'price_asc' ? { price: 'asc' }
    : query.sort === 'price_desc' ? { price: 'desc' }
    : { createdAt: 'desc' }

  const [items, total] = await Promise.all([
    prisma.listing.findMany({
      where,
      include: {
        photos: { where: { isPrimary: true }, take: 1 },
        category: true,
        seller: { select: { id: true, name: true, avatarUrl: true, verified: true, isTrusted: true } },
      },
      orderBy,
      skip,
      take: limit,
    }),
    prisma.listing.count({ where }),
  ])

  return ok(c, { items, total, page, limit, pages: Math.ceil(total / limit) })
})

export { search as searchRoutes }
