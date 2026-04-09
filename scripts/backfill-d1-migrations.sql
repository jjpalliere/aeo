-- Use when your D1 database ALREADY has the schema from older migrations
-- (manual `wrangler d1 execute`, old migrate.sh, etc.) but `d1_migrations`
-- does not list them — so `wrangler d1 migrations apply` fails with
-- "table X already exists".
--
-- 1) Remote production:
--    npx wrangler d1 execute aeo-db --remote --file=./scripts/backfill-d1-migrations.sql
-- 2) Local dev:
--    npx wrangler d1 execute aeo-db --local --file=./scripts/backfill-d1-migrations.sql
-- 3) Then apply only new migrations:
--    npx wrangler d1 migrations apply aeo-db --remote
--    (or --local)
--
-- Adjust the INSERT list: only include migration filenames that are truly
-- already applied in THIS database. If you are sure 001–003 are done but
-- 004 is not, include only 001–003 below.

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('001_initial.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('002_accounts.sql');
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('003_seed_owner.sql');
