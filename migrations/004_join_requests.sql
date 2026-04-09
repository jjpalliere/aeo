-- 004_join_requests.sql — Access requests (pending approval by owner)

CREATE TABLE join_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP,
  reviewed_by TEXT REFERENCES accounts(id),
  reject_reason TEXT
);

CREATE INDEX idx_join_requests_status ON join_requests(status);
CREATE INDEX idx_join_requests_created ON join_requests(created_at);
CREATE UNIQUE INDEX idx_join_requests_email_pending_unique ON join_requests(email) WHERE status = 'pending';
