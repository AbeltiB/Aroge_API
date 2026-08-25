import { prisma } from './prisma.js'
import { notificationQueue } from './queue.js'

interface NotifyOptions {
  userId: string
  type: string
  title: string
  body: string
  data?: Record<string, unknown>
  channel?: string
  isPopup?: boolean
  expiresAt?: Date
  broadcastId?: string
}

/**
 * Create an in-app Notification record and enqueue a push delivery job.
 * The push worker only sends Expo push — it does NOT write another DB record.
 */
export async function notify(opts: NotifyOptions): Promise<void> {
  await prisma.notification.create({
    data: {
      userId: opts.userId,
      type: opts.type,
      channel: opts.channel ?? 'IN_APP',
      title: opts.title,
      body: opts.body,
      data: opts.data ?? {},
      isPopup: opts.isPopup ?? false,
      expiresAt: opts.expiresAt,
      broadcastId: opts.broadcastId,
    },
  })

  if (!opts.isPopup) {
    await notificationQueue.add('push', {
      userId: opts.userId,
      type: opts.type,
      title: opts.title,
      body: opts.body,
      data: opts.data,
    }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } })
  }
}

export const NOTIFY = {
  // Order events
  orderPlaced: (sellerId: string, listingTitle: string, orderId: string) =>
    notify({ userId: sellerId, type: 'ORDER_PLACED', title: 'New Order!', body: `Someone ordered your listing: ${listingTitle}`, data: { orderId } }),

  paymentSuccess: (buyerId: string, listingTitle: string, orderId: string) =>
    notify({ userId: buyerId, type: 'PAYMENT_SUCCESS', title: 'Payment Confirmed', body: `Your payment for "${listingTitle}" is held in escrow.`, data: { orderId } }),

  paymentFailed: (buyerId: string, listingTitle: string, orderId: string) =>
    notify({ userId: buyerId, type: 'PAYMENT_FAILED', title: 'Payment Failed', body: `Payment for "${listingTitle}" could not be processed.`, data: { orderId } }),

  escrowReleased: (sellerId: string, amount: number, orderId: string) =>
    notify({ userId: sellerId, type: 'ESCROW_RELEASED', title: 'Payment Released!', body: `ETB ${amount.toLocaleString()} has been released to you.`, data: { orderId } }),

  escrowAutoReleased: (sellerId: string, amount: number, orderId: string) =>
    notify({ userId: sellerId, type: 'AUTO_RELEASED', title: 'Payment Auto-Released', body: `ETB ${amount.toLocaleString()} was auto-released after 7 days.`, data: { orderId } }),

  escrowRefunded: (buyerId: string, amount: number, orderId: string) =>
    notify({ userId: buyerId, type: 'ESCROW_REFUNDED', title: 'Refund Processed', body: `ETB ${amount.toLocaleString()} has been refunded to you.`, data: { orderId } }),

  disputeOpened: (userId: string, orderId: string) =>
    notify({ userId, type: 'DISPUTE_OPENED', title: 'Dispute Opened', body: 'A dispute has been opened on your order. Our team will review within 24 hours.', data: { orderId } }),

  adminDecision: (userId: string, decision: string, orderId: string) =>
    notify({ userId, type: 'ADMIN_DECISION', title: 'Dispute Resolved', body: `Admin decision: ${decision}`, data: { orderId } }),

  orderCompleted: (userId: string, orderId: string) =>
    notify({ userId, type: 'ORDER_COMPLETED', title: 'Order Complete', body: 'Your order has been completed successfully.', data: { orderId } }),

  // Offer events
  offerReceived: (sellerId: string, amount: number, listingTitle: string, offerId: string) =>
    notify({ userId: sellerId, type: 'OFFER_RECEIVED', title: 'New Offer', body: `ETB ${amount.toLocaleString()} offer on "${listingTitle}"`, data: { offerId } }),

  offerAccepted: (buyerId: string, listingTitle: string, offerId: string) =>
    notify({ userId: buyerId, type: 'OFFER_ACCEPTED', title: 'Offer Accepted!', body: `Your offer on "${listingTitle}" was accepted. Proceed to checkout.`, data: { offerId } }),

  offerRejected: (buyerId: string, listingTitle: string, offerId: string) =>
    notify({ userId: buyerId, type: 'OFFER_REJECTED', title: 'Offer Rejected', body: `Your offer on "${listingTitle}" was not accepted.`, data: { offerId } }),

  offerCountered: (buyerId: string, listingTitle: string, offerId: string) =>
    notify({ userId: buyerId, type: 'OFFER_COUNTERED', title: 'Counter Offer', body: `You received a counter offer on "${listingTitle}"`, data: { offerId } }),

  // Delivery events
  deliveryApproved: (buyerId: string, orderId: string) =>
    notify({ userId: buyerId, type: 'DELIVERY_APPROVED', title: 'Delivery Approved', body: 'Your delivery request has been approved. We will arrange pickup shortly.', data: { orderId } }),

  deliveryRejected: (buyerId: string, reason: string, orderId: string) =>
    notify({ userId: buyerId, type: 'DELIVERY_REJECTED', title: 'Delivery Request Declined', body: `Reason: ${reason}. Your order will proceed as a meet-up.`, data: { orderId } }),

  // Message events
  newMessage: (receiverId: string, senderName: string, body: string, listingId: string) =>
    notify({
      userId: receiverId, type: 'NEW_MESSAGE', title: senderName,
      body: body.length > 100 ? `${body.slice(0, 97)}...` : body,
      data: { listingId },
    }),

  // Badge events
  trustedBadgeGranted: (userId: string) =>
    notify({
      userId, type: 'BADGE_GRANTED', title: 'You earned the Aroge Trusted Badge!',
      body: "You've been recognised as a trusted community member. The አ badge is now on your profile.",
      isPopup: true,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }),
}
