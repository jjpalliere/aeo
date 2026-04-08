import { Hono } from 'hono'
import type { Env } from '../types'
import { requireRun } from '../middleware/scope'

const assistant = new Hono<{ Bindings: Env }>()

// POST /api/assistant — query the AI assistant about a run
assistant.post('/', async c => {
  const body = await c.req.json<{ run_id: string; question: string }>()
  if (!body.run_id || !body.question) {
    return c.json({ error: 'run_id and question are required' }, 400)
  }

  const { run_id, question } = body

  // Validate run ownership before accessing any data
  const runCheck = await requireRun(c, run_id)
  if (!runCheck) return c.json({ error: 'Not found' }, 404)

  // Gather context data
  const run = await c.env.DB.prepare(
    `SELECT r.*, b.name as brand_name, b.domain as brand_domain
     FROM runs r JOIN brands b ON b.id = r.brand_id WHERE r.id = ?`
  )
    .bind(run_id)
    .first<{ brand_name: string; brand_domain: string; status: string; completed_queries: number; total_queries: number }>()

  if (!run) return c.json({ error: 'Run not found' }, 404)

  // Competitor ranking summary
  const { results: competitorRanks } = await c.env.DB.prepare(
    `SELECT bm.brand_name, bm.is_target,
            COUNT(*) as mention_count,
            ROUND(AVG(bm.rank), 1) as avg_rank,
            (SELECT bm2.positioning FROM brand_mentions bm2
             JOIN queries q2 ON q2.id = bm2.query_id
             WHERE q2.run_id = q.run_id AND bm2.brand_name = bm.brand_name AND bm2.positioning IS NOT NULL
             LIMIT 1) as positioning
     FROM brand_mentions bm
     JOIN queries q ON q.id = bm.query_id
     WHERE q.run_id = ?
     GROUP BY bm.brand_name
     ORDER BY avg_rank ASC
     LIMIT 15`
  )
    .bind(run_id)
    .all<{ brand_name: string; is_target: number; mention_count: number; avg_rank: number; positioning: string | null }>()

  // Top cited domains
  const { results: topDomains } = await c.env.DB.prepare(
    `SELECT c.domain, c.company_name, c.source_type, COUNT(*) as count
     FROM citations c JOIN queries q ON q.id = c.query_id
     WHERE q.run_id = ? AND c.domain != '_none_'
     GROUP BY c.domain ORDER BY count DESC LIMIT 10`
  )
    .bind(run_id)
    .all<{ domain: string; company_name: string; source_type: string; count: number }>()

  // Source type distribution
  const { results: sourceTypes } = await c.env.DB.prepare(
    `SELECT c.source_type, COUNT(*) as count
     FROM citations c JOIN queries q ON q.id = c.query_id
     WHERE q.run_id = ? AND c.domain != '_none_'
     GROUP BY c.source_type`
  )
    .bind(run_id)
    .all<{ source_type: string; count: number }>()

  // Sample context snippets for the brand
  const { results: brandSnippets } = await c.env.DB.prepare(
    `SELECT bm.brand_name, bm.rank, bm.context_snippet, q.llm, p.funnel_stage
     FROM brand_mentions bm
     JOIN queries q ON q.id = bm.query_id
     JOIN prompts p ON p.id = q.prompt_id
     WHERE q.run_id = ? AND bm.is_target = 1
     ORDER BY bm.rank ASC LIMIT 10`
  )
    .bind(run_id)
    .all<{ brand_name: string; rank: number; context_snippet: string; llm: string; funnel_stage: string }>()

  // Owned pages
  const { results: ownedPages } = await c.env.DB.prepare(
    `SELECT c.url, COUNT(*) as count
     FROM citations c JOIN queries q ON q.id = c.query_id
     WHERE q.run_id = ? AND c.source_type = 'owned'
     GROUP BY c.url ORDER BY count DESC LIMIT 10`
  )
    .bind(run_id)
    .all<{ url: string; count: number }>()

  // Build system context
  const competitorSummary = competitorRanks
    .map(r => `- ${r.brand_name}${r.is_target ? ' [TARGET BRAND]' : ''}: mentioned ${r.mention_count}x, avg rank ${r.avg_rank}${r.positioning ? ` — "${r.positioning}"` : ''}`)
    .join('\n')

  const domainSummary = topDomains
    .map(d => `- ${d.domain} (${d.source_type}): cited ${d.count}x`)
    .join('\n')

  const sourceTypeSummary = sourceTypes
    .map(s => `- ${s.source_type}: ${s.count} citations`)
    .join('\n')

  const ownedPageSummary = ownedPages.length > 0
    ? ownedPages.map(p => `- ${p.url}: cited ${p.count}x`).join('\n')
    : 'No owned pages were cited'

  const snippetSummary = brandSnippets
    .map(s => `[${s.llm}, rank ${s.rank}, ${s.funnel_stage}]: "${s.context_snippet}"`)
    .join('\n')

  const systemPrompt = `You are an AEO (Answer Engine Optimization) analyst assistant with access to LLM visibility data for a brand.

BRAND: ${run.brand_name} (${run.brand_domain})
RUN STATUS: ${run.status}${run.total_queries > 0 ? ` (${run.completed_queries ?? 0} / ${run.total_queries} queries complete, ${Math.round(((run.completed_queries ?? 0) / run.total_queries) * 100)}%)` : ''}

## Brand & Competitor Rankings
${competitorSummary || 'No mentions data yet'}

## Top Cited Domains
${domainSummary || 'No citations yet'}

## Citation Source Type Distribution
${sourceTypeSummary || 'No citations yet'}

## Most Cited Owned Pages
${ownedPageSummary}

## How the Brand Is Described (sample context snippets)
${snippetSummary || 'No brand mentions yet'}

Answer the user's question based on this data. Be specific, data-driven, and actionable.
If the data doesn't support a definitive answer, say so clearly.
Focus on what the user can actually do to improve their brand's AI visibility.`

  // Call Claude
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': c.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: question }],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    return c.json({ error: `Claude error: ${err}` }, 500)
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>
  }
  const answer = data.content[0]?.text ?? ''

  return c.json({ answer })
})

export { assistant }
