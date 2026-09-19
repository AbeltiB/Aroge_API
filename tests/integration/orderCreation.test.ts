import { describe, it, expect } from 'vitest'
import { prisma } from '../../src/lib/prisma.js'
import { createOrderFromListing, OrderCreationError } from '../../src/lib/orderCreation.js'
import { createUser, createCategory, createListing } from '../factories.js'

describe('createOrderFromListing', () => {
  it('creates an order with no delivery fee for a MEETUP order and no active fees', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id, { price: 500 })

    const result = await createOrderFromListing({
      buyerId: buyer.id,
      sellerId: seller.id,
      listingId: listing.id,
      title: listing.title,
      amount: 500,
      deliveryMethod: 'MEETUP',
      paymentMethod: 'TELEBIRR',
    })

    expect(result.order.amount).toBe(500)
    expect(result.order.deliveryFee).toBe(0)
    expect(result.order.serviceFee).toBe(0)
    expect(result.totalAmount).toBe(500)
    expect(result.delivery).toBeNull()
    expect(result.order.orderStatus).toBe('PENDING_PAYMENT')

    const payment = await prisma.payment.findUnique({ where: { orderId: result.order.id } })
    expect(payment?.amount).toBe(500)
    expect(payment?.status).toBe('PENDING')
    // MockPaymentGateway.initiateCharge always succeeds synchronously.
    expect(payment?.gatewayRef).toBe(`mock_${result.idempotencyKey}`)
  })

  it('applies active percentage and flat platform fees to the total', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id, { price: 1000 })

    await prisma.platformFee.createMany({
      data: [
        { name: '5% service fee', type: 'PERCENTAGE', value: 5, visibleTo: 'BUYER', isActive: true, displayOrder: 1 },
        { name: 'Flat handling fee', type: 'FLAT', value: 20, visibleTo: 'BOTH', isActive: true, displayOrder: 2 },
        { name: 'Inactive fee (should be ignored)', type: 'FLAT', value: 999, visibleTo: 'BUYER', isActive: false, displayOrder: 3 },
        { name: 'Seller-only fee (should be ignored for buyer total)', type: 'FLAT', value: 50, visibleTo: 'SELLER', isActive: true, displayOrder: 4 },
      ],
    })

    const result = await createOrderFromListing({
      buyerId: buyer.id,
      sellerId: seller.id,
      listingId: listing.id,
      title: listing.title,
      amount: 1000,
      deliveryMethod: 'MEETUP',
      paymentMethod: 'TELEBIRR',
    })

    // 1000 * 5% = 50, + 20 flat = 70 service fee. Inactive/seller-only fees excluded.
    expect(result.order.serviceFee).toBe(70)
    expect(result.totalAmount).toBe(1070)
    expect(result.feeSnapshot).toHaveLength(2)
  })

  it('rejects AROGE_DELIVERY when delivery service is disabled', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id)

    await expect(createOrderFromListing({
      buyerId: buyer.id,
      sellerId: seller.id,
      listingId: listing.id,
      title: listing.title,
      amount: 500,
      deliveryMethod: 'AROGE_DELIVERY',
      paymentMethod: 'TELEBIRR',
      dropoffAddress: 'Bole, Addis Ababa',
    })).rejects.toThrow(OrderCreationError)
  })

  it('adds the delivery fee and creates a Delivery row when AROGE_DELIVERY is enabled', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id, { price: 500 })

    await prisma.deliverySettings.create({ data: { id: 'default', isEnabled: true, fee: 100 } })

    const result = await createOrderFromListing({
      buyerId: buyer.id,
      sellerId: seller.id,
      listingId: listing.id,
      title: listing.title,
      amount: 500,
      deliveryMethod: 'AROGE_DELIVERY',
      paymentMethod: 'TELEBIRR',
      dropoffAddress: 'Bole, Addis Ababa',
    })

    expect(result.order.deliveryFee).toBe(100)
    expect(result.totalAmount).toBe(600)
    expect(result.delivery).not.toBeNull()
    expect(result.delivery?.status).toBe('PENDING_APPROVAL')
    expect(result.delivery?.dropoffAddress).toBe('Bole, Addis Ababa')
  })

  it('skips the gateway charge and leaves gatewayRef null when skipGatewayCharge is set (Aroge Live claims)', async () => {
    const seller = await createUser()
    const buyer = await createUser()
    const category = await createCategory()
    const listing = await createListing(seller.id, category.id, { price: 300 })

    const result = await createOrderFromListing({
      buyerId: buyer.id,
      sellerId: seller.id,
      listingId: listing.id,
      title: listing.title,
      amount: 300,
      deliveryMethod: 'MEETUP',
      paymentMethod: 'TELEBIRR',
      skipGatewayCharge: true,
    })

    expect(result.charge).toEqual({})
    const payment = await prisma.payment.findUnique({ where: { orderId: result.order.id } })
    expect(payment?.gatewayRef).toBeNull()
    expect(payment?.status).toBe('PENDING')
  })
})
