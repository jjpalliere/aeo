-- 003_seed_owner.sql — Bootstrap owner account, team, and backfill existing data
-- IMPORTANT: Replace <YOUR_EMAIL> with the owner's email before running!

INSERT INTO accounts (id, email, is_owner, created_at)
VALUES ('owner_001', 'jjpalliere@gmail.com', 1, datetime('now'));

INSERT INTO teams (id, name, invite_code, created_by, created_at)
VALUES ('team_001', 'Personal', 'BOOT-STRAP', 'owner_001', datetime('now'));

INSERT INTO team_members (team_id, account_id, joined_at)
VALUES ('team_001', 'owner_001', datetime('now'));

-- Backfill all existing data to owner's team
UPDATE brands SET team_id = 'team_001' WHERE team_id IS NULL;
UPDATE runs SET team_id = 'team_001' WHERE team_id IS NULL;
UPDATE prompts SET team_id = 'team_001' WHERE team_id IS NULL;
UPDATE personas SET team_id = 'team_001' WHERE team_id IS NULL;

-- Create first signup code for inviting others
INSERT INTO signup_codes (id, code, max_uses, times_used, created_by, created_at)
VALUES ('code_001', 'FIRST-CODE', 10, 0, 'owner_001', datetime('now'));
