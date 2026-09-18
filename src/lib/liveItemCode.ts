import { randomBytes } from 'node:crypto'
import { prisma } from './prisma.js'

// Crockford-Base32-style alphabet, excluding visually ambiguous characters
// (no 0/O, 1/I/L) — this is spoken aloud and typed by buyers, so legibility
// matters more than entropy density.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

function randomCode(length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

// The permanent Layer-2 item identifier (see the two-layer labeling scheme
// in aroge-live-implementation-spec.md) — generated once, the moment a
// Listing first enters an Aroge Live session, and stable across relistings.
export async function ensureListingItemCode(listingId: string): Promise<string> {
  const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId }, select: { itemCode: true } })
  if (listing.itemCode) return listing.itemCode

  for (let attempt = 0; attempt < 5; attempt++) {
    const itemCode = `ARG-${randomCode(4)}`
    try {
      await prisma.listing.update({ where: { id: listingId }, data: { itemCode } })
      return itemCode
    } catch (e: any) {
      if (e.code === 'P2002') continue // collision — retry with a new code
      throw e
    }
  }
  throw new Error('Could not generate a unique item code after 5 attempts')
}
