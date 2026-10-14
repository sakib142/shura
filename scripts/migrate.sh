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

for f in migrations/*.sql; do
  echo "applying $f"
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U forge -d forge < "$f"
done
echo "migrations applied"
