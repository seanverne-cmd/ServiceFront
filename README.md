# ServiceFront

A multi-business AI website receptionist and lead-capture platform. One codebase serves many
independent businesses: an embeddable chat widget answers a business's website visitors from that
business's *approved* facts, and the owner reviews the conversations in a dashboard. Revenue model
is a one-time setup fee plus a monthly subscription.

**Status: Phase 1 (foundation) and Phase 2a (the chat engine) are complete and verified on a clean
rebuild.** Ten migrations create 17 tables, row-level security is forced on every tenant table, and
three suites pass against the real database and a running server:

| Suite | Assertions | What it proves |
| --- | --- | --- |
| `bun run test:isolation` | 33 | No tenant context returns nothing; no tenant can read, write or delete another's rows |
| `bun run test:auth` | 50 | Sign-in, cookie flags, session expiry, roles enforced server-side, business switching, cross-tenant refusal over HTTP |
| `bun run test:chat` | 102 | The widget answers only from approved facts, stores every exchange, and the owner — and only the owner — can read it |

Phase 2b (the visible, embeddable widget UI on a demo business site) is **not built yet**. The chat
engine is reachable today over HTTP; see [Chat widget API](#chat-widget-api-phase-2a).

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
| Chat engine, widget endpoints, origin checks, rate limiting | **Real** — driven over HTTP by `test:chat` |
| Dashboard conversation list and transcript | **Real** — reads through the tenant-scoped data layer |
| Tenant isolation / auth / chat suites (33 + 50 + 102 assertions) | **Real** — run against the real database and a running server |
| App build and `/api/health` | **Real** — health performs a live database query |
| `Pacific Coast Plumbing Services` tenant | **Synthetic** — fictional business, invented services/areas/FAQs/hours |
| `Pacific Paws Veterinary Clinic` tenant | **Synthetic** — fictional business, invented data |
| Demo conversations/messages created by the seed | **Synthetic** — flagged `is_synthetic = true` and tagged with a `synthetic_batch` |
| Every chat answer in this repo's default configuration | **Demonstration mode** — composed deterministically from approved facts, labelled as such in the API and the dashboard. Not a live model answer. |
| The live-model path (`src/lib/widget/llm.ts`) | **Implemented and gated, not yet exercised** — it runs only when `LLM_PROVIDER`, `LLM_API_KEY` and `LLM_MODEL` are set and `DEMO_MODE=false`, and no live provider key has been configured here. |

Every synthetic row carries `is_synthetic = true` plus a `synthetic_batch` tag, so it can be
identified and deleted in one statement.

## Quick start (clean machine)

Requires PostgreSQL 16 and Bun. No paid third-party service is needed to run or demo the app.

```bash
# 0. After a machine replacement: restore /opt/sf-store, links and dependencies
bash scripts/dev-env.sh

# 1. Database roles + dev database (idempotent)
bash scripts/bootstrap-db.sh

# 2. Schema and synthetic data
bun run db:migrate
bun run db:seed

# 3. Build and run
bun run build
bun run start                       # http://localhost:3100
curl -s localhost:3100/api/health
```

`bun run verify` runs migrate, seed and the isolation suite in one go. The HTTP suites need the
server running:

```bash
bun run test:isolation
bun run test:auth                   # 50 assertions
bun run test:chat                   # 102 assertions
```

Copy `.env.example` to `.env` first if `.env` is missing. The defaults point at the local database
that `scripts/bootstrap-db.sh` creates. `.env` is git-ignored and must never be committed.

Port **3000 belongs to the public marketing site — never start the app there.** The app defaults to
3100; the HTTP suites accept `TEST_BASE_URL` / `CHAT_TEST_BASE_URL` if you run it elsewhere.

Full clean-machine and disaster-recovery instructions: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
Schema and tenancy model: [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).

## Chat widget API (Phase 2a)

Each business has a public widget id (`businesses.widget_public_id`, format `sfw_` + 24 lowercase
hex characters). It is public by design: it names the business and nothing else. The business is
resolved **server-side from the URL id only** — nothing in a request body can name a tenant, a role
or a response mode.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/widget/<widgetPublicId>/config` | Public widget bootstrap: business display name, welcome message, brand colour, disclosure, allowed origins |
| `POST /api/widget/<widgetPublicId>/message` | Body `{ conversationId?: uuid, text: string }` → `{ conversationId, reply, mode: "demo" \| "live", sources, ... }` |
| `OPTIONS` on either | CORS preflight; refused unless the request's `Origin` is allowed for that business |

Guarantees the suite enforces:

- **Origin-restricted.** Requests are refused (403) unless the `Origin` matches the business's
  `widget_allowed_origins` or `PUBLIC_WIDGET_ORIGIN`. The seeded businesses allow the loopback dev
  ports (3100, 3200) so the demo works on a dev machine.
- **Answers only from approved facts.** Replies are composed from that business's hours, service
  areas, services and FAQs. When nothing approved covers the question, the reply says it does not
  have that confirmed instead of inventing an answer.
- **Honest labelling.** Without live credentials every reply is `mode: "demo"`, prefixed
  `[demo mode]`, and carries the disclosure that it was composed deterministically, not generated by
  a model. The dashboard shows the same label on every stored reply.
- **Persisted and tenant-scoped.** Every exchange is stored in `messages` under the business's
  `conversations` row, with the cited knowledge sources, and is readable only by a signed-in member
  of that business (`/dashboard/conversations`, `/dashboard/conversations/<id>`).
- **Rate limited** per visitor and per conversation per minute, with no tenant data in the limits.

Find the demo widget ids after seeding:

```bash
psql "postgresql://servicefront_owner:servicefront_owner@127.0.0.1:5432/servicefront_dev" \
  -c "select slug, widget_public_id from public.businesses order by slug;"
```

Then, with the server running:

```bash
curl -s -H 'Origin: http://localhost:3100' \
  http://127.0.0.1:3100/api/widget/<widgetPublicId>/config

curl -s -X POST -H 'Origin: http://localhost:3100' -H 'content-type: application/json' \
  -d '{"text":"Do you service Fullerton?"}' \
  http://127.0.0.1:3100/api/widget/<widgetPublicId>/message
```

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

Sign in at `/sign-in`, then read a transcript at `/dashboard/conversations`.

## Moving to hosted Supabase Auth

One file changes: **`src/lib/auth/session.ts`** (the `HOSTED-AUTH MIGRATION POINT` comment at the
top lists exactly what to replace). `business_members.user_id` already stores the identity
provider's user id, so `src/lib/auth/authorize.ts`, the tenancy context, every RLS policy and every
page are untouched.

## Repository layout

```
db/migrations/      Numbered .sql migrations (0001-0010), applied in order, each in its own transaction
scripts/            dev-env.sh, bootstrap-db.sh, migrate.ts, seed.ts, reset.ts, test-{isolation,auth,chat}.ts
src/app/            App Router: landing, /sign-in, /dashboard{,/conversations}, /api/{health,auth,widget}
src/lib/db/         Postgres client, tenant- and widget-scoped transaction helpers, query layer
src/lib/widget/     Chat engine, knowledge loading, origin checks, rate limit, live-model adapter
src/lib/auth/       Sessions, roles, request guards
docs/               DATA_MODEL.md, RUNBOOK.md
```

`scripts/` is excluded from `tsconfig.json` on purpose: those files are run by Bun and use
Bun-only APIs such as `import.meta.dir`, which Next's type-check would reject. They are type-checked
by Bun at runtime instead.

## Security model in one paragraph

The app connects to Postgres as `servicefront_app`, a role that **cannot bypass RLS and owns no
tables**. Every dashboard request sets `app.current_business_id` and `app.current_user_id` as
transaction-local settings; the RLS policies read those settings and require a live membership row.
The anonymous widget sets `app.widget_business_id` for one transaction, which unlocks read-only
access to that business's approved knowledge plus inserts into `conversations`/`messages` and
nothing else. If the settings are missing, the policies match nothing, so queries return **zero
rows** instead of everything — missing context fails closed. The migration/seed/test tooling uses a
separate `servicefront_owner` role (local stand-in for Supabase's service role) which is never given
to the running app. Platform-admin support access is off by default and requires an explicit opt-in
that writes an `audit_logs` entry.

## What is not built yet (deliberately deferred)

The embeddable widget UI and the demo business page that hosts it (Phase 2b), conversational lead
capture and the lead pipeline, the KPI/insight dashboard, notifications, the onboarding wizard,
usage/cost views, payment processing, and a live-model run against a real provider. The tables for
most of these already exist; the UI does not.

## Environment variables

See `.env.example` for the annotated list. All values are server-side only. The single exception is
`PUBLIC_WIDGET_ORIGIN`, which is a public URL. Never put a database password, service-role key or LLM
API key in a `NEXT_PUBLIC_*` variable or in client code.
