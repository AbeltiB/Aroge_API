// Promote a Telegram user to an Aroge admin role.
// Usage: npx tsx scripts/promote-admin.ts <telegramId> "<name>" [SUPER_ADMIN|MODERATOR|SUPPORT]
//
// Get a numeric Telegram user ID by messaging @userinfobot on Telegram.
import 'dotenv/config'

async function main() {
  const [telegramId, name, role = 'SUPER_ADMIN'] = process.argv.slice(2)

  if (!telegramId || !name) {
    console.error('Usage: npx tsx scripts/promote-admin.ts <telegramId> "<name>" [SUPER_ADMIN|MODERATOR|SUPPORT]')
    process.exit(1)
  }
  if (!['SUPER_ADMIN', 'MODERATOR', 'SUPPORT'].includes(role)) {
    console.error(`Invalid role "${role}". Must be SUPER_ADMIN, MODERATOR, or SUPPORT.`)
    process.exit(1)
  }

  const { PrismaClient } = await import('../src/generated/prisma/client.js')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
  const prisma = new PrismaClient({ adapter } as any)

  const admin = await prisma.adminUser.upsert({
    where: { telegramId },
    update: { role: role as any, name },
    create: { telegramId, name, role: role as any },
  })

  console.log(`✅ ${admin.name} (telegramId ${admin.telegramId}) is now ${admin.role}`)
  await prisma.$disconnect()
}

main()
