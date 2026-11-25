#!/bin/bash
# Runs once, as the "postgres" superuser, the first time the pgdata volume is created.
# DocuLex's own role owns its database but is not a superuser: if the app (or an SQL injection)
# is compromised, it cannot read other databases, create roles or run COPY ... PROGRAM.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres \
  -v app_password="$DOCULEX_DB_PASSWORD" <<'SQL'
CREATE ROLE doculex_app LOGIN PASSWORD :'app_password';
CREATE DATABASE doculex OWNER doculex_app;
REVOKE ALL ON DATABASE doculex FROM PUBLIC;
GRANT CONNECT ON DATABASE doculex TO doculex_app;
SQL

# Creating the extension needs the superuser; migration 0000's
# CREATE EXTENSION IF NOT EXISTS then finds it and does nothing.
psql -v ON_ERROR_STOP=1 --username postgres --dbname doculex <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
SQL
