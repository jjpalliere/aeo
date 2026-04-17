// src/routes/teams.ts — Team CRUD, member management, invitations (admin-gated).

import { Hono } from 'hono'
import type { Env } from '../types'
import { generateInviteCode, generateToken } from '../services/auth'
import { isTeamAdmin } from '../middleware/teamAdmin'
import { deleteTeamArchiveFlow } from '../services/archive'
import { sendInvitationEmail } from '../services/invitation-email'

const teams = new Hono<{ Bindings: Env }>()

const INVITE_TTL_DAYS = 7

// ─── List / create / join ───────────────────────────────────────────────────

// GET /api/teams — list teams the current user belongs to
teams.get('/', async c => {
  const account = c.get('account')
  const { results } = await c.env.DB.prepare(`
    SELECT t.id, t.name, t.invite_code, t.created_at, tm.role,
           (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count,
           (SELECT COUNT(*) FROM brands WHERE team_id = t.id AND archived_at IS NULL) as brand_count
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE tm.account_id = ?
    ORDER BY tm.joined_at
  `).bind(account.id).all()

  return c.json({ teams: results })
})

// POST /api/teams — create a new team (creator becomes admin)
teams.post('/', async c => {
  const account = c.get('account')
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }))
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'Team name is required' }, 400)

  const teamId = crypto.randomUUID()
  const inviteCode = generateInviteCode()

  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO teams (id, name, invite_code, created_by) VALUES (?, ?, ?, ?)')
      .bind(teamId, name, inviteCode, account.id),
    c.env.DB.prepare(`INSERT INTO team_members (team_id, account_id, role) VALUES (?, ?, 'admin')`)
      .bind(teamId, account.id),
  ])

  return c.json({ id: teamId, name, invite_code: inviteCode }, 201)
})

// POST /api/teams/join — join via invite code (any existing account)
teams.post('/join', async c => {
  const account = c.get('account')
  const body = await c.req.json<{ invite_code?: string }>().catch(() => ({} as { invite_code?: string }))
  const code = body.invite_code?.trim()
  if (!code) return c.json({ error: 'Invite code is required' }, 400)

  const team = await c.env.DB.prepare(
    'SELECT id, name FROM teams WHERE UPPER(invite_code) = UPPER(?)'
  ).bind(code).first<{ id: string; name: string }>()

  if (!team) return c.json({ error: 'Invalid invite code' }, 404)

  const existing = await c.env.DB.prepare(
    'SELECT 1 FROM team_members WHERE team_id = ? AND account_id = ?'
  ).bind(team.id, account.id).first()
  if (existing) return c.json({ error: 'Already a member of this team' }, 409)

  await c.env.DB.prepare(
    `INSERT INTO team_members (team_id, account_id, role) VALUES (?, ?, 'member')`
  ).bind(team.id, account.id).run()

  return c.json({ ok: true, team_id: team.id, team_name: team.name })
})

// ─── Rename / delete ────────────────────────────────────────────────────────

// PATCH /api/teams/:id — rename (team admin or owner)
teams.patch('/:id', async c => {
  const teamId = c.req.param('id')
  if (!(await isTeamAdmin(c, teamId))) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }))
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'name is required' }, 400)
  if (name.length > 200) return c.json({ error: 'name too long' }, 400)

  const res = await c.env.DB.prepare(`UPDATE teams SET name = ? WHERE id = ?`)
    .bind(name, teamId).run()
  if (res.meta.changes === 0) return c.json({ error: 'Team not found' }, 404)

  return c.json({ ok: true, name })
})

// DELETE /api/teams/:id — archive-to-admin on delete
// Body: { confirmName } — must match current team name
teams.delete('/:id', async c => {
  const teamId = c.req.param('id')
  if (!(await isTeamAdmin(c, teamId))) return c.json({ error: 'Forbidden' }, 403)

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
      db: c.env.DB,
      kv: c.env.KV,
      teamId,
      deleterAccountId: deleter.id,
    })
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode ?? 500
    const message = err instanceof Error ? err.message : 'Delete failed'
    return c.json({ error: message }, status as 400 | 404 | 409 | 500)
  }

  // Generic response — no hint that data was archived.
  return c.json({ ok: true })
})

// POST /api/teams/:id/rotate-invite — generate a new invite code, invalidating the old one
teams.post('/:id/rotate-invite', async c => {
  const teamId = c.req.param('id')
  if (!(await isTeamAdmin(c, teamId))) return c.json({ error: 'Forbidden' }, 403)
  const code = generateInviteCode()
  const res = await c.env.DB.prepare(`UPDATE teams SET invite_code = ? WHERE id = ?`)
    .bind(code, teamId).run()
  if (res.meta.changes === 0) return c.json({ error: 'Team not found' }, 404)
  return c.json({ ok: true, invite_code: code })
})

// ─── Members ────────────────────────────────────────────────────────────────

// GET /api/teams/:id/members — list members (must be a member)
teams.get('/:id/members', async c => {
  const teamId = c.req.param('id')
  const account = c.get('account')

  if (!account.is_owner) {
    const member = await c.env.DB.prepare(
      'SELECT 1 FROM team_members WHERE team_id = ? AND account_id = ?'
    ).bind(teamId, account.id).first()
    if (!member) return c.json({ error: 'Not found' }, 404)
  }

  const { results } = await c.env.DB.prepare(`
    SELECT a.id, a.email, tm.role, tm.joined_at
    FROM accounts a
    JOIN team_members tm ON tm.account_id = a.id
    WHERE tm.team_id = ?
    ORDER BY tm.joined_at
  `).bind(teamId).all()

  return c.json({ members: results })
})

// POST /api/teams/:id/members — add existing account by email
teams.post('/:id/members', async c => {
  const teamId = c.req.param('id')
  if (!(await isTeamAdmin(c, teamId))) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{ email?: string; role?: string }>().catch(() => ({} as { email?: string; role?: string }))
  const email = body.email?.trim().toLowerCase()
  if (!email) return c.json({ error: 'email required' }, 400)
  const role = body.role === 'admin' ? 'admin' : 'member'

  const acc = await c.env.DB.prepare(`SELECT id FROM accounts WHERE email = ?`)
    .bind(email).first<{ id: string }>()
  if (!acc) {
    return c.json({ error: 'no account exists for that email — use Invite by email instead' }, 404)
  }

  const existing = await c.env.DB.prepare(
    'SELECT 1 FROM team_members WHERE team_id = ? AND account_id = ?'
  ).bind(teamId, acc.id).first()
  if (existing) return c.json({ error: 'already a member' }, 409)

  await c.env.DB.prepare(
    `INSERT INTO team_members (team_id, account_id, role) VALUES (?, ?, ?)`
  ).bind(teamId, acc.id, role).run()

  return c.json({ ok: true })
})

// DELETE /api/teams/:id/members/:accountId — kick
teams.delete('/:id/members/:accountId', async c => {
  const teamId = c.req.param('id')
  const kickId = c.req.param('accountId')
  const caller = c.get('account')

  if (!(await isTeamAdmin(c, teamId))) return c.json({ error: 'Forbidden' }, 403)

  // Self-kick → leave flow
  if (kickId === caller.id) {
    const { results: all } = await c.env.DB.prepare(
      `SELECT account_id, role FROM team_members WHERE team_id = ?`
    ).bind(teamId).all<{ account_id: string; role: string }>()
    if (all.length <= 1) {
      return c.json({ error: 'Cannot leave — you are the only member. Delete the team instead.' }, 400)
    }
    const admins = all.filter(m => m.role === 'admin')
    if (admins.length === 1 && admins[0].account_id === caller.id && !caller.is_owner) {
      return c.json({ error: 'Promote another member to admin first.' }, 400)
    }
    await c.env.DB.prepare(
      `DELETE FROM team_members WHERE team_id = ? AND account_id = ?`
    ).bind(teamId, caller.id).run()
    return c.json({ ok: true })
  }

  // Kicking someone else — never let the last admin disappear (unless super-admin override).
  if (!caller.is_owner) {
    const target = await c.env.DB.prepare(
      `SELECT role FROM team_members WHERE team_id = ? AND account_id = ?`
    ).bind(teamId, kickId).first<{ role: string }>()
    if (target?.role === 'admin') {
      const { results: admins } = await c.env.DB.prepare(
        `SELECT account_id FROM team_members WHERE team_id = ? AND role = 'admin'`
      ).bind(teamId).all()
      if ((admins?.length ?? 0) <= 1) {
        return c.json({ error: 'Promote another member to admin first.' }, 400)
      }
    }
  }

  const res = await c.env.DB.prepare(
    `DELETE FROM team_members WHERE team_id = ? AND account_id = ?`
  ).bind(teamId, kickId).run()
  if (res.meta.changes === 0) return c.json({ error: 'member not found' }, 404)

  // Clear active_team_id for kicked user if it was this team.
  await c.env.DB.prepare(
    `UPDATE sessions SET active_team_id = NULL, active_brand_id = NULL
     WHERE active_team_id = ? AND account_id = ?`
  ).bind(teamId, kickId).run()

  return c.json({ ok: true })
})

// PATCH /api/teams/:id/members/:accountId — promote / demote
teams.patch('/:id/members/:accountId', async c => {
  const teamId = c.req.param('id')
  const memberId = c.req.param('accountId')
  if (!(await isTeamAdmin(c, teamId))) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{ role?: string }>().catch(() => ({} as { role?: string }))
  const role = body.role
  if (role !== 'admin' && role !== 'member') {
    return c.json({ error: 'role must be admin or member' }, 400)
  }

  // If demoting an admin, ensure another admin remains.
  if (role === 'member') {
    const { results: admins } = await c.env.DB.prepare(
      `SELECT account_id FROM team_members WHERE team_id = ? AND role = 'admin'`
    ).bind(teamId).all<{ account_id: string }>()
    if ((admins?.length ?? 0) <= 1 && admins?.[0]?.account_id === memberId) {
      return c.json({ error: 'Cannot demote the last admin' }, 400)
    }
  }

  const res = await c.env.DB.prepare(
    `UPDATE team_members SET role = ? WHERE team_id = ? AND account_id = ?`
  ).bind(role, teamId, memberId).run()
  if (res.meta.changes === 0) return c.json({ error: 'member not found' }, 404)

  return c.json({ ok: true, role })
})

// DELETE /api/teams/:id/leave — leave a team (keeps existing contract)
teams.delete('/:id/leave', async c => {
  const teamId = c.req.param('id')
  const account = c.get('account')

  const { results: all } = await c.env.DB.prepare(
    `SELECT account_id, role FROM team_members WHERE team_id = ?`
  ).bind(teamId).all<{ account_id: string; role: string }>()
  if (!all || all.length === 0) return c.json({ error: 'not a member' }, 404)
  if (all.length <= 1) {
    return c.json({ error: 'Cannot leave — you are the only member. Delete the team instead.' }, 400)
  }
  const admins = all.filter(m => m.role === 'admin')
  if (admins.length === 1 && admins[0].account_id === account.id && !account.is_owner) {
    return c.json({ error: 'Promote another member to admin first.' }, 400)
  }

  await c.env.DB.prepare(
    'DELETE FROM team_members WHERE team_id = ? AND account_id = ?'
  ).bind(teamId, account.id).run()
  return c.json({ ok: true })
})

// ─── Invitations (admin-gated CRUD) ─────────────────────────────────────────

// POST /api/teams/:id/invitations — invite by email (existing or new account)
teams.post('/:id/invitations', async c => {
  const teamId = c.req.param('id')
  if (!(await isTeamAdmin(c, teamId))) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json<{ email?: string }>().catch(() => ({} as { email?: string }))
  const email = body.email?.trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'valid email required' }, 400)
  }

  const team = await c.env.DB.prepare(`SELECT name FROM teams WHERE id = ?`)
    .bind(teamId).first<{ name: string }>()
  if (!team) return c.json({ error: 'Team not found' }, 404)

  // Dedupe: already a member?
  const existingAcc = await c.env.DB.prepare(`SELECT id FROM accounts WHERE email = ?`)
    .bind(email).first<{ id: string }>()
  if (existingAcc) {
    const existingMember = await c.env.DB.prepare(
      `SELECT 1 FROM team_members WHERE team_id = ? AND account_id = ?`
    ).bind(teamId, existingAcc.id).first()
    if (existingMember) return c.json({ error: 'already a member' }, 409)
  }

  // Dedupe: pending invitation for same (team, email)?
  const existingInvite = await c.env.DB.prepare(
    `SELECT id FROM invitations WHERE team_id = ? AND email = ? AND status = 'pending'`
  ).bind(teamId, email).first()
  if (existingInvite) {
    return c.json({ error: 'invitation already pending — resend instead' }, 409)
  }

  // Reserve a signup code only if the email has no account yet.
  let signupCodeId: string | null = null
  if (!existingAcc) {
    signupCodeId = crypto.randomUUID()
  }

  const invitationId = crypto.randomUUID()
  const token = generateToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const inviter = c.get('account')

  const stmts: D1PreparedStatement[] = []
  if (signupCodeId) {
    // One-use signup code so /api/invitations/accept can consume it even under
    // the site-wide signup-code requirement.
    const code = generateInviteCode()
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO signup_codes (id, code, max_uses, times_used, created_by) VALUES (?, ?, 1, 0, ?)`
      ).bind(signupCodeId, code, inviter.id)
    )
  }
  stmts.push(
    c.env.DB.prepare(`
      INSERT INTO invitations
        (id, team_id, email, invited_by_account_id, token, status, expires_at, signup_code_id)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).bind(invitationId, teamId, email, inviter.id, token, expiresAt, signupCodeId)
  )

  await c.env.DB.batch(stmts)

  // Send email — failure is logged but the invitation persists so resend can retry.
  const siteUrl = c.env.SITE_URL || 'https://terrain.run'
  try {
    await sendInvitationEmail(email, token, team.name, inviter.email, c.env.RESEND_API_KEY, siteUrl)
  } catch (err) {
    console.error('[invitations] send failed, KV fallback:', err)
    try {
      await c.env.KV.put(`invitation_fallback:${email}`, token, { expirationTtl: 7 * 24 * 60 * 60 })
    } catch (kvErr) {
      console.error('[invitations] KV fallback failed:', kvErr)
    }
  }

  return c.json({ ok: true, id: invitationId }, 201)
})

// GET /api/teams/:id/invitations — list pending + recently accepted/revoked (limit 50)
teams.get('/:id/invitations', async c => {
  const teamId = c.req.param('id')
  if (!(await isTeamAdmin(c, teamId))) return c.json({ error: 'Forbidden' }, 403)

  const { results } = await c.env.DB.prepare(`
    SELECT i.id, i.email, i.status, i.expires_at, i.created_at, i.accepted_at,
           a.email as invited_by_email
    FROM invitations i
    JOIN accounts a ON a.id = i.invited_by_account_id
    WHERE i.team_id = ?
    ORDER BY
      CASE i.status WHEN 'pending' THEN 0 ELSE 1 END,
      i.created_at DESC
    LIMIT 50
  `).bind(teamId).all()

  return c.json({ invitations: results })
})

// POST /api/teams/:id/invitations/:invitationId/resend — rotate token + re-email
teams.post('/:id/invitations/:invitationId/resend', async c => {
  const teamId = c.req.param('id')
  const invId = c.req.param('invitationId')
  if (!(await isTeamAdmin(c, teamId))) return c.json({ error: 'Forbidden' }, 403)

  const invite = await c.env.DB.prepare(`
    SELECT i.email, i.status, t.name as team_name, a.email as inviter_email
    FROM invitations i
    JOIN teams t ON t.id = i.team_id
    JOIN accounts a ON a.id = i.invited_by_account_id
    WHERE i.id = ? AND i.team_id = ?
  `).bind(invId, teamId).first<{ email: string; status: string; team_name: string; inviter_email: string }>()
  if (!invite) return c.json({ error: 'invitation not found' }, 404)
  if (invite.status !== 'pending') {
    return c.json({ error: `cannot resend a ${invite.status} invitation` }, 400)
  }

  const token = generateToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Preserve created_at (audit integrity). Only rotate token + extend expiry.
  await c.env.DB.prepare(
    `UPDATE invitations SET token = ?, expires_at = ? WHERE id = ?`
  ).bind(token, expiresAt, invId).run()

  const siteUrl = c.env.SITE_URL || 'https://terrain.run'
  try {
    await sendInvitationEmail(invite.email, token, invite.team_name, invite.inviter_email, c.env.RESEND_API_KEY, siteUrl)
  } catch (err) {
    console.error('[invitations] resend failed, KV fallback:', err)
    try {
      await c.env.KV.put(`invitation_fallback:${invite.email}`, token, { expirationTtl: 7 * 24 * 60 * 60 })
    } catch (kvErr) {
      console.error('[invitations] KV fallback failed:', kvErr)
    }
  }

  return c.json({ ok: true })
})

// DELETE /api/teams/:id/invitations/:invitationId — revoke
teams.delete('/:id/invitations/:invitationId', async c => {
  const teamId = c.req.param('id')
  const invId = c.req.param('invitationId')
  if (!(await isTeamAdmin(c, teamId))) return c.json({ error: 'Forbidden' }, 403)

  const res = await c.env.DB.prepare(`
    UPDATE invitations SET status = 'revoked'
    WHERE id = ? AND team_id = ? AND status = 'pending'
  `).bind(invId, teamId).run()
  if (res.meta.changes === 0) return c.json({ error: 'invitation not pending or not found' }, 404)
  return c.json({ ok: true })
})

export { teams }
