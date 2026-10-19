#!/usr/bin/env bash
# Creates the two local PostgreSQL roles ServiceFront expects and the development database.
# Run once per machine (or after wiping the cluster). Safe to re-run.
#
#   servicefront_owner  - owns the schema, runs migrations + seeds, BYPASSRLS (local stand-in for
#                         Supabase's `postgres` / service role)
#   servicefront_app    - what the application connects as: table privileges, RLS enforced locally
#                         stand-in for Supabase's `authenticated` role)
#
# Nothing here is needed on a hosted Supabase project: create the project, put its connection
# strings in .env, and run `bun run db:migrate`. The SQL migrations never create roles.
set -euo pipefail

OS_USER="${SF_PG_SUPERUSER:-postgres}"
DEV_DB="${SF_DB_NAME:-servicefront_dev}"
OWNER_PW="${SF_OWNER_PASSWORD:-servicefront_owner}"
APP_PW="${SF_APP_PASSWORD:-servicefront_app}"

run_sql() { su "$OS_USER" -c "psql -q -v ON_ERROR_STOP=1 -d postgres -c \"$1\""; }

ensure_role() {
  local role="$1" password="$2" extra="$3"
  local exists
  exists=$(su "$OS_USER" -c "psql -At -d postgres -c \"select 1 from pg_roles where rolname='$role'\"")
  if [ "$exists" = "1" ]; then
    run_sql "alter role $role with login password '$password' $extra"
    echo "= role $role updated"
  else
    run_sql "create role $role with login password '$password' $extra"
    echo "+ role $role created"
  fi
}

ensure_role servicefront_owner "$OWNER_PW" "nosuperuser nocreatedb bypassrls"
ensure_role servicefront_app   "$APP_PW"   "nosuperuser nocreatedb nobypassrls"

exists_db=$(su "$OS_USER" -c "psql -At -d postgres -c \"select 1 from pg_database where datname='$DEV_DB'\"")
if [ "$exists_db" = "1" ]; then
  echo "= database $DEV_DB already exists"
else
  su "$OS_USER" -c "createdb -O servicefront_owner $DEV_DB"
  echo "+ database $DEV_DB created"
fi

run_sql "grant connect on database $DEV_DB to servicefront_app"
run_sql "alter schema public owner to servicefront_owner" >/dev/null 2>&1 || true
su "$OS_USER" -c "psql -q -d $DEV_DB -c 'alter schema public owner to servicefront_owner; grant usage on schema public to servicefront_app;'"

echo "Local database ready. DATABASE_URL=postgresql://servicefront_app:${APP_PW}@127.0.0.1:5432/${DEV_DB}"
