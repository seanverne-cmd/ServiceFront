#!/usr/bin/env bash
# ============================================================================
#  dev-env.sh — rebuild the ServiceFront development environment in one command
# ============================================================================
# This machine is replaced between sessions: PostgreSQL is gone, and both
# `node_modules` and `.next` are symlinks into /opt/sf-store, which is wiped.
# Afterwards `bun install` and `next build` fail with ENOENT because the symlink
# TARGETS no longer exist (creating the link is not enough - the directories
# must exist too).
#
# This script repairs exactly that, idempotently:
#   1. recreates the /opt/sf-store targets the repo's symlinks point at
#   2. starts PostgreSQL if it is installed but not running
#   3. installs dependencies (bun install) with caches off /home
#   4. reports the state of the database and prints the exact next steps
#
# Safe to re-run at any time; it never deletes a working directory.
#
#   bash scripts/dev-env.sh
# ============================================================================
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${SF_STORE:-/opt/sf-store}"
cd "$REPO_ROOT"

say() { printf '%s\n' "$*"; }
ok() { printf '  [ok]   %s\n' "$*"; }
fix() { printf '  [fix]  %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; }

# Keep caches and temp files off the small /home volume.
export BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-/var/cache/bun}"
export TMPDIR="${TMPDIR:-/tmp}"
mkdir -p "$BUN_INSTALL_CACHE_DIR" 2>/dev/null || true

say "== 1. /opt/sf-store (the symlink targets for node_modules and .next)"
mkdir -p "$STORE/node_modules" "$STORE/next"
ok "targets exist: $STORE/node_modules, $STORE/next"

# A symlink is only usable once its target directory exists. Re-link if missing/wrong.
link_dir() { # link_dir <path-in-repo> <target>
  local path="$1" target="$2"
  if [ -L "$path" ]; then
    local current
    current="$(readlink "$path")"
    if [ "$current" != "$target" ]; then
      rm -f "$path" && ln -s "$target" "$path" && fix "$path -> $target (was $current)"
    else
      ok "$path -> $target"
    fi
  elif [ -d "$path" ]; then
    ok "$path is a real directory (not symlinked) - leaving it alone"
  else
    ln -s "$target" "$path" && fix "$path -> $target (link created)"
  fi
}
link_dir node_modules "$STORE/node_modules"
link_dir .next "$STORE/next"

say "== 2. PostgreSQL"
if command -v pg_isready >/dev/null 2>&1 && pg_isready -q -h 127.0.0.1 -p 5432 2>/dev/null; then
  ok "cluster already accepting connections on 127.0.0.1:5432"
elif command -v pg_ctlcluster >/dev/null 2>&1; then
  fix "cluster is down - starting PostgreSQL 16"
  (command -v service >/dev/null 2>&1 && service postgresql start) >/dev/null 2>&1 ||
    pg_ctlcluster 16 main start >/dev/null 2>&1 || true
  sleep 2
  if pg_isready -q -h 127.0.0.1 -p 5432 2>/dev/null; then ok "cluster is up"; else warn "cluster still down - see docs/RUNBOOK.md"; fi
else
  warn "PostgreSQL is not installed. Install it, then re-run this script:"
  say "         sudo apt-get update && sudo apt-get install -y postgresql postgresql-contrib"
fi

say "== 3. Dependencies"
if command -v bun >/dev/null 2>&1; then
  if bun install >/tmp/sf-bun-install.log 2>&1; then
    ok "bun install ($(ls node_modules 2>/dev/null | wc -l) entries in node_modules)"
  else
    warn "bun install failed - last lines:"
    tail -5 /tmp/sf-bun-install.log | sed 's/^/         /'
  fi
else
  warn "bun is not installed. Run: curl -fsSL https://bun.sh/install | bash"
fi

say "== 4. Configuration and database state"
if [ -f .env ]; then ok ".env present"; else warn ".env missing - copy it: cp .env.example .env"; fi
DB_READY=no
if command -v psql >/dev/null 2>&1 &&
   PGPASSWORD="${SF_APP_PASSWORD:-servicefront_app}" psql -h 127.0.0.1 -U servicefront_app -d "${SF_DB_NAME:-servicefront_dev}" -tAc 'select 1' >/dev/null 2>&1; then
  DB_READY=yes
  ok "database ${SF_DB_NAME:-servicefront_dev} is reachable by servicefront_app"
else
  warn "database not reachable yet (roles and schema may not exist on this machine)"
fi

cat <<NEXT

== Next steps
   1. First time on this machine, or the cluster was wiped:
        bash scripts/bootstrap-db.sh      # roles + dev database (idempotent)
        bun run db:migrate                # schema, RLS, auth tables
        bun run db:seed                   # two synthetic tenants + the four demo accounts
   2. Build and run (3000 belongs to the marketing site - never use it here):
        bun run build
        bun run start                     # http://127.0.0.1:3100
   3. Prove it end to end, against a running server:
        bun run test:isolation
        TEST_BASE_URL=http://127.0.0.1:3100 bun run test:auth

   Demo accounts and the full recovery procedure: docs/RUNBOOK.md
   Database is ${DB_READY} ready right now.
NEXT
