# Runbook

How to get ServiceFront running on a clean machine, and how to rebuild the database after the
machine is replaced or restarted.

## Decision: the local Postgres cluster is ephemeral

The development database lives in the default Debian/Ubuntu cluster location
(`/var/lib/postgresql/16/main`, i.e. on `/`), **not** on the persistent volume `/home`.

**Why:** `/home` is a small volume (600 MB total). A Postgres data directory plus its WAL does not
reliably fit beside a Node dependency tree on it, and filling `/home` takes the whole working tree
down with it — that is exactly what happened on a previous machine. The cluster is therefore treated
as disposable, and the guarantee we make instead is that it is **fully rebuildable from this repo by
a documented sequence of commands**. Everything that must survive — migrations, seed logic, tests,
application code — is committed to git. Nothing of value lives only inside the cluster.

Practical consequence: after a machine replacement, do not go looking for the old data. Re-run the
bootstrap sequence below; it reproduces an identical database.

If a deployment ever needs a durable cluster, point `PGDATA` at a volume with room for it (and take
backups) — the migration and application code do not change.

## Dependencies live outside `/home`

Because `/home` is small, the heavy generated directories are stored on the large volume and
symlinked in:

```bash
/opt/sf-store/node_modules   <- /home/team/shared/servicefront/node_modules (symlink)
/opt/sf-store/next           <- /home/team/shared/servicefront/.next        (symlink)
```

Both paths are git-ignored. On a fresh machine, either recreate them:

```bash
mkdir -p /opt/sf-store/next
cd /home/team/shared/servicefront
ln -s /opt/sf-store/next .next          # before the first build
bun install                             # creates node_modules
mv node_modules /opt/sf-store/node_modules && ln -s /opt/sf-store/node_modules node_modules
```

or simply let `node_modules` and `.next` live in the repo if the volume is big enough. Also keep
package caches and temp files off `/home`:

```bash
export BUN_INSTALL_CACHE_DIR=/var/cache/bun
export TMPDIR=/tmp
```

Check space before and during a build with `df -h /home`. If `/home` is nearly full, stop and free
something you can name and re-create (`.next`, `node_modules`, build output) rather than letting an
install die half-finished.

## One-command rebuild after a machine replacement

This machine is replaced between sessions. PostgreSQL is gone and `/opt/sf-store` is wiped, so
the app will not build until both are restored. That is two commands — the package install, then
the repo's own repair script:

```bash
apt-get update && apt-get install -y postgresql postgresql-contrib   # only if psql is missing
pg_ctlcluster 16 main start

cd /home/team/shared/servicefront
bash scripts/dev-env.sh
```

`scripts/dev-env.sh` is idempotent and re-runs safely at any time. It performs:

1. recreates `/opt/sf-store/node_modules` and `/opt/sf-store/next` (the symlink targets),
2. re-links `node_modules` / `.next` if the links themselves are missing or wrong,
3. starts PostgreSQL 16 if it is installed but not running (and tells you how to install it if not),
4. runs `bun install` with the Bun cache and `TMPDIR` kept off the small `/home` volume,
5. reports whether `.env` and the database are reachable, then prints the exact next steps.

After it, the usual sequence applies:

```bash
bash scripts/bootstrap-db.sh     # only if the cluster was wiped: roles + dev database
bun run db:migrate               # 10 migrations, 17 tables
bun run db:seed                  # two tenants, knowledge base, four demo accounts
bun run build
setsid nohup bun run start > /tmp/sf.log 2>&1 &   # port 3100
sleep 5
bun run test:isolation           # 33 assertions
bun run test:auth                # 50 assertions, HTTP
bun run test:chat                # 102 assertions, HTTP
```

The suites default to `http://127.0.0.1:3100`; set `TEST_BASE_URL` / `CHAT_TEST_BASE_URL` if the
server runs on another port (3200 is what earlier CI-style runs used).

`bun run db:seed:accounts` alone is enough to restore the demo logins on a machine whose database
survived but whose users were re-seeded.

## Demo accounts (synthetic)

All four are fictional demonstration identities with published passwords. They exist to exercise
roles and business switching; they must never be reused for a real business.

| Email | Password | Role | Business |
| --- | --- | --- | --- |
| `owner@pacificcoastplumbing-demo.example` | `Plumbing!Demo2026` | `business_owner` | Pacific Coast Plumbing Services |
| `staff@pacificcoastplumbing-demo.example` | `Staff!Demo2026` | `business_staff` | Pacific Coast Plumbing Services |
| `owner@pacificpaws-demo.example` | `Paws!Demo2026` | `business_owner` | Pacific Paws Veterinary Clinic |
| `multi@servicefront-demo.example` | `Multi!Demo2026` | owner at plumbing, staff at paws | both (business switching) |

`bun run db:seed:accounts` upserts these users and their `business_members` rows and re-derives the
password hashes, so it is also the password reset. It needs `MIGRATION_DATABASE_URL` (owner role),
because it writes `users` and `business_members`, which tenant sessions may not do.

## Running the authentication suite

`test:auth` talks to a **running** server over HTTP (it never calls the data layer for the checks
themselves), so build and start the app first:

```bash
bun run build
setsid nohup bun run start > /tmp/sf.log 2>&1 &   # port 3100
sleep 5
bun run test:auth                                  # expect: "50 passed, 0 failed"
```

Port **3000 is the public marketing site — never start the app there.** 3100 is the default in
`package.json`; set `TEST_BASE_URL` if you start it elsewhere.

What it proves: unauthenticated requests redirect to sign-in; sign-in sets an `httpOnly`,
`SameSite=Lax` cookie whose `Secure` flag matches the mode the server is running in (see below);
no account enumeration; every tenant sees only its own data; a staff write is refused server-side
with 403 and nothing reaches the database; a member of both businesses can switch and the rendered
dashboard follows the switch; and an expired session or a session pointing at a business the user
is not a member of is refused (401/403), never silently served.

### The session cookie's `Secure` policy

`sessionCookieSecure()` in `src/lib/auth/session.ts` is the single source of truth, and
`/api/health` reports it (`configuration.sessionCookieSecure`, `configuration.nodeEnv`):

- **production** (`next start`) — the cookie is **always** `Secure`. `SF_COOKIE_SECURE` cannot turn
  it off.
- **development / test** — not `Secure` by default, so the plain-http flow works on any host;
  set `SF_COOKIE_SECURE=true` to opt in (e.g. an https dev tunnel). Browsers accept `Secure`
  cookies on `http://localhost`/`127.0.0.1` anyway, but not on a plain-http LAN address.

`test:auth` reads the policy from `/api/health` and asserts the cookie matches it, instead of
hard-coding one expectation: it fails if a production server ever omits `Secure`, and it fails if
the cookie and the declared policy disagree.

## Running the chat suite

`test:chat` also drives a **running** server over HTTP and needs the seeded knowledge base, so run
`db:seed` first:

```bash
bun run test:chat            # expect: "RESULT: 102 passed, 0 failed"
```

It covers, in order: widget bootstrap and CORS, answer routing and grounding (hours, service areas,
services, FAQs, emergency wording), honest "not confirmed" answers for questions no approved fact
covers, appointment replies that name the approved service without implying a booked slot,
per-visitor and per-conversation rate limits, cross-tenant refusals, persistence of every exchange,
a foreign `conversationId` in the body being ignored, loopback origins (`localhost` and `127.0.0.1`
on 3100/3200), the owner reading the transcript in `/dashboard/conversations/<id>` with its cited
knowledge sources and demo label, the other tenant getting a 404 that reveals nothing, and a
malformed sign-in body returning 400 rather than 500.

If a transcript assertion about citations fails on a database that was migrated from an older
schema, the stored `cited_fact_refs` may be double-encoded; `normalizeFactRefs()` in
`src/lib/db/widget.ts` reads through that shape. A fresh `db:migrate` + `db:seed` always stores the
canonical `text[]`.

### Verifying the widget by hand

```bash
# the demo widget ids
psql "postgresql://servicefront_owner:servicefront_owner@127.0.0.1:5432/servicefront_dev" \
  -c "select slug, widget_public_id from public.businesses order by slug;"

# bootstrap (200 with an allowed Origin, 403 with any other)
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: http://localhost:3100' \
  http://127.0.0.1:3100/api/widget/<widgetPublicId>/config

# ask a question (expect mode:"demo" and a reply naming an approved service)
curl -s -X POST -H 'Origin: http://localhost:3100' -H 'content-type: application/json' \
  -d '{"text":"Do you service Fullerton?"}' \
  http://127.0.0.1:3100/api/widget/<widgetPublicId>/message
```

Sign in as the plumbing owner at `/sign-in` and open `/dashboard/conversations` to read the stored
exchange. A `403` means the `Origin` is not in that business's `widget_allowed_origins` or
`PUBLIC_WIDGET_ORIGIN`; a `404` means the id is not a `sfw_...` public id (the legacy
`widget_public_key` column is not accepted).

## Moving to hosted Supabase Auth

The SQL never creates roles and every page reads identity through one module, so adopting hosted
Supabase Auth is a single-file change: **`src/lib/auth/session.ts`** — its header comment
(`HOSTED-AUTH MIGRATION POINT`) lists exactly what to replace (cookie helpers, `getSession`,
`signIn`/`signOut`). `src/lib/auth/authorize.ts`, the tenancy context, every RLS policy and every
page stay as they are, because `business_members.user_id` already holds the provider's user id.

## Clean-machine bootstrap

Assumes a Debian/Ubuntu host with root or passwordless sudo. No paid third-party service is needed.

### 1. Install PostgreSQL 16 and Bun

```bash
apt-get update && apt-get install -y postgresql postgresql-contrib
pg_ctlcluster 16 main start      # or: service postgresql start
pg_isready -h 127.0.0.1          # expect: accepting connections
```

(If Bun is absent: `curl -fsSL https://bun.sh/install | bash`.)

### 2. Create roles and the development database

```bash
cd /home/team/shared/servicefront
bash scripts/bootstrap-db.sh
```

This is **idempotent** — safe to re-run at any time. It creates or updates:

- `servicefront_owner` (login, `BYPASSRLS`) — migrations, seed, tests
- `servicefront_app` (login, `NOBYPASSRLS`) — the running application
- database `servicefront_dev`, owned by `servicefront_owner`
- `connect` on the database for the app role
- **`alter schema public owner to servicefront_owner`** and `usage` on `public` for the app role

That last step matters: since PostgreSQL 15 the `public` schema is owned by `pg_database_owner`, so
the app role cannot create objects and the owner role cannot be relied on to own the schema. The
bootstrap does it explicitly so it never has to be done by hand.

### 3. Environment

```bash
cp .env.example .env      # if .env is missing; defaults already match the local database
```

`.env` is git-ignored. Never commit it.

### 4. Migrate, seed, verify

```bash
bun install
bun run db:migrate        # applies db/migrations/*.sql in order, each in its own transaction (10 files, 17 tables)
bun run db:seed           # synthetic demo data for both fictional tenants + the four demo accounts
bun run test:isolation    # 33 assertions; must end "33 passed, 0 failed"
```

Expected tail of the isolation run:

```
33 passed, 0 failed
tenant isolation verified: no context returns nothing, and no tenant can reach another's rows
```

The two `{"level":"error", ... "pgCode":"42501"}` lines printed during the run are **expected** —
they are the logged refusals from the deliberate negative tests, not failures.

### 5. Build and run

```bash
bun run build
bun run start             # listens on port 3100
curl -s localhost:3100/api/health
curl -s -o /dev/null -w '%{http_code}\n' localhost:3100/
```

To run it detached so it survives the shell:

```bash
setsid nohup bun run start > /tmp/sf.log 2>&1 &
```

## Rebuilding the database after a restart or machine replacement

The cluster is ephemeral, so after a replacement:

```bash
apt-get install -y postgresql postgresql-contrib
pg_ctlcluster 16 main start
cd /home/team/shared/servicefront
bash scripts/bootstrap-db.sh
bun run db:migrate && bun run db:seed && bun run test:isolation
```

If the cluster exists but you want a clean slate:

```bash
bun run db:reset          # drops and recreates the public schema, then re-grants
bun run db:migrate && bun run db:seed
```

`scripts/reset.ts` **re-grants privileges to `servicefront_app` after recreating `public`**. Dropping
the schema drops its grants with it; without the re-grant the app role silently loses access and
every query fails. That is handled in the script so it is never a manual step.

### Checking the cluster is healthy

```bash
pg_isready -h 127.0.0.1
pg_lsclusters
tail -50 /var/log/postgresql/postgresql-16-main.log
```

### Resetting just the synthetic data

```bash
# as the owner role
psql "postgresql://servicefront_owner:servicefront_owner@127.0.0.1:5432/servicefront_dev" \
  -c "delete from public.businesses where is_synthetic = true;"
```

Synthetic rows are always tagged, so this never touches real customer data.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `bun install` dies with `ENOSPC` | `/home` is full. See "Dependencies live outside `/home`" above; free `.next`/`node_modules`, keep caches in `/var/cache/bun`. |
| `bun install`/`next build` fails with `ENOENT` on `node_modules` or `.next` | The symlinks exist but their `/opt/sf-store` targets do not (machine replaced). Run `bash scripts/dev-env.sh`. |
| `pg_isready: command not found` | Postgres is not installed on this machine. Step 1 above. |
| `test:chat` gets 403 from the widget endpoints | The `Origin` header is not in the business's `widget_allowed_origins` / `PUBLIC_WIDGET_ORIGIN`. |
| `test:chat` gets 404 from the widget endpoints | The id is not a `sfw_...` `widget_public_id` (the legacy `widget_public_key` is not accepted). |
| `permission denied for schema public` | The `alter schema public owner` / `usage` grant is missing. Re-run `scripts/bootstrap-db.sh`. |
| Migrations fail with `must be owner of table` | You are connecting with `servicefront_app`. Migrations must use `MIGRATION_DATABASE_URL` (`servicefront_owner`). |
| Every query returns 0 rows | No tenant context was set, or the user has no membership. This is the intended fail-closed behaviour — check `withTenantTransaction` usage. |
| Build fails on `scripts/*.ts` with `Property 'dir' does not exist on type 'ImportMeta'` | `scripts/` must stay out of `tsconfig.json`'s `include`; those files use Bun-only APIs. |
| `next build` type error about `@/` imports | `paths` in `tsconfig.json` must keep `"@/*": ["./src/*"]`. |
