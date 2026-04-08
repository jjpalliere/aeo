// src/routes/admin.ts — Owner-only: signup codes, accounts, fallback tokens

import { Hono } from 'hono'
import type { Env } from '../types'
import { generateInviteCode } from '../services/auth'

const admin = new Hono<{ Bindings: Env }>()

// Owner-only guard
admin.use('/*', async (c, next) => {
  const account = c.get('account')
  if (!account?.is_owner) return c.json({ error: 'Forbidden' }, 403)
  return next()
})

// GET /api/admin/codes — list all signup codes
admin.get('/codes', async c => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM signup_codes ORDER BY created_at DESC'
  ).all()
  return c.json({ codes: results })
})

// POST /api/admin/codes — generate a new signup code
admin.post('/codes', async c => {
  const body = await c.req.json<{ max_uses?: number }>().catch(() => ({ max_uses: undefined } as { max_uses?: number }))
  const maxUses = body.max_uses ?? 1
  const account = c.get('account')

  const id = crypto.randomUUID()
  const code = generateInviteCode()

  await c.env.DB.prepare(
    'INSERT INTO signup_codes (id, code, max_uses, times_used, created_by) VALUES (?, ?, ?, 0, ?)'
  ).bind(id, code, maxUses, account.id).run()

  return c.json({ id, code, max_uses: maxUses }, 201)
})

// GET /api/admin/accounts — list all accounts
admin.get('/accounts', async c => {
  const { results } = await c.env.DB.prepare(`
    SELECT a.id, a.email, a.is_owner, a.created_at,
           GROUP_CONCAT(t.name, ', ') as teams
    FROM accounts a
    LEFT JOIN team_members tm ON tm.account_id = a.id
    LEFT JOIN teams t ON t.id = tm.team_id
    GROUP BY a.id
    ORDER BY a.created_at DESC
  `).all()
  return c.json({ accounts: results })
})

// GET /api/admin/fallback-tokens — list KV fallback magic link tokens
admin.get('/fallback-tokens', async c => {
  // KV list with prefix
  const list = await c.env.KV.list({ prefix: 'magic_link_fallback:' })
  const tokens: { email: string; token: string }[] = []
  for (const key of list.keys) {
    const token = await c.env.KV.get(key.name)
    if (token) {
      tokens.push({
        email: key.name.replace('magic_link_fallback:', ''),
        token,
      })
    }
  }
  return c.json({ tokens })
})

export { admin }
