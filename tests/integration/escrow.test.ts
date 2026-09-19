import { describe, it, expect } from 'vitest'
import { AdminRole } from '@arogenpm/sdk'
import { app } from '../../src/app.js'
import { prisma } from '../../src/lib/prisma.js'
import { createUser, createAdmin, createCategory, createListing, createOrder, userToken, adminToken, authHeader } from '../factories.js'

const BASE = 'http://localhost/api/v1/escrow'

describe('POST /escrow/orders/:orderId/dispute', () => {
  it('lets the buyer dispute a PAID_ESCROWED order they are party to', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const { order } = await createOrder(buyer.id, seller.id, listing.id, { orderStatus: 'PAID_ESCROWED', paymentStatus: 'HELD' })
    const token = await userToken(buyer.id, buyer.telegramId)

    const res = await app.fetch(new Request(`${BASE}/orders/${order.id}/dispute`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Item was not as described in the listing.' }),
    }))

    expect(res.status).toBe(200)
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(updated.orderStatus).toBe('DISPUTED')
    const events = await prisma.escrowEvent.findMany({ where: { orderId: order.id } })
    expect(events.map((e) => e.eventType)).toEqual(['DISPUTED'])
  })

  it('rejects a dispute from someone who is not the buyer or seller', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const stranger = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const { order } = await createOrder(buyer.id, seller.id, listing.id, { orderStatus: 'PAID_ESCROWED' })
    const token = await userToken(stranger.id, stranger.telegramId)

    const res = await app.fetch(new Request(`${BASE}/orders/${order.id}/dispute`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Trying to dispute an order I am not part of.' }),
    }))

    expect(res.status).toBe(404)
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(updated.orderStatus).toBe('PAID_ESCROWED')
  })

  it('rejects disputing an order that is not PAID_ESCROWED', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const { order } = await createOrder(buyer.id, seller.id, listing.id, { orderStatus: 'PENDING_PAYMENT' })
    const token = await userToken(buyer.id, buyer.telegramId)

    const res = await app.fetch(new Request(`${BASE}/orders/${order.id}/dispute`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'This order was never even paid for yet.' }),
    }))

    expect(res.status).toBe(404)
  })

  it('rejects a dispute reason shorter than 10 characters', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const { order } = await createOrder(buyer.id, seller.id, listing.id, { orderStatus: 'PAID_ESCROWED' })
    const token = await userToken(buyer.id, buyer.telegramId)

    const res = await app.fetch(new Request(`${BASE}/orders/${order.id}/dispute`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'too short' }),
    }))

    expect(res.status).toBe(400)
  })

  it('requires authentication', async () => {
    const res = await app.fetch(new Request(`${BASE}/orders/nonexistent/dispute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'No auth header on this request at all.' }),
    }))
    expect(res.status).toBe(401)
  })
})

describe('POST /escrow/orders/:orderId/release', () => {
  it('lets a SUPER_ADMIN release a DISPUTED order to the seller', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const { order, payment } = await createOrder(buyer.id, seller.id, listing.id, { orderStatus: 'DISPUTED', paymentStatus: 'HELD' })
    const admin = await createAdmin(AdminRole.SUPER_ADMIN)
    const token = await adminToken(admin.id, AdminRole.SUPER_ADMIN, admin.telegramId)

    const res = await app.fetch(new Request(`${BASE}/orders/${order.id}/release`, {
      method: 'POST',
      headers: authHeader(token),
    }))

    expect(res.status).toBe(200)
    const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    const updatedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })
    expect(updatedOrder.orderStatus).toBe('COMPLETED')
    expect(updatedOrder.paymentStatus).toBe('RELEASED')
    expect(updatedPayment.status).toBe('RELEASED')
  })

  it('rejects release from a MODERATOR (not SUPER_ADMIN — real money movement)', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const { order } = await createOrder(buyer.id, seller.id, listing.id, { orderStatus: 'DISPUTED' })
    const admin = await createAdmin(AdminRole.MODERATOR)
    const token = await adminToken(admin.id, AdminRole.MODERATOR, admin.telegramId)

    const res = await app.fetch(new Request(`${BASE}/orders/${order.id}/release`, {
      method: 'POST',
      headers: authHeader(token),
    }))

    expect(res.status).toBe(403)
    const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(updatedOrder.orderStatus).toBe('DISPUTED')
  })

  it('rejects release from a regular (non-admin) user token', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const { order } = await createOrder(buyer.id, seller.id, listing.id, { orderStatus: 'DISPUTED' })
    const token = await userToken(buyer.id, buyer.telegramId)

    const res = await app.fetch(new Request(`${BASE}/orders/${order.id}/release`, {
      method: 'POST',
      headers: authHeader(token),
    }))

    expect(res.status).toBe(403)
  })

  it('rejects releasing an order that is not DISPUTED', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const { order } = await createOrder(buyer.id, seller.id, listing.id, { orderStatus: 'PAID_ESCROWED' })
    const admin = await createAdmin(AdminRole.SUPER_ADMIN)
    const token = await adminToken(admin.id, AdminRole.SUPER_ADMIN, admin.telegramId)

    const res = await app.fetch(new Request(`${BASE}/orders/${order.id}/release`, {
      method: 'POST',
      headers: authHeader(token),
    }))

    expect(res.status).toBe(404)
  })
})

describe('POST /escrow/orders/:orderId/refund', () => {
  it('lets a SUPER_ADMIN refund a DISPUTED order and reactivates the listing', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id, { status: 'RESERVED' })
    const { order, payment } = await createOrder(buyer.id, seller.id, listing.id, { orderStatus: 'DISPUTED', paymentStatus: 'HELD' })
    const admin = await createAdmin(AdminRole.SUPER_ADMIN)
    const token = await adminToken(admin.id, AdminRole.SUPER_ADMIN, admin.telegramId)

    const res = await app.fetch(new Request(`${BASE}/orders/${order.id}/refund`, {
      method: 'POST',
      headers: authHeader(token),
    }))

    expect(res.status).toBe(200)
    const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    const updatedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })
    const updatedListing = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(updatedOrder.orderStatus).toBe('REFUNDED')
    expect(updatedOrder.paymentStatus).toBe('REFUNDED')
    expect(updatedPayment.status).toBe('REFUNDED')
    expect(updatedListing.status).toBe('ACTIVE')
  })

  it('cannot double-refund an already-refunded order', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const { order } = await createOrder(buyer.id, seller.id, listing.id, { orderStatus: 'REFUNDED', paymentStatus: 'REFUNDED' })
    const admin = await createAdmin(AdminRole.SUPER_ADMIN)
    const token = await adminToken(admin.id, AdminRole.SUPER_ADMIN, admin.telegramId)

    const res = await app.fetch(new Request(`${BASE}/orders/${order.id}/refund`, {
      method: 'POST',
      headers: authHeader(token),
    }))

    expect(res.status).toBe(404)
  })
})

describe('GET /escrow/orders/:orderId/events', () => {
  it('lets an uninvolved admin view escrow events for any order', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const { order } = await createOrder(buyer.id, seller.id, listing.id, { orderStatus: 'DISPUTED' })
    await prisma.escrowEvent.create({ data: { orderId: order.id, eventType: 'DISPUTED', amount: order.amount, actorId: buyer.id } })
    const admin = await createAdmin(AdminRole.MODERATOR)
    const token = await adminToken(admin.id, AdminRole.MODERATOR, admin.telegramId)

    const res = await app.fetch(new Request(`${BASE}/orders/${order.id}/events`, { headers: authHeader(token) }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
  })

  it('hides events for a non-admin who is not buyer or seller on the order', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const stranger = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const { order } = await createOrder(buyer.id, seller.id, listing.id)
    const token = await userToken(stranger.id, stranger.telegramId)

    const res = await app.fetch(new Request(`${BASE}/orders/${order.id}/events`, { headers: authHeader(token) }))
    expect(res.status).toBe(404)
  })
})
