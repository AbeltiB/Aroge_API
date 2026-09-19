import { describe, it, expect } from 'vitest'
import { prisma } from '../../src/lib/prisma.js'
import { markPaymentHeld } from '../../src/lib/markPaymentHeld.js'
import { createUser, createCategory, createListing, createOrder } from '../factories.js'

describe('markPaymentHeld', () => {
  it('transitions payment PENDING -> HELD and order -> PAID_ESCROWED, and reserves the listing', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id, { status: 'ACTIVE' })
    const { order, payment } = await createOrder(buyer.id, seller.id, listing.id, { amount: 500 })

    await markPaymentHeld(payment, 'test confirmation')

    const updatedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })
    const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    const updatedListing = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })

    expect(updatedPayment.status).toBe('HELD')
    expect(updatedOrder.orderStatus).toBe('PAID_ESCROWED')
    expect(updatedOrder.paymentStatus).toBe('HELD')
    expect(updatedListing.status).toBe('RESERVED')
  })

  it('records a HELD EscrowEvent with the order amount', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const { order, payment } = await createOrder(buyer.id, seller.id, listing.id, { amount: 750 })

    await markPaymentHeld(payment, 'test confirmation', seller.id)

    const events = await prisma.escrowEvent.findMany({ where: { orderId: order.id } })
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe('HELD')
    expect(events[0].amount).toBe(750)
    expect(events[0].actorId).toBe(seller.id)
    expect(events[0].note).toBe('test confirmation')
  })

  it('enqueues a delivery-request job only for AROGE_DELIVERY orders', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)
    const { payment } = await createOrder(buyer.id, seller.id, listing.id, { deliveryMethod: 'MEETUP' })

    await markPaymentHeld(payment, 'test confirmation')

    const { deliveryQueue } = await import('../../src/lib/queue.js')
    const waiting = await deliveryQueue.getJobs(['waiting', 'delayed'])
    expect(waiting).toHaveLength(0)
  })
})
