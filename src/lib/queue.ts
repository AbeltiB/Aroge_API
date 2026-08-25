import { Queue } from 'bullmq'
import { redis } from './redis.js'

export const notificationQueue = new Queue('aroge-notifications', { connection: redis })
export const escrowQueue = new Queue('aroge-escrow', { connection: redis })
export const deliveryQueue = new Queue('aroge-delivery', { connection: redis })
export const broadcastQueue = new Queue('aroge-broadcasts', { connection: redis })
