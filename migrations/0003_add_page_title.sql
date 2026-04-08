-- Add page_title column for existing databases.
-- Run: wrangler d1 execute aeo-db --local --file=./migrations/0003_add_page_title.sql
-- If you get "duplicate column name", the migration was already applied.
ALTER TABLE citations ADD COLUMN page_title TEXT;
