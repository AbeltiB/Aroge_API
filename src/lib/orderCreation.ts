import { randomUUID } from 'node:crypto'
import { prisma } from './prisma.js'
import { NOTIFY } from './notify.js'
import { ADMIN_NOTIFY } from './adminNotify.js'
import { getPaymentGateway } from './payments/registry.js'

interface CreateOrderFromListingParams {
  buyerId: string
  sellerId: string
  listingId?: string | null
  bundleId?: string | null
  title: string
  amount: number
  deliveryMethod: 'AROGE_DELIVERY' | 'MEETUP'
  paymentMethod: 'TELEBIRR' | 'CBE_BIRR' | 'BANK_TRANSFER'
  pickupAddress?: string
  dropoffAddress?: string
  source?: 'MARKETPLACE' | 'LIVE'
  liveSessionId?: string
  // A live-sale buyer pays the seller directly (Telebirr/CBE) out of band —
  // there's no real checkout to redirect to, so skip pretending one exists.
  // Payment is still created PENDING; staff flip it to HELD manually later.
  skipGatewayCharge?: boolean
}

// Extracted from the original inline logic in routes/orders.ts's POST / handler
// so both the marketplace checkout route and Aroge Live's claim-conversion
// route share one path — resolving the listing/bundle/offer and the
// buyer-isn't-the-seller check stay in each caller, since they differ per call site.
export async function createOrderFromListing(params: CreateOrderFromListingParams) {
  const {
    buyerId, sellerId, listingId = null, bundleId = null, title, amount,
    deliveryMethod, paymentMethod, pickupAddress, dropoffAddress,
    source = 'MARKETPLACE', liveSessionId, skipGatewayCharge = false,
  } = params

  let deliveryFee = 0
  if (deliveryMethod === 'AROGE_DELIVERY') {
    const deliverySettings = await prisma.deliverySettings.findUnique({ where: { id: 'default' } })
    if (!deliverySettings?.isEnabled) throw new OrderCreationError('Delivery service is not currently available')
    deliveryFee = deliverySettings.fee
  }

  const activeFees = await prisma.platformFee.findMany({
    where: { isActive: true, visibleTo: { in: ['BUYER', 'BOTH'] } },
    orderBy: { displayOrder: 'asc' },
  })

  const feeSnapshot = activeFees.map((fee) => ({
    feeId: fee.id,
    name: fee.name,
    type: fee.type,
    value: fee.value,
    amount:
      fee.type === 'PERCENTAGE'
        ? Math.round(amount * (fee.value / 100) * 100) / 100
        : fee.value,
  }))

  const serviceFee = feeSnapshot.reduce((sum, f) => sum + f.amount, 0)
  const totalAmount = amount + deliveryFee + serviceFee

  const idempotencyKey = randomUUID()

  const order = await prisma.order.create({
    data: {
      listingId,
      bundleId,
      buyerId,
      sellerId,
      amount,
      deliveryFee,
      serviceFee,
      feeSnapshot,
      deliveryMethod: deliveryMethod as any,
      paymentMethod: paymentMethod as any,
      idempotencyKey,
      source: source as any,
      liveSessionId: liveSessionId ?? null,
    },
  })

  let delivery = null
  if (deliveryMethod === 'AROGE_DELIVERY') {
    const seller = await prisma.user.findUnique({
      where: { id: sellerId },
      select: { city: true, subCity: true },
    })
    const resolvedPickupAddress =
      pickupAddress?.trim() ||
      [seller?.subCity, seller?.city].filter(Boolean).join(', ') ||
      ''

    delivery = await prisma.delivery.create({
      data: {
        orderId: order.id,
        fee: deliveryFee,
        status: 'PENDING_APPROVAL' as any,
        pickupAddress: resolvedPickupAddress,
        dropoffAddress: dropoffAddress!.trim(),
      },
    })
    void ADMIN_NOTIFY.deliveryRequested(delivery.id, order.id)
  }

  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      gateway: paymentMethod as any,
      amount: totalAmount,
      idempotencyKey,
    },
  })

  let charge: { gatewayRef?: string; checkoutUrl?: string } = {}
  if (!skipGatewayCharge) {
    const gateway = getPaymentGateway(paymentMethod as any)
    charge = await gateway.initiateCharge({
      orderId: order.id,
      paymentId: payment.id,
      amount: totalAmount,
      idempotencyKey,
    })

    if (charge.gatewayRef) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { gatewayRef: charge.gatewayRef },
      })
    }
  }

  void NOTIFY.orderPlaced(sellerId, title, order.id)

  return { order, feeSnapshot, totalAmount, delivery, payment, charge, idempotencyKey }
}

export class OrderCreationError extends Error {}
