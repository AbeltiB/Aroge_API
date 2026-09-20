import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prisma } from '../../src/lib/prisma.js'
import { createUser, createCategory, createListing } from '../factories.js'

const searchMock = vi.fn()

vi.mock('../../src/lib/meilisearch.js', () => ({
  listingsIndex: { search: (...args: unknown[]) => searchMock(...args) },
}))

// Imported after the mock so app.ts's route registration picks up the
// mocked lib/meilisearch.js instead of constructing a real client.
const { app } = await import('../../src/app.js')

const BASE = 'http://localhost/api/v1/search'

describe('GET /search', () => {
  beforeEach(() => {
    searchMock.mockReset()
  })

  it('hydrates hits from Postgres and preserves Meilisearch\'s rank order', async () => {
    const seller = await createUser()
    const category = await createCategory()
    const listingA = await createListing(seller.id, category.id, { title: 'A' })
    const listingB = await createListing(seller.id, category.id, { title: 'B' })

    // Rank order deliberately reversed from creation order.
    searchMock.mockResolvedValue({
      hits: [{ id: listingB.id }, { id: listingA.id }],
      estimatedTotalHits: 2,
    })

    const res = await app.fetch(new Request(`${BASE}?q=widget`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.items.map((i: { id: string }) => i.id)).toEqual([listingB.id, listingA.id])
    expect(body.data.total).toBe(2)
  })

  it('drops a hit that is no longer ACTIVE in Postgres (stale index)', async () => {
    const seller = await createUser()
    const category = await createCategory()
    const soldListing = await createListing(seller.id, category.id, { status: 'SOLD' })

    searchMock.mockResolvedValue({
      hits: [{ id: soldListing.id }],
      estimatedTotalHits: 1,
    })

    const res = await app.fetch(new Request(`${BASE}?q=widget`))
    const body = await res.json()
    expect(body.data.items).toEqual([])
  })

  it('drops a hit belonging to a seller currently in holiday mode', async () => {
    const seller = await createUser()
    await prisma.user.update({ where: { id: seller.id }, data: { holidayMode: true } })
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)

    searchMock.mockResolvedValue({ hits: [{ id: listing.id }], estimatedTotalHits: 1 })

    const res = await app.fetch(new Request(`${BASE}?q=widget`))
    const body = await res.json()
    expect(body.data.items).toEqual([])
  })

  it('returns no items and skips the Postgres query when there are no hits', async () => {
    searchMock.mockResolvedValue({ hits: [], estimatedTotalHits: 0 })

    const res = await app.fetch(new Request(`${BASE}?q=nonexistent`))
    const body = await res.json()
    expect(body.data.items).toEqual([])
    expect(body.data.total).toBe(0)
  })

  it('builds a Meilisearch filter expression from query params', async () => {
    searchMock.mockResolvedValue({ hits: [], estimatedTotalHits: 0 })

    await app.fetch(new Request(
      `${BASE}?q=phone&categoryId=cat-1&city=Addis+Ababa&condition=GOOD&minPrice=100&maxPrice=500&negotiable=true&sellerType=business&sort=price_asc`
    ))

    expect(searchMock).toHaveBeenCalledWith('phone', expect.objectContaining({
      filter: 'categoryId = "cat-1" AND city = "Addis Ababa" AND condition = "GOOD" AND price >= 100 AND price <= 500 AND negotiable = true AND isBusiness = true',
      sort: ['price:asc'],
    }))
  })

  it('defaults to sorting by newest first', async () => {
    searchMock.mockResolvedValue({ hits: [], estimatedTotalHits: 0 })

    await app.fetch(new Request(`${BASE}`))

    expect(searchMock).toHaveBeenCalledWith('', expect.objectContaining({ sort: ['createdAt:desc'] }))
  })
})
