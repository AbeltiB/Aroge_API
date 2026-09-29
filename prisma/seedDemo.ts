import 'dotenv/config'
import { readFile } from 'node:fs/promises'

// Populates the marketplace with realistic-looking demo content (personal
// sellers, business sellers, listings across categories, buyer/seller
// message threads) so the app doesn't look empty before real users arrive.
//
// Every seeded user gets a telegramId prefixed "seed-" — a reserved
// namespace real Telegram IDs can never collide with (they're plain
// numeric strings). That prefix is the ONLY marker this data needs: every
// other seeded row (listings, businesses, messages, follows, photos)
// hangs off one of these users via a foreign key, so wipeSeedData.ts finds
// everything by walking those relations from the seed-user set rather than
// needing its own flag on every table.
//
// Usage: run from inside the aroge-api container (has DATABASE_URL,
// MINIO_*, and node_modules with tsx already) so real S3 uploads work:
//   npx tsx prisma/seedDemo.ts
//
// Idempotent-ish: re-running skips users that already exist (by
// telegramId) but will create duplicate listings/messages if run twice
// with existing seed users still present — run wipeSeedData.ts first if
// you want a clean re-seed.

async function main() {
  const { PrismaClient } = await import('../src/generated/prisma/client.js')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
  const { randomUUID } = await import('node:crypto')

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
  const prisma = new PrismaClient({ adapter } as any)

  const s3 = new S3Client({
    endpoint: process.env.MINIO_ENDPOINT,
    // Garage's s3_region is configured as "garage" (not the SDK-default
    // "us-east-1" storage.ts uses at runtime) — a standalone script hits
    // Garage's real SigV4 scope check directly, so this has to match
    // exactly or every request 400s with AuthorizationHeaderMalformed.
    region: 'garage',
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY!,
      secretAccessKey: process.env.MINIO_SECRET_KEY!,
    },
    forcePathStyle: true,
  })

  async function uploadSeedPhoto(localFile: string): Promise<string> {
    const buffer = await readFile(`/tmp/seed-images/${localFile}.jpg`)
    const key = `seed-listings/${randomUUID()}.jpg`
    await s3.send(new PutObjectCommand({
      Bucket: process.env.MINIO_PUBLIC_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'image/jpeg',
    }))
    return key
  }

  try {
    console.log('📸 Uploading placeholder photos to Garage...')
    const photoKeys: Record<string, string> = {}
    for (const name of ['phone', 'laptop', 'sofa', 'shoes', 'car', 'bike', 'tv', 'stroller']) {
      photoKeys[name] = await uploadSeedPhoto(name)
    }
    console.log(`✅ Uploaded ${Object.keys(photoKeys).length} photos`)

    // ── Seed users ──────────────────────────────────────────────────────
    const userDefs = [
      { key: 'selam', telegramId: 'seed-0001', name: 'Selam Tesfaye', city: 'Addis Ababa', subCity: 'Bole', verified: true, isTrusted: true, trustedAt: new Date() },
      { key: 'dawit', telegramId: 'seed-0002', name: 'Dawit Bekele', city: 'Addis Ababa', subCity: 'Yeka', verified: true },
      { key: 'ruth', telegramId: 'seed-0003', name: 'Ruth Alemu', city: 'Addis Ababa', subCity: 'Kirkos', verified: true, isTrusted: true, trustedAt: new Date() },
      { key: 'nardos', telegramId: 'seed-0004', name: 'Nardos Girma', city: 'Addis Ababa', subCity: 'Bole', verified: true, isTrusted: true, trustedAt: new Date() },
      { key: 'yonas', telegramId: 'seed-0005', name: 'Yonas Tadesse', city: 'Addis Ababa', subCity: 'Kirkos', verified: true, isTrusted: true, trustedAt: new Date() },
      { key: 'meron', telegramId: 'seed-0006', name: 'Meron Hailu', city: 'Addis Ababa', subCity: 'Bole' },
      { key: 'samuel', telegramId: 'seed-0007', name: 'Samuel Getachew', city: 'Addis Ababa', subCity: 'Lideta' },
      { key: 'hana', telegramId: 'seed-0008', name: 'Hana Worku', city: 'Addis Ababa', subCity: 'Arada' },
    ] as const

    const users: Record<string, { id: string }> = {}
    for (const u of userDefs) {
      users[u.key] = await prisma.user.upsert({
        where: { telegramId: u.telegramId },
        update: {},
        create: {
          telegramId: u.telegramId,
          name: u.name,
          city: u.city,
          subCity: u.subCity,
          verified: u.verified ?? false,
          isTrusted: u.isTrusted ?? false,
          trustedAt: u.trustedAt,
        },
      })
    }
    console.log(`✅ Seeded ${Object.keys(users).length} demo users`)

    // ── Businesses ──────────────────────────────────────────────────────
    const nardosElectronics = await prisma.business.create({
      data: {
        repUserId: users.nardos.id,
        name: 'Nardos Electronics',
        type: 'Electronics Retailer',
        city: 'Addis Ababa',
        verifiedAt: new Date(),
      },
    })
    const addisFurniture = await prisma.business.create({
      data: {
        repUserId: users.yonas.id,
        name: 'Addis Furniture Hub',
        type: 'Furniture Store',
        city: 'Addis Ababa',
        verifiedAt: new Date(),
      },
    })
    console.log('✅ Seeded 2 demo businesses')

    // ── Listings ─────────────────────────────────────────────────────────
    const category = async (slug: string) => {
      const c = await prisma.category.findUniqueOrThrow({ where: { slug } })
      return c.id
    }

    const listingDefs = [
      // Personal sellers
      { sellerKey: 'selam', title: 'iPhone 12, 128GB — barely used', description: 'Selling my iPhone 12 in great condition. Comes with original box and charger. No scratches on the screen, battery health 89%.', categorySlug: 'phones-tablets', condition: 'LIKE_NEW', price: 32000, negotiable: true, photo: 'phone' },
      { sellerKey: 'selam', title: 'Nike Air Max sneakers, size 42', description: 'Worn a handful of times, still in great shape. True to size.', categorySlug: 'shoes', condition: 'GOOD', price: 3500, negotiable: true, photo: 'shoes' },
      { sellerKey: 'dawit', title: 'Dell XPS 13 laptop', description: 'Core i7, 16GB RAM, 512GB SSD. Great for work or school. Selling because I upgraded.', categorySlug: 'computers', condition: 'GOOD', price: 45000, negotiable: false, photo: 'laptop' },
      { sellerKey: 'dawit', title: 'Mountain bike, 26 inch', description: 'Sturdy mountain bike, recently serviced with new brake pads.', categorySlug: 'bicycles', condition: 'FAIR', price: 8500, negotiable: true, photo: 'bike' },
      { sellerKey: 'ruth', title: '3-seater sofa, grey fabric', description: 'Comfortable sofa, moving out and need to sell quickly. Minor wear on the armrest.', categorySlug: 'sofas-chairs', condition: 'GOOD', price: 12000, negotiable: true, photo: 'sofa' },
      { sellerKey: 'ruth', title: 'Baby stroller, foldable', description: 'Used for one child, still sturdy and clean. Easy one-hand fold.', categorySlug: 'baby-gear', condition: 'GOOD', price: 4200, negotiable: true, photo: 'stroller' },
      { sellerKey: 'meron', title: 'Samsung 43" Smart TV', description: 'Great picture quality, comes with remote and wall mount bracket.', categorySlug: 'tv-audio', condition: 'LIKE_NEW', price: 18000, negotiable: false, photo: 'tv' },
      { sellerKey: 'samuel', title: 'Toyota Vitz 2015', description: 'Well-maintained, single owner, all service records available. Fuel efficient.', categorySlug: 'cars', condition: 'GOOD', price: 950000, negotiable: true, photo: 'car' },
      { sellerKey: 'hana', title: "Men's leather jacket, size L", description: 'Genuine leather, worn only a few times.', categorySlug: 'mens-clothing', condition: 'LIKE_NEW', price: 4500, negotiable: true, photo: 'shoes' },
      { sellerKey: 'hana', title: 'Study desk with drawer', description: 'Solid wood desk, perfect for a home office or student room.', categorySlug: 'kitchen', condition: 'GOOD', price: 3800, negotiable: true, photo: 'sofa' },
      // Business sellers
      { sellerKey: 'nardos', businessId: nardosElectronics.id, title: 'Refurbished MacBook Air M1', description: 'Fully tested and refurbished, 6-month shop warranty included.', categorySlug: 'computers', condition: 'LIKE_NEW', price: 62000, negotiable: false, photo: 'laptop' },
      { sellerKey: 'nardos', businessId: nardosElectronics.id, title: 'Samsung Galaxy A54', description: 'Brand new, sealed box, full manufacturer warranty.', categorySlug: 'phones-tablets', condition: 'NEW', price: 28000, negotiable: false, photo: 'phone' },
      { sellerKey: 'nardos', businessId: nardosElectronics.id, title: 'Canon EOS M50 camera', description: 'Great starter camera for content creators, includes kit lens.', categorySlug: 'cameras', condition: 'NEW', price: 55000, negotiable: false, photo: 'tv' },
      { sellerKey: 'yonas', businessId: addisFurniture.id, title: 'Queen size bed frame + mattress', description: 'Complete bedroom set, delivery available within Addis Ababa.', categorySlug: 'beds', condition: 'NEW', price: 22000, negotiable: false, photo: 'sofa' },
      { sellerKey: 'yonas', businessId: addisFurniture.id, title: 'Dining table set, 6 chairs', description: 'Solid wood dining set, shop floor model with small discount.', categorySlug: 'kitchen', condition: 'LIKE_NEW', price: 28000, negotiable: true, photo: 'sofa' },
      { sellerKey: 'yonas', businessId: addisFurniture.id, title: 'Double-door refrigerator', description: 'Energy-efficient, quiet operation, 1-year shop warranty.', categorySlug: 'appliances', condition: 'NEW', price: 38000, negotiable: false, photo: 'tv' },
    ] as const

    const listings: { id: string; sellerKey: string }[] = []
    for (const [i, l] of listingDefs.entries()) {
      const listing = await prisma.listing.create({
        data: {
          sellerId: users[l.sellerKey].id,
          businessId: 'businessId' in l ? l.businessId : undefined,
          title: l.title,
          description: l.description,
          categoryId: await category(l.categorySlug),
          condition: l.condition as any,
          price: l.price,
          negotiable: l.negotiable,
          // A couple of non-ACTIVE listings for realism, rest active.
          status: i === 3 ? 'RESERVED' : i === 9 ? 'SOLD' : 'ACTIVE',
          city: 'Addis Ababa',
          subCity: userDefs.find((u) => u.key === l.sellerKey)!.subCity,
        },
      })
      await prisma.listingPhoto.create({
        data: { listingId: listing.id, cloudinaryKey: photoKeys[l.photo], orderIndex: 0, isPrimary: true },
      })
      listings.push({ id: listing.id, sellerKey: l.sellerKey })
    }
    console.log(`✅ Seeded ${listings.length} demo listings with photos`)

    // ── Follows (buyers following sellers) ─────────────────────────────
    await prisma.follow.createMany({
      data: [
        { followerId: users.meron.id, followedId: users.selam.id },
        { followerId: users.samuel.id, followedId: users.nardos.id },
        { followerId: users.hana.id, followedId: users.ruth.id },
      ],
      skipDuplicates: true,
    })
    console.log('✅ Seeded follow relationships')

    // ── Message threads ─────────────────────────────────────────────────
    const iphoneListing = listings[0]
    const macbookListing = listings.find((l) => l.sellerKey === 'nardos')!
    const carListing = listings.find((l, i) => listingDefs[i].title.startsWith('Toyota'))!

    const threads: Array<{ listingId: string; a: string; b: string; lines: Array<[string, string]> }> = [
      {
        listingId: iphoneListing.id,
        a: 'meron', b: 'selam',
        lines: [
          ['meron', 'Hi! Is the iPhone 12 still available?'],
          ['selam', 'Yes it is! Still in great condition.'],
          ['meron', 'Would you do 30,000 birr?'],
          ['selam', 'I can do 31,000, it includes the original box and charger.'],
        ],
      },
      {
        listingId: macbookListing.id,
        a: 'samuel', b: 'nardos',
        lines: [
          ['samuel', 'Does the MacBook Air come with the warranty in writing?'],
          ['nardos', 'Yes, we give a written 6-month shop warranty with every refurbished unit.'],
          ['samuel', 'Great, I will come by this weekend to see it.'],
        ],
      },
      {
        listingId: carListing.id,
        a: 'hana', b: 'samuel',
        lines: [
          ['hana', 'Hi, is the Vitz still for sale?'],
          ['samuel', 'Yes! Feel free to come check it out, service records are all available.'],
        ],
      },
    ]

    let messageCount = 0
    for (const thread of threads) {
      for (const [senderKey, body] of thread.lines) {
        const receiverKey = senderKey === thread.a ? thread.b : thread.a
        await prisma.message.create({
          data: {
            listingId: thread.listingId,
            senderId: users[senderKey].id,
            receiverId: users[receiverKey].id,
            body,
          },
        })
        messageCount++
      }
    }
    console.log(`✅ Seeded ${messageCount} demo messages across ${threads.length} threads`)

    console.log('\n🎉 Demo data seeded successfully. Run wipeSeedData.ts when real data is ready to replace it.')

    await prisma.$disconnect()
  } catch (e) {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  }
}

main()
