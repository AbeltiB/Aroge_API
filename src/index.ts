import 'dotenv/config'
import { initSentry } from './lib/sentry.js'

// Note: in ESM, every import below is fully resolved before this call
// actually runs (imports aren't interleaved with a module's own top-level
// code) — so this does NOT get Sentry's auto-instrumentation of modules
// loaded later, the way requiring it first would in CommonJS. That's fine
// here: tracesSampleRate is 0 (see sentry.ts) and the only thing that
// matters is Sentry.init() having run before app.onError() ever calls
// Sentry.captureException(), which this guarantees regardless of ESM's
// import-hoisting — that first real request is always well after this line.
initSentry()

import { serve } from '@hono/node-server'
import { env } from './config/env.js'
import { app } from './app.js'
import { setTelegramWebhook } from './lib/telegramBot.js'
import { toWebhookSecretToken } from './lib/telegramLogin.js'

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`🚀 aroge-api listening on http://localhost:${info.port}`)
})

// RENDER_EXTERNAL_URL is auto-injected by Render (e.g. https://aroge-api.onrender.com) —
// re-registering on every boot is idempotent and means the bot-login webhook
// survives redeploys with no manual setup step.
const publicUrl = process.env.RENDER_EXTERNAL_URL
if (publicUrl && env.TELEGRAM_WEBHOOK_SECRET) {
  setTelegramWebhook(`${publicUrl}/api/v1/telegram/webhook`, toWebhookSecretToken(env.TELEGRAM_WEBHOOK_SECRET))
    .then((res) => console.log('Telegram webhook registration:', res))
    .catch((e) => console.error('Telegram webhook registration failed:', e))
}