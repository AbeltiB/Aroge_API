import { describe, it, expect } from 'vitest'
import { MockPaymentGateway } from '../../src/lib/payments/mockGateway.js'
import { BankTransferGateway } from '../../src/lib/payments/bankTransferGateway.js'

describe('MockPaymentGateway', () => {
  it('initiateCharge returns a deterministic gatewayRef derived from the idempotency key', async () => {
    const gateway = new MockPaymentGateway('TELEBIRR')
    const result = await gateway.initiateCharge({
      orderId: 'order-1', paymentId: 'payment-1', amount: 1000, idempotencyKey: 'abc-123',
    })
    expect(result.gatewayRef).toBe('mock_abc-123')
  })

  it('verifyWebhookSignature always accepts (no real secret to check)', () => {
    const gateway = new MockPaymentGateway('TELEBIRR')
    expect(gateway.verifyWebhookSignature('anything', {})).toBe(true)
  })

  it('parses a TELEBIRR webhook payload', () => {
    const gateway = new MockPaymentGateway('TELEBIRR')
    const event = gateway.parseWebhookEvent(JSON.stringify({
      reference: 'idem-key-1', transactionId: 'txn-1', status: 'SUCCESS',
    }))
    expect(event).toEqual({ idempotencyKey: 'idem-key-1', gatewayRef: 'txn-1', status: 'SUCCEEDED', raw: expect.any(Object) })
  })

  it('parses a failed TELEBIRR webhook payload as FAILED', () => {
    const gateway = new MockPaymentGateway('TELEBIRR')
    const event = gateway.parseWebhookEvent(JSON.stringify({ reference: 'idem-key-1', status: 'DECLINED' }))
    expect(event.status).toBe('FAILED')
  })

  it('parses a CBE_BIRR webhook payload using its own field names', () => {
    const gateway = new MockPaymentGateway('CBE_BIRR')
    const event = gateway.parseWebhookEvent(JSON.stringify({
      referenceNumber: 'idem-key-2', txnId: 'txn-2', responseCode: '00',
    }))
    expect(event).toEqual({ idempotencyKey: 'idem-key-2', gatewayRef: 'txn-2', status: 'SUCCEEDED', raw: expect.any(Object) })
  })

  it('a non-"00" CBE_BIRR response code is FAILED', () => {
    const gateway = new MockPaymentGateway('CBE_BIRR')
    const event = gateway.parseWebhookEvent(JSON.stringify({ referenceNumber: 'x', responseCode: '99' }))
    expect(event.status).toBe('FAILED')
  })
})

describe('BankTransferGateway', () => {
  it('initiateCharge returns no gatewayRef (no real charge happens upfront)', async () => {
    const gateway = new BankTransferGateway()
    const result = await gateway.initiateCharge({ orderId: 'o1', paymentId: 'p1', amount: 500, idempotencyKey: 'k1' })
    expect(result.gatewayRef).toBeNull()
  })

  it('verifyWebhookSignature always rejects (there is no webhook)', () => {
    const gateway = new BankTransferGateway()
    expect(gateway.verifyWebhookSignature('anything', {})).toBe(false)
  })

  it('parseWebhookEvent throws — bank transfer has no webhook', () => {
    const gateway = new BankTransferGateway()
    expect(() => gateway.parseWebhookEvent()).toThrow()
  })
})
