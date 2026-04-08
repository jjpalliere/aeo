#!/bin/bash
# scripts/migrate.sh — Versioned migration runner for D1
# Usage:
#   ./scripts/migrate.sh --local           # local SQLite (.wrangler/state/)
#   ./scripts/migrate.sh                   # remote prod D1 (default)

set -e

WRANGLER_ARGS=()
DB_NAME="aeo-db"
IS_LOCAL=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --local)
      WRANGLER_ARGS+=(--local)
      IS_LOCAL=true
      shift
      ;;
    *)
      echo "Unknown arg: $1"; exit 1
      ;;
  esac
done

# Default to remote when not --local
if [ "$IS_LOCAL" = false ]; then
  WRANGLER_ARGS+=(--remote)
fi

echo "Migrating $DB_NAME ${WRANGLER_ARGS[*]}"
echo "---"

run_d1() {
  npx wrangler d1 execute "$DB_NAME" "${WRANGLER_ARGS[@]}" "$@"
}

# Ensure _migrations table exists
run_d1 --command "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"

for file in migrations/*.sql; do
  name=$(basename "$file")
  applied=$(run_d1 --command "SELECT name FROM _migrations WHERE name = '$name'" 2>&1)
  if echo "$applied" | grep -q "$name"; then
    echo "SKIP  $name (already applied)"
    continue
  fi
  echo "APPLY $name..."
  run_d1 --file "$file"
  run_d1 --command "INSERT INTO _migrations (name) VALUES ('$name')"
  echo "  ✓ $name applied"
done

echo "---"
echo "Done."
