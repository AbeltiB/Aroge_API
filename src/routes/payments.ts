import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { verifyPaymentReferenceSchema } from 'aroge-sdk'
import { prisma } from '../lib/prisma.js'
import { cloudinary } from '../lib/cloudinary.js'
import { ok, err } from '../lib/response.js'
import { getPaymentGateway } from '../lib/payments/registry.js'
import { markPaymentHeld } from '../lib/markPaymentHeld.js'
import { authMiddleware } from '../middleware/auth.js'
import { rateLimit } from '../middleware/rateLimit.js'
import {
  submitVerification,
  getVerificationStatus,
  verifyEtWebhookSignatureValid,
  evaluateVerificationResult,
  isVerifyEtConfigured,
  VerifyEtError,
} from '../lib/verifyEt.js'
import type { PaymentGatewayName } from '../lib/payments/types.js'
import type { AuthVariables } from '../middleware/auth.js'

const payments = new Hono<{ Variables: AuthVariables }>()

async function handleWebhook(gatewayName: PaymentGatewayName, c: any) {
  const rawBody = await c.req.text()
  const headers = Object.fromEntries(c.req.raw.headers.entries())

  const gateway = getPaymentGateway(gatewayName)

  if (!gateway.verifyWebhookSignature(rawBody, headers)) {
    return err(c, 'Invalid webhook signature', 401)
  }

  let event
  try {
    event = gateway.parseWebhookEvent(rawBody)
  } catch {
    return err(c, 'Invalid payload', 400)
  }

  if (!event.idempotencyKey || event.status !== 'SUCCEEDED') {
    return ok(c, { received: true })
  }

  const payment = await prisma.payment.findFirst({ where: { idempotencyKey: event.idempotencyKey } })
  if (!payment || payment.status !== 'PENDING') return ok(c, { received: true })

  if (event.gatewayRef) {
    await prisma.payment.update({ where: { id: payment.id }, data: { gatewayRef: event.gatewayRef } })
  }
  await markPaymentHeld(payment, `${gatewayName} payment confirmed`)

  return ok(c, { received: true })
}

payments.post('/webhook/telebirr', (c) => handleWebhook('TELEBIRR', c))
payments.post('/webhook/cbe-birr', (c) => handleWebhook('CBE_BIRR', c))

payments.get('/bank-accounts', authMiddleware, async (c) => {
  const accounts = await prisma.bankAccount.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  })
  return ok(c, accounts)
})

payments.post('/:id/proof', authMiddleware, async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')

  const payment = await prisma.payment.findFirst({
    where: { id, gateway: 'BANK_TRANSFER' as any, order: { buyerId: userId } },
    include: { order: true },
  })
  if (!payment) return err(c, 'Payment not found', 404)
  if (payment.status !== 'PENDING') return err(c, 'This payment is no longer awaiting proof', 400)

  const formData = await c.req.formData()
  const file = formData.get('proof') as File | null
  if (!file) return err(c, 'No proof image provided', 400)

  const buffer = Buffer.from(await file.arrayBuffer())
  try {
    const uploadResult = await new Promise<any>((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: `aroge/payment-proofs/${id}`, type: 'authenticated', resource_type: 'auto' },
        (error, result) => (error ? reject(error) : resolve(result))
      ).end(buffer)
    })
    const updated = await prisma.payment.update({
      where: { id },
      data: { proofKey: uploadResult.public_id, proofUploadedAt: new Date() },
    })
    return ok(c, updated)
  } catch (e: any) {
    console.error(`[payment proof] upload failed for payment ${id}:`, e?.message)
    return err(c, 'Upload failed — please try again later', 500)
  }
})

// verify.et field names differ per bank (referenceNumber/transactionNumber/
// receiptNumber, accountSuffix vs suffix, phone vs phoneNumber). Sending every
// alias with the same value is harmless — "explicit bank payloads always win
// when bank is present" per their docs — and avoids a brittle per-bank switch.
function buildVerifyEtPayload(
  input: { bank: string; reference: string; suffix?: string; phone?: string },
  settlementAccount: string,
  webhookUrl?: string
) {
  return {
    bank: input.bank,
    reference: input.reference,
    referenceNumber: input.reference,
    transactionNumber: input.reference,
    receiptNumber: input.reference,
    accountSuffix: input.suffix,
    suffix: input.suffix,
    phone: input.phone,
    phoneNumber: input.phone,
    settlementAccount,
    webhookUrl,
  }
}

// verify.et requires production webhook URLs to be public HTTPS hosts. Render
// (and most PaaS proxies) terminate TLS at the edge and forward plain HTTP
// internally, so @hono/node-server's own req.url is 'http://...' even in
// production — X-Forwarded-Proto/Host (set by the proxy) is the only reliable
// signal for the real public scheme/host. A local dev/tunnel-less origin has
// neither header and no https, so it correctly falls through to undefined.
function buildWebhookCallbackUrl(c: any): string | undefined {
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() ?? c.req.header('host')
  const proto = forwardedProto ?? new URL(c.req.url).protocol.replace(':', '')

  if (proto !== 'https' || !forwardedHost) return undefined
  return `https://${forwardedHost}/api/v1/payments/webhook/verify-et`
}

payments.post('/:id/verify-reference',
  authMiddleware,
  rateLimit(5, 60),
  zValidator('json', verifyPaymentReferenceSchema),
  async (c) => {
    if (!isVerifyEtConfigured()) {
      return err(c, 'Automatic verification is not available — please upload a transfer screenshot instead', 503)
    }

    const userId = c.get('userId')
    const id = c.req.param('id')
    const body = c.req.valid('json')

    const payment = await prisma.payment.findFirst({
      where: { id, gateway: 'BANK_TRANSFER' as any, order: { buyerId: userId } },
    })
    if (!payment) return err(c, 'Payment not found', 404)
    if (payment.status !== 'PENDING') return err(c, 'This payment is no longer awaiting verification', 400)

    const bankAccount = await prisma.bankAccount.findFirst({ where: { bankCode: body.bank, isActive: true } })
    if (!bankAccount) return err(c, 'This bank is not currently supported for verification', 400)

    // Deterministic per attempt-content idempotency key: retries of the exact
    // same reference reuse the same verify.et request instead of double-billing.
    const idempotencyKey = `payment-${payment.id}-${body.bank}-${body.reference}`.slice(0, 128)

    let result
    try {
      result = await submitVerification(
        buildVerifyEtPayload(body, bankAccount.accountNumber, buildWebhookCallbackUrl(c)),
        { waitMs: 5000, idempotencyKey }
      )
    } catch (e) {
      const verifyErr = e instanceof VerifyEtError ? e : null
      console.error('[verify-et] submit failed:', verifyErr?.message ?? e)
      if (verifyErr?.status === 402) {
        return err(c, 'Automatic verification is temporarily unavailable — please upload a transfer screenshot instead', 503)
      }
      if (verifyErr?.status === 422) {
        return err(c, 'Please check the reference number and details, then try again', 422)
      }
      if (verifyErr?.status === 429) {
        return err(c, 'Too many verification attempts — please try again shortly', 429)
      }
      return err(c, 'Verification service is temporarily unavailable — please upload a transfer screenshot instead', 503)
    }

    // Store the requestId regardless of outcome so the webhook/poll fallback
    // can find this payment if the result wasn't ready synchronously.
    await prisma.payment.update({ where: { id: payment.id }, data: { verifyRequestId: result.requestId } })

    const item = result.data?.[0]
    if (!item) {
      return ok(c, { status: 'pending' as const, message: 'Verification submitted — this will confirm automatically once complete.' })
    }

    const verdict = evaluateVerificationResult(item, payment)
    if (!verdict.ok) {
      await prisma.payment.update({ where: { id: payment.id }, data: { verificationRaw: item as any } })
      return err(c, verdict.reason, 422)
    }

    try {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { verifiedBank: body.bank, verifiedReference: body.reference, verificationRaw: item as any },
      })
    } catch (e: any) {
      if (e.code === 'P2002') return err(c, 'This transaction reference has already been used for another order', 409)
      throw e
    }

    await markPaymentHeld(payment, `Verified via verify.et (request ${result.requestId})`)
    return ok(c, { status: 'verified' as const })
  }
)

payments.get('/:id/verification-status', authMiddleware, rateLimit(20, 60), async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')

  const payment = await prisma.payment.findFirst({
    where: { id, gateway: 'BANK_TRANSFER' as any, order: { buyerId: userId } },
  })
  if (!payment) return err(c, 'Payment not found', 404)
  if (payment.status !== 'PENDING') return ok(c, { status: 'confirmed' as const })
  if (!payment.verifyRequestId) return ok(c, { status: 'not_submitted' as const })

  let statusRes
  try {
    statusRes = await getVerificationStatus(payment.verifyRequestId)
  } catch (e) {
    console.error('[verify-et] status check failed:', e instanceof VerifyEtError ? e.message : e)
    return ok(c, { status: 'pending' as const })
  }

  if (statusRes.data.processingStatus !== 'completed') {
    return ok(c, { status: 'pending' as const })
  }

  // GET /api/verify/:requestId deliberately omits amount/settlementAccountMatch
  // (see verify.et's docs — only the POST /api/verify response and the webhook
  // carry those), so this endpoint can't make the confirm/reject call itself.
  // Once verify.et shows the request as completed, re-submitting the same
  // reference to /verify-reference is the safe way to fetch the full result
  // and finalize — it reuses the same deterministic idempotency key, so it
  // won't create a second verify.et request or double-charge credits.
  if (!statusRes.data.verified) {
    return ok(c, { status: 'failed' as const })
  }
  return ok(c, { status: 'ready_to_confirm' as const })
})

payments.post('/webhook/verify-et', async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header('x-webhook-signature')

  if (!verifyEtWebhookSignatureValid(rawBody, signature ?? null)) {
    return err(c, 'Invalid webhook signature', 401)
  }

  let event: any
  try {
    event = JSON.parse(rawBody)
  } catch {
    return err(c, 'Invalid payload', 400)
  }

  if (event?.event !== 'verification.completed') return ok(c, { received: true })
  // Guard against Prisma treating an omitted/undefined requestId as "no
  // filter" and matching an arbitrary payment row instead of none.
  if (typeof event.requestId !== 'string' || !event.requestId) return ok(c, { received: true })

  const payment = await prisma.payment.findFirst({ where: { verifyRequestId: event.requestId } })
  if (!payment || payment.status !== 'PENDING') return ok(c, { received: true })

  const d = event.data ?? {}
  const item = {
    verified: !!d.verified,
    status: d.status,
    amount: d.amount,
    currency: d.currency ?? 'ETB',
    settlementAccountMatch: d.settlementAccountMatch,
    confirmationHistory: d.confirmationHistory,
  }

  const verdict = evaluateVerificationResult(item, payment)
  if (!verdict.ok) {
    await prisma.payment.update({ where: { id: payment.id }, data: { verificationRaw: d } })
    return ok(c, { received: true })
  }

  try {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { verifiedBank: d.bank ?? null, verifiedReference: d.referenceNumber ?? null, verificationRaw: d },
    })
  } catch (e: any) {
    if (e.code === 'P2002') return ok(c, { received: true })
    throw e
  }

  await markPaymentHeld(payment, `Verified via verify.et webhook (request ${event.requestId})`)
  return ok(c, { received: true })
})

export { payments as paymentRoutes }
