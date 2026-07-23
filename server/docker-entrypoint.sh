#!/bin/sh
set -e

# `prisma migrate deploy` exits 0 on an empty migrations directory without
# creating anything, so a fresh install would start against a database with no
# tables. Choose the right command instead of chaining them.
if ls prisma/migrations/*/migration.sql >/dev/null 2>&1; then
  echo "Applying migrations…"
  npx prisma migrate deploy
else
  echo "No migrations found — syncing schema directly."
  npx prisma db push --skip-generate
fi

exec node src/index.js
