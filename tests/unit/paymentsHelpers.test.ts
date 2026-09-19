import { describe, it, expect } from 'vitest'
import { buildVerifyEtPayload, buildWebhookCallbackUrl } from '../../src/routes/payments.js'

describe('buildVerifyEtPayload', () => {
  it('sends every field-name alias verify.et might expect, all set to the same value', () => {
    const payload = buildVerifyEtPayload(
      { bank: 'cbe', reference: 'REF123', suffix: '4567', phone: '0911000000' },
      'settlement-acct-1',
      'https://api.aroge.online/api/v1/payments/webhook/verify-et'
    )
    expect(payload.reference).toBe('REF123')
    expect(payload.referenceNumber).toBe('REF123')
    expect(payload.transactionNumber).toBe('REF123')
    expect(payload.receiptNumber).toBe('REF123')
    expect(payload.accountSuffix).toBe('4567')
    expect(payload.suffix).toBe('4567')
    expect(payload.phone).toBe('0911000000')
    expect(payload.phoneNumber).toBe('0911000000')
    expect(payload.settlementAccount).toBe('settlement-acct-1')
    expect(payload.webhookUrl).toBe('https://api.aroge.online/api/v1/payments/webhook/verify-et')
  })

  it('leaves suffix/phone undefined when not provided', () => {
    const payload = buildVerifyEtPayload({ bank: 'cbe', reference: 'REF1' }, 'acct')
    expect(payload.suffix).toBeUndefined()
    expect(payload.phone).toBeUndefined()
  })
})

function fakeContext(headers: Record<string, string>, url: string) {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      url,
    },
  } as any
}

describe('buildWebhookCallbackUrl', () => {
  it('builds an https callback URL from X-Forwarded-Proto/Host behind a proxy', () => {
    const c = fakeContext(
      { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'api.aroge.online' },
      'http://internal:4000/api/v1/payments/1/verify-reference'
    )
    expect(buildWebhookCallbackUrl(c)).toBe('https://api.aroge.online/api/v1/payments/webhook/verify-et')
  })

  it('returns undefined when there is no forwarded-proto (local/dev, no proxy)', () => {
    const c = fakeContext({}, 'http://localhost:4000/api/v1/payments/1/verify-reference')
    expect(buildWebhookCallbackUrl(c)).toBeUndefined()
  })

  it('returns undefined when the forwarded proto is not https', () => {
    const c = fakeContext(
      { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'api.aroge.online' },
      'http://internal:4000/x'
    )
    expect(buildWebhookCallbackUrl(c)).toBeUndefined()
  })

  it('falls back to the plain Host header when X-Forwarded-Host is absent', () => {
    const c = fakeContext(
      { 'x-forwarded-proto': 'https', host: 'api.aroge.online' },
      'http://internal:4000/x'
    )
    expect(buildWebhookCallbackUrl(c)).toBe('https://api.aroge.online/api/v1/payments/webhook/verify-et')
  })
})
