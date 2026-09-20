import { Queue } from 'bullmq'
import { redis } from './redis.js'

export const notificationQueue = new Queue('aroge-notifications', { connection: redis })
export const escrowQueue = new Queue('aroge-escrow', { connection: redis })
export const deliveryQueue = new Queue('aroge-delivery', { connection: redis })
export const broadcastQueue = new Queue('aroge-broadcasts', { connection: redis })
export const claimExpiryQueue = new Queue('aroge-claim-expiry', { connection: redis })
export const sessionReconciliationQueue = new Queue('aroge-session-reconciliation', { connection: redis })
export const searchSyncQueue = new Queue('aroge-search-sync', { connection: redis })
