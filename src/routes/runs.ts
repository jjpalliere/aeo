import { Hono } from 'hono'
import type { Env, Run, Query, Brand } from '../types'
import { queryLLM, extractCitations, type LLMResponse } from '../services/llm'
import { scrapeCitation } from '../services/citation'
import { extractBrandMentions } from '../services/generator'
import { analyzeRun } from '../services/analyzer'

const runs = new Hono<{ Bindings: Env }>()

// Appends run log lines to KV (visible as terminal in live.html)
function makeRunReporter(runId: string, env: Env) {
  const short = runId.slice(0, 8)
  const logsKey = `logs:run:${runId}`

  const log = async (line: string) => {
    console.log(line)
    try {
      const existing = await env.KV.get(logsKey) || ''
      await env.KV.put(
        logsKey,
        existing ? `${existing}\n${line}` : line,
        { expirationTtl: 3600 },
      )
    } catch { /* non-fatal */ }
  }
  return { log }
}

const QUERY_BATCH = 3
// Claude tier limit: 30k input tokens/min. ~1k tokens/query × 3 = 3k/batch → 10 batches/min max → 6s min delay. Use 12s to stay safely under.
const DELAY_AFTER_CLAUDE_BATCH_MS = 12_000
const DELAY_AFTER_429_MS = 30_000 // Brief backoff when we hit limit; bucket replenishes over time

// Kick off the next /process call server-side so runs are self-driving
function scheduleNextProcess(
  c: { executionCtx: ExecutionContext; req: { url: string; header: (name: string) => string | undefined }; env: Env },
  runId: string
) {
  const origin = new URL(c.req.url).origin
  const short = runId.slice(0, 8)
  const logsKey = `logs:run:${runId}`
  const appendLog = async (line: string) => {
    try {
      const existing = await c.env.KV.get(logsKey) || ''
      await c.env.KV.put(logsKey, existing ? `${existing}\n${line}` : line, { expirationTtl: 3600 })
    } catch { /* non-fatal */ }
  }
  // Forward the auth cookie so the self-fetch passes the auth middleware
  const cookie = c.req.header('Cookie') ?? ''
  c.executionCtx.waitUntil(
    new Promise<void>(r => setTimeout(r, 150)).then(() =>
      fetch(`${origin}/api/runs/${runId}/process`, {
        method: 'POST',
        headers: { Cookie: cookie },
      })
        .then(async r => {
          if (!r.ok) {
            const msg = `[${short}] ✗ scheduleNextProcess → HTTP ${r.status}`
            console.error(`[run:${short}] scheduleNextProcess → HTTP ${r.status}`)
            await appendLog(msg)
          }
        })
        .catch(async err => {
          const msg = `[${short}] ✗ scheduleNextProcess failed: ${err}`
          console.error(`[run:${short}] scheduleNextProcess → fetch failed: ${err}`)
          await appendLog(msg)
        })
    )
  )
}

// GET /api/runs/list — list all runs across all brands (for sidebar)
runs.get('/list', async c => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.brand_id, r.status, r.created_at, r.total_queries, r.completed_queries, b.name as brand_name, b.domain as brand_domain
     FROM runs r JOIN brands b ON b.id = r.brand_id
     ORDER BY r.created_at DESC`
  ).all()
  return c.json({ runs: results || [] })
})

// POST /api/runs — create a run for a brand
runs.post('/', async c => {
  const body = await c.req.json<{ brand_id: string }>()
  if (!body.brand_id) return c.json({ error: 'brand_id is required' }, 400)

  const brand = await c.env.DB.prepare(`SELECT * FROM brands WHERE id = ?`)
    .bind(body.brand_id)
    .first<Brand>()

  if (!brand) return c.json({ error: 'Brand not found' }, 404)
  if (brand.status !== 'ready') return c.json({ error: 'Brand is not ready yet' }, 400)

  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO runs (id, brand_id, status) VALUES (?, ?, 'pending')`
  )
    .bind(id, body.brand_id)
    .run()

  const short = id.slice(0, 8)
  console.log(`[run:${short}] created — kicking off self-driving process loop`)
  try {
    const logsKey = `logs:run:${id}`
    await c.env.KV.put(logsKey, `[${short}] Run created — starting process loop`, { expirationTtl: 3600 })
  } catch { /* non-fatal */ }

  scheduleNextProcess(c, id)

  return c.json({ id })
})

// GET /api/runs/:id — run status
runs.get('/:id', async c => {
  const runId = c.req.param('id')
  const run = await c.env.DB.prepare(`SELECT * FROM runs WHERE id = ?`)
    .bind(runId)
    .first<Run>()

  if (!run) {
    console.log(`[runs] GET /${runId.slice(0, 8)} — not found`)
    return c.json({ error: 'Not found' }, 404)
  }
  console.log(`[runs] GET /${runId.slice(0, 8)} — status=${run.status}, ${run.completed_queries}/${run.total_queries}`)
  return c.json(run)
})

// GET /api/runs/:id/logs — run progression log (terminal output)
runs.get('/:id/logs', async c => {
  const runId = c.req.param('id')
  const run = await c.env.DB.prepare(`SELECT id FROM runs WHERE id = ?`).bind(runId).first()
  if (!run) return c.json({ error: 'Not found' }, 404)

  const raw = await c.env.KV.get(`logs:run:${runId}`) || ''
  const logs = raw ? raw.split('\n').filter(Boolean) : []
  return c.json({ logs })
})

// POST /api/runs/:id/process — advance the run by one batch
runs.post('/:id/process', async c => {
  const runId = c.req.param('id')
  const run = await c.env.DB.prepare(`SELECT * FROM runs WHERE id = ?`)
    .bind(runId)
    .first<Run>()

  if (!run) return c.json({ error: 'Not found' }, 404)
  if (run.status === 'complete' || run.status === 'failed') {
    return c.json({ phase: run.status, done: true, total: run.total_queries, completed: run.completed_queries })
  }

  const brand = await c.env.DB.prepare(`SELECT * FROM brands WHERE id = ?`)
    .bind(run.brand_id)
    .first<Brand>()

  if (!brand) return c.json({ error: 'Brand not found' }, 500)

  const short = runId.slice(0, 8)
  const { log } = makeRunReporter(runId, c.env)
  console.log(`[run:${short}] /process → status=${run.status}`)
  await log(`[${short}] /process → status=${run.status}`)

  // ─── Process lock — prevent concurrent batches hammering the Claude rate limit
  const lockKey = `lock:process:${runId}`
  const isLocked = await c.env.KV.get(lockKey)
  if (isLocked) {
    await log(`[${short}] /process busy — another batch in flight, skipping`)
    console.log(`[run:${short}] /process busy — another batch in flight, skipping`)
    return c.json({ phase: run.status, total: run.total_queries, completed: run.completed_queries, done: false })
  }
  await c.env.KV.put(lockKey, '1', { expirationTtl: 90 })
  const unlock = () => c.env.KV.delete(lockKey).catch(() => {})
  console.log(`[run:${short}] lock acquired`)

  // ─── Phase: pending → querying ──────────────────────────────────────────────
  if (run.status === 'pending') {
    await log(`[${short}] Pending — creating queries from approved prompts/personas`)
    console.log(`[run:${short}] pending — creating queries from approved prompts/personas`)
    const { results: approvedPrompts } = await c.env.DB.prepare(
      `SELECT id, persona_id FROM prompts WHERE brand_id = ? AND approved = 1`
    )
      .bind(run.brand_id)
      .all<{ id: string; persona_id: string | null }>()

    const { results: approvedPersonas } = await c.env.DB.prepare(
      `SELECT * FROM personas WHERE brand_id = ? AND approved = 1`
    )
      .bind(run.brand_id)
      .all<{ id: string }>()

    if (approvedPrompts.length === 0) {
      await log(`[${short}] ✗ Error: No approved prompts`)
      console.error(`[run:${short}] No approved prompts`)
      await unlock(); return c.json({ error: 'No approved prompts' }, 400)
    }

    let personasToUse = approvedPersonas
    if (personasToUse.length === 0) {
      const DEFAULT_SYSTEM_MESSAGE = 'You are a helpful AI assistant. Answer the user\'s question thoughtfully and accurately. Do not mention that you are an AI.'
      const defaultPersonaId = crypto.randomUUID()
      await c.env.DB.prepare(
        `INSERT INTO personas (id, brand_id, name, description, goals, pain_points, system_message, rationale, approved) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)`
      ).bind(defaultPersonaId, run.brand_id, 'Default', '', '[]', '[]', DEFAULT_SYSTEM_MESSAGE).run()
      personasToUse = [{ id: defaultPersonaId }]
      await log(`[${short}] No approved personas — inserted default`)
      console.log(`[run:${short}] no approved personas — using default`)
    }

    const approvedPersonaIds = new Set(personasToUse.map(p => p.id))
    const llms: Array<'claude' | 'chatgpt' | 'gemini'> = ['claude', 'chatgpt', 'gemini']
    const stmts: D1PreparedStatement[] = []

    for (const prompt of approvedPrompts) {
      if (prompt.persona_id) {
        // Persona-specific prompt: use its owning persona only (skip if persona not approved/exists)
        if (!approvedPersonaIds.has(prompt.persona_id)) continue
        for (const llm of llms) {
          stmts.push(
            c.env.DB.prepare(
              `INSERT INTO queries (id, run_id, prompt_id, persona_id, llm, status) VALUES (?, ?, ?, ?, ?, 'pending')`
            ).bind(crypto.randomUUID(), runId, prompt.id, prompt.persona_id, llm)
          )
        }
      } else {
        // Legacy prompt (no persona_id): cross with all approved personas
        for (const persona of personasToUse) {
          for (const llm of llms) {
            stmts.push(
              c.env.DB.prepare(
                `INSERT INTO queries (id, run_id, prompt_id, persona_id, llm, status) VALUES (?, ?, ?, ?, ?, 'pending')`
              ).bind(crypto.randomUUID(), runId, prompt.id, persona.id, llm)
            )
          }
        }
      }
    }

    const total = stmts.length
    await log(`[${short}] Inserting ${total} queries (${approvedPrompts.length} prompts × 3 LLMs)`)
    console.log(`[run:${short}] pending — inserting ${total} queries`)
    const BATCH_SIZE = 50
    for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
      await c.env.DB.batch(stmts.slice(i, i + BATCH_SIZE))
    }
    await log(`[${short}] Pending → Querying`)
    console.log(`[run:${short}] pending → querying`)

    await c.env.DB.prepare(
      `UPDATE runs SET status = 'querying', total_queries = ? WHERE id = ?`
    )
      .bind(total, runId)
      .run()

    await unlock(); scheduleNextProcess(c, runId)
    return c.json({ phase: 'querying', total, completed: 0, done: false })
  }

  // ─── Phase: querying ────────────────────────────────────────────────────────
  if (run.status === 'querying') {
    // Claim a batch atomically
    const { results: pending } = await c.env.DB.prepare(
      `SELECT q.id, p.text as prompt_text, pe.system_message, q.llm
       FROM queries q
       JOIN prompts p ON p.id = q.prompt_id
       JOIN personas pe ON pe.id = q.persona_id
       WHERE q.run_id = ? AND q.status = 'pending'
       LIMIT ?`
    )
      .bind(runId, QUERY_BATCH)
      .all<Query>()

    if (pending.length === 0) {
      // Check for queries stuck in 'processing' (worker was killed mid-batch)
      // Reset them back to pending so they get retried rather than silently dropped
      const resetResult = await c.env.DB.prepare(
        `UPDATE queries SET status = 'pending' WHERE run_id = ? AND status = 'processing'`
      ).bind(runId).run()

      if (resetResult.meta.changes > 0) {
        await log(`[${short}] Reset ${resetResult.meta.changes} stuck queries, retrying`)
        console.log(`[run:${short}] querying — reset ${resetResult.meta.changes} stuck processing queries, retrying`)
        await unlock(); scheduleNextProcess(c, runId)
        return c.json({ phase: 'querying', total: run.total_queries, completed: run.completed_queries, done: false })
      }

      // Truly done — move to analyzing (citations scraped inline during querying)
      await log(`[${short}] Querying complete → Analyzing`)
      console.log(`[run:${short}] querying complete → analyzing`)
      await c.env.DB.prepare(`UPDATE runs SET status = 'analyzing' WHERE id = ?`)
        .bind(runId)
        .run()
      await unlock(); scheduleNextProcess(c, runId)
      return c.json({ phase: 'analyzing', total: run.total_queries, completed: run.total_queries, done: false })
    }

    // Mark as processing
    const ids = pending.map(q => q.id)
    await c.env.DB.batch(
      ids.map(id =>
        c.env.DB.prepare(`UPDATE queries SET status = 'processing' WHERE id = ?`).bind(id)
      )
    )

    const llmSummary = pending.map(q => q.llm).join(', ')
    await log(`[${short}] Querying batch of ${pending.length} [${llmSummary}]`)
    console.log(`[run:${short}] querying batch of ${pending.length} [${llmSummary}]`)

    const apiKeys = {
      anthropic: c.env.ANTHROPIC_API_KEY,
      openai: c.env.OPENAI_API_KEY,
      google: c.env.GOOGLE_AI_API_KEY,
    }

    // Run concurrently
    const results = await Promise.allSettled(
      pending.map(q =>
        queryLLM(q.llm as 'claude' | 'chatgpt' | 'gemini', q.system_message!, q.prompt_text!, apiKeys)
      )
    )

    const updateStmts = results.map((result, i) => {
      const q = pending[i]
      if (result.status === 'fulfilled') {
        console.log(`[run:${short}] ✓ ${q.llm} query done`)
        return c.env.DB.prepare(
          `UPDATE queries SET status = 'complete', response_text = ? WHERE id = ?`
        ).bind(result.value.response_text, q.id)
      } else {
        const is429 = String(result.reason).includes('429')
        if (is429) {
          console.log(`[run:${short}] ${q.llm} 429 — resetting to pending for retry`)
          return c.env.DB.prepare(`UPDATE queries SET status = 'pending' WHERE id = ?`).bind(q.id)
        }
        console.error(`[run:${short}] ✗ ${q.llm} query failed: ${result.reason}`)
        return c.env.DB.prepare(`UPDATE queries SET status = 'failed' WHERE id = ?`).bind(q.id)
      }
    })
    // Log LLM failures to KV (after batch, so we can await log once)
    const failed = results.filter((r, i) => r.status === 'rejected' && !String((r as PromiseRejectedResult).reason).includes('429'))
    if (failed.length > 0) {
      const summary = failed.map((r, i) => `${pending[i].llm}: ${String((r as PromiseRejectedResult).reason).slice(0, 400)}`).join('; ')
      await log(`[${short}] ✗ LLM failures: ${summary}`)
    }
    await c.env.DB.batch(updateStmts)

    // Throttle: if this batch had Claude, wait before next batch to avoid 429
    const hadClaude = pending.some(q => q.llm === 'claude')
    const had429 = results.some(r => r.status === 'rejected' && String(r.reason).includes('429'))
    const delayMs = had429 ? DELAY_AFTER_429_MS : hadClaude ? DELAY_AFTER_CLAUDE_BATCH_MS : 0
    if (delayMs > 0) {
      if (had429) await log(`[${short}] Rate limit (429) — waiting ${delayMs / 1000}s before retry`)
      console.log(`[run:${short}] waiting ${delayMs / 1000}s before next batch${had429 ? ' (429 backoff)' : ''}`)
      await new Promise(r => setTimeout(r, delayMs))
    }

    // ── Inline pipeline: scrape citations + extract mentions per response ──
    // This runs immediately after each batch so the dashboard shows live data
    const brandDomain = brand.domain
    console.log(`[run:${short}] inline pipeline — scraping citations for ${results.filter(r => r.status === 'fulfilled').length} fulfilled responses`)

    // Gather competitor domains we've already identified
    const { results: knownCompDomains } = await c.env.DB.prepare(
      `SELECT DISTINCT c.domain FROM citations c
       JOIN queries q ON q.id = c.query_id
       WHERE q.run_id = ? AND c.source_type = 'competitor'`
    ).bind(runId).all<{ domain: string }>()
    const competitorDomains = new Set(knownCompDomains.map(r => r.domain))
    if (competitorDomains.size > 0) {
      console.log(`[run:${short}] inline pipeline — ${competitorDomains.size} known competitor domains`)
    }

    let totalUrlsFound = 0
    let totalScrapedOk = 0
    let totalScrapedFail = 0
    let totalPlaceholders = 0
    const byLlm: Record<string, { urls: number; scraped: number; failed: number }> = {}
    for (const llm of ['claude', 'chatgpt', 'gemini']) byLlm[llm] = { urls: 0, scraped: 0, failed: 0 }

    await Promise.allSettled(
      results.map(async (result, i) => {
        if (result.status !== 'fulfilled') return
        const query = pending[i]
        const responseText = result.value?.response_text ?? ''
        const llmCitations = result.value?.citations ?? []

        // Use LLM's structured citations (tool results, annotations, grounding) + any inline URLs in text
        const inlineUrls = extractCitations(responseText)
        const unique = [...new Set([...llmCitations, ...inlineUrls])].slice(0, 10)
        if (llmCitations.length > 0 || inlineUrls.length > 0) {
          console.log(`[run:${short}] citation sources — llm: ${llmCitations.length}, inline: ${inlineUrls.length}, unique: ${unique.length}`)
        }
        const citationInserts: D1PreparedStatement[] = []

        if (unique.length > 0) {
          totalUrlsFound += unique.length
          byLlm[query.llm].urls += unique.length
          console.log(`[run:${short}] citation query ${query.id.slice(0, 8)} — ${unique.length} URLs to scrape`)
          const scraped = await Promise.allSettled(
            unique.map((url: string) => scrapeCitation(url, brandDomain, competitorDomains))
          )
          for (let j = 0; j < unique.length; j++) {
            const sr = scraped[j]
            if (sr.status === 'fulfilled') {
              const cit = sr.value
              if (cit.scraped_ok) {
                totalScrapedOk++
                byLlm[query.llm].scraped++
              } else {
                totalScrapedFail++
                byLlm[query.llm].failed++
              }
              citationInserts.push(
                c.env.DB.prepare(
                  `INSERT OR IGNORE INTO citations (id, query_id, url, domain, page_title, on_page_text, company_name, source_type, scraped_ok)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).bind(crypto.randomUUID(), query.id, cit.url,
                  cit.domain, cit.page_title ?? null, cit.on_page_text, cit.company_name, cit.source_type, cit.scraped_ok)
              )
            } else {
              totalScrapedFail++
              byLlm[query.llm].failed++
              console.log(`[run:${short}] citation scrape rejected for ${unique[j].slice(0, 50)}: ${String((sr as PromiseRejectedResult).reason).slice(0, 60)}`)
            }
          }
        } else {
          totalPlaceholders++
          // Placeholder for queries with no URLs cited
          citationInserts.push(
            c.env.DB.prepare(
              `INSERT OR IGNORE INTO citations (id, query_id, url, domain, page_title, source_type, scraped_ok)
               VALUES (?, ?, '_none_', '_none_', NULL, 'unknown', 0)`
            ).bind(crypto.randomUUID(), query.id)
          )
        }
        if (citationInserts.length > 0) {
          await c.env.DB.batch(citationInserts)
          console.log(`[run:${short}] citation query ${query.id.slice(0, 8)} — inserted ${citationInserts.length} rows`)
        }
      })
    )
    const perLlmParts = (['claude', 'chatgpt', 'gemini'] as const)
      .filter(llm => byLlm[llm].urls > 0)
      .map(llm => `${llm}: ${byLlm[llm].scraped} scraped, ${byLlm[llm].failed} failed`)
      .join('; ')
    await log(`[${short}] Citations: ${totalUrlsFound} URLs${perLlmParts ? ` (${perLlmParts})` : ''}`)
    console.log(`[run:${short}] inline pipeline done — URLs: ${totalUrlsFound}, scraped ok: ${totalScrapedOk}, scraped fail: ${totalScrapedFail}${perLlmParts ? ` (${perLlmParts})` : ''}, placeholders: ${totalPlaceholders}`)

    // ── Inline brand mention extraction (populates Competitors tab during run) ──
    const apiKey = c.env.OPENAI_API_KEY
    if (apiKey) {
      const { results: runCitations } = await c.env.DB.prepare(
        `SELECT c.company_name FROM citations c
         JOIN queries q ON q.id = c.query_id
         WHERE q.run_id = ? AND c.source_type != 'owned' AND c.company_name IS NOT NULL`
      )
        .bind(runId)
        .all<{ company_name: string }>()
      const competitorHints = [...new Set(runCitations.map(r => r.company_name!))].filter(Boolean)
      const brandName = (brand.name ?? brand.domain ?? 'unknown').trim() || 'unknown'

      for (let i = 0; i < results.length; i++) {
        if (results[i].status !== 'fulfilled') continue
        const query = pending[i]
        const responseText = (results[i] as PromiseFulfilledResult<LLMResponse>).value?.response_text ?? ''
        try {
          await extractBrandMentions(responseText, brandName, competitorHints, apiKey, {
            queryId: query.id,
            env: c.env,
          })
        } catch (err) {
          console.error(`[run:${short}] inline extractBrandMentions failed for ${query.id.slice(0, 8)}: ${err}`)
        }
        if (i < results.length - 1) {
          await new Promise(r => setTimeout(r, 1500))
        }
      }
    }
    // ── End inline pipeline ────────────────────────────────────────────────

    // Count completed
    const countRow = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM queries WHERE run_id = ? AND status IN ('complete', 'failed')`
    )
      .bind(runId)
      .first<{ c: number }>()

    const completed = countRow?.c ?? 0
    await c.env.DB.prepare(`UPDATE runs SET completed_queries = ? WHERE id = ?`)
      .bind(completed, runId)
      .run()

    await log(`[${short}] Batch complete — ${completed}/${run.total_queries} done`)
    console.log(`[run:${short}] querying batch complete — ${completed}/${run.total_queries} total done, scheduling next`)
    await unlock(); scheduleNextProcess(c, runId)
    return c.json({ phase: 'querying', total: run.total_queries, completed, done: false })
  }

  // ─── Phase: scraping (legacy) ── runs stuck in scraping from before we removed this phase → move to analyzing
  if (run.status === 'scraping') {
    await log(`[${short}] Scraping (legacy) → Analyzing`)
    console.log(`[run:${short}] scraping (legacy) → analyzing`)
    await c.env.DB.prepare(`UPDATE runs SET status = 'analyzing' WHERE id = ?`)
      .bind(runId)
      .run()
    await unlock(); scheduleNextProcess(c, runId)
    return c.json({ phase: 'analyzing', total: run.total_queries, completed: run.total_queries, done: false })
  }

  // ─── Phase: analyzing ────────────────────────────────────────────────────────
  if (run.status === 'analyzing') {
    await log(`[${short}] Analyzing — extracting brand mentions`)
    console.log(`[run:${short}] entering analyzing phase`)
    try {
      await analyzeRun(runId, (brand.name ?? brand.domain ?? 'unknown').trim() || 'unknown', brand.domain || '', c.env)
    } catch (err) {
      await log(`[${short}] ✗ Analyze failed: ${err}`)
      console.error(`[run:${short}] ✗ analyzeRun threw: ${err}`)
      await c.env.DB.prepare(`UPDATE runs SET status = 'failed', error = ? WHERE id = ?`)
        .bind(String(err), runId)
        .run()
      await unlock()
      return c.json({ phase: 'failed', done: true, error: String(err) })
    }
    await log(`[${short}] ✓ Complete`)
    console.log(`[run:${short}] ✓ complete`)
    await unlock()
    return c.json({ phase: 'complete', total: run.total_queries, completed: run.total_queries, done: true })
  }

  await log(`[${short}] ⚠ Unhandled status=${run.status} — scheduling next (fallback)`)
  console.log(`[run:${short}] ⚠ unhandled status=${run.status} — scheduling next (fallback)`)
  await unlock(); scheduleNextProcess(c, runId)
  return c.json({ phase: run.status, total: run.total_queries, completed: run.completed_queries, done: false })
})

// GET /api/runs/:id/queries/:queryId/response — on-demand fetch for output modal (must be before /:id/results)
runs.get('/:id/queries/:queryId/response', async c => {
  const runId = c.req.param('id')
  const queryId = c.req.param('queryId')

  const row = await c.env.DB.prepare(
    `SELECT q.id, q.response_text, q.llm,
            p.text as prompt_text, p.funnel_stage,
            pe.name as persona_name
     FROM queries q
     JOIN prompts p ON p.id = q.prompt_id
     JOIN personas pe ON pe.id = q.persona_id
     WHERE q.id = ? AND q.run_id = ? AND q.status = 'complete'`
  )
    .bind(queryId, runId)
    .first<{ id: string; response_text: string; llm: string; prompt_text: string; funnel_stage: string; persona_name: string }>()

  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({
    prompt_text: row.prompt_text,
    persona_name: row.persona_name,
    llm: row.llm,
    funnel_stage: row.funnel_stage,
    response_text: row.response_text,
  })
})

/** Sanitize error for API response — surfaces DB/schema errors for debugging without exposing internals */
function apiErrorDetail(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/SQLITE|no such column|duplicate column|syntax error/i.test(msg)) {
    return `Database error: ${msg}`
  }
  return msg.length > 200 ? msg.substring(0, 200) + '…' : msg
}

// GET /api/runs/:id/results — full analytics results
runs.get('/:id/results', async c => {
  const runId = c.req.param('id')
  try {
  const run = await c.env.DB.prepare(`SELECT r.*, b.name as brand_name, b.domain as brand_domain FROM runs r JOIN brands b ON b.id = r.brand_id WHERE r.id = ?`)
    .bind(runId)
    .first<Run & { brand_name: string; brand_domain: string }>()

  if (!run) return c.json({ error: 'Not found' }, 404)

  // Ranking: brand mentions per query, with prompt text and LLM
  // Include q.id as query_id so frontend can group by query (avoids collision when prompt text or persona name is duplicated)
  const { results: mentions } = await c.env.DB.prepare(
    `SELECT bm.brand_name, bm.rank, bm.is_target, bm.context_snippet, bm.positioning,
            q.id as query_id, q.llm, p.text as prompt_text, p.funnel_stage, pe.name as persona_name
     FROM brand_mentions bm
     JOIN queries q ON q.id = bm.query_id
     JOIN prompts p ON p.id = q.prompt_id
     JOIN personas pe ON pe.id = q.persona_id
     WHERE q.run_id = ?
     ORDER BY bm.is_target DESC, bm.rank ASC`
  )
    .bind(runId)
    .all()

  // Top cited domains
  const { results: topDomains } = await c.env.DB.prepare(
    `SELECT c.domain, c.company_name, c.source_type, COUNT(*) as count
     FROM citations c
     JOIN queries q ON q.id = c.query_id
     WHERE q.run_id = ? AND c.domain != '_none_'
     GROUP BY c.domain
     ORDER BY count DESC
     LIMIT 20`
  )
    .bind(runId)
    .all()

  // Source type distribution
  const { results: sourceTypes } = await c.env.DB.prepare(
    `SELECT c.source_type, COUNT(*) as count
     FROM citations c
     JOIN queries q ON q.id = c.query_id
     WHERE q.run_id = ? AND c.domain != '_none_'
     GROUP BY c.source_type`
  )
    .bind(runId)
    .all()

  // Most cited owned pages
  const { results: ownedPages } = await c.env.DB.prepare(
    `SELECT c.url, COUNT(*) as count
     FROM citations c
     JOIN queries q ON q.id = c.query_id
     WHERE q.run_id = ? AND c.source_type = 'owned'
     GROUP BY c.url
     ORDER BY count DESC
     LIMIT 10`
  )
    .bind(runId)
    .all()

  // All citations with frequency (url, domain, count) for Citations tab — kept for domain filter derivation
  const { results: citationList } = await c.env.DB.prepare(
    `SELECT c.url, c.domain, COUNT(*) as count
     FROM citations c
     JOIN queries q ON q.id = c.query_id
     WHERE q.run_id = ? AND c.url != '_none_'
     GROUP BY c.url
     ORDER BY count DESC`
  )
    .bind(runId)
    .all()

  // Per-citation detail for Citations tab (query snippet, page title, chatbot link)
  // Requires migration: npm run db:migrate:page_title
  let citationDetail: Record<string, unknown>[] = []
  try {
    const r = await c.env.DB.prepare(
      `SELECT c.id, c.query_id, c.url, c.domain, c.page_title, c.company_name, c.source_type,
              p.text as prompt_text, p.funnel_stage,
              pe.name as persona_name,
              q.llm,
              EXISTS (SELECT 1 FROM brand_mentions bm WHERE bm.query_id = c.query_id AND bm.is_target = 1) as mentions_target
       FROM citations c
       JOIN queries q ON q.id = c.query_id
       JOIN prompts p ON p.id = q.prompt_id
       JOIN personas pe ON pe.id = q.persona_id
       WHERE q.run_id = ? AND c.url != '_none_'
       ORDER BY c.url, q.llm, pe.name`
    )
      .bind(runId)
      .all()
    citationDetail = (r.results ?? []) as Record<string, unknown>[]
  } catch (err) {
    const msg = String(err)
    if (msg.includes('page_title') || msg.includes('no such column')) {
      console.error('[runs] citationDetail failed — run: npm run db:migrate:page_title')
    }
    // Fallback: return [] so dashboard still loads; Citations tab shows "No citations yet"
  }

  // Competitor comparison: avg rank vs brand (positioning = first non-null per brand)
  const { results: competitorRanks } = await c.env.DB.prepare(
    `SELECT bm.brand_name, bm.is_target,
            COUNT(*) as mention_count,
            AVG(bm.rank) as avg_rank,
            MIN(bm.rank) as best_rank,
            (SELECT bm2.positioning FROM brand_mentions bm2
             JOIN queries q2 ON q2.id = bm2.query_id
             WHERE q2.run_id = q.run_id AND bm2.brand_name = bm.brand_name AND bm2.positioning IS NOT NULL
             LIMIT 1) as positioning
     FROM brand_mentions bm
     JOIN queries q ON q.id = bm.query_id
     WHERE q.run_id = ?
     GROUP BY bm.brand_name
     ORDER BY avg_rank ASC`
  )
    .bind(runId)
    .all()

  // ─── Competitor aggregate: enrich competitorRanks with per-LLM and positioning stats ───
  let competitorDetail: Record<string, unknown>[] = []
  try {
  // Query 1: How many times was each brand mentioned per LLM? (brand_name, llm, cnt)
  const { results: mentionsByLlmRaw } = await c.env.DB.prepare(
    `SELECT bm.brand_name, q.llm, COUNT(*) as cnt
     FROM brand_mentions bm JOIN queries q ON q.id = bm.query_id
     WHERE q.run_id = ?
     GROUP BY bm.brand_name, q.llm`
  )
    .bind(runId)
    .all<{ brand_name: string; llm: string; cnt: number }>()
  const mentionsByLlm = mentionsByLlmRaw ?? []
  console.log(`[runs] competitor aggregate — mentions_by_llm: ${mentionsByLlm.length} rows (brand×llm)`)

  // Query 2: For each brand, which positioning phrases appear and how often? (brand_name, text, cnt)
  // Ordered by cnt DESC so we can take top 3 per brand
  const { results: positioningCountsRaw } = await c.env.DB.prepare(
    `SELECT bm.brand_name, bm.positioning as text, COUNT(*) as cnt
     FROM brand_mentions bm JOIN queries q ON q.id = bm.query_id
     WHERE q.run_id = ? AND bm.positioning IS NOT NULL AND bm.positioning != ''
     GROUP BY bm.brand_name, bm.positioning
     ORDER BY bm.brand_name, cnt DESC`
  )
    .bind(runId)
    .all<{ brand_name: string; text: string; cnt: number }>()
  const positioningCounts = positioningCountsRaw ?? []
  console.log(`[runs] competitor aggregate — positioning_counts: ${positioningCounts.length} unique (brand, positioning) pairs`)

  // Query 3: For each brand and LLM, which positioning phrase appears most often? (brand_name, llm, text, cnt)
  // Ordered by brand, llm, cnt DESC so first row per (brand, llm) is the winner
  const { results: positioningByLlmRaw } = await c.env.DB.prepare(
    `SELECT bm.brand_name, q.llm, bm.positioning as text, COUNT(*) as cnt
     FROM brand_mentions bm JOIN queries q ON q.id = bm.query_id
     WHERE q.run_id = ? AND bm.positioning IS NOT NULL AND bm.positioning != ''
     GROUP BY bm.brand_name, q.llm, bm.positioning
     ORDER BY bm.brand_name, q.llm, cnt DESC`
  )
    .bind(runId)
    .all<{ brand_name: string; llm: string; text: string; cnt: number }>()
  const positioningByLlm = positioningByLlmRaw ?? []
  console.log(`[runs] competitor aggregate — positioning_by_llm: ${positioningByLlm.length} rows (brand×llm×positioning)`)

  // Merge: for each brand in competitorRanks, attach mentions_by_llm, top_positionings, top_positioning_by_llm
  competitorDetail = (competitorRanks ?? []).map((r: Record<string, unknown>) => {
    const brand = String(r.brand_name ?? '')
    const mentionsByLlmMap: Record<string, number> = {}
    for (const row of mentionsByLlm) {
      if (row.brand_name === brand) mentionsByLlmMap[row.llm] = row.cnt
    }
    const topPositionings = positioningCounts
      .filter(p => p.brand_name === brand)
      .slice(0, 3)
      .map(p => ({ text: p.text, count: p.cnt }))
    const topByLlm: Record<string, string> = {}
    const seen = new Set<string>()
    for (const row of positioningByLlm) {
      if (row.brand_name === brand && !seen.has(row.llm)) {
        seen.add(row.llm)
        topByLlm[row.llm] = row.text
      }
    }
    const totalFromLlm = Object.values(mentionsByLlmMap).reduce((a, b) => a + b, 0)
    return {
      ...r,
      mention_count: totalFromLlm || Number(r.mention_count) || 0,
      mentions_by_llm: mentionsByLlmMap,
      top_positionings: topPositionings,
      top_positioning_by_llm: topByLlm,
    }
  })
  console.log(`[runs] competitor aggregate — built competitorDetail for ${competitorDetail.length} brands`)
  } catch (err) {
    console.error('[runs] competitor aggregate failed — using competitorRanks as fallback:', err)
    competitorDetail = competitorRanks ?? []
  }

  // Prompt-level detail: all completed queries, with first-mentioned brand where available
  const { results: promptDetail } = await c.env.DB.prepare(
    `SELECT q.id as query_id, p.text as prompt_text, p.funnel_stage, q.llm,
            bm.brand_name, bm.rank, bm.is_target, bm.context_snippet, bm.positioning,
            pe.name as persona_name
     FROM queries q
     JOIN prompts p ON p.id = q.prompt_id
     JOIN personas pe ON pe.id = q.persona_id
     LEFT JOIN brand_mentions bm ON bm.query_id = q.id AND bm.rank = 1
     WHERE q.run_id = ? AND q.status = 'complete'
     ORDER BY p.text, q.llm, pe.name`
  )
    .bind(runId)
    .all()

  // All approved personas from the brand — so dashboard can show personas before their prompts have returned
  const { results: personas = [] } = run.brand_id
    ? await c.env.DB.prepare(
        `SELECT id, name, description FROM personas WHERE brand_id = ? AND approved = 1 ORDER BY created_at`
      )
        .bind(run.brand_id)
        .all<{ id: string; name: string; description?: string }>()
    : { results: [] }

  return c.json({
    run,
    personas,
    mentions,
    topDomains,
    sourceTypes,
    ownedPages,
    citationList,
    citationDetail,
    competitorRanks,
    competitorDetail,
    promptDetail,
  })
  } catch (err) {
    console.error(`[runs] GET /${runId.slice(0, 8)}/results failed:`, err)
    return c.json({ error: apiErrorDetail(err) }, 500)
  }
})

// POST /api/runs/:id/cancel — abort a run in progress
runs.post('/:id/cancel', async c => {
  const runId = c.req.param('id')
  console.log(`[runs] POST /${runId.slice(0, 8)}/cancel — aborting run`)
  await c.env.DB.prepare(
    `UPDATE runs SET status = 'failed', error = 'Cancelled by user' WHERE id = ? AND status NOT IN ('complete','failed')`
  )
    .bind(runId)
    .run()
  await c.env.DB.prepare(
    `UPDATE queries SET status = 'failed' WHERE run_id = ? AND status IN ('pending','processing')`
  )
    .bind(runId)
    .run()
  return c.json({ ok: true })
})

// GET /api/runs/:id/live-responses — completed query responses grouped by LLM (for live viewer)
runs.get('/:id/live-responses', async c => {
  const runId = c.req.param('id')
  const { results } = await c.env.DB.prepare(
    `SELECT q.id, q.llm, q.response_text, q.status,
            p.text as prompt_text, p.funnel_stage,
            pe.name as persona_name
     FROM queries q
     JOIN prompts p ON p.id = q.prompt_id
     JOIN personas pe ON pe.id = q.persona_id
     WHERE q.run_id = ? AND q.status = 'complete'
     ORDER BY q.created_at DESC
     LIMIT 60`
  )
    .bind(runId)
    .all<{
      id: string; llm: string; response_text: string; status: string
      prompt_text: string; funnel_stage: string; persona_name: string
    }>()

  const grouped: Record<string, typeof results> = { claude: [], chatgpt: [], gemini: [] }
  for (const row of results) {
    if (grouped[row.llm]) grouped[row.llm].push(row)
  }

  // Count per LLM
  const counts = await c.env.DB.prepare(
    `SELECT llm,
       SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as done,
       COUNT(*) as total
     FROM queries WHERE run_id = ? GROUP BY llm`
  )
    .bind(runId)
    .all<{ llm: string; done: number; total: number }>()

  const progress: Record<string, { done: number; total: number }> = {}
  for (const row of counts.results) {
    progress[row.llm] = { done: row.done, total: row.total }
  }

  return c.json({ grouped, progress })
})

// GET /api/runs/:id/partial — partial results while run is still in progress
runs.get('/:id/partial', async c => {
  const runId = c.req.param('id')
  try {
  const run = await c.env.DB.prepare(
    `SELECT r.*, b.name as brand_name, b.domain as brand_domain
     FROM runs r JOIN brands b ON b.id = r.brand_id WHERE r.id = ?`
  )
    .bind(runId)
    .first<Run & { brand_name: string; brand_domain: string }>()

  if (!run) return c.json({ error: 'Not found' }, 404)

  // Only return what's already computed
  const { results: competitorRanks } = await c.env.DB.prepare(
    `SELECT bm.brand_name, bm.is_target,
            COUNT(*) as mention_count,
            AVG(bm.rank) as avg_rank,
            MIN(bm.rank) as best_rank,
            (SELECT bm2.positioning FROM brand_mentions bm2
             JOIN queries q2 ON q2.id = bm2.query_id
             WHERE q2.run_id = q.run_id AND bm2.brand_name = bm.brand_name AND bm2.positioning IS NOT NULL
             LIMIT 1) as positioning
     FROM brand_mentions bm
     JOIN queries q ON q.id = bm.query_id
     WHERE q.run_id = ?
     GROUP BY bm.brand_name ORDER BY avg_rank ASC LIMIT 15`
  )
    .bind(runId)
    .all()

  // Competitor aggregate for partial (same logic as /results)
  let competitorDetailPartial: Record<string, unknown>[] = []
  try {
  const { results: mentionsByLlmPartialRaw } = await c.env.DB.prepare(
    `SELECT bm.brand_name, q.llm, COUNT(*) as cnt
     FROM brand_mentions bm JOIN queries q ON q.id = bm.query_id
     WHERE q.run_id = ? GROUP BY bm.brand_name, q.llm`
  )
    .bind(runId)
    .all<{ brand_name: string; llm: string; cnt: number }>()
  const mentionsByLlmPartial = mentionsByLlmPartialRaw ?? []
  const { results: positioningCountsPartialRaw } = await c.env.DB.prepare(
    `SELECT bm.brand_name, bm.positioning as text, COUNT(*) as cnt
     FROM brand_mentions bm JOIN queries q ON q.id = bm.query_id
     WHERE q.run_id = ? AND bm.positioning IS NOT NULL AND bm.positioning != ''
     GROUP BY bm.brand_name, bm.positioning ORDER BY bm.brand_name, cnt DESC`
  )
    .bind(runId)
    .all<{ brand_name: string; text: string; cnt: number }>()
  const positioningCountsPartial = positioningCountsPartialRaw ?? []
  const { results: positioningByLlmPartialRaw } = await c.env.DB.prepare(
    `SELECT bm.brand_name, q.llm, bm.positioning as text, COUNT(*) as cnt
     FROM brand_mentions bm JOIN queries q ON q.id = bm.query_id
     WHERE q.run_id = ? AND bm.positioning IS NOT NULL AND bm.positioning != ''
     GROUP BY bm.brand_name, q.llm, bm.positioning ORDER BY bm.brand_name, q.llm, cnt DESC`
  )
    .bind(runId)
    .all<{ brand_name: string; llm: string; text: string; cnt: number }>()
  const positioningByLlmPartial = positioningByLlmPartialRaw ?? []
  competitorDetailPartial = (competitorRanks ?? []).map((r: Record<string, unknown>) => {
    const brand = String(r.brand_name ?? '')
    const mentionsByLlmMap: Record<string, number> = {}
    for (const row of mentionsByLlmPartial) {
      if (row.brand_name === brand) mentionsByLlmMap[row.llm] = row.cnt
    }
    const topPositionings = positioningCountsPartial
      .filter(p => p.brand_name === brand)
      .slice(0, 3)
      .map(p => ({ text: p.text, count: p.cnt }))
    const topByLlm: Record<string, string> = {}
    const seen = new Set<string>()
    for (const row of positioningByLlmPartial) {
      if (row.brand_name === brand && !seen.has(row.llm)) {
        seen.add(row.llm)
        topByLlm[row.llm] = row.text
      }
    }
    const totalFromLlm = Object.values(mentionsByLlmMap).reduce((a, b) => a + b, 0)
    return {
      ...r,
      mention_count: totalFromLlm || Number(r.mention_count) || 0,
      mentions_by_llm: mentionsByLlmMap,
      top_positionings: topPositionings,
      top_positioning_by_llm: topByLlm,
    }
  })
  if (competitorDetailPartial.length > 0) {
    console.log(`[runs] partial — competitorDetail: ${competitorDetailPartial.length} brands`)
  }
  } catch (err) {
    console.error('[runs] partial competitor aggregate failed — using competitorRanks:', err)
    competitorDetailPartial = competitorRanks ?? []
  }

  const { results: topDomains } = await c.env.DB.prepare(
    `SELECT c.domain, c.company_name, c.source_type, COUNT(*) as count
     FROM citations c JOIN queries q ON q.id = c.query_id
     WHERE q.run_id = ? AND c.domain != '_none_'
     GROUP BY c.domain ORDER BY count DESC LIMIT 15`
  )
    .bind(runId)
    .all()

  const { results: sourceTypes } = await c.env.DB.prepare(
    `SELECT c.source_type, COUNT(*) as count
     FROM citations c JOIN queries q ON q.id = c.query_id
     WHERE q.run_id = ? AND c.domain != '_none_'
     GROUP BY c.source_type`
  )
    .bind(runId)
    .all()

  const completedCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as c FROM queries WHERE run_id = ? AND status = 'complete'`
  )
    .bind(runId)
    .first<{ c: number }>()

  const totalCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as c FROM queries WHERE run_id = ?`
  )
    .bind(runId)
    .first<{ c: number }>()

  // Include brand mentions so the dashboard Ranking/Competitors panels update live
  const { results: mentions } = await c.env.DB.prepare(
    `SELECT bm.brand_name, bm.rank, bm.is_target, bm.context_snippet, bm.positioning,
            q.id as query_id, q.llm, p.text as prompt_text, p.funnel_stage, pe.name as persona_name
     FROM brand_mentions bm
     JOIN queries q ON q.id = bm.query_id
     JOIN prompts p ON p.id = q.prompt_id
     JOIN personas pe ON pe.id = q.persona_id
     WHERE q.run_id = ?
     ORDER BY bm.is_target DESC, bm.rank ASC
     LIMIT 200`
  )
    .bind(runId)
    .all()

  // Most cited owned pages so far
  const { results: ownedPages } = await c.env.DB.prepare(
    `SELECT c.url, COUNT(*) as count
     FROM citations c JOIN queries q ON q.id = c.query_id
     WHERE q.run_id = ? AND c.source_type = 'owned'
     GROUP BY c.url ORDER BY count DESC LIMIT 10`
  )
    .bind(runId)
    .all()

  // Citation list (url, domain, count) for Citations tab
  const { results: citationList } = await c.env.DB.prepare(
    `SELECT c.url, c.domain, COUNT(*) as count
     FROM citations c JOIN queries q ON q.id = c.query_id
     WHERE q.run_id = ? AND c.url != '_none_'
     GROUP BY c.url ORDER BY count DESC`
  )
    .bind(runId)
    .all()

  // Per-citation detail for Citations tab (requires migration: db:migrate:page_title)
  let citationDetail: Record<string, unknown>[] = []
  try {
    const r = await c.env.DB.prepare(
      `SELECT c.id, c.query_id, c.url, c.domain, c.page_title, c.company_name, c.source_type,
              p.text as prompt_text, p.funnel_stage,
              pe.name as persona_name,
              q.llm,
              EXISTS (SELECT 1 FROM brand_mentions bm WHERE bm.query_id = c.query_id AND bm.is_target = 1) as mentions_target
       FROM citations c
       JOIN queries q ON q.id = c.query_id
       JOIN prompts p ON p.id = q.prompt_id
       JOIN personas pe ON pe.id = q.persona_id
       WHERE q.run_id = ? AND c.url != '_none_'
       ORDER BY c.url, q.llm, pe.name`
    )
      .bind(runId)
      .all()
    citationDetail = (r.results ?? []) as Record<string, unknown>[]
  } catch {
    // Fallback if page_title column missing (migration not run)
  }

  // Prompt-level first mentions so far — all completed queries, brand data where available
  const { results: promptDetail } = await c.env.DB.prepare(
    `SELECT q.id as query_id, p.text as prompt_text, p.funnel_stage, q.llm,
            bm.brand_name, bm.rank, bm.is_target, bm.context_snippet, bm.positioning,
            pe.name as persona_name
     FROM queries q
     JOIN prompts p ON p.id = q.prompt_id
     JOIN personas pe ON pe.id = q.persona_id
     LEFT JOIN brand_mentions bm ON bm.query_id = q.id AND bm.rank = 1
     WHERE q.run_id = ? AND q.status = 'complete'
     ORDER BY p.text, q.llm, pe.name`
  )
    .bind(runId)
    .all()

  const { results: personas = [] } = run.brand_id
    ? await c.env.DB.prepare(
        `SELECT id, name, description FROM personas WHERE brand_id = ? AND approved = 1 ORDER BY created_at`
      )
        .bind(run.brand_id)
        .all<{ id: string; name: string; description?: string }>()
    : { results: [] }

  return c.json({
    run,
    personas,
    competitorRanks,
    competitorDetail: competitorDetailPartial,
    topDomains,
    sourceTypes,
    mentions,
    ownedPages,
    citationList,
    citationDetail,
    promptDetail,
    completed: completedCount?.c ?? 0,
    total: totalCount?.c ?? run.total_queries ?? 0,
  })
  } catch (err) {
    console.error(`[runs] GET /${runId.slice(0, 8)}/partial failed:`, err)
    return c.json({ error: apiErrorDetail(err) }, 500)
  }
})

// GET /api/runs/:id/siblings — all runs for the same brand
runs.get('/:id/siblings', async c => {
  const runId = c.req.param('id')

  const row = await c.env.DB.prepare(`SELECT brand_id FROM runs WHERE id = ?`)
    .bind(runId)
    .first<{ brand_id: string }>()
  if (!row) return c.json({ error: 'Not found' }, 404)

  const { results } = await c.env.DB.prepare(
    `SELECT id, status, created_at, total_queries, completed_queries
     FROM runs WHERE brand_id = ? ORDER BY created_at DESC`
  )
    .bind(row.brand_id)
    .all()

  return c.json({ runs: results })
})

// DELETE /api/runs/:id — cascade-delete a run and all its data
runs.delete('/:id', async c => {
  const runId = c.req.param('id')
  console.log(`[runs] DELETE /${runId.slice(0, 8)} — cascade-deleting run`)

  const run = await c.env.DB.prepare(`SELECT id FROM runs WHERE id = ?`)
    .bind(runId)
    .first()
  if (!run) return c.json({ error: 'Not found' }, 404)

  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM brand_mentions WHERE query_id IN (SELECT id FROM queries WHERE run_id = ?)`
    ).bind(runId),
    c.env.DB.prepare(
      `DELETE FROM citations WHERE query_id IN (SELECT id FROM queries WHERE run_id = ?)`
    ).bind(runId),
    c.env.DB.prepare(`DELETE FROM queries WHERE run_id = ?`).bind(runId),
    c.env.DB.prepare(`DELETE FROM runs WHERE id = ?`).bind(runId),
  ])

  // Clean up KV keys for this run
  try {
    await c.env.KV.delete(`logs:run:${runId}`)
    await c.env.KV.delete(`lock:process:${runId}`)
  } catch (kvErr) {
    console.warn(`[runs] KV cleanup for ${runId.slice(0, 8)} failed (non-fatal):`, kvErr)
  }

  return c.json({ ok: true })
})

export { runs }
