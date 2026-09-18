import type { Prisma } from '../generated/prisma/client.js'

// Shared by POST /claims/:id/cancel and the claim-expiry worker's fire
// handler — same "who's next" logic either way. Duplicated (not imported)
// in aroge-worker, which has its own generated Prisma client and doesn't
// share code with this repo beyond the SDK.
// Returns the promoted claim's id (so the caller can schedule its follow-up
// expiry job once the transaction has actually committed — never from
// inside the transaction itself), or null if nothing was waiting.
export async function promoteNextWaitlistedClaim(
  tx: Prisma.TransactionClient,
  liveItemId: string,
  claimWindowMinutes: number
): Promise<string | null> {
  const next = await tx.claim.findFirst({
    where: { liveItemId, status: 'WAITLISTED' as any },
    orderBy: { waitlistPosition: 'asc' },
  })
  if (!next) return null

  await tx.claim.update({
    where: { id: next.id },
    data: {
      status: 'CLAIMED' as any,
      expiresAt: new Date(Date.now() + claimWindowMinutes * 60_000),
      waitlistPosition: null,
    },
  })

  // Shift everyone still behind them up by one.
  await tx.claim.updateMany({
    where: { liveItemId, status: 'WAITLISTED' as any, waitlistPosition: { gt: next.waitlistPosition ?? 0 } },
    data: { waitlistPosition: { decrement: 1 } },
  })

  return next.id
}
