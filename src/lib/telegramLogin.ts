export const TOKEN_TTL_SECONDS = 5 * 60

export function pendingLoginKey(token: string): string {
  return `telegram_login:${token}`
}
