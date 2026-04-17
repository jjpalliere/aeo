// src/routes/admin.ts — Owner-only: signup codes, accounts, fallback tokens, join requests, teams management

import { Hono } from 'hono'
import type { Env } from '../types'
import { createAccountWithDefaultTeam, generateInviteCode } from '../services/auth'
import { issueMagicLink, MAGIC_LINK_TTL_APPROVAL_MIN } from '../services/magic-link'
import { getArchiveTeamId, deleteTeamArchiveFlow } from '../services/archive'

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

// ─── Teams management (owner) ──────────────────────────────────────────────

// GET /api/admin/teams — all teams with counts + is_archive flag
admin.get('/teams', async c => {
  const archiveTeamId = await getArchiveTeamId(c.env.DB).catch(() => null)
  const { results } = await c.env.DB.prepare(`
    SELECT t.id, t.name, t.invite_code, t.created_at,
           (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count,
           (SELECT COUNT(*) FROM brands WHERE team_id = t.id AND archived_at IS NULL) as brand_count,
           (SELECT COUNT(*) FROM brands WHERE team_id = t.id AND archived_at IS NOT NULL) as archived_brand_count,
           (SELECT COUNT(*) FROM runs WHERE team_id = t.id) as run_count
    FROM teams t
    ORDER BY t.created_at DESC
  `).all<{
    id: string; name: string; invite_code: string; created_at: string
    member_count: number; brand_count: number; archived_brand_count: number; run_count: number
  }>()
  const teams = (results ?? []).map(r => ({ ...r, is_archive: r.id === archiveTeamId }))
  return c.json({ teams, archive_team_id: archiveTeamId })
})

// POST /api/admin/teams — create a team on behalf of a user (or self)
admin.post('/teams', async c => {
  const body = await c.req.json<{ name?: string; assigneeEmail?: string }>().catch(() => ({} as { name?: string; assigneeEmail?: string }))
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'name required' }, 400)

  let assigneeId = c.get('account').id
  if (body.assigneeEmail) {
    const acc = await c.env.DB.prepare(`SELECT id FROM accounts WHERE email = ?`)
      .bind(body.assigneeEmail.trim().toLowerCase()).first<{ id: string }>()
    if (!acc) return c.json({ error: 'assignee email not found' }, 404)
    assigneeId = acc.id
  }

  const teamId = crypto.randomUUID()
  const inviteCode = generateInviteCode()
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO teams (id, name, invite_code, created_by) VALUES (?, ?, ?, ?)`)
      .bind(teamId, name, inviteCode, assigneeId),
    c.env.DB.prepare(`INSERT INTO team_members (team_id, account_id, role) VALUES (?, ?, 'admin')`)
      .bind(teamId, assigneeId),
  ])

  return c.json({ id: teamId, name, invite_code: inviteCode }, 201)
})

// GET /api/admin/teams/:id/members — any team's members (bypasses "must be a member")
admin.get('/teams/:id/members', async c => {
  const teamId = c.req.param('id')
  const { results } = await c.env.DB.prepare(`
    SELECT a.id, a.email, a.is_owner, tm.role, tm.joined_at
    FROM accounts a
    JOIN team_members tm ON tm.account_id = a.id
    WHERE tm.team_id = ?
    ORDER BY tm.joined_at
  `).bind(teamId).all()
  return c.json({ members: results })
})

// DELETE /api/admin/teams/:id — archive-to-admin on delete (owner can delete any team)
admin.delete('/teams/:id', async c => {
  const teamId = c.req.param('id')
  const body = await c.req.json<{ confirmName?: string }>().catch(() => ({} as { confirmName?: string }))
  const team = await c.env.DB.prepare(`SELECT name FROM teams WHERE id = ?`)
    .bind(teamId).first<{ name: string }>()
  if (!team) return c.json({ error: 'Team not found' }, 404)
  const confirm = body.confirmName?.trim().toLowerCase()
  if (!confirm || confirm !== team.name.trim().toLowerCase()) {
    return c.json({ error: 'confirmName must match team name' }, 400)
  }
  const deleter = c.get('account')
  try {
    await deleteTeamArchiveFlow({
      db: c.env.DB, kv: c.env.KV, teamId, deleterAccountId: deleter.id,
    })
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode ?? 500
    const message = err instanceof Error ? err.message : 'Delete failed'
    return c.json({ error: message }, status as 400 | 404 | 409 | 500)
  }
  return c.json({ ok: true })
})

// GET /api/admin/archive — archived brands visible for audit
admin.get('/archive', async c => {
  const { results } = await c.env.DB.prepare(`
    SELECT b.id, b.name, b.domain, b.archived_at,
           b.archived_from_team_name, b.archived_from_account_id,
           a.email as archived_by_email
    FROM brands b
    LEFT JOIN accounts a ON a.id = b.archived_from_account_id
    WHERE b.archived_at IS NOT NULL
    ORDER BY b.archived_at DESC
  `).all()
  return c.json({ archive: results })
})

// GET /api/admin/deletion-log — team deletion history
admin.get('/deletion-log', async c => {
  const { results } = await c.env.DB.prepare(`
    SELECT tdl.id, tdl.team_name, tdl.brand_ids, tdl.created_at, a.email as deleted_by_email
    FROM team_deletion_log tdl
    JOIN accounts a ON a.id = tdl.deleted_by
    ORDER BY tdl.created_at DESC
    LIMIT 100
  `).all()
  return c.json({ log: results })
})

// PATCH /api/admin/accounts/:id — toggle is_owner
admin.patch('/accounts/:id', async c => {
  const targetId = c.req.param('id')
  const body = await c.req.json<{ is_owner?: boolean }>().catch(() => ({} as { is_owner?: boolean }))
  if (typeof body.is_owner !== 'boolean') {
    return c.json({ error: 'is_owner (boolean) required' }, 400)
  }
  const caller = c.get('account')

  // Guard: cannot strip is_owner from yourself if you're the last owner.
  if (body.is_owner === false) {
    const { results: owners } = await c.env.DB.prepare(
      `SELECT id FROM accounts WHERE is_owner = 1`
    ).all<{ id: string }>()
    if ((owners?.length ?? 0) <= 1) {
      return c.json({ error: 'Cannot remove the last super-admin' }, 400)
    }
    if (targetId === caller.id && (owners?.length ?? 0) === 1) {
      return c.json({ error: 'Cannot remove your own super-admin status as the last owner' }, 400)
    }
  }

  const res = await c.env.DB.prepare(
    `UPDATE accounts SET is_owner = ? WHERE id = ?`
  ).bind(body.is_owner ? 1 : 0, targetId).run()
  if (res.meta.changes === 0) return c.json({ error: 'account not found' }, 404)

  return c.json({ ok: true })
})

// PATCH /api/admin/brands/:id/team — move a brand between teams (owner only)
admin.patch('/brands/:id/team', async c => {
  const brandId = c.req.param('id')
  const body = await c.req.json<{ team_id?: string }>().catch(() => ({} as { team_id?: string }))
  if (!body.team_id) return c.json({ error: 'team_id required' }, 400)

  const brand = await c.env.DB.prepare(`SELECT team_id FROM brands WHERE id = ?`)
    .bind(brandId).first<{ team_id: string }>()
  if (!brand) return c.json({ error: 'brand not found' }, 404)
  if (brand.team_id === body.team_id) return c.json({ ok: true, no_op: true })

  const target = await c.env.DB.prepare(`SELECT id FROM teams WHERE id = ?`)
    .bind(body.team_id).first()
  if (!target) return c.json({ error: 'target team not found' }, 404)

  // Block if brand has an active run.
  const active = await c.env.DB.prepare(
    `SELECT 1 FROM runs WHERE brand_id = ? AND status IN ('pending','querying','scraping','analyzing') LIMIT 1`
  ).bind(brandId).first()
  if (active) return c.json({ error: 'brand has an in-flight run' }, 409)

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE brands SET team_id = ? WHERE id = ?`).bind(body.team_id, brandId),
    c.env.DB.prepare(`UPDATE runs SET team_id = ? WHERE brand_id = ?`).bind(body.team_id, brandId),
    c.env.DB.prepare(`UPDATE prompts SET team_id = ? WHERE brand_id = ?`).bind(body.team_id, brandId),
    c.env.DB.prepare(`UPDATE personas SET team_id = ? WHERE brand_id = ?`).bind(body.team_id, brandId),
  ])

  // KV rekey for this single brand's keys ({oldTeamId}:*:{brandId}).
  // We rewrite all keys prefixed by oldTeamId: whose tail mentions this brand.
  try {
    const oldPrefix = `${brand.team_id}:`
    const newPrefix = `${body.team_id}:`
    let cursor: string | undefined
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const list = await c.env.KV.list({ prefix: oldPrefix, cursor })
      for (const { name } of list.keys) {
        if (!name.includes(brandId)) continue
        const rest = name.slice(oldPrefix.length)
        let newKey = newPrefix + rest
        const existing = await c.env.KV.get(newKey)
        if (existing !== null) newKey = `${newKey}:from:${brand.team_id}`
        const value = await c.env.KV.get(name)
        if (value !== null) await c.env.KV.put(newKey, value)
        await c.env.KV.delete(name)
      }
      if (list.list_complete) break
      cursor = list.cursor
    }
  } catch (err) {
    console.error('[admin/brands/:id/team] KV rekey failed (non-fatal):', err)
  }

  return c.json({ ok: true })
})

export { admin }
