import * as Sentry from '@sentry/node'
import { env } from '../config/env.js'

// Points at a self-hosted GlitchTip instance (Sentry-API-compatible, so the
// official @sentry/node SDK works unmodified — see infra/README.md for how
// that's deployed). Safe to leave SENTRY_DSN unset: Sentry.init() with an
// empty DSN just no-ops rather than throwing, so this never gates local dev
// or a deploy that hasn't been given a real DSN yet.
export function initSentry(): void {
  if (!env.SENTRY_DSN) return

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    // Error tracking only for now, not performance tracing — keep the
    // volume/cost predictable until there's a reason to want traces too.
    tracesSampleRate: 0,
  })
}

export { Sentry }
