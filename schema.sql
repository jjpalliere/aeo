CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  name TEXT,
  scraped_content TEXT, -- JSON: { pages: [{ url, title, text }], summary: string }
  supplement TEXT,      -- ICP / persona text uploaded by user
  status TEXT DEFAULT 'scraping', -- scraping | ready | failed
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  persona_id TEXT REFERENCES personas(id),
  text TEXT NOT NULL,
  funnel_stage TEXT NOT NULL, -- tofu | mofu | bofu
  rationale TEXT,
  approved INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  goals TEXT,           -- JSON array of goal strings
  pain_points TEXT,     -- JSON array of pain point strings
  system_message TEXT NOT NULL,
  rationale TEXT,
  approved INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  status TEXT DEFAULT 'pending', -- pending | querying | scraping | analyzing | complete | failed
  total_queries INTEGER DEFAULT 0,
  completed_queries INTEGER DEFAULT 0,
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS queries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  prompt_id TEXT NOT NULL REFERENCES prompts(id),
  persona_id TEXT NOT NULL REFERENCES personas(id),
  llm TEXT NOT NULL, -- claude | chatgpt | gemini
  response_text TEXT,
  status TEXT DEFAULT 'pending', -- pending | processing | complete | failed
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS citations (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL REFERENCES queries(id),
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  page_title TEXT,
  on_page_text TEXT,
  company_name TEXT,
  source_type TEXT DEFAULT 'unknown', -- owned | competitor | news | industry | unknown
  scraped_ok INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS brand_mentions (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL REFERENCES queries(id),
  brand_name TEXT NOT NULL,
  rank INTEGER NOT NULL,
  is_target INTEGER DEFAULT 0,
  context_snippet TEXT,
  positioning TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_prompts_brand ON prompts(brand_id);
CREATE INDEX IF NOT EXISTS idx_personas_brand ON personas(brand_id);
CREATE INDEX IF NOT EXISTS idx_queries_run ON queries(run_id);
CREATE INDEX IF NOT EXISTS idx_queries_status ON queries(run_id, status);
CREATE INDEX IF NOT EXISTS idx_citations_query ON citations(query_id);
CREATE INDEX IF NOT EXISTS idx_brand_mentions_query ON brand_mentions(query_id);
CREATE INDEX IF NOT EXISTS idx_brand_mentions_run ON brand_mentions(query_id);
