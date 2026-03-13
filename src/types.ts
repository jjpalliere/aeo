export interface Env {
  DB: D1Database
  KV: KVNamespace
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  GOOGLE_AI_API_KEY: string
  ASSETS: Fetcher
}

export interface Brand {
  id: string
  url: string
  domain: string
  name: string | null
  scraped_content: string | null // JSON string
  supplement: string | null      // ICP / persona text uploaded by user
  status: 'scraping' | 'generating' | 'personas_ready' | 'generating_prompts' | 'ready' | 'failed' | 'scrape_blocked'
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
  created_at: string
}

export interface Persona {
  id: string
  brand_id: string
  name: string
  description: string
  system_message: string
  rationale: string | null
  approved: number
  created_at: string
}

export interface Run {
  id: string
  brand_id: string
  status: 'pending' | 'querying' | 'scraping' | 'analyzing' | 'complete' | 'failed'
  total_queries: number
  completed_queries: number
  error: string | null
  created_at: string
  completed_at: string | null
}

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
