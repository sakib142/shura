#!/usr/bin/env bash
# Applies migrations through the container's own psql, so nothing needs to be
# installed on the host.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop, then: pnpm db:up && pnpm migrate" >&2
  exit 1
fi

docker compose up -d postgres >/dev/null
echo "waiting for postgres..."
for _ in $(seq 1 40); do
  if docker compose exec -T postgres pg_isready -U forge -d forge >/dev/null 2>&1; then break; fi
  sleep 1
done

docker compose exec -T postgres psql -U forge -d postgres \
  -c "SELECT 1 FROM pg_database WHERE datname='forge_test'" | grep -q 1 || \
  docker compose exec -T postgres psql -U forge -d postgres -c "CREATE DATABASE forge_test OWNER forge"

# The same migrations run against both. Tests truncate, so they get their own
# database rather than sharing the one that holds a real audit trail.
for db in forge forge_test; do
  for f in migrations/*.sql; do
    echo "applying $f -> $db"
    docker compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U forge -d "$db" < "$f" >/dev/null
  done
done
echo "migrations applied to forge and forge_test"
