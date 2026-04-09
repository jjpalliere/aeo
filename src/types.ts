export interface Env {
  DB: D1Database
  KV: KVNamespace
  /** Optional: Similarity Browser KV (same namespace as Pages app) for listing run keys */
  SIMILARITY_KV?: KVNamespace
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  GOOGLE_AI_API_KEY: string
  RESEND_API_KEY: string
  ASSETS: Fetcher
  /** Base URL for magic links (e.g. https://aeo.jjpalier.dev). Defaults to terrain.run if unset. */
  SITE_URL?: string
}

export interface Account {
  id: string
  email: string
  is_owner: number
  created_at: string
}

export interface Team {
  id: string
  name: string
  invite_code: string
  created_by: string
  created_at: string
}

export interface Session {
  id: string
  account_id: string
  active_team_id: string | null
  active_brand_id: string | null
  token: string
  expires_at: string
  created_at: string
}

export interface MagicLink {
  id: string
  email: string
  token: string
  expires_at: string
  used: number
  created_at: string
}

export interface SignupCode {
  id: string
  code: string
  max_uses: number
  times_used: number
  created_by: string | null
  created_at: string
}

export interface Brand {
  id: string
  url: string
  domain: string
  name: string | null
  scraped_content: string | null // JSON string
  supplement: string | null      // ICP / persona text uploaded by user
  status: 'scraping' | 'generating' | 'personas_ready' | 'generating_prompts' | 'ready' | 'failed' | 'scrape_blocked'
  team_id: string               // nullable in SQLite, enforced NOT NULL in app layer
  created_at: string
}

export interface ScrapedPage {
  url: string
  title: string
  description: string
  text: string
}

export interface ScrapedContent {
  pages: ScrapedPage[]
  summary: string
  brand_name: string
  industry_keywords: string[]
}

export interface Prompt {
  id: string
  brand_id: string
  persona_id: string | null
  text: string
  funnel_stage: 'tofu' | 'mofu' | 'bofu'
  rationale: string | null
  approved: number
  team_id: string
  created_at: string
}

export interface Persona {
  id: string
  brand_id: string
  name: string
  description: string
  goals: string | null
  pain_points: string | null
  system_message: string
  rationale: string | null
  approved: number
  team_id: string
  created_at: string
}

export interface Run {
  id: string
  brand_id: string
  status: 'pending' | 'querying' | 'scraping' | 'analyzing' | 'complete' | 'failed'
  total_queries: number
  completed_queries: number
  error: string | null
  team_id: string
  created_at: string
  completed_at: string | null
}

// Query, Citation, BrandMention — no team_id (scoped via parent run/brand)

export interface Query {
  id: string
  run_id: string
  prompt_id: string
  persona_id: string
  llm: 'claude' | 'chatgpt' | 'gemini'
  response_text: string | null
  status: 'pending' | 'processing' | 'complete' | 'failed'
  created_at: string
  // joined fields
  prompt_text?: string
  system_message?: string
  funnel_stage?: string
}

export interface Citation {
  id: string
  query_id: string
  url: string
  domain: string
  page_title?: string | null
  on_page_text: string | null
  company_name: string | null
  source_type: 'owned' | 'competitor' | 'news' | 'industry' | 'unknown'
  scraped_ok: number
  created_at: string
}

export interface BrandMention {
  id: string
  query_id: string
  brand_name: string
  rank: number
  is_target: number
  context_snippet: string | null
  positioning: string | null
  created_at: string
}

export interface ProcessResult {
  phase: string
  total: number
  completed: number
  done: boolean
  error?: string
}

export interface LLMApiKeys {
  anthropic: string
  openai: string
  google: string
}

// Hono context variables — injected by session middleware
declare module 'hono' {
  interface ContextVariableMap {
    account: { id: string; email: string; is_owner: number }
    teamId: string
    brandId: string | null
    sessionId: string
  }
}
