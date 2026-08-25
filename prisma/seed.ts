import 'dotenv/config'

async function main() {
  const { PrismaClient } = await import('../src/generated/prisma/client.js')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
  const prisma = new PrismaClient({ adapter } as any)

  try {
    // Auth is Telegram-only — there's no email/password to seed ahead of time.
    // Set OWNER_TELEGRAM_ID (get yours from @userinfobot on Telegram) to
    // pre-provision the owner as SUPER_ADMIN + a fully-trusted mobile user on
    // their very first Telegram login. Without it, this step is skipped and
    // you can promote an admin later with `npx tsx scripts/promote-admin.ts`.
    const ownerTelegramId = process.env.OWNER_TELEGRAM_ID

    if (ownerTelegramId) {
      await prisma.adminUser.upsert({
        where: { telegramId: ownerTelegramId },
        update: { role: 'SUPER_ADMIN' },
        create: { telegramId: ownerTelegramId, role: 'SUPER_ADMIN', name: 'Aroge Owner' },
      })
      console.log(`✅ Admin seeded: telegramId ${ownerTelegramId} → SUPER_ADMIN`)

      await prisma.user.upsert({
        where: { telegramId: ownerTelegramId },
        update: { verified: true, isTrusted: true, trustedAt: new Date() },
        create: {
          telegramId: ownerTelegramId,
          verified: true,
          isTrusted: true,
          trustedAt: new Date(),
          name: 'Aroge Owner',
        },
      })
      console.log(`✅ Super-user seeded: telegramId ${ownerTelegramId} (fully trusted & verified)`)
    } else {
      console.log('ℹ️  OWNER_TELEGRAM_ID not set — skipping owner admin/user seed.')
    }

    const categoryTree = [
      { nameEn: 'Electronics', nameAm: 'ኤሌክትሮኒክስ', slug: 'electronics', children: [
        { nameEn: 'Phones & Tablets', nameAm: 'ስልኮችና ታብሌቶች', slug: 'phones-tablets' },
        { nameEn: 'Computers', nameAm: 'ኮምፒውተሮች', slug: 'computers' },
        { nameEn: 'TVs & Audio', nameAm: 'ቴሌቪዥን እና ኦዲዮ', slug: 'tv-audio' },
        { nameEn: 'Cameras', nameAm: 'ካሜራዎች', slug: 'cameras' },
      ]},
      { nameEn: 'Vehicles', nameAm: 'ተሽከርካሪዎች', slug: 'vehicles', children: [
        { nameEn: 'Cars', nameAm: 'መኪናዎች', slug: 'cars' },
        { nameEn: 'Motorcycles', nameAm: 'ሞተርሳይክሎች', slug: 'motorcycles' },
        { nameEn: 'Bicycles', nameAm: 'ብስክሌቶች', slug: 'bicycles' },
      ]},
      { nameEn: 'Clothing & Fashion', nameAm: 'ልብስ እና ፋሽን', slug: 'clothing', children: [
        { nameEn: "Men's Clothing", nameAm: 'የወንዶች ልብስ', slug: 'mens-clothing' },
        { nameEn: "Women's Clothing", nameAm: 'የሴቶች ልብስ', slug: 'womens-clothing' },
        { nameEn: "Children's Clothing", nameAm: 'የልጆች ልብስ', slug: 'childrens-clothing' },
        { nameEn: 'Shoes', nameAm: 'ጫማዎች', slug: 'shoes' },
      ]},
      { nameEn: 'Furniture & Home', nameAm: 'የቤት ዕቃዎች', slug: 'furniture', children: [
        { nameEn: 'Sofas & Chairs', nameAm: 'ሶፋዎችና ወንበሮች', slug: 'sofas-chairs' },
        { nameEn: 'Beds & Mattresses', nameAm: 'አልጋዎችና ፍራሽ', slug: 'beds' },
        { nameEn: 'Kitchen & Dining', nameAm: 'ወጥ ቤት እና ማዕድ ቤት', slug: 'kitchen' },
        { nameEn: 'Appliances', nameAm: 'ቤት ውስጥ መሳሪያዎች', slug: 'appliances' },
      ]},
      { nameEn: 'Sports & Outdoors', nameAm: 'ስፖርት እና ወጣ', slug: 'sports', children: [
        { nameEn: 'Fitness Equipment', nameAm: 'የሰውነት ማጠናከሪያ', slug: 'fitness' },
        { nameEn: 'Sports Gear', nameAm: 'የስፖርት ቁሳቁሶች', slug: 'sports-gear' },
      ]},
      { nameEn: 'Books & Education', nameAm: 'መጻሕፍትና ትምህርት', slug: 'books', children: [
        { nameEn: 'Textbooks', nameAm: 'የትምህርት መጻሕፍት', slug: 'textbooks' },
        { nameEn: 'Fiction', nameAm: 'ልቦለድ', slug: 'fiction' },
      ]},
      { nameEn: 'Baby & Kids', nameAm: 'ሕፃናትና ልጆች', slug: 'baby-kids', children: [
        { nameEn: 'Toys', nameAm: 'መጫወቻዎች', slug: 'toys' },
        { nameEn: 'Baby Gear', nameAm: 'የሕፃናት ቁሳቁሶች', slug: 'baby-gear' },
      ]},
      { nameEn: 'Tools & Construction', nameAm: 'መሳሪያዎችና ግንባታ', slug: 'tools', children: [
        { nameEn: 'Hand Tools', nameAm: 'የእጅ መሳሪያዎች', slug: 'hand-tools' },
        { nameEn: 'Construction Materials', nameAm: 'የግንባታ ቁሳቁሶች', slug: 'construction' },
      ]},
    ]

    for (const cat of categoryTree) {
      const parent = await prisma.category.upsert({
        where: { slug: cat.slug },
        update: {},
        create: { nameEn: cat.nameEn, nameAm: cat.nameAm, slug: cat.slug },
      })
      for (const child of (cat.children ?? [])) {
        await prisma.category.upsert({
          where: { slug: child.slug },
          update: {},
          create: { nameEn: child.nameEn, nameAm: child.nameAm, slug: child.slug, parentId: parent.id },
        })
      }
    }
    console.log('✅ Category tree seeded')

    await prisma.$disconnect()
  } catch (e) {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  }
}

main()
