# ServiceFront

A multi-business AI website receptionist and lead-capture platform. One codebase serves many
independent businesses: an embeddable chat widget answers a business's website visitors from that
business's *approved* facts, and the owner reviews conversations in a dashboard. Revenue model is a
one-time setup fee plus a monthly subscription.

**Status: Phase 1 (foundation) is complete and verified.** The database schema, migrations,
multi-tenant model with row-level security, demo seed data, the isolation test suite (33
assertions), the authentication suite (`test:auth`, 50 assertions) and the app build all pass on a
clean machine. The chat widget itself (Phase 2) is not built yet — see "What is not built yet"
below.

## Stack

Next.js 15 (App Router, TypeScript) · React 19 · Tailwind v4 · shadcn/ui-style components ·
PostgreSQL 16 with row-level security · `postgres` (porsager) driver · Bun as package manager and
script runner.

## What is real vs. synthetic

Everything in this repo is real, working code and a real database. What is **synthetic** is the
*data*: the two demonstration tenants are fictional.

| Thing | Real or synthetic |
| --- | --- |
| Schema, migrations, RLS policies, tenancy helpers | **Real** — applied to a live Postgres and tested |
| Tenant isolation test suite (33 assertions) | **Real** — runs against the real database as the real app role |
| App build and `/api/health` | **Real** — health performs a live database query |
| `Pacific Coast Plumbing Services` tenant | **Synthetic** — fictional business, invented services/areas/FAQs/hours |
| `Pacific Paws Veterinary Clinic` tenant | **Synthetic** — fictional business, invented data |
| Demo conversations/messages/leads created by the seed | **Synthetic** — flagged `is_synthetic = true` and tagged with a `synthetic_batch` |
| Any AI answer | **Not built yet.** There is no LLM call in this phase. No demo response should ever be described as a live model answer. |

Every synthetic row carries `is_synthetic = true` plus a `synthetic_batch` tag, so it can be
identified and deleted in one statement.

## Quick start (clean machine)

Requires PostgreSQL 16 and Bun. No paid third-party service is needed to run or demo the app.

```bash
# 1. Database roles + dev database (idempotent)
bash scripts/bootstrap-db.sh

# 2. Schema
bun install
bun run db:migrate

# 3. Synthetic demonstration data
bun run db:seed

# 4. Prove tenant isolation (33 assertions)
bun run test:isolation

# 5. Build and run
bun run build
bun run start            # http://localhost:3100
curl -s localhost:3100/api/health
```

`bun run verify` runs steps 2–4 in one go.

Copy `.env.example` to `.env` first if `.env` is missing. The defaults point at the local database
that `scripts/bootstrap-db.sh` creates. `.env` is git-ignored and must never be committed.

Full clean-machine and disaster-recovery instructions: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
Schema and tenancy model: [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).

## Demo accounts (synthetic)

`bun run db:seed:accounts` creates (or re-hashes) exactly these four accounts. All of them are
**fictional demonstration identities** with published passwords — they are only fit for local and
demo use, and they must never be reused for a real business.

| Account (email) | Password | Role | Business |
| --- | --- | --- | --- |
| `owner@pacificcoastplumbing-demo.example` | `Plumbing!Demo2026` | `business_owner` | Pacific Coast Plumbing Services |
| `staff@pacificcoastplumbing-demo.example` | `Staff!Demo2026` | `business_staff` | Pacific Coast Plumbing Services |
| `owner@pacificpaws-demo.example` | `Paws!Demo2026` | `business_owner` | Pacific Paws Veterinary Clinic |
| `multi@servicefront-demo.example` | `Multi!Demo2026` | `business_owner` (plumbing) + `business_staff` (paws) | both — used to prove business switching |

`bun run db:seed:accounts` is idempotent: it upserts the four `users` rows and their
`business_members` rows and re-derives the password hashes, so it doubles as a password reset on a
machine that came back from a replacement. It requires `MIGRATION_DATABASE_URL` (see `.env`).

`bun run test:auth` drives the running app over HTTP with these accounts and asserts sign-in,
cookie flags, session expiry, role enforcement and tenant isolation (50 assertions). See
[`docs/RUNBOOK.md`](docs/RUNBOOK.md#running-the-authentication-suite).

## Moving to hosted Supabase Auth

One file changes: **`src/lib/auth/session.ts`** (the `HOSTED-AUTH MIGRATION POINT` comment at the
top lists exactly what to replace). `business_members.user_id` already stores the identity
provider's user id, so `src/lib/auth/authorize.ts`, the tenancy context, every RLS policy and every
page are untouched.

## Repository layout

```
db/migrations/      Numbered .sql migrations, applied in order, each in its own transaction
scripts/            bootstrap-db.sh, migrate.ts, seed.ts, reset.ts, test-isolation.ts
src/app/            Next.js App Router: layout, landing page, /api/health
src/lib/db/         Postgres client, tenant-scoped transaction helpers, query layer
src/lib/            env parsing/validation, logger, input validation, utils
docs/               DATA_MODEL.md, RUNBOOK.md
```

`scripts/` is excluded from `tsconfig.json` on purpose: those files are run by Bun and use
Bun-only APIs such as `import.meta.dir`, which Next's type-check would reject. They are type-checked
by Bun at runtime instead.

## Security model in one paragraph

The app connects to Postgres as `servicefront_app`, a role that **cannot bypass RLS and owns no
tables**. Every request sets `app.current_business_id` and `app.current_user_id` as transaction-local
settings; the RLS policies read those settings and require a live membership row. If the settings are
missing, the policies match nothing, so queries return **zero rows** instead of everything — missing
context fails closed. The migration/seed/test tooling uses a separate `servicefront_owner` role
(local stand-in for Supabase's service role) which is never given to the running app.

## What is not built yet (deliberately deferred)

Conversational lead capture and the lead pipeline, the KPI/insight dashboard, notifications, the
onboarding wizard, veterinary-specific configuration, usage/cost views, live LLM integration, and
payment processing. The tables for most of these already exist; the UI and the widget do not.

## Environment variables

See `.env.example` for the annotated list. All values are server-side only. The single exception is
`PUBLIC_WIDGET_ORIGIN`, which is a public URL. Never put a database password, service-role key or LLM
API key in a `NEXT_PUBLIC_*` variable or in client code.
