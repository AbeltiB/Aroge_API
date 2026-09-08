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

const reports = new Hono<{ Variables: AuthVariables }>()

reports.use('*', authMiddleware)

const createReportSchema = z.object({
  targetType: z.enum(['LISTING', 'USER', 'MESSAGE']),
  targetId: z.string().uuid(),
  reason: z.string().min(5).max(500),
})

reports.post('/', zValidator('json', createReportSchema), async (c) => {
  const reporterId = c.get('userId')
  const body = c.req.valid('json')

  const report = await prisma.report.create({
    data: { reporterId, ...body },
  })
  return ok(c, report)
})

reports.get('/', adminOnly, requireRole(AdminRole.MODERATOR), async (c) => {
  const query = c.req.query()
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(100, Number(query.limit) || 30)
  const skip = (page - 1) * limit

  const where: any = {}
  if (query.status) where.status = query.status
  if (query.targetType) where.targetType = query.targetType

  const [items, total] = await Promise.all([
    prisma.report.findMany({
      where,
      include: { reporter: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      skip, take: limit,
    }),
    prisma.report.count({ where }),
  ])
  return ok(c, { items, total, page, limit })
})

reports.patch('/:id',
  adminOnly, requireRole(AdminRole.MODERATOR),
  zValidator('json', z.object({ status: z.enum(['REVIEWED', 'DISMISSED']) })),
  async (c) => {
    const adminId = c.get('userId')
    const id = c.req.param('id')
    const { status } = c.req.valid('json')

    const existing = await prisma.report.findUnique({ where: { id } })
    if (!existing) return err(c, 'Report not found', 404)

    const report = await prisma.report.update({
      where: { id },
      data: { status, reviewedBy: adminId, reviewedAt: new Date() },
    })
    return ok(c, report)
  }
)

export { reports as reportRoutes }
