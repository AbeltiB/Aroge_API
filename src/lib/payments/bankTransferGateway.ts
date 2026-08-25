import type { InitiateChargeInput, InitiateChargeResult, PaymentGateway, WebhookEvent } from './types.js'

/**
 * Manual gateway — there's no external provider or webhook. The buyer
 * transfers funds directly to a published bank account and uploads a proof
 * image (see POST /payments/:paymentId/proof); an admin then confirms receipt
 * (POST /admin/payments/:id/verify), which drives the same HELD/PAID_ESCROWED
 * transition a webhook would.
 */
export class BankTransferGateway implements PaymentGateway {
  readonly name = 'BANK_TRANSFER' as const

  async initiateCharge(_input: InitiateChargeInput): Promise<InitiateChargeResult> {
    return { gatewayRef: null }
  }

  verifyWebhookSignature(): boolean {
    return false
  }

  parseWebhookEvent(): WebhookEvent {
    throw new Error('BANK_TRANSFER has no webhook — payments are confirmed manually by an admin')
  }
}
