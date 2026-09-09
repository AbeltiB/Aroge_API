import { env } from '../config/env.js'

const API_BASE = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`

export async function sendTelegramMessage(chatId: number | string, text: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  if (!res.ok) {
    console.error('sendTelegramMessage failed:', await res.text())
  }
}

export async function setTelegramWebhook(url: string, secretToken: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, secret_token: secretToken, allowed_updates: ['message'] }),
  })
  return res.json()
}
