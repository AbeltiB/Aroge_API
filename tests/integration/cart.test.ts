// Note: this file may print "Unhandled Rejection" noise from
// notify.ts's fire-and-forget `void NOTIFY.orderPlaced(...)` calls
// occasionally racing the next test's beforeEach truncation (the
// notification write lands just as its target row gets truncated out
// from under it). Harmless — pre-existing fire-and-forget pattern, not a
// cart bug, and confirmed not to affect the suite's exit code.
import { describe, it, expect } from 'vitest'
import { app } from '../../src/app.js'
import { prisma } from '../../src/lib/prisma.js'
import { createUser, createCategory, createListing, createCartItem, userToken, authHeader } from '../factories.js'

const CART_BASE = 'http://localhost/api/v1/cart'
const BUNDLES_BASE = 'http://localhost/api/v1/bundles'

describe('POST /cart', () => {
  it('adds an active listing to the buyer\'s cart', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const token = await userToken(buyer.id, buyer.telegramId)

    const res = await app.fetch(new Request(CART_BASE, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId: listing.id }),
    }))

    expect(res.status).toBe(200)
    const items = await prisma.cartItem.findMany({ where: { buyerId: buyer.id } })
    expect(items).toHaveLength(1)
    expect(items[0].listingId).toBe(listing.id)
  })

  it('is idempotent — adding the same listing twice does not error or duplicate', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const token = await userToken(buyer.id, buyer.telegramId)

    for (let i = 0; i < 2; i++) {
      const res = await app.fetch(new Request(CART_BASE, {
        method: 'POST',
        headers: { ...authHeader(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ listingId: listing.id }),
      }))
      expect(res.status).toBe(200)
    }

    const items = await prisma.cartItem.findMany({ where: { buyerId: buyer.id } })
    expect(items).toHaveLength(1)
  })

  it('rejects adding your own listing', async () => {
    const seller = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const token = await userToken(seller.id, seller.telegramId)

    const res = await app.fetch(new Request(CART_BASE, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId: listing.id }),
    }))

    expect(res.status).toBe(400)
  })

  it('rejects a non-active listing', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id, { status: 'SOLD' })
    const token = await userToken(buyer.id, buyer.telegramId)

    const res = await app.fetch(new Request(CART_BASE, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId: listing.id }),
    }))

    expect(res.status).toBe(404)
  })
})

describe('GET /cart', () => {
  it('lists the buyer\'s cart with hydrated listing data', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id, { title: 'Cart Test Item' })
    await createCartItem(buyer.id, listing.id)
    const token = await userToken(buyer.id, buyer.telegramId)

    const res = await app.fetch(new Request(CART_BASE, { headers: authHeader(token) }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].listing.title).toBe('Cart Test Item')
  })
})

describe('DELETE /cart/:listingId', () => {
  it('removes an item from the cart', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    await createCartItem(buyer.id, listing.id)
    const token = await userToken(buyer.id, buyer.telegramId)

    const res = await app.fetch(new Request(`${CART_BASE}/${listing.id}`, {
      method: 'DELETE', headers: authHeader(token),
    }))
    expect(res.status).toBe(200)
    const items = await prisma.cartItem.findMany({ where: { buyerId: buyer.id } })
    expect(items).toHaveLength(0)
  })
})

describe('POST /cart/checkout', () => {
  it('orders a single item directly (no bundle) when only one item is checked out', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id, { price: 500 })
    await createCartItem(buyer.id, listing.id)
    const token = await userToken(buyer.id, buyer.telegramId)

    const res = await app.fetch(new Request(`${CART_BASE}/checkout`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deliveryMethod: 'MEETUP', paymentMethod: 'TELEBIRR' }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.orders).toHaveLength(1)
    expect(body.data.failures).toHaveLength(0)
    expect(body.data.orders[0].listingId).toBe(listing.id)
    expect(body.data.orders[0].bundleId).toBeNull()

    const remaining = await prisma.cartItem.findMany({ where: { buyerId: buyer.id } })
    expect(remaining).toHaveLength(0)
  })

  it('groups 2+ items from the same seller into one order via a dynamic Bundle', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listingA = await createListing(seller.id, category.id, { price: 300 })
    const listingB = await createListing(seller.id, category.id, { price: 400 })
    await createCartItem(buyer.id, listingA.id)
    await createCartItem(buyer.id, listingB.id)
    const token = await userToken(buyer.id, buyer.telegramId)

    const res = await app.fetch(new Request(`${CART_BASE}/checkout`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deliveryMethod: 'MEETUP', paymentMethod: 'TELEBIRR' }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.orders).toHaveLength(1)
    const order = body.data.orders[0]
    expect(order.listingId).toBeNull()
    expect(order.bundleId).not.toBeNull()
    expect(order.amount).toBe(700)

    const bundle = await prisma.bundle.findUniqueOrThrow({ where: { id: order.bundleId }, include: { items: true } })
    expect(bundle.source).toBe('CART_CHECKOUT')
    expect(bundle.items.map((i) => i.listingId).sort()).toEqual([listingA.id, listingB.id].sort())
  })

  it('creates one order per seller when the cart spans multiple sellers', async () => {
    const sellerA = await createUser()
    const sellerB = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listingA = await createListing(sellerA.id, category.id, { price: 100 })
    const listingB = await createListing(sellerB.id, category.id, { price: 200 })
    await createCartItem(buyer.id, listingA.id)
    await createCartItem(buyer.id, listingB.id)
    const token = await userToken(buyer.id, buyer.telegramId)

    const res = await app.fetch(new Request(`${CART_BASE}/checkout`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deliveryMethod: 'MEETUP', paymentMethod: 'TELEBIRR' }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.orders).toHaveLength(2)
    expect(body.data.orders.map((o: { sellerId: string }) => o.sellerId).sort()).toEqual([sellerA.id, sellerB.id].sort())
  })

  it('partially succeeds when one seller\'s listing went stale, leaving that item in the cart', async () => {
    const sellerA = await createUser()
    const sellerB = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const goodListing = await createListing(sellerA.id, category.id, { price: 100 })
    const staleListing = await createListing(sellerB.id, category.id, { price: 200 })
    await createCartItem(buyer.id, goodListing.id)
    await createCartItem(buyer.id, staleListing.id)
    // Goes stale after being added to the cart.
    await prisma.listing.update({ where: { id: staleListing.id }, data: { status: 'SOLD' } })
    const token = await userToken(buyer.id, buyer.telegramId)

    const res = await app.fetch(new Request(`${CART_BASE}/checkout`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deliveryMethod: 'MEETUP', paymentMethod: 'TELEBIRR' }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.orders).toHaveLength(1)
    expect(body.data.orders[0].listingId).toBe(goodListing.id)
    expect(body.data.failures).toHaveLength(1)
    expect(body.data.failures[0].listingIds).toEqual([staleListing.id])

    const remaining = await prisma.cartItem.findMany({ where: { buyerId: buyer.id } })
    expect(remaining).toHaveLength(1)
    expect(remaining[0].listingId).toBe(staleListing.id)
  })

  it('only checks out the given listingIds when provided, leaving the rest in the cart', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listingA = await createListing(seller.id, category.id, { price: 100 })
    const listingB = await createListing(seller.id, category.id, { price: 200 })
    await createCartItem(buyer.id, listingA.id)
    await createCartItem(buyer.id, listingB.id)
    const token = await userToken(buyer.id, buyer.telegramId)

    const res = await app.fetch(new Request(`${CART_BASE}/checkout`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingIds: [listingA.id], deliveryMethod: 'MEETUP', paymentMethod: 'TELEBIRR' }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.orders).toHaveLength(1)
    expect(body.data.orders[0].listingId).toBe(listingA.id)

    const remaining = await prisma.cartItem.findMany({ where: { buyerId: buyer.id } })
    expect(remaining).toHaveLength(1)
    expect(remaining[0].listingId).toBe(listingB.id)
  })
})

describe('Bundle.source guards against cart-checkout bundles', () => {
  it('excludes CART_CHECKOUT bundles from GET /bundles/mine', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listingA = await createListing(seller.id, category.id, { price: 100 })
    const listingB = await createListing(seller.id, category.id, { price: 200 })
    await createCartItem(buyer.id, listingA.id)
    await createCartItem(buyer.id, listingB.id)
    const buyerToken = await userToken(buyer.id, buyer.telegramId)

    await app.fetch(new Request(`${CART_BASE}/checkout`, {
      method: 'POST',
      headers: { ...authHeader(buyerToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deliveryMethod: 'MEETUP', paymentMethod: 'TELEBIRR' }),
    }))

    const sellerToken = await userToken(seller.id, seller.telegramId)
    const res = await app.fetch(new Request(`${BUNDLES_BASE}/mine`, { headers: authHeader(sellerToken) }))
    const body = await res.json()
    expect(body.data).toHaveLength(0)
  })

  it('rejects DELETE /bundles/:id for a CART_CHECKOUT bundle', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listingA = await createListing(seller.id, category.id, { price: 100 })
    const listingB = await createListing(seller.id, category.id, { price: 200 })
    await createCartItem(buyer.id, listingA.id)
    await createCartItem(buyer.id, listingB.id)
    const buyerToken = await userToken(buyer.id, buyer.telegramId)

    const checkoutRes = await app.fetch(new Request(`${CART_BASE}/checkout`, {
      method: 'POST',
      headers: { ...authHeader(buyerToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deliveryMethod: 'MEETUP', paymentMethod: 'TELEBIRR' }),
    }))
    const checkoutBody = await checkoutRes.json()
    const bundleId = checkoutBody.data.orders[0].bundleId

    const sellerToken = await userToken(seller.id, seller.telegramId)
    const res = await app.fetch(new Request(`${BUNDLES_BASE}/${bundleId}`, {
      method: 'DELETE', headers: authHeader(sellerToken),
    }))
    expect(res.status).toBe(400)
  })
})
