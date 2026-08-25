import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../config/env.js'

export interface VerifyEtSubmission {
  bank: string
  referenceNumber?: string
  transactionNumber?: string
  receiptNumber?: string
  accountSuffix?: string
  phone?: string
  settlementAccount?: string
  webhookUrl?: string
}

export interface VerifyEtSettlementMatch {
  matched: boolean
  matchConfidence: 'high' | 'medium' | 'low' | 'none'
  ambiguous: boolean
  reason: string
}

export interface VerifyEtConfirmationHistory {
  isFirstConfirmation: boolean
  confirmedBefore: boolean
  confirmationCount: number
}

export interface VerifyEtResultItem {
  bank: string
  status: string
  verified: boolean
  amount: number | string
  currency: string
  senderName?: string
  receiverName?: string
  receiverAccount?: string
  referenceNumber?: string
  timestamp?: string
  confirmationHistory?: VerifyEtConfirmationHistory
  settlementAccountMatch?: VerifyEtSettlementMatch
}

export interface VerifyEtSubmitResponse {
  success: boolean
  message: string
  data: VerifyEtResultItem[]
  requestId: string
  verification: { requestId: string; processingStatus: string; status: string; verified: boolean }
}

export interface VerifyEtStatusResponse {
  success: boolean
  message: string
  data: {
    requestId: string
    bank: string
    processingStatus: string
    status: string
    verified: boolean
    completedAt?: string
  }
}

export class VerifyEtError extends Error {
  status: number
  retryAfter: string | null

  constructor(message: string, status: number, retryAfter: string | null) {
    super(message)
    this.name = 'VerifyEtError'
    this.status = status
    this.retryAfter = retryAfter
  }
}

export function isVerifyEtConfigured(): boolean {
  return !!env.VERIFY_ET_API_KEY
}

/** POST /api/verify — submits a bank-transfer reference for verification. */
export async function submitVerification(
  payload: VerifyEtSubmission & Record<string, unknown>,
  opts: { waitMs?: number; idempotencyKey: string }
): Promise<VerifyEtSubmitResponse> {
  if (!env.VERIFY_ET_API_KEY) {
    throw new VerifyEtError('Verification service is not configured', 503, null)
  }

  const url = new URL('/api/verify', env.VERIFY_ET_BASE_URL)
  if (opts.waitMs) url.searchParams.set('waitMs', String(opts.waitMs))

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.VERIFY_ET_API_KEY,
      'idempotency-key': opts.idempotencyKey,
    },
    body: JSON.stringify(payload),
  })

  const body = await res.json().catch(() => null)

  // res.ok is true for both 200 (completed) and 202 (queued) — only a genuine
  // non-2xx (402/422/429/503/etc.) should be treated as an error here.
  if (!res.ok) {
    throw new VerifyEtError(
      body?.message ?? `verify.et request failed (${res.status})`,
      res.status,
      res.headers.get('retry-after')
    )
  }

  return body as VerifyEtSubmitResponse
}

/** GET /api/verify/:requestId — polls a queued verification for its final result. */
export async function getVerificationStatus(requestId: string): Promise<VerifyEtStatusResponse> {
  if (!env.VERIFY_ET_API_KEY) {
    throw new VerifyEtError('Verification service is not configured', 503, null)
  }

  const url = new URL(`/api/verify/${requestId}`, env.VERIFY_ET_BASE_URL)
  const res = await fetch(url, { headers: { 'x-api-key': env.VERIFY_ET_API_KEY } })
  const body = await res.json().catch(() => null)

  if (!res.ok) {
    throw new VerifyEtError(body?.message ?? `verify.et status check failed (${res.status})`, res.status, res.headers.get('retry-after'))
  }

  return body as VerifyEtStatusResponse
}

/**
 * verify.et signs webhook bodies with X-Webhook-Signature only when a secret
 * is configured on their side. Their docs don't spell out the exact scheme,
 * so this assumes the common convention (HMAC-SHA256 hex digest of the raw
 * body) — confirm against a real webhook delivery before relying on it, and
 * adjust here if verify.et's actual scheme differs.
 */
export function verifyEtWebhookSignatureValid(rawBody: string, signatureHeader: string | null): boolean {
  if (!env.VERIFY_ET_WEBHOOK_SECRET) return true
  if (!signatureHeader) return false

  const expected = createHmac('sha256', env.VERIFY_ET_WEBHOOK_SECRET).update(rawBody).digest('hex')
  const expectedBuf = Buffer.from(expected, 'utf8')
  const givenBuf = Buffer.from(signatureHeader, 'utf8')
  if (expectedBuf.length !== givenBuf.length) return false
  return timingSafeEqual(expectedBuf, givenBuf)
}

/**
 * Shared acceptance rule for a verify.et result — used by both the
 * synchronous submit path and the async webhook/poll paths so a payment can
 * never be confirmed by one path under looser rules than the other.
 */
export function evaluateVerificationResult(
  item: Pick<VerifyEtResultItem, 'verified' | 'status' | 'amount' | 'currency' | 'settlementAccountMatch' | 'confirmationHistory'>,
  payment: { amount: number }
): { ok: true } | { ok: false; reason: string } {
  if (!item.verified || item.status !== 'success') {
    return { ok: false, reason: 'This transaction could not be verified' }
  }
  if (item.currency && item.currency !== 'ETB') {
    return { ok: false, reason: 'Unexpected currency on this transaction' }
  }

  const amount = Number(item.amount)
  if (!Number.isFinite(amount) || Math.abs(amount - payment.amount) > 0.01) {
    return { ok: false, reason: `Transferred amount does not match the order total` }
  }

  const match = item.settlementAccountMatch
  if (!match || !match.matched || match.matchConfidence === 'none' || match.matchConfidence === 'low' || match.ambiguous) {
    return { ok: false, reason: 'This transfer does not appear to be paid into an Aroge account' }
  }

  if (item.confirmationHistory && item.confirmationHistory.confirmedBefore) {
    return { ok: false, reason: 'This transaction reference has already been used' }
  }

  return { ok: true }
}
