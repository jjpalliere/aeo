// src/routes/admin.ts — Owner-only: signup codes, accounts, fallback tokens, join requests

import { Hono } from 'hono'
import type { Env } from '../types'
import { createAccountWithDefaultTeam, generateInviteCode } from '../services/auth'
import { issueMagicLink, MAGIC_LINK_TTL_APPROVAL_MIN } from '../services/magic-link'

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

// GET /api/admin/join-requests?status=pending|approved|rejected|all
admin.get('/join-requests', async c => {
  const raw = c.req.query('status') ?? 'pending'
  const allowed = new Set(['pending', 'approved', 'rejected', 'all'])
  const statusFilter = allowed.has(raw) ? raw : 'pending'

  if (statusFilter === 'all') {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM join_requests ORDER BY created_at ASC'
    ).all()
    return c.json({ requests: results })
  }

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM join_requests WHERE status = ? ORDER BY created_at ASC'
  )
    .bind(statusFilter)
    .all()
  return c.json({ requests: results })
})

// POST /api/admin/join-requests/:id/approve
admin.post('/join-requests/:id/approve', async c => {
  const id = c.req.param('id')
  const reviewer = c.get('account')

  const row = await c.env.DB.prepare(
    `SELECT * FROM join_requests WHERE id = ?`
  ).bind(id).first<{
    id: string
    email: string
    status: string
  }>()

  if (!row || row.status !== 'pending') {
    return c.json({ error: 'Request not found or not pending' }, 400)
  }

  const email = row.email

  const existing = await c.env.DB.prepare(
    'SELECT id FROM accounts WHERE email = ?'
  ).bind(email).first<{ id: string }>()
  if (!existing) {
    await createAccountWithDefaultTeam(c.env.DB, email)
  }

  const upd = await c.env.DB.prepare(
    `UPDATE join_requests SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ?
     WHERE id = ? AND status = 'pending'`
  )
    .bind(reviewer.id, id)
    .run()

  if (upd.meta.changes === 0) {
    return c.json({ error: 'Request could not be approved' }, 400)
  }

  await issueMagicLink(c.env, email, MAGIC_LINK_TTL_APPROVAL_MIN)
  return c.json({ ok: true })
})

// POST /api/admin/join-requests/:id/reject
admin.post('/join-requests/:id/reject', async c => {
  const id = c.req.param('id')
  const reviewer = c.get('account')
  const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }))
  const reason = body.reason?.trim().slice(0, 500) || null

  const upd = await c.env.DB.prepare(
    `UPDATE join_requests SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ?, reject_reason = ?
     WHERE id = ? AND status = 'pending'`
  )
    .bind(reviewer.id, reason, id)
    .run()

  if (upd.meta.changes === 0) {
    return c.json({ error: 'Request not found or not pending' }, 400)
  }

  return c.json({ ok: true })
})

// POST /api/admin/join-requests/:id/resend-link — approved row only; new 2h magic link
admin.post('/join-requests/:id/resend-link', async c => {
  const id = c.req.param('id')

  const row = await c.env.DB.prepare(
    `SELECT * FROM join_requests WHERE id = ?`
  ).bind(id).first<{ id: string; email: string; status: string }>()

  if (!row || row.status !== 'approved') {
    return c.json({ error: 'Only approved requests can resend a login link' }, 400)
  }

  const account = await c.env.DB.prepare(
    'SELECT id FROM accounts WHERE email = ?'
  ).bind(row.email).first<{ id: string }>()
  if (!account) {
    return c.json({ error: 'No account for this email' }, 400)
  }

  await issueMagicLink(c.env, row.email, MAGIC_LINK_TTL_APPROVAL_MIN)
  return c.json({ ok: true })
})

export { admin }
