// src/routes/invitations.ts — Anonymous endpoints for invitation preview + acceptance.
// Protected (team admin) endpoints for create / list / revoke / resend live in teams.ts.

import { Hono } from 'hono'
import type { Env } from '../types'
import { generateToken, getCookie } from '../services/auth'

const invitations = new Hono<{ Bindings: Env }>()

// GET /api/invitations/:token — anonymous preview. Returns team name + inviter email
// so the landing page can show "You were invited to X by y@z". Does not consume.
invitations.get('/:token', async c => {
  const token = c.req.param('token')
  if (!token) return c.json({ error: 'token required' }, 400)

  const row = await c.env.DB.prepare(`
    SELECT i.status, i.expires_at, i.email,
           t.id as team_id, t.name as team_name,
           a.email as inviter_email
    FROM invitations i
    JOIN teams t ON t.id = i.team_id
    JOIN accounts a ON a.id = i.invited_by_account_id
    WHERE i.token = ?
  `).bind(token).first<{
    status: string; expires_at: string; email: string
    team_id: string; team_name: string; inviter_email: string
  }>()

  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.status !== 'pending') return c.json({ error: `invitation ${row.status}` }, 400)
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return c.json({ error: 'invitation expired' }, 400)
  }

  return c.json({
    team_name: row.team_name,
    inviter_email: row.inviter_email,
    email: row.email,
  })
})

// POST /api/invitations/accept — claim the invitation and log the user in.
// Anonymous. The token is the auth.
invitations.post('/accept', async c => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }))
  const token = body.token
  if (!token) return c.json({ error: 'token required' }, 400)

  const invite = await c.env.DB.prepare(`
    SELECT id, team_id, email, signup_code_id, status, expires_at
    FROM invitations WHERE token = ?
  `).bind(token).first<{
    id: string; team_id: string; email: string
    signup_code_id: string | null
    status: string; expires_at: string
  }>()

  if (!invite) return c.json({ error: 'not found' }, 404)
  if (invite.status !== 'pending') return c.json({ error: 'invitation no longer valid' }, 400)
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return c.json({ error: 'invitation expired' }, 400)
  }

  // Look up account
  let account = await c.env.DB.prepare(
    `SELECT id FROM accounts WHERE email = ?`
  ).bind(invite.email).first<{ id: string }>()

  // If no account, we must have a reserved signup code
  if (!account && !invite.signup_code_id) {
    return c.json({ error: 'invitation is missing a signup code — contact inviter to resend' }, 400)
  }

  const accountId = account?.id ?? crypto.randomUUID()
  const isNew = !account

  // Atomic claim: UPDATE only if still pending. If meta.changes === 0, we lost the race.
  const claim = await c.env.DB.prepare(`
    UPDATE invitations
    SET status = 'accepted',
        accepted_at = datetime('now'),
        accepted_by_account_id = ?
    WHERE id = ? AND status = 'pending'
  `).bind(accountId, invite.id).run()

  if (claim.meta.changes === 0) {
    return c.json({ error: 'invitation no longer valid' }, 400)
  }

  // Build the rest of the operations as a batch.
  const stmts: D1PreparedStatement[] = []

  if (isNew) {
    // Consume the reserved signup code (atomic: only if still has uses).
    stmts.push(
      c.env.DB.prepare(`
        UPDATE signup_codes SET times_used = times_used + 1
        WHERE id = ? AND times_used < max_uses
      `).bind(invite.signup_code_id)
    )
    // Create account + default team + membership (mirrors createAccountWithDefaultTeam,
    // but inline so it's part of the same batch).
    const defaultTeamId = crypto.randomUUID()
    const defaultInviteCode = genInviteCode()
    const emailPrefix = invite.email.split('@')[0].slice(0, 30) || 'My Team'
    stmts.push(
      c.env.DB.prepare(`INSERT INTO accounts (id, email, is_owner) VALUES (?, ?, 0)`)
        .bind(accountId, invite.email),
      c.env.DB.prepare(`INSERT INTO teams (id, name, invite_code, created_by) VALUES (?, ?, ?, ?)`)
        .bind(defaultTeamId, `${emailPrefix}'s Team`, defaultInviteCode, accountId),
      c.env.DB.prepare(`INSERT INTO team_members (team_id, account_id, role) VALUES (?, ?, 'admin')`)
        .bind(defaultTeamId, accountId),
    )
  }

  // Add to invited team as member (if not already there; rare but covers edge).
  stmts.push(
    c.env.DB.prepare(`
      INSERT OR IGNORE INTO team_members (team_id, account_id, role)
      VALUES (?, ?, 'member')
    `).bind(invite.team_id, accountId)
  )

  // Find first brand in invited team
  const firstBrand = await c.env.DB.prepare(
    `SELECT id FROM brands WHERE team_id = ? AND archived_at IS NULL ORDER BY created_at LIMIT 1`
  ).bind(invite.team_id).first<{ id: string }>()

  // Create session
  const sessionId = crypto.randomUUID()
  const sessionToken = generateToken()
  const sessionExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
  stmts.push(
    c.env.DB.prepare(
      `INSERT INTO sessions (id, account_id, active_team_id, active_brand_id, token, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(sessionId, accountId, invite.team_id, firstBrand?.id ?? null, sessionToken, sessionExpiry)
  )

  try {
    await c.env.DB.batch(stmts)
  } catch (err) {
    // Roll back the claim so the user can retry.
    await c.env.DB.prepare(`
      UPDATE invitations SET status = 'pending', accepted_at = NULL, accepted_by_account_id = NULL
      WHERE id = ?
    `).bind(invite.id).run()
    console.error('[invitations/accept] batch failed:', err)
    return c.json({ error: 'could not accept invitation — try again' }, 500)
  }

  // Set cookie, redirect to /
  const isSecure = new URL(c.req.url).protocol === 'https:'
  const securePart = isSecure ? ' Secure;' : ''
  return new Response(JSON.stringify({ ok: true, redirect: '/' }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `aeo_session=${sessionToken}; Path=/; HttpOnly;${securePart} SameSite=Strict; Max-Age=259200`,
    },
  })
})

function genInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  const code = Array.from(bytes).map(b => chars[b % chars.length]).join('')
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

// Prevent unused import warning
void getCookie

export { invitations }
