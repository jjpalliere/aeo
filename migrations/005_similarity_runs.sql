-- 005_similarity_runs.sql — Map AEO brands to Similarity Browser KV run ids

CREATE TABLE similarity_runs (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  run_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (brand_id, run_id)
);

-- Extra brand index: optional if you rely on UNIQUE(brand_id, run_id) for brand-only lookups; safe to drop in a follow-up migration if you want less redundancy.
CREATE INDEX idx_similarity_runs_brand ON similarity_runs(brand_id);
