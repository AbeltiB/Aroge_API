/**
 * An order is fulfilled from either a single listing OR a bundle (mutually
 * exclusive — see createOrderSchema's refine). Whenever an order's status
 * change needs to reflect onto the underlying listing(s) — reserved on
 * payment, sold on completion, reverted to active on refund — route through
 * this helper so both paths stay in sync in one place.
 */
export async function setOrderListingsStatus(
  tx: any,
  order: { listingId: string | null; bundleId: string | null },
  status: 'ACTIVE' | 'RESERVED' | 'SOLD'
): Promise<void> {
  if (order.listingId) {
    await tx.listing.update({ where: { id: order.listingId }, data: { status } })
    return
  }

  if (order.bundleId) {
    const items = await tx.bundleItem.findMany({
      where: { bundleId: order.bundleId },
      select: { listingId: true },
    })
    if (items.length > 0) {
      await tx.listing.updateMany({
        where: { id: { in: items.map((i: { listingId: string }) => i.listingId) } },
        data: { status },
      })
    }
    await tx.bundle.update({ where: { id: order.bundleId }, data: { status } })
  }
}
