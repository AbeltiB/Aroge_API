import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'
import { listingsIndex } from '../lib/meilisearch.js'
import { ok } from '../lib/response.js'

const search = new Hono()

function escapeFilterValue(value: string): string {
  return value.replace(/"/g, '\\"')
}

search.get('/', async (c) => {
  const query = c.req.query()
  const q = query.q ?? ''
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(50, Number(query.limit) || 20)
  const offset = (page - 1) * limit

  const filters: string[] = []
  if (query.categoryId) filters.push(`categoryId = "${escapeFilterValue(query.categoryId)}"`)
  if (query.city) filters.push(`city = "${escapeFilterValue(query.city)}"`)
  if (query.condition) filters.push(`condition = "${escapeFilterValue(query.condition)}"`)
  if (query.minPrice) filters.push(`price >= ${Number(query.minPrice)}`)
  if (query.maxPrice) filters.push(`price <= ${Number(query.maxPrice)}`)
  if (query.negotiable === 'true') filters.push('negotiable = true')
  if (query.sellerType === 'business') filters.push('isBusiness = true')
  if (query.sellerType === 'individual') filters.push('isBusiness = false')

  const sort =
    query.sort === 'price_asc' ? ['price:asc']
    : query.sort === 'price_desc' ? ['price:desc']
    : ['createdAt:desc']

  const results = await listingsIndex.search(q, {
    filter: filters.length ? filters.join(' AND ') : undefined,
    sort,
    offset,
    limit,
  })

  const hitIds = results.hits.map((hit) => hit.id as string)

  const rows = hitIds.length
    ? await prisma.listing.findMany({
        where: {
          id: { in: hitIds },
          deletedAt: null,
          status: 'ACTIVE',
          seller: { holidayMode: false },
        },
        include: {
          photos: { where: { isPrimary: true }, take: 1 },
          category: true,
          seller: { select: { id: true, name: true, avatarUrl: true, verified: true, isTrusted: true } },
        },
      })
    : []

  // The index is eventually-consistent with Postgres (see lib/searchSync.ts)
  // — this re-applies the real business rules (active, not deleted, seller
  // not on holiday) and drops anything the index hasn't caught up on yet,
  // then restores Meilisearch's rank order (findMany with `id: { in }`
  // doesn't preserve input order).
  const byId = new Map(rows.map((row) => [row.id, row]))
  const items = hitIds.map((id) => byId.get(id)).filter((row) => row !== undefined)

  const total = results.estimatedTotalHits
  return ok(c, { items, total, page, limit, pages: Math.ceil(total / limit) })
})

export { search as searchRoutes }
