// src/routes/similarity.ts — Brand ↔ Similarity KV run mappings (team-scoped)

import { Hono } from 'hono'
import type { Env } from '../types'
import { rejectIfNotOwner } from '../middleware/owner'
import { requireBrand } from '../middleware/scope'

const similarity = new Hono<{ Bindings: Env }>()

/** List all key names in a KV namespace (paginated). */
async function listAllKvKeys(kv: KVNamespace): Promise<string[]> {
  const names: string[] = []
  let cursor: string | undefined
  for (;;) {
    const list = await kv.list(cursor ? { cursor } : {})
    for (const k of list.keys) names.push(k.name)
    if (list.list_complete) break
    cursor = list.cursor
  }
  return names
}

// GET /api/similarity/runs — mapped runs for active brand (team-scoped)
similarity.get('/runs', async c => {
  const brandId = c.req.query('brand_id')?.trim() || c.get('brandId')
  if (!brandId) {
    return c.json({ error: 'Select a brand or pass brand_id' }, 400)
  }

  const brand = await requireBrand(c, brandId)
  if (!brand) {
    return c.json({ error: 'Brand not found' }, 404)
  }

  const { results } = await c.env.DB.prepare(
    `SELECT id, brand_id, run_id, label, created_at
     FROM similarity_runs WHERE brand_id = ? ORDER BY created_at DESC`
  )
    .bind(brandId)
    .all<{ id: string; brand_id: string; run_id: string; label: string; created_at: string }>()

  return c.json({ runs: results ?? [] })
})

// POST /api/similarity/runs — create mapping (owner only)
similarity.post('/runs', async c => {
  const denied = rejectIfNotOwner(c)
  if (denied) return denied

  const body = await c.req
    .json<{ brand_id?: string; run_id?: string; label?: string }>()
    .catch(() => ({} as Record<string, unknown>))

  const brandId = typeof body.brand_id === 'string' ? body.brand_id.trim() : ''
  const runId = typeof body.run_id === 'string' ? body.run_id.trim() : ''
  const label = typeof body.label === 'string' ? body.label.trim() : ''

  if (!brandId || !runId || !label) {
    return c.json({ error: 'brand_id, run_id, and label are required' }, 400)
  }

  const brand = await requireBrand(c, brandId)
  if (!brand) {
    return c.json({ error: 'Brand not found' }, 404)
  }

  const id = crypto.randomUUID()
  try {
    await c.env.DB.prepare(
      `INSERT INTO similarity_runs (id, brand_id, run_id, label) VALUES (?, ?, ?, ?)`
    )
      .bind(id, brandId, runId, label)
      .run()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/UNIQUE|unique/i.test(msg)) {
      return c.json({ error: 'This run is already mapped to this brand' }, 409)
    }
    throw e
  }

  return c.json({ id, brand_id: brandId, run_id: runId, label }, 201)
})

// DELETE /api/similarity/runs/:id — remove mapping (owner only)
similarity.delete('/runs/:id', async c => {
  const denied = rejectIfNotOwner(c)
  if (denied) return denied

  const mappingId = c.req.param('id')
  const teamId = c.get('teamId')

  const row = await c.env.DB.prepare(
    `SELECT sr.id FROM similarity_runs sr
     JOIN brands b ON b.id = sr.brand_id
     WHERE sr.id = ? AND b.team_id = ?`
  )
    .bind(mappingId, teamId)
    .first<{ id: string }>()

  if (!row) {
    return c.json({ error: 'Mapping not found' }, 404)
  }

  await c.env.DB.prepare('DELETE FROM similarity_runs WHERE id = ?').bind(mappingId).run()
  return c.json({ ok: true })
})

// GET /api/similarity/available-runs — raw KV key names in SIMILARITY_KV (owner only)
similarity.get('/available-runs', async c => {
  const denied = rejectIfNotOwner(c)
  if (denied) return denied

  const kv = c.env.SIMILARITY_KV
  if (!kv) {
    return c.json(
      { error: 'SIMILARITY_KV binding not configured' },
      503
    )
  }

  const keys = await listAllKvKeys(kv)
  return c.json({ keys })
})

export { similarity }
