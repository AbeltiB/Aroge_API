import 'dotenv/config'
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