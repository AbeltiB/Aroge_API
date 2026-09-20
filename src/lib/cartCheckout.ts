import { prisma } from './prisma.js'
import { createOrderFromListing, OrderCreationError } from './orderCreation.js'

interface CheckoutCartParams {
  buyerId: string
  // Omit to check out the entire cart.
  listingIds?: string[]
  deliveryMethod: 'AROGE_DELIVERY' | 'MEETUP'
  paymentMethod: 'TELEBIRR' | 'CBE_BIRR' | 'BANK_TRANSFER'
  dropoffAddress?: string
}

interface CheckoutFailure {
  sellerId: string
  listingIds: string[]
  reason: string
}

interface CartLineItem {
  listingId: string
  sellerId: string
  title: string
  price: number
}

/**
 * Groups the buyer's (selected) cart items by seller and places one order
 * per seller — a single listing orders directly, 2+ listings from the same
 * seller get bundled on the fly (Bundle{source: CART_CHECKOUT}) first, since
 * createOrderFromListing already fully supports ordering a Bundle. Both
 * branches call createOrderFromListing completely unchanged.
 *
 * Partial success is expected, not an error: each seller group is
 * independent, so one seller's listing going stale doesn't block the rest
 * of the checkout. Only successfully-ordered listings are removed from the
 * cart — failed ones stay so the buyer can retry or drop them.
 */
export async function checkoutCart(params: CheckoutCartParams) {
  const { buyerId, listingIds, deliveryMethod, paymentMethod, dropoffAddress } = params
  // No pickupAddress override here (unlike orders.ts's single-item flow) —
  // a cart checkout can span several sellers with different pickup
  // locations, so one buyer-supplied address can't correctly apply to all
  // of them. Each order falls back to its own seller's city/subCity, the
  // same default createOrderFromListing already uses when none is given.

  const cartItems = await prisma.cartItem.findMany({
    where: {
      buyerId,
      ...(listingIds ? { listingId: { in: listingIds } } : {}),
    },
    include: { listing: true },
  })

  const validItems: CartLineItem[] = []
  const failures: CheckoutFailure[] = []

  // Re-validate against the listing's current state, not just its presence
  // in the cart — mirrors the checks in routes/orders.ts's POST / handler
  // (a listing can go stale between being added to the cart and checkout).
  for (const item of cartItems) {
    const listing = item.listing
    if (listing.deletedAt || listing.status !== 'ACTIVE') {
      failures.push({ sellerId: listing.sellerId, listingIds: [item.listingId], reason: 'Listing is no longer available' })
      continue
    }
    if (listing.sellerId === buyerId) {
      failures.push({ sellerId: listing.sellerId, listingIds: [item.listingId], reason: 'Cannot order your own listing' })
      continue
    }
    validItems.push({ listingId: listing.id, sellerId: listing.sellerId, title: listing.title, price: listing.price })
  }

  const bySeller = new Map<string, CartLineItem[]>()
  for (const item of validItems) {
    const group = bySeller.get(item.sellerId)
    if (group) group.push(item)
    else bySeller.set(item.sellerId, [item])
  }

  const orders: Awaited<ReturnType<typeof createOrderFromListing>>['order'][] = []

  for (const [sellerId, items] of bySeller) {
    try {
      let result: Awaited<ReturnType<typeof createOrderFromListing>>

      if (items.length === 1) {
        const item = items[0]
        result = await createOrderFromListing({
          buyerId, sellerId, listingId: item.listingId, title: item.title, amount: item.price,
          deliveryMethod, paymentMethod, dropoffAddress,
        })
      } else {
        const totalPrice = items.reduce((sum, i) => sum + i.price, 0)
        const bundle = await prisma.bundle.create({
          data: {
            sellerId,
            price: totalPrice,
            source: 'CART_CHECKOUT' as any,
            items: { create: items.map((i) => ({ listingId: i.listingId })) },
          },
        })

        try {
          result = await createOrderFromListing({
            buyerId, sellerId, bundleId: bundle.id, title: `Bundle (${items.length} items)`, amount: totalPrice,
            deliveryMethod, paymentMethod, dropoffAddress,
          })
        } catch (e) {
          // Best-effort cleanup so a failed checkout doesn't leave an
          // orphan bundle behind — BundleItem rows must go first, there's
          // no cascade delete on that FK.
          await prisma.bundleItem.deleteMany({ where: { bundleId: bundle.id } }).catch(() => {})
          await prisma.bundle.delete({ where: { id: bundle.id } }).catch(() => {})
          throw e
        }
      }

      orders.push(result.order)
      await prisma.cartItem.deleteMany({
        where: { buyerId, listingId: { in: items.map((i) => i.listingId) } },
      })
    } catch (e) {
      const reason = e instanceof OrderCreationError ? e.message : 'Could not complete this order'
      failures.push({ sellerId, listingIds: items.map((i) => i.listingId), reason })
    }
  }

  return { orders, failures }
}
