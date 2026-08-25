import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'
import { ok } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import type { AuthVariables } from '../middleware/auth.js'

const notifications = new Hono<{ Variables: AuthVariables }>()
notifications.use('*', authMiddleware)

notifications.get('/', async (c) => {
  const userId = c.get('userId')
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(50, Number(c.req.query('limit')) || 20)
  const skip = (page - 1) * limit

  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.notification.count({ where: { userId } }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ])

  return ok(c, { items, total, unread, page, limit })
})

notifications.get('/unread-count', async (c) => {
  const userId = c.get('userId')
  const count = await prisma.notification.count({ where: { userId, readAt: null } })
  return ok(c, { count })
})

// Popup notifications (unread, not expired)
notifications.get('/popups', async (c) => {
  const userId = c.get('userId')
  const items = await prisma.notification.findMany({
    where: {
      userId,
      isPopup: true,
      readAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: 'desc' },
    take: 3,
  })
  return ok(c, items)
})

notifications.patch('/:id/read', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  await prisma.notification.updateMany({
    where: { id, userId },
    data: { readAt: new Date() },
  })
  return ok(c, null)
})

notifications.patch('/read-all', async (c) => {
  const userId = c.get('userId')
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  })
  return ok(c, null)
})

export { notifications as notificationRoutes }
