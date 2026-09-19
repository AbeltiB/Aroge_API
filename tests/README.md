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
