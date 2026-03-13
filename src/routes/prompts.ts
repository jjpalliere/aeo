import { Hono } from 'hono'
import type { Env } from '../types'

const prompts = new Hono<{ Bindings: Env }>()

// PATCH /api/prompts/:id — update text, funnel_stage, or approved
prompts.patch('/:id', async c => {
  const body = await c.req.json<{
    text?: string
    funnel_stage?: string
    approved?: number
  }>()

  const fields: string[] = []
  const values: unknown[] = []

  if (body.text !== undefined) { fields.push('text = ?'); values.push(body.text) }
  if (body.funnel_stage !== undefined) { fields.push('funnel_stage = ?'); values.push(body.funnel_stage) }
  if (body.approved !== undefined) { fields.push('approved = ?'); values.push(body.approved) }

  if (fields.length === 0) return c.json({ error: 'Nothing to update' }, 400)

  values.push(c.req.param('id'))
  await c.env.DB.prepare(`UPDATE prompts SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()

  const updated = await c.env.DB.prepare(`SELECT * FROM prompts WHERE id = ?`)
    .bind(c.req.param('id'))
    .first()

  return c.json(updated)
})

// DELETE /api/prompts/:id
prompts.delete('/:id', async c => {
  await c.env.DB.prepare(`DELETE FROM prompts WHERE id = ?`)
    .bind(c.req.param('id'))
    .run()
  return c.json({ ok: true })
})

// POST /api/prompts/approve-all/:brandId — approve all prompts for a brand
prompts.post('/approve-all/:brandId', async c => {
  await c.env.DB.prepare(`UPDATE prompts SET approved = 1 WHERE brand_id = ?`)
    .bind(c.req.param('brandId'))
    .run()
  return c.json({ ok: true })
})

export { prompts }
