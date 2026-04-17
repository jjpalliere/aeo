-- 006_team_roles_and_archive.sql — per-team roles, archive metadata, invitations, deletion log

-- Per-team role (admin | member). Creators become 'admin' via backfill.
ALTER TABLE team_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member';

UPDATE team_members
  SET role = 'admin'
  WHERE account_id IN (
    SELECT created_by FROM teams WHERE teams.id = team_members.team_id
  );

-- Archive metadata on brands. When a team is deleted, its brands move to the
-- super-admin's archive team with these fields populated, rather than being
-- cascade-deleted.
ALTER TABLE brands ADD COLUMN archived_at TIMESTAMP;
ALTER TABLE brands ADD COLUMN archived_from_team_name TEXT;
ALTER TABLE brands ADD COLUMN archived_from_account_id TEXT REFERENCES accounts(id);

CREATE INDEX IF NOT EXISTS idx_brands_archived_at ON brands(archived_at);

-- Audit log of team deletions — lets the super-admin answer "what did they archive".
CREATE TABLE team_deletion_log (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  deleted_by TEXT NOT NULL REFERENCES accounts(id),
  brand_ids TEXT NOT NULL,            -- JSON array of brand ids moved to archive
  archive_team_id TEXT NOT NULL REFERENCES teams(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_team_deletion_log_created ON team_deletion_log(created_at DESC);

-- Email-based invitations for non-users (and existing accounts). Invitee clicks
-- a magic link in the email; acceptance creates/looks-up the account and adds
-- them to the team. signup_code_id links to a single-use code reserved at
-- invitation time for accounts that don't exist yet.
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  email TEXT NOT NULL,
  invited_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  token TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | accepted | revoked | expired
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMP,
  accepted_by_account_id TEXT REFERENCES accounts(id),
  signup_code_id TEXT REFERENCES signup_codes(id)
);

CREATE INDEX idx_invitations_token ON invitations(token);
CREATE INDEX idx_invitations_team ON invitations(team_id, status);
CREATE INDEX idx_invitations_email ON invitations(email, status);
