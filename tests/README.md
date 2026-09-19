# Running the test suite locally

One-time setup:

1. Start the shared local dev stack (`docker compose up -d` from the repo-root-level `Aroge/docker-compose.yml`, not this repo) — Postgres on `5433`, Redis on `6380`.
2. Create the `aroge_test` database once (only needed if it doesn't already exist — the repo-root compose file's `docker-init/init-test-db.sql` creates it automatically on a *fresh* Postgres volume, but won't run again on a volume that already existed before that file was added):
   ```
   docker exec <postgres-container-name> psql -U postgres -c "CREATE DATABASE aroge_test;"
   ```
3. `cp .env.test.example .env.test`
4. Push the schema: `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/aroge_test npx prisma db push`

Then: `npm test`.

## Why integration tests, not just unit tests

Most of the actual risk in this API (escrow dispute/release/refund, payment-webhook handling, auth) lives inline in route handlers, not in separately-extracted pure functions. Rather than refactor everything first, tests spin up the real Hono app (`app.fetch()`) against a real, disposable Postgres + Redis — see `tests/setup.ts`, which truncates every table before each test and refuses to run at all if `DATABASE_URL` doesn't look like the test database.

## Scope (Phase 2 — minimal, highest-ROI first pass)

Covered: JWT signing/verification, the payment gateway classes, `orderCreation.ts`, `markPaymentHeld.ts`, all four `escrow.ts` routes, and the auth/role middleware.

**Not covered yet** (flagged as follow-up, not silently dropped): `admin.ts` (1071 lines), the Telegram signature-verification login flow in `auth.ts`, and the `verify.et` bank-reference-verification routes in `payments.ts`.

## `npm run typecheck` is not part of the CI gate

Confirmed via a real CI run: `tsc --noEmit` OOMs even on GitHub's standard runner at a 6GB heap ceiling (~7 min in, `FATAL ERROR: Ineffective mark-compacts near heap limit`) — this isn't specific to the local dev machine's limited RAM. Prisma 7's generated types are apparently large enough that this repo's own `build` script already sidesteps full checking with `tsc --noCheck` rather than `tsc`. Until that's fixed structurally (a bigger CI runner, or something that reduces the type-checking surface), CI relies on the test suite for correctness and doesn't type-check at all — a real gap versus the original Phase 2 plan, worth a dedicated look later.
