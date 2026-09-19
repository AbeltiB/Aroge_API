import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma.js'
import { signAccessToken } from '../src/lib/jwt.js'
import { AdminRole } from '@arogenpm/sdk'

export async function createUser(overrides: Partial<{ name: string; telegramId: string }> = {}) {
  return prisma.user.create({
    data: {
      telegramId: overrides.telegramId ?? `tg_${randomUUID()}`,
      name: overrides.name ?? 'Test User',
    },
  })
}

export async function createAdmin(role: AdminRole = AdminRole.SUPER_ADMIN, overrides: Partial<{ name: string; telegramId: string }> = {}) {
  return prisma.adminUser.create({
    data: {
      telegramId: overrides.telegramId ?? `tg_admin_${randomUUID()}`,
      name: overrides.name ?? 'Test Admin',
      role,
    },
  })
}

export async function createCategory(overrides: Partial<{ nameEn: string; nameAm: string; slug: string }> = {}) {
  const slug = overrides.slug ?? `category-${randomUUID()}`
  return prisma.category.create({
    data: {
      nameEn: overrides.nameEn ?? 'Test Category',
      nameAm: overrides.nameAm ?? 'ሙከራ',
      slug,
    },
  })
}

export async function createListing(sellerId: string, categoryId: string, overrides: Partial<{
  title: string; description: string; price: number; condition: 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR' | 'POOR'; status: string
}> = {}) {
  return prisma.listing.create({
    data: {
      sellerId,
      categoryId,
      title: overrides.title ?? 'Test Listing',
      description: overrides.description ?? 'A listing created for tests',
      price: overrides.price ?? 1000,
      condition: (overrides.condition ?? 'GOOD') as any,
      status: (overrides.status ?? 'ACTIVE') as any,
    },
  })
}

interface CreateOrderOverrides {
  amount?: number
  deliveryFee?: number
  serviceFee?: number
  deliveryMethod?: 'AROGE_DELIVERY' | 'MEETUP'
  paymentMethod?: 'TELEBIRR' | 'CBE_BIRR' | 'BANK_TRANSFER'
  orderStatus?: string
  paymentStatus?: string
  paymentIsHeld?: boolean
}

// Creates an Order + its Payment directly (bypassing lib/orderCreation.ts)
// so escrow/dispute/release/refund tests can start from an arbitrary state
// (e.g. already DISPUTED) without re-driving the whole checkout flow.
export async function createOrder(
  buyerId: string,
  sellerId: string,
  listingId: string | null,
  overrides: CreateOrderOverrides = {}
) {
  const amount = overrides.amount ?? 1000
  const idempotencyKey = randomUUID()

  const order = await prisma.order.create({
    data: {
      listingId,
      buyerId,
      sellerId,
      amount,
      deliveryFee: overrides.deliveryFee ?? 0,
      serviceFee: overrides.serviceFee ?? 0,
      deliveryMethod: (overrides.deliveryMethod ?? 'MEETUP') as any,
      paymentMethod: (overrides.paymentMethod ?? 'TELEBIRR') as any,
      orderStatus: (overrides.orderStatus ?? 'PENDING_PAYMENT') as any,
      paymentStatus: (overrides.paymentStatus ?? 'PENDING') as any,
      idempotencyKey,
    },
  })

  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      gateway: (overrides.paymentMethod ?? 'TELEBIRR') as any,
      amount,
      idempotencyKey: `payment-${idempotencyKey}`,
      status: (overrides.paymentStatus ?? 'PENDING') as any,
    },
  })

  return { order, payment }
}

export async function userToken(userId: string, telegramId?: string) {
  return signAccessToken({ sub: userId, telegramId, type: 'user' })
}

export async function adminToken(adminId: string, role: AdminRole, telegramId: string) {
  return signAccessToken({ sub: adminId, telegramId, role, type: 'admin' })
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` }
}
