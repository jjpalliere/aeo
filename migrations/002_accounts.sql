-- 002_accounts.sql — Account system tables + team_id on existing tables

-- Migration tracking
CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Accounts
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  is_owner INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Teams
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Team membership (many-to-many)
CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id, account_id)
);

-- Magic links for passwordless auth
CREATE TABLE magic_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  active_team_id TEXT REFERENCES teams(id),
  active_brand_id TEXT,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Signup codes (required for new account creation)
CREATE TABLE signup_codes (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  max_uses INTEGER DEFAULT 1,
  times_used INTEGER DEFAULT 0,
  created_by TEXT REFERENCES accounts(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for new tables
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX idx_magic_links_token ON magic_links(token);
CREATE INDEX idx_magic_links_email ON magic_links(email, used);
CREATE INDEX idx_team_members_account ON team_members(account_id);
CREATE INDEX idx_signup_codes_code ON signup_codes(code);

-- Add team_id to existing tables (nullable — backfilled in 003)
ALTER TABLE brands ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE runs ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE prompts ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE personas ADD COLUMN team_id TEXT REFERENCES teams(id);

-- Indexes for team scoping
CREATE INDEX idx_brands_team ON brands(team_id);
CREATE INDEX idx_runs_team ON runs(team_id);
CREATE INDEX idx_prompts_team ON prompts(team_id);
CREATE INDEX idx_personas_team ON personas(team_id);
