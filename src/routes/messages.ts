import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { uploadPublic } from '../lib/storage.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import { NOTIFY } from '../lib/notify.js'
import type { AuthVariables } from '../middleware/auth.js'

const messages = new Hono<{ Variables: AuthVariables }>()

messages.use('*', authMiddleware)

// "general" in the URL means a conversation not tied to any listing (e.g.
// started from a seller's profile) — stored as listingId: null.
const GENERAL = 'general'
function toListingId(param: string): string | null {
  return param === GENERAL ? null : param
}

async function assertCanMessage(senderId: string, receiverId: string, listingId: string | null): Promise<string | null> {
  if (senderId === receiverId) return 'Cannot message yourself'

  if (listingId) {
    const listing = await prisma.listing.findFirst({ where: { id: listingId, deletedAt: null } })
    if (!listing) return 'Listing not found'
  } else {
    const receiver = await prisma.user.findUnique({ where: { id: receiverId } })
    if (!receiver) return 'User not found'
  }

  const blocked = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: senderId, blockedId: receiverId },
        { blockerId: receiverId, blockedId: senderId },
      ],
    },
  })
  if (blocked) return 'You cannot message this user'

  return null
}

messages.get('/', async (c) => {
  const userId = c.get('userId')

  const all = await prisma.message.findMany({
    where: { OR: [{ senderId: userId }, { receiverId: userId }] },
    orderBy: { createdAt: 'desc' },
    include: {
      listing: { select: { id: true, title: true, photos: { where: { isPrimary: true }, take: 1 } } },
      sender: { select: { id: true, name: true, avatarUrl: true } },
      receiver: { select: { id: true, name: true, avatarUrl: true } },
    },
    take: 200,
  })

  const threads = new Map<string, any>()
  for (const m of all) {
    const otherUser = m.senderId === userId ? m.receiver : m.sender
    const key = `${m.listingId}:${otherUser.id}`
    const existing = threads.get(key)
    const isUnread = m.receiverId === userId && m.readAt === null

    if (!existing) {
      threads.set(key, {
        listingId: m.listingId,
        otherUserId: otherUser.id,
        otherUser,
        listing: m.listing,
        lastMessage: { id: m.id, body: m.body, createdAt: m.createdAt, readAt: m.readAt },
        unreadCount: isUnread ? 1 : 0,
      })
    } else if (isUnread) {
      existing.unreadCount += 1
    }
  }

  return ok(c, Array.from(threads.values()).slice(0, 30))
})

messages.get('/:listingId/:userId', async (c) => {
  const myId = c.get('userId')
  const listingId = toListingId(c.req.param('listingId'))
  const otherId = c.req.param('userId')

  const items = await prisma.message.findMany({
    where: {
      listingId,
      OR: [
        { senderId: myId, receiverId: otherId },
        { senderId: otherId, receiverId: myId },
      ],
    },
    orderBy: { createdAt: 'asc' },
  })

  await prisma.message.updateMany({
    where: { listingId, receiverId: myId, senderId: otherId, readAt: null },
    data: { readAt: new Date() },
  })

  return ok(c, items)
})

messages.post('/:listingId/:userId',
  zValidator('json', z.object({ body: z.string().min(1).max(2000) })),
  async (c) => {
    const senderId = c.get('userId')
    const listingId = toListingId(c.req.param('listingId'))
    const receiverId = c.req.param('userId')
    const { body } = c.req.valid('json')

    const denyReason = await assertCanMessage(senderId, receiverId, listingId)
    if (denyReason) return err(c, denyReason, denyReason.endsWith('not found') ? 404 : 400)

    const [message, sender] = await Promise.all([
      prisma.message.create({ data: { listingId, senderId, receiverId, body } }),
      prisma.user.findUnique({ where: { id: senderId }, select: { name: true } }),
    ])

    void NOTIFY.newMessage(receiverId, sender?.name ?? 'New message', body, listingId)

    return ok(c, message)
  }
)

messages.post('/:listingId/:userId/media', async (c) => {
  const senderId = c.get('userId')
  const listingId = toListingId(c.req.param('listingId'))
  const receiverId = c.req.param('userId')

  const denyReason = await assertCanMessage(senderId, receiverId, listingId)
  if (denyReason) return err(c, denyReason, denyReason.endsWith('not found') ? 404 : 400)

  const formData = await c.req.formData()
  const file = formData.get('photo') as File | null
  if (!file) return err(c, 'No photo provided', 400)

  const buffer = Buffer.from(await file.arrayBuffer())
  try {
    const key = await uploadPublic(buffer, `messages/${listingId ?? GENERAL}`, file.type || 'image/jpeg')

    const [message, sender] = await Promise.all([
      prisma.message.create({
        data: { listingId, senderId, receiverId, body: '📷 Photo', mediaKey: key },
      }),
      prisma.user.findUnique({ where: { id: senderId }, select: { name: true } }),
    ])

    void NOTIFY.newMessage(receiverId, sender?.name ?? 'New message', '📷 Sent a photo', listingId)

    return ok(c, message)
  } catch (e: any) {
    console.error(`[message photo] upload failed for listing ${listingId ?? GENERAL}:`, e?.message)
    return err(c, 'Upload failed — please try again later', 500)
  }
})

export { messages as messageRoutes }
