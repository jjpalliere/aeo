import { Hono } from 'hono'
import type { Env, Brand } from '../types'
import { scrapeSite, extractDomain, ScrapeBlockedError } from '../services/scraper'
import { generatePrompts, generatePersonas, classifyPrompts, pingOpenAI, type PersonaForPrompts } from '../services/generator'

const brands = new Hono<{ Bindings: Env }>()

// Appends a raw log line to KV (visible as terminal output in the browser)
// and writes it to the wrangler console too.
function makeReporter(brandId: string, env: Env) {
  const short = brandId.slice(0, 8)
  const logsKey = `logs:${brandId}`

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

  // onProgress: user-friendly step name → written as [shortId] Step Name
  // Also maintains the legacy progress:{id} key for any remaining readers.
  const onProgress = async (step: string) => {
    await log(`[${short}] ${step}`)
    try {
      await env.KV.put(
        `progress:${brandId}`,
        JSON.stringify({ step, ts: Date.now() }),
        { expirationTtl: 3600 },
      )
    } catch { /* non-fatal */ }
  }

  return { log, onProgress }
}

// POST /api/brands — create brand and kick off scrape + generation
brands.post('/', async c => {
  const body = await c.req.json<{ url?: string; name?: string; pastedText?: string }>()

  // ── Predict mode: user pasted text, no live URL needed ───────────────────────
  if (body.pastedText?.trim()) {
    try {
      const name = body.name?.trim() || 'Brand'
      const id = crypto.randomUUID()
      const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'brand'
      const url = `predict://${safeName}`

      const scraped = {
        pages: [{ url, title: name, description: '', text: body.pastedText.trim() }],
        summary: body.pastedText.trim().substring(0, 3000),
        brand_name: name,
        industry_keywords: [] as string[],
      }

      await c.env.DB.prepare(
        `INSERT INTO brands (id, url, domain, name, scraped_content, status) VALUES (?, ?, ?, ?, ?, 'generating')`
      ).bind(id, url, safeName, name, JSON.stringify(scraped)).run()

      const env = c.env
      c.executionCtx.waitUntil(
        (async () => {
          const { log, onProgress } = makeReporter(id, env)
          try {
            await log(`[${id.slice(0,8)}] Pre-flight API check…`)
            await pingOpenAI(env.OPENAI_API_KEY)
            await log(`[${id.slice(0,8)}] API key OK — starting generation`)
            const { personas, brand_name } = await generatePersonas(scraped, null, env.OPENAI_API_KEY, onProgress, log)
            if (brand_name) {
              await env.DB.prepare(`UPDATE brands SET name = ? WHERE id = ?`).bind(brand_name, id).run()
            }
            if (personas.length > 0) {
              await env.DB.batch(personas.map(p =>
                env.DB.prepare(
                  `INSERT INTO personas (id, brand_id, name, description, goals, pain_points, system_message, rationale) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                ).bind(crypto.randomUUID(), id, p.name, p.description, JSON.stringify(p.goals ?? []), JSON.stringify(p.pain_points ?? []), p.system_message, p.rationale ?? null)
              ))
            }
            await env.DB.prepare(`UPDATE brands SET status = 'personas_ready' WHERE id = ?`).bind(id).run()
            await log(`[${id.slice(0, 8)}] ✓ Personas ready`)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            await env.DB.prepare(`UPDATE brands SET status = 'failed' WHERE id = ?`).bind(id).run()
            try { await env.KV.put(`error:${id}`, msg, { expirationTtl: 86400 }) } catch {}
            console.error('Predict mode generation failed:', msg)
          }
        })()
      )

      return c.json({ id, status: 'generating' })
    } catch (err: unknown) {
      console.error('Predict mode setup error:', err)
      return c.json({ error: String(err) }, 500)
    }
  }

  // ── Standard mode: scrape a live URL ─────────────────────────────────────────
  if (!body.url) return c.json({ error: 'url is required' }, 400)

  const id = crypto.randomUUID()
  const url = body.url.trim()
  const domain = extractDomain(url.startsWith('http') ? url : `https://${url}`)

  await c.env.DB.prepare(
    `INSERT INTO brands (id, url, domain, status) VALUES (?, ?, ?, 'scraping')`
  )
    .bind(id, url, domain)
    .run()

  // Return immediately — client redirects to approve page.
  // Approve page calls POST /api/brands/:id/continue to run scrape+personas in a long-lived request
  // (avoids Cloudflare waitUntil 30s limit which was killing the worker at "Identifying buyer archetypes").
  return c.json({ id, status: 'scraping' })
})

// POST /api/brands/:id/continue — run scrape + persona generation (called by approve page)
// Runs in main request so no 30s waitUntil limit. Approve page fires this when it sees status 'scraping'.
brands.post('/:id/continue', async c => {
  const brandId = c.req.param('id')
  const brand = await c.env.DB.prepare(`SELECT * FROM brands WHERE id = ?`)
    .bind(brandId)
    .first<Brand & { url?: string }>()
  if (!brand) return c.json({ error: 'Not found' }, 404)
  if (brand.status !== 'scraping') return c.json({ ok: true, status: brand.status })

  // Claim the work: only one request runs (atomic status update)
  const claim = await c.env.DB.prepare(
    `UPDATE brands SET status = 'generating' WHERE id = ? AND status = 'scraping'`
  ).bind(brandId).run()
  if (claim.meta.changes === 0) return c.json({ ok: true, status: 'already_running' })

  const url = (brand.url || '').trim() || `https://${brand.domain || ''}`
  const env = c.env
  const { log, onProgress } = makeReporter(brandId, env)
  try {
    await log(`[${brandId.slice(0,8)}] Pre-flight API check…`)
    await pingOpenAI(env.OPENAI_API_KEY)
    await log(`[${brandId.slice(0,8)}] API key OK — scraping ${url}`)
    const scraped = await scrapeSite(url, onProgress, log)
    await env.DB.prepare(
      `UPDATE brands SET scraped_content = ?, name = ?, status = 'generating' WHERE id = ?`
    )
      .bind(JSON.stringify(scraped), scraped.brand_name, brandId)
      .run()

    const { personas, brand_name } = await generatePersonas(scraped, null, env.OPENAI_API_KEY, onProgress, log)
    if (brand_name) {
      await env.DB.prepare(`UPDATE brands SET name = ? WHERE id = ?`).bind(brand_name, brandId).run()
    }

    const personaStmts = personas.map(p =>
      env.DB.prepare(
        `INSERT INTO personas (id, brand_id, name, description, goals, pain_points, system_message, rationale) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), brandId, p.name, p.description, JSON.stringify(p.goals ?? []), JSON.stringify(p.pain_points ?? []), p.system_message, p.rationale ?? null)
    )
    await env.DB.batch(personaStmts)

    await env.DB.prepare(`UPDATE brands SET status = 'personas_ready' WHERE id = ?`).bind(brandId).run()
    await log(`[${brandId.slice(0,8)}] ✓ Personas ready`)
    return c.json({ ok: true, status: 'personas_ready' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof ScrapeBlockedError ? 'scrape_blocked' : 'failed'
    await env.DB.prepare(`UPDATE brands SET status = ? WHERE id = ?`).bind(status, brandId).run()
    try { await env.KV.put(`error:${brandId}`, msg, { expirationTtl: 86400 }) } catch {}
    console.error(`[${brandId.slice(0,8)}] ✗ Brand setup failed:`, msg)
    return c.json({ error: msg }, 500)
  }
})

// POST /api/brands/quick-start — skip setup: brand + prompts + personas → run immediately
// Must be before /:id routes so 'quick-start' is not matched as a brand ID.
brands.post('/quick-start', async c => {
  console.log('[quick-start] request received')
  let body: { brand_name?: string; brand_domain?: string; prompts?: Array<{ text: string; funnel_stage?: string; persona_name?: string }>; personas?: Array<{ name: string; system_message: string }> }
  try {
    body = await c.req.json()
  } catch {
    console.log('[quick-start] invalid JSON body')
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  if (!body || typeof body !== 'object') {
    console.log('[quick-start] missing or invalid body')
    return c.json({ error: 'Request body is required' }, 400)
  }

  if (!body.brand_name?.trim()) {
    console.log('[quick-start] validation failed: brand_name required')
    return c.json({ error: 'brand_name is required' }, 400)
  }
  if (!body.prompts?.length) {
    console.log('[quick-start] validation failed: prompts required')
    return c.json({ error: 'prompts is required (min 1)' }, 400)
  }

  const validPersonas = (body.personas ?? [])
    .filter((p): p is { name: string; system_message: string } => !!(p?.name?.trim() && p?.system_message?.trim()))

  // Validate prompts before any DB writes (avoids rollback if all prompts are empty)
  const validStages = ['tofu', 'mofu', 'bofu'] as const
  const validPrompts = body.prompts
    .filter(p => p.text?.trim())
    .map(p => ({
      text: p.text!.trim(),
      stage: (p.funnel_stage && validStages.includes(p.funnel_stage as any) ? p.funnel_stage : 'mofu') as typeof validStages[number],
      persona_name: p.persona_name?.trim() || null,
    }))
  if (validPrompts.length === 0) {
    console.log('[quick-start] validation failed: at least one non-empty prompt required')
    return c.json({ error: 'At least one non-empty prompt is required' }, 400)
  }

  const brandName = body.brand_name.trim()
  const safeName = brandName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'brand'

  // Normalize domain for citation classifier (strip protocol, www)
  const rawDomain = body.brand_domain?.trim() || ''
  const domain = rawDomain
    ? extractDomain(rawDomain.startsWith('http') ? rawDomain : `https://${rawDomain}`)
    : ''
  const url = domain ? `https://${domain}` : `direct://${safeName}`

  const DEFAULT_SYSTEM_MESSAGE = 'You are a helpful AI assistant. Answer the user\'s question thoughtfully and accurately. Do not mention that you are an AI.'
  const personasToInsert = validPersonas.length > 0
    ? validPersonas.map(p => ({ name: p.name.trim(), system_message: p.system_message.trim() }))
    : [{ name: 'Default', system_message: DEFAULT_SYSTEM_MESSAGE }]
  console.log('[quick-start] parsed:', { brandName, domain: domain || '(none)', prompts: validPrompts.length, personas: validPersonas.length, willInsert: personasToInsert.length })

  const brandId = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO brands (id, url, domain, name, scraped_content, status) VALUES (?, ?, ?, ?, NULL, 'ready')`
  ).bind(brandId, url, domain, brandName).run()
  console.log('[quick-start] brand inserted:', brandId.slice(0, 8))

  // Insert personas (or default if none provided)
  try {
    const personaStmts = personasToInsert.map(p =>
      c.env.DB.prepare(
        `INSERT INTO personas (id, brand_id, name, description, goals, pain_points, system_message, rationale, approved) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)`
      ).bind(crypto.randomUUID(), brandId, p.name, '', '[]', '[]', p.system_message)
    )
    await c.env.DB.batch(personaStmts)
    console.log('[quick-start] personas inserted:', personasToInsert.length)
  } catch (err) {
    await c.env.DB.prepare(`DELETE FROM brands WHERE id = ?`).bind(brandId).run()
    console.error('[quick-start] persona insert failed, rolled back brand:', err)
    return c.json({ error: 'Failed to save personas' }, 500)
  }

  // Build persona name → id map for prompt assignment
  const { results: insertedPersonas } = await c.env.DB.prepare(
    `SELECT id, name FROM personas WHERE brand_id = ? ORDER BY created_at`
  ).bind(brandId).all<{ id: string; name: string }>()
  const personaNameToId = new Map(insertedPersonas.map(p => [p.name.toLowerCase(), p.id]))

  // Insert prompts (already validated above)
  const promptStmts = validPrompts.map(p => {
    const personaId = p.persona_name ? (personaNameToId.get(p.persona_name.toLowerCase()) ?? null) : null
    return c.env.DB.prepare(
      `INSERT INTO prompts (id, brand_id, persona_id, text, funnel_stage, rationale, approved) VALUES (?, ?, ?, ?, ?, NULL, 1)`
    ).bind(crypto.randomUUID(), brandId, personaId, p.text, p.stage)
  })
  try {
    await c.env.DB.batch(promptStmts)
    console.log('[quick-start] prompts inserted:', promptStmts.length)
  } catch (err) {
    await c.env.DB.prepare(`DELETE FROM personas WHERE brand_id = ?`).bind(brandId).run()
    await c.env.DB.prepare(`DELETE FROM brands WHERE id = ?`).bind(brandId).run()
    console.error('[quick-start] prompt insert failed, rolled back:', err)
    return c.json({ error: 'Failed to save prompts' }, 500)
  }

  console.log('[quick-start] success, brandId:', brandId.slice(0, 8))
  return c.json({ brandId })
})

// POST /api/brands/:id/proceed-blocked — user chose to proceed despite scrape failure
brands.post('/:id/proceed-blocked', async c => {
  const brandId = c.req.param('id')
  const body = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }))

  const brand = await c.env.DB.prepare(`SELECT * FROM brands WHERE id = ?`)
    .bind(brandId)
    .first<Brand>()
  if (!brand) return c.json({ error: 'Not found' }, 404)
  if (brand.status !== 'scrape_blocked') return c.json({ error: 'Not in scrape_blocked state' }, 400)

  const domain = brand.domain || ''
  const brandName = (brand as any).name || domain.split('.')[0]

  // If the user pasted their own content, use it; otherwise fall back to AI domain knowledge
  const scraped = body.text?.trim()
    ? {
        pages: [{ url: brand.url, title: brandName || domain, description: '', text: body.text.trim() }],
        summary: body.text.trim().substring(0, 3000),
        brand_name: brandName,
        industry_keywords: [] as string[],
      }
    : {
        pages: [{
          url: brand.url,
          title: domain,
          description: '',
          text: `Site: ${brand.url}\nDomain: ${domain}\n\nThis site blocked automated scraping. Generate personas and questions using your general knowledge of this company, its industry, and the kinds of buyers it typically attracts.`,
        }],
        summary: `Brand: ${brandName}\nSite: ${brand.url}\n\nThis site blocked automated scraping. Use your general knowledge of this company, its industry, and typical buyer psychology to generate realistic personas and questions.`,
        brand_name: brandName,
        industry_keywords: [] as string[],
      }

  await c.env.DB.prepare(
    `UPDATE brands SET scraped_content = ?, name = ?, status = 'generating' WHERE id = ?`
  ).bind(JSON.stringify(scraped), brandName, brandId).run()

  const env = c.env
  c.executionCtx.waitUntil(
    (async () => {
      const { log, onProgress } = makeReporter(brandId, env)
      try {
        await log(`[${brandId.slice(0,8)}] Pre-flight API check…`)
        await pingOpenAI(env.OPENAI_API_KEY)
        await log(`[${brandId.slice(0,8)}] API key OK — generating from domain knowledge`)
        const { personas, brand_name } = await generatePersonas(scraped, null, env.OPENAI_API_KEY, onProgress, log)
        if (brand_name) {
          await env.DB.prepare(`UPDATE brands SET name = ? WHERE id = ?`).bind(brand_name, brandId).run()
        }
        if (personas.length > 0) {
          await env.DB.batch(personas.map(p =>
            env.DB.prepare(
              `INSERT INTO personas (id, brand_id, name, description, goals, pain_points, system_message, rationale) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(crypto.randomUUID(), brandId, p.name, p.description, JSON.stringify(p.goals ?? []), JSON.stringify(p.pain_points ?? []), p.system_message, p.rationale ?? null)
          ))
        }
        await env.DB.prepare(`UPDATE brands SET status = 'personas_ready' WHERE id = ?`).bind(brandId).run()
        await log(`[${brandId.slice(0,8)}] ✓ Personas ready`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await env.DB.prepare(`UPDATE brands SET status = 'scrape_blocked' WHERE id = ?`).bind(brandId).run()
        try { await env.KV.put(`error:${brandId}`, msg, { expirationTtl: 86400 }) } catch {}
        console.error(`[${brandId.slice(0,8)}] ✗ Proceed-blocked generation failed:`, msg)
      }
    })()
  )

  return c.json({ ok: true, status: 'generating' })
})

// POST /api/brands/:id/generate-prompts — generate persona-specific questions
// Optional query param: ?persona_id=X for per-persona regeneration
brands.post('/:id/generate-prompts', async c => {
  const brandId = c.req.param('id')
  const targetPersonaId = c.req.query('persona_id') || null

  const brand = await c.env.DB.prepare(`SELECT * FROM brands WHERE id = ?`)
    .bind(brandId)
    .first<Brand>()
  if (!brand) return c.json({ error: 'Not found' }, 404)
  if (!brand.scraped_content) return c.json({ error: 'No scraped content' }, 400)

  const { results: personaRows } = await c.env.DB.prepare(
    `SELECT id, name, description, goals, pain_points FROM personas WHERE brand_id = ? AND approved = 1 ORDER BY created_at`
  )
    .bind(brandId)
    .all<{ id: string; name: string; description: string; goals: string; pain_points: string }>()

  if (personaRows.length === 0) return c.json({ error: 'No approved personas — approve at least one persona first' }, 400)

  // Determine which personas to generate for
  const targetPersonas: PersonaForPrompts[] = (targetPersonaId
    ? personaRows.filter(p => p.id === targetPersonaId)
    : personaRows
  ).map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    goals: (() => { try { return JSON.parse(p.goals || '[]') } catch { return [] } })(),
    pain_points: (() => { try { return JSON.parse(p.pain_points || '[]') } catch { return [] } })(),
  }))

  if (targetPersonas.length === 0) return c.json({ error: 'Persona not found or not approved' }, 404)

  await c.env.DB.prepare(`UPDATE brands SET status = 'generating_prompts' WHERE id = ?`)
    .bind(brandId)
    .run()

  const env = c.env
  const scraped = JSON.parse(brand.scraped_content as string)
  const supplement = (brand as any).supplement || null
  const scrapedForPrompts = { ...scraped, brand_name: brand.name || scraped.brand_name }

  c.executionCtx.waitUntil(
    (async () => {
      const short = brandId.slice(0, 8)
      const { log, onProgress } = makeReporter(brandId, env)
      try {
        await log(`[${short}] Pre-flight API check…`)
        await pingOpenAI(env.OPENAI_API_KEY)
        await log(`[${short}] API key OK — generating questions for ${targetPersonas.length} persona(s)`)

        // Delete prompts for target personas (per-persona regen) or all (full regen)
        if (targetPersonaId) {
          await env.DB.prepare(`DELETE FROM prompts WHERE brand_id = ? AND persona_id = ?`).bind(brandId, targetPersonaId).run()
        } else {
          await env.DB.prepare(`DELETE FROM prompts WHERE brand_id = ?`).bind(brandId).run()
        }

        let totalSaved = 0
        for (let i = 0; i < targetPersonas.length; i++) {
          const persona = targetPersonas[i]
          await log(`[${short}] Generating questions for ${persona.name} (${i + 1}/${targetPersonas.length})`)

          const prompts = await generatePrompts(scrapedForPrompts, supplement, persona, env.OPENAI_API_KEY, onProgress, log)

          if (prompts.length > 0) {
            await env.DB.batch(
              prompts.map(p =>
                env.DB.prepare(
                  `INSERT INTO prompts (id, brand_id, persona_id, text, funnel_stage, rationale) VALUES (?, ?, ?, ?, ?, ?)`
                ).bind(crypto.randomUUID(), brandId, persona.id, p.text, p.funnel_stage, p.rationale ?? null)
              )
            )
            totalSaved += prompts.length
          }
        }

        await log(`[${short}] ✓ ${totalSaved} questions saved across ${targetPersonas.length} persona(s)`)
        await env.DB.prepare(`UPDATE brands SET status = 'ready' WHERE id = ?`).bind(brandId).run()
        await log(`[${short}] ✓ ready`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[${short}] ✗ generate-prompts failed: ${msg}`)
        await env.DB.prepare(`UPDATE brands SET status = 'personas_ready' WHERE id = ?`).bind(brandId).run()
        try { await env.KV.put(`error:${brandId}`, msg, { expirationTtl: 86400 }) } catch {}
      }
    })()
  )

  return c.json({ ok: true, status: 'generating_prompts' })
})

// GET /api/brands/:id — get brand with prompts + personas
brands.get('/:id', async c => {
  const brand = await c.env.DB.prepare(`SELECT * FROM brands WHERE id = ?`)
    .bind(c.req.param('id'))
    .first<Brand>()

  if (!brand) return c.json({ error: 'Not found' }, 404)

  const { results: prompts } = await c.env.DB.prepare(
    `SELECT * FROM prompts WHERE brand_id = ? ORDER BY persona_id, funnel_stage, created_at`
  )
    .bind(brand.id)
    .all()

  const { results: personas } = await c.env.DB.prepare(
    `SELECT * FROM personas WHERE brand_id = ? ORDER BY created_at`
  )
    .bind(brand.id)
    .all()

  // Read real-time progress from KV (only meaningful while status is in-progress)
  let currentStep: string | null = null
  let lastError: string | null = null
  let logs: string[] = []
  try {
    const raw = await c.env.KV.get(`progress:${brand.id}`)
    if (raw) currentStep = (JSON.parse(raw) as { step: string }).step
  } catch { /* non-fatal */ }
  try {
    lastError = await c.env.KV.get(`error:${brand.id}`)
  } catch { /* non-fatal */ }
  try {
    const rawLogs = await c.env.KV.get(`logs:${brand.id}`)
    if (rawLogs) logs = rawLogs.split('\n').filter(Boolean)
  } catch { /* non-fatal */ }

  return c.json({ ...brand, prompts, personas, currentStep, lastError, logs })
})

// POST /api/brands/:id/classify-prompts — classify pasted prompts into funnel stages (no storage)
brands.post('/:id/classify-prompts', async c => {
  const brandId = c.req.param('id')
  const brand = await c.env.DB.prepare(`SELECT * FROM brands WHERE id = ?`)
    .bind(brandId).first<Brand>()
  if (!brand) return c.json({ error: 'Brand not found' }, 404)

  const body = await c.req.json<{ texts: string[] }>().catch(() => ({ texts: [] as string[] }))
  if (!body.texts?.length) return c.json({ error: 'texts is required' }, 400)

  const texts = [...new Set(body.texts.map(t => t.trim()).filter(Boolean))].slice(0, 60)

  const { results: existingPromptRows } = await c.env.DB.prepare(
    `SELECT text FROM prompts WHERE brand_id = ? ORDER BY funnel_stage, created_at`
  ).bind(brandId).all<{ text: string }>()

  const context = {
    brandName: (brand as any).name ?? brand.domain ?? 'Brand',
    brandSummary: brand.scraped_content
      ? (JSON.parse(brand.scraped_content as string).summary ?? '').substring(0, 800)
      : '',
    existingPrompts: existingPromptRows.map(p => p.text),
  }

  try {
    const prompts = await classifyPrompts(texts, c.env.ANTHROPIC_API_KEY, context)
    return c.json({ prompts })
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/brands/:id/import-prompts — bulk insert pre-classified prompts
brands.post('/:id/import-prompts', async c => {
  const brandId = c.req.param('id')
  const brand = await c.env.DB.prepare(`SELECT id FROM brands WHERE id = ?`).bind(brandId).first()
  if (!brand) return c.json({ error: 'Brand not found' }, 404)

  const body = await c.req.json<{ prompts: Array<{ text: string; funnel_stage: string; rationale?: string }>; persona_id?: string }>()
  if (!body.prompts?.length) return c.json({ error: 'prompts is required' }, 400)

  const personaId = body.persona_id || null
  const valid = body.prompts.filter(p => p.text && ['tofu', 'mofu', 'bofu'].includes(p.funnel_stage))

  if (valid.length > 0) {
    await c.env.DB.batch(
      valid.map(p =>
        c.env.DB.prepare(
          `INSERT INTO prompts (id, brand_id, persona_id, text, funnel_stage, rationale) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), brandId, personaId, p.text, p.funnel_stage, p.rationale ?? null)
      )
    )
  }

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM prompts WHERE brand_id = ? ORDER BY persona_id, funnel_stage, created_at`
  ).bind(brandId).all()

  return c.json({ ok: true, count: valid.length, prompts: results })
})

// POST /api/brands/:id/supplement — upload ICP text, regenerate personas
brands.post('/:id/supplement', async c => {
  const brandId = c.req.param('id')
  const body = await c.req.json<{ text: string }>()
  if (!body.text?.trim()) return c.json({ error: 'text is required' }, 400)

  const brand = await c.env.DB.prepare(`SELECT * FROM brands WHERE id = ?`)
    .bind(brandId)
    .first<Brand>()

  if (!brand) return c.json({ error: 'Brand not found' }, 404)

  await c.env.DB.prepare(`UPDATE brands SET supplement = ? WHERE id = ?`)
    .bind(body.text.trim(), brandId)
    .run()

  const scraped = brand.scraped_content ? JSON.parse(brand.scraped_content) : null
  if (!scraped) return c.json({ error: 'Brand not scraped yet' }, 400)

  let result: Awaited<ReturnType<typeof generatePersonas>>
  try {
    result = await generatePersonas(scraped, body.text.trim(), c.env.OPENAI_API_KEY)
  } catch (err) {
    console.error('[supplement] generatePersonas failed:', err)
    return c.json({ error: 'Persona generation failed — try again' }, 500)
  }

  const { personas, brand_name } = result
  if (brand_name) {
    await c.env.DB.prepare(`UPDATE brands SET name = ? WHERE id = ?`).bind(brand_name, brandId).run()
  }

  // Delete prompts too — they reference the old persona IDs
  const deletePromptsStmt = c.env.DB.prepare(`DELETE FROM prompts WHERE brand_id = ?`).bind(brandId)
  const deleteStmt = c.env.DB.prepare(`DELETE FROM personas WHERE brand_id = ?`).bind(brandId)
  const insertStmts = personas.map(p =>
    c.env.DB.prepare(
      `INSERT INTO personas (id, brand_id, name, description, goals, pain_points, system_message, rationale) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), brandId, p.name, p.description, JSON.stringify(p.goals ?? []), JSON.stringify(p.pain_points ?? []), p.system_message, p.rationale ?? null)
  )
  try {
    await c.env.DB.batch([deletePromptsStmt, deleteStmt, ...insertStmts])
  } catch (err) {
    console.error('[supplement] persona replace failed:', err)
    return c.json({ error: 'Failed to save personas' }, 500)
  }

  const { results: newPersonas } = await c.env.DB.prepare(
    `SELECT * FROM personas WHERE brand_id = ? ORDER BY created_at`
  )
    .bind(brandId)
    .all()

  return c.json({ ok: true, personas: newPersonas })
})

export { brands }
