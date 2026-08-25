export type PaymentGatewayName = 'TELEBIRR' | 'CBE_BIRR' | 'BANK_TRANSFER'

export interface InitiateChargeInput {
  orderId: string
  paymentId: string
  amount: number
  idempotencyKey: string
}

export interface InitiateChargeResult {
  /** Gateway's own reference for this charge attempt, if it returns one upfront. */
  gatewayRef: string | null
  /** Present for gateways with a hosted checkout page the buyer must be redirected to. */
  checkoutUrl?: string
}

export type WebhookStatus = 'SUCCEEDED' | 'FAILED'

export interface WebhookEvent {
  /** Maps back to Payment.idempotencyKey */
  idempotencyKey: string | null
  gatewayRef: string | null
  status: WebhookStatus
  raw: unknown
}

/**
 * One implementation per real provider (Telebirr, CBE Birr, an aggregator like
 * Chapa, etc). Swap the registry in `./registry.ts` to point at a real
 * implementation once a provider is chosen — nothing in orders.ts/payments.ts
 * needs to change.
 */
export interface PaymentGateway {
  readonly name: PaymentGatewayName
  initiateCharge(input: InitiateChargeInput): Promise<InitiateChargeResult>
  verifyWebhookSignature(rawBody: string, headers: Record<string, string | undefined>): boolean
  parseWebhookEvent(rawBody: string): WebhookEvent
}
