-- Add positioning column for existing databases.
-- Run: npm run db:migrate:positioning
-- If you get "duplicate column name", the migration was already applied.
ALTER TABLE brand_mentions ADD COLUMN positioning TEXT;
