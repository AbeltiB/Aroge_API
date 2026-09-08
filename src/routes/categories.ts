import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { ok, err } from '../lib/response.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminOnly } from '../middleware/adminOnly.js'
import { requireRole } from '../middleware/requireRole.js'
import { AdminRole } from '@arogenpm/sdk'
import type { AuthVariables } from '../middleware/auth.js'

const categories = new Hono<{ Variables: AuthVariables }>()

const categorySchema = z.object({
  parentId: z.string().uuid().optional().nullable(),
  nameEn: z.string().min(1).max(80),
  nameAm: z.string().min(1).max(80),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  iconKey: z.string().optional().nullable(),
})

categories.get('/', async (c) => {
  const roots = await prisma.category.findMany({
    where: { parentId: null },
    include: { children: true },
    orderBy: { nameEn: 'asc' },
  })
  return ok(c, roots)
})

categories.get('/:id', async (c) => {
  const cat = await prisma.category.findUnique({
    where: { id: c.req.param('id') },
    include: { children: true, parent: true },
  })
  if (!cat) return err(c, 'Category not found', 404)
  return ok(c, cat)
})

categories.post('/', authMiddleware, adminOnly, requireRole(AdminRole.MODERATOR), zValidator('json', categorySchema), async (c) => {
  const body = c.req.valid('json')
  const cat = await prisma.category.create({ data: body as any })
  return ok(c, cat)
})

categories.patch('/:id', authMiddleware, adminOnly, requireRole(AdminRole.MODERATOR), zValidator('json', categorySchema.partial()), async (c) => {
  const id = c.req.param('id')
  const existing = await prisma.category.findUnique({ where: { id } })
  if (!existing) return err(c, 'Category not found', 404)
  const cat = await prisma.category.update({ where: { id }, data: c.req.valid('json') as any })
  return ok(c, cat)
})

export { categories as categoryRoutes }
