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

// Sends a message with a Telegram "Login URL" inline button — the only
// mechanism that reliably reproduces the native "Log in to X" confirmation
// card (device/IP, Log in/Decline), because it's tapped from inside a
// Telegram client the user is already logged into. Unlike the Login
// Widget/oauth.telegram.org page, it doesn't depend on the browser having an
// active Telegram Web session. Requires the button's URL's domain to be
// registered via @BotFather → /setdomain for this bot — currently
// portal.aroge.online (ADMIN_WEB_URL). If ADMIN_WEB_URL's domain ever
// changes again, /setdomain has to be updated too, by hand, via BotFather —
// there's no API for it. Telegram silently drops the signed auth data for
// an unregistered domain (no error, the button just does nothing useful),
// which is exactly what broke login for everyone after the migration off
// the old aroge-web.vercel.app domain until this was caught.
export async function sendLoginButton(chatId: number | string, text: string, loginUrl: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [[{ text: 'Log in to Aroge', login_url: { url: loginUrl } }]],
      },
    }),
  })
  if (!res.ok) {
    console.error('sendLoginButton failed:', await res.text())
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
