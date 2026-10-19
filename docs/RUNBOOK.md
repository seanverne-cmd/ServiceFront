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
bun run db:migrate        # applies db/migrations/*.sql in order, each in its own transaction
bun run db:seed           # synthetic demo data for both fictional tenants
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
| `pg_isready: command not found` | Postgres is not installed on this machine. Step 1 above. |
| `permission denied for schema public` | The `alter schema public owner` / `usage` grant is missing. Re-run `scripts/bootstrap-db.sh`. |
| Migrations fail with `must be owner of table` | You are connecting with `servicefront_app`. Migrations must use `MIGRATION_DATABASE_URL` (`servicefront_owner`). |
| Every query returns 0 rows | No tenant context was set, or the user has no membership. This is the intended fail-closed behaviour — check `withTenantTransaction` usage. |
| Build fails on `scripts/*.ts` with `Property 'dir' does not exist on type 'ImportMeta'` | `scripts/` must stay out of `tsconfig.json`'s `include`; those files use Bun-only APIs. |
| `next build` type error about `@/` imports | `paths` in `tsconfig.json` must keep `"@/*": ["./src/*"]`. |
