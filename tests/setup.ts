import dotenv from 'dotenv'
dotenv.config({ path: '.env.test' })

// Guards the truncate-everything-before-each-test step below from ever
// running against a real database if .env.test fails to load for some
// reason and DATABASE_URL falls back to .env's real dev/production value.
if (!process.env.DATABASE_URL?.includes('aroge_test')) {
  throw new Error(
    `Refusing to run tests: DATABASE_URL doesn't look like the test database ` +
    `(got: ${process.env.DATABASE_URL}). Tests truncate every table before each ` +
    `run — copy .env.test.example to .env.test and make sure it's being picked up.`
  )
}

import { beforeEach, afterAll } from 'vitest'

// Dynamic imports, not static ones: in ESM, static imports are hoisted and
// fully evaluated before this file's OWN top-level code runs (including the
// dotenv.config() call above) — a static import here would load
// config/env.ts and fail its Zod validation before .env.test ever took
// effect. await import() runs in place, after the lines above it.
const { prisma } = await import('../src/lib/prisma.js')
const { redis } = await import('../src/lib/redis.js')
const {
  notificationQueue,
  escrowQueue,
  deliveryQueue,
  broadcastQueue,
  claimExpiryQueue,
  sessionReconciliationQueue,
} = await import('../src/lib/queue.js')

beforeEach(async () => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `
  const names = tables.map((t) => `"${t.tablename}"`).join(', ')
  if (names) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`)
  }
})

afterAll(async () => {
  await Promise.all([
    notificationQueue.close(),
    escrowQueue.close(),
    deliveryQueue.close(),
    broadcastQueue.close(),
    claimExpiryQueue.close(),
    sessionReconciliationQueue.close(),
  ])
  await prisma.$disconnect()
  await redis.quit()
})
