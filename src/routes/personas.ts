import { Hono } from 'hono'
import type { Env } from '../types'

const personas = new Hono<{ Bindings: Env }>()

// PATCH /api/personas/:id
personas.patch('/:id', async c => {
  const teamId = c.get('teamId')
  const body = await c.req.json<{
    name?: string
    description?: string
    system_message?: string
    approved?: number
  }>()

  const fields: string[] = []
  const values: unknown[] = []

  if (body.name !== undefined) { fields.push('name = ?'); values.push(body.name) }
  if (body.description !== undefined) { fields.push('description = ?'); values.push(body.description) }
  if (body.system_message !== undefined) { fields.push('system_message = ?'); values.push(body.system_message) }
  if (body.approved !== undefined) { fields.push('approved = ?'); values.push(body.approved) }

  if (fields.length === 0) return c.json({ error: 'Nothing to update' }, 400)

  values.push(c.req.param('id'), teamId)
  await c.env.DB.prepare(`UPDATE personas SET ${fields.join(', ')} WHERE id = ? AND team_id = ?`)
    .bind(...values)
    .run()

  const updated = await c.env.DB.prepare(`SELECT * FROM personas WHERE id = ? AND team_id = ?`)
    .bind(c.req.param('id'), teamId)
    .first()

  if (!updated) return c.json({ error: 'Not found' }, 404)
  return c.json(updated)
})

// DELETE /api/personas/:id — cascade-deletes persona's prompts too
personas.delete('/:id', async c => {
  const teamId = c.get('teamId')
  const id = c.req.param('id')
  // Verify ownership before delete
  const persona = await c.env.DB.prepare(`SELECT id FROM personas WHERE id = ? AND team_id = ?`)
    .bind(id, teamId).first()
  if (!persona) return c.json({ error: 'Not found' }, 404)

  await c.env.DB.prepare(`DELETE FROM prompts WHERE persona_id = ? AND team_id = ?`).bind(id, teamId).run()
  await c.env.DB.prepare(`DELETE FROM personas WHERE id = ? AND team_id = ?`).bind(id, teamId).run()
  return c.json({ ok: true })
})

// POST /api/personas/approve-all/:brandId
personas.post('/approve-all/:brandId', async c => {
  const teamId = c.get('teamId')
  await c.env.DB.prepare(`UPDATE personas SET approved = 1 WHERE brand_id = ? AND team_id = ?`)
    .bind(c.req.param('brandId'), teamId)
    .run()
  return c.json({ ok: true })
})

export { personas }
