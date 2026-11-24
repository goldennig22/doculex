-- Custom SQL migration file, put your code below! --
-- Was empty: databases created before this fix got the extension by hand. A fresh database (CI, VPS) needs it here,
-- before 0003 adds the vector(1536) column.
CREATE EXTENSION IF NOT EXISTS vector;
