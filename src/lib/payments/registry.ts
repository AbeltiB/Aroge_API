import type { PaymentGateway, PaymentGatewayName } from './types.js'
import { MockPaymentGateway } from './mockGateway.js'
import { BankTransferGateway } from './bankTransferGateway.js'

const gateways: Record<PaymentGatewayName, PaymentGateway> = {
  TELEBIRR: new MockPaymentGateway('TELEBIRR'),
  CBE_BIRR: new MockPaymentGateway('CBE_BIRR'),
  BANK_TRANSFER: new BankTransferGateway(),
}

export function getPaymentGateway(name: PaymentGatewayName): PaymentGateway {
  return gateways[name]
}

export type { PaymentGateway, PaymentGatewayName } from './types.js'
