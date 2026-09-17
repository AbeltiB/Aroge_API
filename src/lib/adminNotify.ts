import { prisma } from './prisma.js'

interface AdminNotifyOptions {
  type: string
  title: string
  body: string
  relatedType?: string
  relatedId?: string
}

/** Creates a global admin-facing notification — see the schema comment on
 *  AdminNotification for why this is global rather than per-recipient. */
async function adminNotify(opts: AdminNotifyOptions): Promise<void> {
  await prisma.adminNotification.create({
    data: {
      type: opts.type,
      title: opts.title,
      body: opts.body,
      relatedType: opts.relatedType,
      relatedId: opts.relatedId,
    },
  })
}

export const ADMIN_NOTIFY = {
  disputeOpened: (orderId: string, amount: number) =>
    adminNotify({
      type: 'DISPUTE_OPENED', title: 'New dispute opened',
      body: `Order for ETB ${amount.toLocaleString()} was disputed — needs review.`,
      relatedType: 'order', relatedId: orderId,
    }),

  reportFiled: (reportId: string, targetType: string, reason: string) =>
    adminNotify({
      type: 'REPORT_FILED', title: `New ${targetType.toLowerCase()} report`,
      body: reason.length > 100 ? `${reason.slice(0, 97)}...` : reason,
      relatedType: 'report', relatedId: reportId,
    }),

  paymentProofUploaded: (paymentId: string, orderId: string) =>
    adminNotify({
      type: 'PAYMENT_PROOF_UPLOADED', title: 'Payment proof submitted',
      body: 'A buyer uploaded a bank transfer screenshot for manual review.',
      relatedType: 'order', relatedId: orderId ?? paymentId,
    }),

  deliveryRequested: (deliveryId: string, orderId: string) =>
    adminNotify({
      type: 'DELIVERY_REQUESTED', title: 'Aroge Delivery requested',
      body: 'A buyer requested courier delivery — needs approval.',
      relatedType: 'order', relatedId: orderId,
    }),

  businessRegistered: (businessId: string, name: string) =>
    adminNotify({
      type: 'BUSINESS_REGISTERED', title: 'New business registered',
      body: `"${name}" signed up as a business seller — pending verification.`,
      relatedType: 'business', relatedId: businessId,
    }),
}
