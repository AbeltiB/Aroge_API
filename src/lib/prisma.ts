import { PrismaClient } from '../generated/prisma/client.js'
import { PrismaPg } from '@prisma/adapter-pg'

// Capped well below Neon free-tier's connection limit — this plus the
// Worker's own pool (also capped) stays comfortably under budget even if
// Render ever runs more than one instance of either service.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 5 })
export const prisma = new PrismaClient({ adapter } as any)