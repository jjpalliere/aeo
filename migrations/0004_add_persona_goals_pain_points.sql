-- Add goals and pain_points columns for personas (JSON arrays).
-- Run: wrangler d1 execute aeo-db --local --file=./migrations/0004_add_persona_goals_pain_points.sql
-- If you get "duplicate column name", the migration was already applied.
ALTER TABLE personas ADD COLUMN goals TEXT;
ALTER TABLE personas ADD COLUMN pain_points TEXT;
