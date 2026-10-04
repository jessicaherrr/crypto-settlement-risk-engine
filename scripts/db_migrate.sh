#!/usr/bin/env bash
# Applies database/migrations/*.sql, in order, to DATABASE_URL - tracking
# what's already been applied in a schema_migrations table so re-running
# this script is a no-op except for new migration files.
#
# This exists because migration 001 (database/migrations/001_core_schema.sql)
# is not self-idempotent (plain ADD CONSTRAINT, no IF NOT EXISTS), so
# "just run every .sql file every time" would fail on a second run against
# an already-migrated database. Every migration after 001 *is* written
# idempotently (IF NOT EXISTS / ON CONFLICT), but tracking applied
# migrations explicitly is simpler and more honest than relying on that
# convention holding forever.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/db scripts/db_migrate.sh
#
# Defaults to the local-dev connection string used throughout this repo
# (docker-compose.yml, .env.example) when DATABASE_URL isn't set.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/database/migrations"
DATABASE_URL="${DATABASE_URL:-postgres://askgene:askgene@localhost:5432/askgene_quantfi}"

if ! command -v psql >/dev/null 2>&1; then
  echo "error: psql is required (brew install postgresql@16, or run via a container that has it)" >&2
  exit 1
fi

echo "Migrating: ${DATABASE_URL%%@*}@... (db target redacted of credentials in this log line)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
SQL

applied_any=0
for file in "$MIGRATIONS_DIR"/*.sql; do
  version="$(basename "$file")"
  already_applied="$(psql "$DATABASE_URL" -tAc "SELECT 1 FROM schema_migrations WHERE version = '$version'")"
  if [ "$already_applied" = "1" ]; then
    echo "  skip   $version (already applied)"
    continue
  fi

  echo "  apply  $version"
  # -f (not \i via -c) because the repo path may contain spaces, which
  # psql's backslash-command tokenizer would split on; -f takes the path
  # as its own argv entry instead. -1 wraps the migration file and the
  # tracking insert in one transaction, so a failed migration can't leave
  # schema_migrations out of sync with what actually applied.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 \
    -f "$file" \
    -c "INSERT INTO schema_migrations (version) VALUES ('$version')"
  applied_any=1
done

if [ "$applied_any" = "0" ]; then
  echo "Already up to date."
else
  echo "Migrations applied."
fi
