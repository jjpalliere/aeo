// src/services/assistant-tools.ts
// Read-only tool registry exposed to the AI Chat assistant via Claude tool-use.
// Every handler receives scoping (runId, teamId, brandId) from closure — NEVER from tool input.

import type { Env } from '../types'

export type ToolName =
  | 'get_run_overview'
  | 'compare_llm_performance'
  | 'get_brand_rankings'
  | 'get_citations'
  | 'search_brand_mentions'

export interface ToolCtx {
  db: D1Database
  runId: string
  teamId: string
  brandId: string
}

export interface ToolSchema {
  name: ToolName
  description: string
  input_schema: Record<string, unknown>
}

export interface ToolDef extends ToolSchema {
  handler: (ctx: ToolCtx, input: Record<string, any>) => Promise<unknown>
}

const ENUMS = {
  llm: ['claude', 'chatgpt', 'gemini'] as const,
  funnel_stage: ['tofu', 'mofu', 'bofu'] as const,
  source_type: ['owned', 'competitor', 'news', 'industry', 'unknown'] as const,
  group_by: ['domain', 'source_type', 'url'] as const,
} as const

function clampLimit(v: unknown, max = 200, def = 50): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n)) return def
  return Math.max(1, Math.min(max, n))
}

// ─── Tool handlers ──────────────────────────────────────────────────────────

async function handleGetRunOverview(ctx: ToolCtx): Promise<unknown> {
  const meta = await ctx.db.prepare(
    `SELECT r.id, r.status, r.total_queries, r.completed_queries,
            b.name AS brand_name, b.domain AS brand_domain
     FROM runs r JOIN brands b ON b.id = r.brand_id
     WHERE r.id = ?1 AND r.team_id = ?2`
  ).bind(ctx.runId, ctx.teamId).first<{
    id: string; status: string; total_queries: number; completed_queries: number
    brand_name: string; brand_domain: string
  }>()
  if (!meta) return { error: 'run not found' }

  const { results: llms } = await ctx.db.prepare(
    `SELECT q.llm, COUNT(*) AS query_count
     FROM queries q JOIN runs r ON r.id = q.run_id
     WHERE r.id = ?1 AND r.team_id = ?2
     GROUP BY q.llm`
  ).bind(ctx.runId, ctx.teamId).all<{ llm: string; query_count: number }>()

  const personaRow = await ctx.db.prepare(
    `SELECT COUNT(DISTINCT q.persona_id) AS persona_count
     FROM queries q JOIN runs r ON r.id = q.run_id
     WHERE r.id = ?1 AND r.team_id = ?2`
  ).bind(ctx.runId, ctx.teamId).first<{ persona_count: number }>()

  const promptRow = await ctx.db.prepare(
    `SELECT COUNT(DISTINCT q.prompt_id) AS prompt_count
     FROM queries q JOIN runs r ON r.id = q.run_id
     WHERE r.id = ?1 AND r.team_id = ?2`
  ).bind(ctx.runId, ctx.teamId).first<{ prompt_count: number }>()

  return {
    brand_name: meta.brand_name,
    brand_domain: meta.brand_domain,
    status: meta.status,
    total_queries: meta.total_queries,
    completed_queries: meta.completed_queries,
    persona_count: personaRow?.persona_count ?? 0,
    prompt_count: promptRow?.prompt_count ?? 0,
    llms: llms ?? [],
  }
}

async function handleCompareLlmPerformance(ctx: ToolCtx): Promise<unknown> {
  const { results } = await ctx.db.prepare(
    `SELECT q.llm,
            COUNT(DISTINCT q.id) AS query_count,
            ROUND(
              CAST(COUNT(DISTINCT CASE WHEN bm.is_target = 1 THEN q.id END) AS REAL)
              / NULLIF(COUNT(DISTINCT q.id), 0),
              3
            ) AS mention_rate,
            ROUND(AVG(CASE WHEN bm.is_target = 1 THEN bm.rank END), 2) AS avg_target_rank,
            ROUND(
              CAST(SUM(CASE WHEN c.source_type = 'owned' THEN 1 ELSE 0 END) AS REAL)
              / NULLIF(COUNT(c.id), 0),
              3
            ) AS owned_citation_rate
     FROM queries q
     JOIN runs r ON r.id = q.run_id
     LEFT JOIN brand_mentions bm ON bm.query_id = q.id
     LEFT JOIN citations c ON c.query_id = q.id AND c.domain != '_none_'
     WHERE r.id = ?1 AND r.team_id = ?2
     GROUP BY q.llm
     ORDER BY q.llm`
  ).bind(ctx.runId, ctx.teamId).all()
  return results ?? []
}

async function handleGetBrandRankings(
  ctx: ToolCtx,
  input: { llm?: string; funnel_stage?: string; persona_id?: string; only_target?: boolean }
): Promise<unknown> {
  const binds: unknown[] = [ctx.runId, ctx.teamId]
  const clauses: string[] = []
  if (input.llm) { clauses.push('AND q.llm = ?'); binds.push(input.llm) }
  if (input.funnel_stage) { clauses.push('AND p.funnel_stage = ?'); binds.push(input.funnel_stage) }
  if (input.persona_id) { clauses.push('AND q.persona_id = ?'); binds.push(input.persona_id) }
  if (input.only_target) clauses.push('AND bm.is_target = 1')

  const sql = `SELECT bm.brand_name,
                      MAX(bm.is_target) AS is_target,
                      COUNT(*) AS mention_count,
                      ROUND(AVG(bm.rank), 2) AS avg_rank,
                      MIN(bm.rank) AS best_rank,
                      MAX(bm.rank) AS worst_rank
               FROM brand_mentions bm
               JOIN queries q ON q.id = bm.query_id
               JOIN runs r ON r.id = q.run_id
               LEFT JOIN prompts p ON p.id = q.prompt_id
               WHERE r.id = ?1 AND r.team_id = ?2
                 ${clauses.join(' ')}
               GROUP BY bm.brand_name
               ORDER BY avg_rank ASC
               LIMIT 50`

  const { results: rows } = await ctx.db.prepare(sql).bind(...binds).all<{
    brand_name: string; is_target: number; mention_count: number
    avg_rank: number; best_rank: number; worst_rank: number
  }>()

  if (!rows || rows.length === 0) return []

  // Fetch up to 3 distinct positionings per brand using a window function
  const names = rows.map(r => r.brand_name)
  const placeholders = names.map(() => '?').join(',')
  const posSql = `WITH distinct_positioning AS (
                    SELECT DISTINCT bm.brand_name, bm.positioning
                    FROM brand_mentions bm
                    JOIN queries q ON q.id = bm.query_id
                    JOIN runs r ON r.id = q.run_id
                    WHERE r.id = ? AND r.team_id = ?
                      AND bm.positioning IS NOT NULL
                      AND bm.brand_name IN (${placeholders})
                  ),
                  ranked AS (
                    SELECT brand_name, positioning,
                           ROW_NUMBER() OVER (PARTITION BY brand_name ORDER BY positioning) AS rn
                    FROM distinct_positioning
                  )
                  SELECT brand_name, positioning FROM ranked WHERE rn <= 3`
  const { results: posRows } = await ctx.db.prepare(posSql).bind(ctx.runId, ctx.teamId, ...names).all<{
    brand_name: string; positioning: string
  }>()

  const posMap: Record<string, string[]> = {}
  for (const pr of posRows ?? []) {
    if (!posMap[pr.brand_name]) posMap[pr.brand_name] = []
    posMap[pr.brand_name].push(pr.positioning)
  }

  return rows.map(r => ({ ...r, positionings: posMap[r.brand_name] ?? [] }))
}

async function handleGetCitations(
  ctx: ToolCtx,
  input: {
    source_type?: string; domain?: string; llm?: string
    group_by: string; limit?: number; text_contains?: string
  }
): Promise<unknown> {
  const groupBy = input.group_by
  const limit = clampLimit(input.limit, 200, 25)
  const binds: unknown[] = [ctx.runId, ctx.teamId]
  const clauses: string[] = []
  if (input.source_type) { clauses.push('AND c.source_type = ?'); binds.push(input.source_type) }
  if (input.domain) { clauses.push("AND c.domain LIKE '%' || ? || '%'"); binds.push(input.domain) }
  if (input.llm) { clauses.push('AND q.llm = ?'); binds.push(input.llm) }
  if (input.text_contains) { clauses.push("AND c.on_page_text LIKE '%' || ? || '%'"); binds.push(input.text_contains) }

  const cte = `WITH filtered AS (
                 SELECT c.id, c.url, c.domain, c.page_title, c.company_name,
                        c.source_type, c.on_page_text, q.llm
                 FROM citations c
                 JOIN queries q ON q.id = c.query_id
                 JOIN runs r ON r.id = q.run_id
                 WHERE r.id = ?1 AND r.team_id = ?2
                   AND c.domain != '_none_'
                   ${clauses.join(' ')}
               )`

  let rowsSql: string
  let rowsBinds: unknown[]

  if (groupBy === 'domain') {
    rowsSql = `${cte}
               SELECT domain, COUNT(*) AS count,
                      MAX(source_type) AS sample_source_type,
                      MAX(company_name) AS sample_company_name
               FROM filtered GROUP BY domain
               ORDER BY count DESC LIMIT ?`
    rowsBinds = [...binds, limit]
  } else if (groupBy === 'source_type') {
    rowsSql = `${cte}
               SELECT source_type, COUNT(*) AS count
               FROM filtered GROUP BY source_type ORDER BY count DESC`
    rowsBinds = binds
  } else { // 'url'
    rowsSql = `${cte}
               SELECT url,
                      MAX(domain) AS domain,
                      MAX(source_type) AS source_type,
                      MAX(page_title) AS page_title,
                      MAX(company_name) AS company_name,
                      COUNT(*) AS count
               FROM filtered GROUP BY url
               ORDER BY count DESC LIMIT ?`
    rowsBinds = [...binds, limit]
  }

  const { results: rows } = await ctx.db.prepare(rowsSql).bind(...rowsBinds).all()

  const totalRow = await ctx.db.prepare(`${cte} SELECT COUNT(*) AS total FROM filtered`)
    .bind(...binds).first<{ total: number }>()

  return { group_by: groupBy, rows: rows ?? [], total_citations: totalRow?.total ?? 0 }
}

async function handleSearchBrandMentions(
  ctx: ToolCtx,
  input: { brand_name?: string; contains?: string; only_target?: boolean; limit?: number }
): Promise<unknown> {
  const limit = clampLimit(input.limit, 100, 25)
  const binds: unknown[] = [ctx.runId, ctx.teamId]
  const clauses: string[] = []
  if (input.brand_name) { clauses.push('AND LOWER(bm.brand_name) = LOWER(?)'); binds.push(input.brand_name) }
  if (input.contains) { clauses.push("AND bm.context_snippet LIKE '%' || ? || '%'"); binds.push(input.contains) }
  if (input.only_target) clauses.push('AND bm.is_target = 1')

  const sql = `SELECT bm.brand_name, bm.rank, bm.is_target,
                      bm.context_snippet, bm.positioning,
                      q.llm, p.funnel_stage
               FROM brand_mentions bm
               JOIN queries q ON q.id = bm.query_id
               JOIN runs r ON r.id = q.run_id
               LEFT JOIN prompts p ON p.id = q.prompt_id
               WHERE r.id = ?1 AND r.team_id = ?2
                 ${clauses.join(' ')}
               ORDER BY bm.is_target DESC, bm.rank ASC
               LIMIT ?`

  const { results } = await ctx.db.prepare(sql).bind(...binds, limit).all<{
    brand_name: string; rank: number; is_target: number
    context_snippet: string | null; positioning: string | null
    llm: string; funnel_stage: string | null
  }>()

  // Truncate text fields for injection surface + token size
  return (results ?? []).map(r => ({
    ...r,
    context_snippet: r.context_snippet ? r.context_snippet.slice(0, 400) : null,
    positioning: r.positioning ? r.positioning.slice(0, 200) : null,
  }))
}

// ─── Registry ───────────────────────────────────────────────────────────────

export const TOOL_REGISTRY: Record<ToolName, ToolDef> = {
  get_run_overview: {
    name: 'get_run_overview',
    description:
      'Returns high-level info about the current run: target brand name/domain, run status, total/completed query counts, number of personas, number of prompts, and which LLMs were queried. Call once at the start of a conversation to ground your answers. Takes no arguments.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (ctx) => handleGetRunOverview(ctx),
  },
  compare_llm_performance: {
    name: 'compare_llm_performance',
    description:
      "Per-LLM rollup across all queries in this run. For each LLM returns query_count, mention_rate (share of queries where target brand was mentioned), avg_target_rank (avg rank when mentioned), and owned_citation_rate (share of citations that are source_type='owned'). Use to answer 'which LLM ranks us worst' or 'where do we have the most ground to cover'.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (ctx) => handleCompareLlmPerformance(ctx),
  },
  get_brand_rankings: {
    name: 'get_brand_rankings',
    description:
      'Aggregated brand-mention leaderboard for this run. Returns one row per brand_name with mention_count, avg_rank, best_rank, worst_rank, is_target flag, and up to 3 sample positionings. Filterable by LLM, funnel stage, persona, or target-only. Use to compare brand visibility against competitors.',
    input_schema: {
      type: 'object',
      properties: {
        llm: { type: 'string', enum: ['claude', 'chatgpt', 'gemini'] },
        funnel_stage: { type: 'string', enum: ['tofu', 'mofu', 'bofu'] },
        persona_id: { type: 'string' },
        only_target: { type: 'boolean', description: 'If true, return only rows where is_target=1.' },
      },
      additionalProperties: false,
    },
    handler: (ctx, input) => handleGetBrandRankings(ctx, input),
  },
  get_citations: {
    name: 'get_citations',
    description:
      'Citation rollup. Groups citations by domain, source_type, or url and returns counts plus sample metadata (page_title, company_name). Filterable by source_type, domain substring, LLM, and/or a substring that must appear in citations.on_page_text. Use to find which sources AI engines lean on, or to find citations whose on-page text mentions a specific topic.',
    input_schema: {
      type: 'object',
      properties: {
        source_type: { type: 'string', enum: ['owned', 'competitor', 'news', 'industry', 'unknown'] },
        domain: { type: 'string', description: 'Case-insensitive substring match against citations.domain.' },
        llm: { type: 'string', enum: ['claude', 'chatgpt', 'gemini'] },
        group_by: { type: 'string', enum: ['domain', 'source_type', 'url'], default: 'domain' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
        text_contains: {
          type: 'string',
          description:
            'Case-insensitive substring match against citations.on_page_text. When provided, only citations whose scraped on-page text contains this phrase are included.',
        },
      },
      required: ['group_by'],
      additionalProperties: false,
    },
    handler: (ctx, input) => handleGetCitations(ctx, input),
  },
  search_brand_mentions: {
    name: 'search_brand_mentions',
    description:
      "Search brand_mentions by brand name and/or context snippet substring. Returns mention rows with brand_name, rank, is_target, context_snippet, positioning, plus the query's LLM and funnel_stage. Use to read how the target brand (or a specific competitor) is being described, or to find mentions matching a keyword.",
    input_schema: {
      type: 'object',
      properties: {
        brand_name: {
          type: 'string',
          description: 'Case-insensitive exact match against brand_mentions.brand_name.',
        },
        contains: {
          type: 'string',
          description: 'Case-insensitive substring match against brand_mentions.context_snippet.',
        },
        only_target: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
      additionalProperties: false,
    },
    handler: (ctx, input) => handleSearchBrandMentions(ctx, input),
  },
}

export function getToolSchemas(): ToolSchema[] {
  return Object.values(TOOL_REGISTRY).map(({ name, description, input_schema }) => ({
    name, description, input_schema,
  }))
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export type DispatchResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

export async function dispatchTool(
  name: string,
  rawInput: unknown,
  ctx: ToolCtx,
): Promise<DispatchResult> {
  if (!(name in TOOL_REGISTRY)) return { ok: false, error: 'unknown tool' }

  // Shallow clone + strip scoping keys. Defence in depth — handlers read scoping
  // from `ctx` (closure), not from input, but this prevents any accidental read.
  const input: Record<string, any> = { ...(rawInput as Record<string, any> ?? {}) }
  delete input.run_id
  delete input.team_id
  delete input.brand_id

  // Required-field check: get_citations needs group_by.
  if (name === 'get_citations' && !input.group_by) {
    return { ok: false, error: 'group_by is required' }
  }

  // Enum validation — reject before SQL.
  for (const key of ['llm', 'funnel_stage', 'source_type', 'group_by'] as const) {
    if (input[key] != null && !(ENUMS[key] as readonly string[]).includes(String(input[key]))) {
      return { ok: false, error: `invalid ${key}` }
    }
  }

  // Clamp limit if present.
  if ('limit' in input) input.limit = clampLimit(input.limit)

  try {
    const result = await TOOL_REGISTRY[name as ToolName].handler(ctx, input)
    // Enforce ≤ 16KB serialized. If over, clip row list when present.
    const serialized = JSON.stringify(result)
    if (serialized.length > 16384 && (result as any)?.rows && Array.isArray((result as any).rows)) {
      const rows = (result as any).rows as unknown[]
      let lo = 0
      let hi = rows.length
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        const test = JSON.stringify({
          ...(result as any),
          rows: rows.slice(0, mid),
          _truncated: true,
          shown: mid,
        })
        if (test.length > 16384) hi = mid - 1
        else lo = mid
      }
      const shown = Math.max(1, lo)
      return {
        ok: true,
        result: { ...(result as any), rows: rows.slice(0, shown), _truncated: true, shown },
      }
    }
    if (serialized.length > 16384 && Array.isArray(result)) {
      // Top-level array result — clip similarly.
      let lo = 0
      let hi = result.length
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        const test = JSON.stringify({ rows: result.slice(0, mid), _truncated: true, shown: mid })
        if (test.length > 16384) hi = mid - 1
        else lo = mid
      }
      const shown = Math.max(1, lo)
      return {
        ok: true,
        result: { rows: (result as unknown[]).slice(0, shown), _truncated: true, shown },
      }
    }
    return { ok: true, result }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg.slice(0, 200) }
  }
}
