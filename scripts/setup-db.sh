#!/bin/bash
# Soul dual database setup — PostgreSQL 17 with pgvector
# Creates both soul_memory and soul_evolution databases.
# Run once on each machine. Idempotent.

set -euo pipefail

DB_USER="graphheight_sys"
DB_HOST="localhost"
DB_PORT="5432"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/../server/db/migrations"

echo "=== Soul Database Setup ==="

# --- soul_memory (prunable, pgvector) ---
echo ""
echo "--- soul_memory ---"

DB_NAME="soul_memory"
echo "Creating database '$DB_NAME' if not exists..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 || \
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c \
  "CREATE DATABASE $DB_NAME OWNER $DB_USER"

echo "Enabling pgvector extension..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c \
  "CREATE EXTENSION IF NOT EXISTS vector"

echo "Running soul_memory migration..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f \
  "$MIGRATIONS_DIR/001-soul-memory.sql"

echo "soul_memory setup complete."

# --- soul_evolution (permanent, no pgvector) ---
echo ""
echo "--- soul_evolution ---"

DB_NAME="soul_evolution"
echo "Creating database '$DB_NAME' if not exists..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 || \
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c \
  "CREATE DATABASE $DB_NAME OWNER $DB_USER"

echo "Running soul_evolution migration..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f \
  "$MIGRATIONS_DIR/001-soul-evolution.sql"

echo "soul_evolution setup complete."

echo ""
echo "=== Soul dual database setup complete ==="
