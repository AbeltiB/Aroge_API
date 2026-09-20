import { prisma } from './prisma.js'
import { notificationQueue, deliveryQueue } from './queue.js'
import { setOrderListingsStatus } from './orderListings.js'
import { enqueueSearchSync } from './searchSync.js'

/**
 * Transitions a PENDING payment to HELD and its order to PAID_ESCROWED.
 * Shared by the webhook handler (Telebirr/CBE Birr) and the admin bank-transfer
 * verification endpoint — same escrow state machine either way.
 */
export async function markPaymentHeld(
  payment: { id: string; orderId: string; amount: number; gatewayRef: string | null },
  note: string,
  actorId: string | null = null
): Promise<void> {
  let affectedListingIds: string[] = []

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'HELD' as any },
    })
    await tx.order.update({
      where: { id: payment.orderId },
      data: { orderStatus: 'PAID_ESCROWED' as any, paymentStatus: 'HELD' as any },
    })
    await tx.escrowEvent.create({
      data: {
        orderId: payment.orderId,
        eventType: 'HELD' as any,
        amount: payment.amount,
        actorId,
        note,
      },
    })
    const order = await tx.order.findUnique({ where: { id: payment.orderId } })
    if (order) {
      affectedListingIds = await setOrderListingsStatus(tx, order, 'RESERVED')
    }
  })

  for (const listingId of affectedListingIds) void enqueueSearchSync(listingId)

  const order = await prisma.order.findUnique({ where: { id: payment.orderId } })
  if (order) {
    await notificationQueue.add('payment-confirmed', {
      userId: order.sellerId,
      type: 'ESCROW_HELD',
      orderId: order.id,
    })
    if (order.deliveryMethod === 'AROGE_DELIVERY') {
      await deliveryQueue.add('request-delivery', { orderId: order.id })
    }
  }
}
