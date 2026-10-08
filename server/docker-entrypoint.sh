#!/bin/sh
set -e

# Adopts a v1 (db push) database into the migration history if needed, then
# runs `prisma migrate deploy` — see scripts/migrate.js.
node scripts/migrate.js

exec node src/index.js
