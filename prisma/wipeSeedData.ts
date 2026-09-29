import 'dotenv/config'

// Removes everything created by seedDemo.ts once real users/listings make
// the demo content unnecessary. Finds seed users by the reserved
// telegramId prefix ("seed-") and walks every relation that could point at
// them or their listings — including rows created by REAL users who
// interacted with seed content in the meantime (saved a demo listing,
// messaged a demo seller, etc.), not just rows the seed script itself
// created.
//
// Safety: if any real Order/Review/Payment is entangled with a seed user
// or listing (someone actually tried to buy a demo item), this refuses to
// delete anything and prints what it found — financial/audit records are
// never silently destroyed. Re-run after resolving those manually (refund
// the order, then delete it) if that happens.
//
// Usage (inside the aroge-api container, same as seedDemo.ts):
//   npx tsx prisma/wipeSeedData.ts

async function main() {
  const { PrismaClient } = await import('../src/generated/prisma/client.js')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3')

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
  const prisma = new PrismaClient({ adapter } as any)

  try {
    const seedUsers = await prisma.user.findMany({
      where: { telegramId: { startsWith: 'seed-' } },
      select: { id: true },
    })
    const seedUserIds = seedUsers.map((u) => u.id)

    if (seedUserIds.length === 0) {
      console.log('ℹ️  No seed users found (telegramId LIKE \'seed-%\') — nothing to wipe.')
      await prisma.$disconnect()
      return
    }
    console.log(`Found ${seedUserIds.length} seed users.`)

    const seedListings = await prisma.listing.findMany({
      where: { sellerId: { in: seedUserIds } },
      select: { id: true },
    })
    const seedListingIds = seedListings.map((l) => l.id)
    console.log(`Found ${seedListingIds.length} seed listings.`)

    // ── Safety check: refuse if any real financial/audit data is entangled ──
    const [orderCount, reviewCount, claimCount] = await Promise.all([
      prisma.order.count({
        where: {
          OR: [
            { buyerId: { in: seedUserIds } },
            { sellerId: { in: seedUserIds } },
            { listingId: { in: seedListingIds } },
          ],
        },
      }),
      prisma.review.count({
        where: { OR: [{ reviewerId: { in: seedUserIds } }, { revieweeId: { in: seedUserIds } }] },
      }),
      prisma.claim.count({ where: { buyerId: { in: seedUserIds } } }),
    ])

    if (orderCount > 0 || reviewCount > 0 || claimCount > 0) {
      console.error('❌ Refusing to wipe: real activity found involving seed users/listings.')
      console.error(`   orders: ${orderCount}, reviews: ${reviewCount}, live claims: ${claimCount}`)
      console.error('   Resolve these manually first (e.g. refund/close the order), then re-run.')
      await prisma.$disconnect()
      process.exit(1)
    }

    // ── Delete in FK-safe order (children before parents). Matches on ──
    // listing/receiver too, not just seed-user-initiated rows, since a real
    // user could have messaged/saved/followed a seed listing or seller.
    const messages = await prisma.message.deleteMany({
      where: {
        OR: [
          { senderId: { in: seedUserIds } },
          { receiverId: { in: seedUserIds } },
          { listingId: { in: seedListingIds } },
        ],
      },
    })
    const savedItems = await prisma.savedItem.deleteMany({
      where: { OR: [{ userId: { in: seedUserIds } }, { listingId: { in: seedListingIds } }] },
    })
    const cartItems = await prisma.cartItem.deleteMany({
      where: { OR: [{ buyerId: { in: seedUserIds } }, { listingId: { in: seedListingIds } }] },
    })
    const follows = await prisma.follow.deleteMany({
      where: { OR: [{ followerId: { in: seedUserIds } }, { followedId: { in: seedUserIds } }] },
    })
    const blocks = await prisma.block.deleteMany({
      where: { OR: [{ blockerId: { in: seedUserIds } }, { blockedId: { in: seedUserIds } }] },
    })
    const notifications = await prisma.notification.deleteMany({
      where: { userId: { in: seedUserIds } },
    })
    const holidayLogs = await prisma.holidayModeLog.deleteMany({
      where: { userId: { in: seedUserIds } },
    })
    const reports = await prisma.report.deleteMany({
      where: { OR: [{ reporterId: { in: seedUserIds } }, { targetId: { in: [...seedUserIds, ...seedListingIds] } }] },
    })
    const offers = await prisma.offer.deleteMany({
      where: { OR: [{ buyerId: { in: seedUserIds } }, { listingId: { in: seedListingIds } }] },
    })
    const bundleItems = await prisma.bundleItem.deleteMany({
      where: { listingId: { in: seedListingIds } },
    })
    const photos = await prisma.listingPhoto.deleteMany({
      where: { listingId: { in: seedListingIds } },
    })
    const listingsDeleted = await prisma.listing.deleteMany({
      where: { id: { in: seedListingIds } },
    })
    const businesses = await prisma.business.deleteMany({
      where: { repUserId: { in: seedUserIds } },
    })
    const usersDeleted = await prisma.user.deleteMany({
      where: { id: { in: seedUserIds } },
    })

    console.log('✅ Deleted:')
    console.log(`   messages: ${messages.count}, savedItems: ${savedItems.count}, cartItems: ${cartItems.count}`)
    console.log(`   follows: ${follows.count}, blocks: ${blocks.count}, notifications: ${notifications.count}`)
    console.log(`   holidayLogs: ${holidayLogs.count}, reports: ${reports.count}, offers: ${offers.count}`)
    console.log(`   bundleItems: ${bundleItems.count}, photos: ${photos.count}, listings: ${listingsDeleted.count}`)
    console.log(`   businesses: ${businesses.count}, users: ${usersDeleted.count}`)

    // ── Clean up the uploaded seed images from Garage too ──
    const s3 = new S3Client({
      endpoint: process.env.MINIO_ENDPOINT,
      // Must match Garage's actual s3_region ("garage") — see seedDemo.ts.
      region: 'garage',
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY!,
        secretAccessKey: process.env.MINIO_SECRET_KEY!,
      },
      forcePathStyle: true,
    })
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.MINIO_PUBLIC_BUCKET,
      Prefix: 'seed-listings/',
    }))
    const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }))
    if (keys.length > 0) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: process.env.MINIO_PUBLIC_BUCKET,
        Delete: { Objects: keys },
      }))
      console.log(`✅ Deleted ${keys.length} seed images from object storage`)
    }

    console.log('\n🎉 Seed data fully wiped.')
    await prisma.$disconnect()
  } catch (e) {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  }
}

main()
