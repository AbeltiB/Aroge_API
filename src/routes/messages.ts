import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { cloudinary } from '../lib/cloudinary.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import { NOTIFY } from '../lib/notify.js'
import type { AuthVariables } from '../middleware/auth.js'

const messages = new Hono<{ Variables: AuthVariables }>()

messages.use('*', authMiddleware)

async function assertCanMessage(senderId: string, receiverId: string, listingId: string): Promise<string | null> {
  if (senderId === receiverId) return 'Cannot message yourself'

  const listing = await prisma.listing.findFirst({ where: { id: listingId, deletedAt: null } })
  if (!listing) return 'Listing not found'

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
  const { listingId, userId: otherId } = c.req.param()

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
    const { listingId, userId: receiverId } = c.req.param()
    const { body } = c.req.valid('json')

    const denyReason = await assertCanMessage(senderId, receiverId, listingId)
    if (denyReason) return err(c, denyReason, denyReason === 'Listing not found' ? 404 : 400)

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
  const { listingId, userId: receiverId } = c.req.param()

  const denyReason = await assertCanMessage(senderId, receiverId, listingId)
  if (denyReason) return err(c, denyReason, denyReason === 'Listing not found' ? 404 : 400)

  const formData = await c.req.formData()
  const file = formData.get('photo') as File | null
  if (!file) return err(c, 'No photo provided', 400)

  const buffer = Buffer.from(await file.arrayBuffer())
  try {
    const uploadResult = await new Promise<any>((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: `aroge/messages/${listingId}`, format: 'webp', transformation: [{ width: 1200, crop: 'limit' }] },
        (error, result) => (error ? reject(error) : resolve(result))
      ).end(buffer)
    })

    const [message, sender] = await Promise.all([
      prisma.message.create({
        data: { listingId, senderId, receiverId, body: '📷 Photo', mediaKey: uploadResult.public_id },
      }),
      prisma.user.findUnique({ where: { id: senderId }, select: { name: true } }),
    ])

    void NOTIFY.newMessage(receiverId, sender?.name ?? 'New message', '📷 Sent a photo', listingId)

    return ok(c, message)
  } catch (e: any) {
    console.error(`[message photo] upload failed for listing ${listingId}:`, e?.message)
    return err(c, 'Upload failed — please try again later', 500)
  }
})

export { messages as messageRoutes }
