import type {
  InitiateChargeInput,
  InitiateChargeResult,
  PaymentGateway,
  PaymentGatewayName,
  WebhookEvent,
} from './types.js'

/**
 * Dev/staging default — no real provider is wired up yet. `initiateCharge`
 * just logs and returns a fake reference; `verifyWebhookSignature` accepts
 * everything (there's no real secret to check against). `parseWebhookEvent`
 * still parses the payload shapes the two existing webhook routes expect, so
 * the escrow flow can be exercised locally with a plain curl POST.
 *
 * Replace with a real class per provider (implementing the same
 * `PaymentGateway` interface) and point `registry.ts` at it — orders.ts and
 * payments.ts don't need to change.
 */
export class MockPaymentGateway implements PaymentGateway {
  constructor(readonly name: PaymentGatewayName) {}

  async initiateCharge(input: InitiateChargeInput): Promise<InitiateChargeResult> {
    console.log(`[PaymentGateway:${this.name}] charge initiated (mock)`, input)
    return { gatewayRef: `mock_${input.idempotencyKey}` }
  }

  verifyWebhookSignature(): boolean {
    return true
  }

  parseWebhookEvent(rawBody: string): WebhookEvent {
    const body = JSON.parse(rawBody)

    if (this.name === 'TELEBIRR') {
      return {
        idempotencyKey: body.reference ?? null,
        gatewayRef: body.transactionId ?? null,
        status: body.status === 'SUCCESS' ? 'SUCCEEDED' : 'FAILED',
        raw: body,
      }
    }

    // CBE_BIRR
    return {
      idempotencyKey: body.referenceNumber ?? null,
      gatewayRef: body.txnId ?? null,
      status: body.responseCode === '00' ? 'SUCCEEDED' : 'FAILED',
      raw: body,
    }
  }
}
