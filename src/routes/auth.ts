// src/routes/auth.ts — Magic link auth: login, verify, logout, me, active

import { Hono } from 'hono'
import type { Env } from '../types'
import { validateSession, checkRateLimit, generateToken, generateInviteCode, getCookie } from '../services/auth'
import { sendMagicLink } from '../services/email'

const auth = new Hono<{ Bindings: Env }>()

// POST /api/auth/login — send magic link (public, rate-limited)
auth.post('/login', async c => {
  const body = await c.req.json<{ email?: string; invite_code?: string }>().catch(() => ({} as { email?: string; invite_code?: string }))

  const email = body.email?.trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Valid email is required' }, 400)
  }

  // Rate limit
  const allowed = await checkRateLimit(email, c.env.KV)
  if (!allowed) {
    return c.json({ error: 'Too many requests. Try again in a few minutes.' }, 429)
  }

  // Check if account exists
  let account = await c.env.DB.prepare(
    'SELECT id FROM accounts WHERE email = ?'
  ).bind(email).first<{ id: string }>()

  if (!account) {
    // New user — invite code required
    const inviteCode = body.invite_code?.trim()
    if (!inviteCode) {
      return c.json({ error: 'Invite code required for new accounts' }, 400)
    }

    // Atomic code claim
    const claim = await c.env.DB.prepare(
      `UPDATE signup_codes SET times_used = times_used + 1
       WHERE UPPER(code) = UPPER(?) AND times_used < max_uses`
    ).bind(inviteCode).run()

    if (claim.meta.changes === 0) {
      return c.json({ error: 'Invalid or exhausted invite code' }, 400)
    }

    // Create account + team + membership atomically
    const accountId = crypto.randomUUID()
    const teamId = crypto.randomUUID()
    const teamInviteCode = generateInviteCode()
    const emailPrefix = email.split('@')[0].slice(0, 30) || 'My Team'

    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO accounts (id, email, is_owner) VALUES (?, ?, 0)')
        .bind(accountId, email),
      c.env.DB.prepare('INSERT INTO teams (id, name, invite_code, created_by) VALUES (?, ?, ?, ?)')
        .bind(teamId, `${emailPrefix}'s Team`, teamInviteCode, accountId),
      c.env.DB.prepare('INSERT INTO team_members (team_id, account_id) VALUES (?, ?)')
        .bind(teamId, accountId),
    ])

    account = { id: accountId }
  }

  // Invalidate existing unused magic links for this email
  await c.env.DB.prepare(
    'UPDATE magic_links SET used = 1 WHERE email = ? AND used = 0'
  ).bind(email).run()

  // Generate magic link
  const token = generateToken()
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()

  await c.env.DB.prepare(
    'INSERT INTO magic_links (id, email, token, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), email, token, expiresAt).run()

  // Send email with double try/catch fallback
  const siteUrl = c.env.SITE_URL || 'https://terrain.run'
  try {
    await sendMagicLink(email, token, c.env.RESEND_API_KEY, siteUrl)
  } catch (err) {
    console.error('Email send failed:', err)
    try {
      await c.env.KV.put(`magic_link_fallback:${email}`, token, { expirationTtl: 900 })
    } catch (kvErr) {
      console.error('KV fallback also failed:', kvErr)
    }
    // Still return success — admin can retrieve the link from KV
  }

  return c.json({ ok: true, message: 'Check your email for a login link' })
})

// GET /api/auth/verify — validate magic link token, set session, redirect
auth.get('/verify', async c => {
  const token = c.req.query('token')
  if (!token) {
    return c.redirect('/login.html?error=missing_token')
  }

  const link = await c.env.DB.prepare(
    `SELECT * FROM magic_links WHERE token = ? AND used = 0 AND expires_at > datetime('now')`
  ).bind(token).first<{ id: string; email: string; token: string }>()

  if (!link) {
    return c.redirect('/login.html?error=expired')
  }

  // Mark magic link as used
  await c.env.DB.prepare('UPDATE magic_links SET used = 1 WHERE id = ?').bind(link.id).run()

  // Get account
  const account = await c.env.DB.prepare(
    'SELECT id FROM accounts WHERE email = ?'
  ).bind(link.email).first<{ id: string }>()

  if (!account) {
    return c.redirect('/login.html?error=no_account')
  }

  // Get first team
  const membership = await c.env.DB.prepare(
    'SELECT team_id FROM team_members WHERE account_id = ? ORDER BY joined_at LIMIT 1'
  ).bind(account.id).first<{ team_id: string }>()

  // Get first brand in team (if any)
  let brandId: string | null = null
  if (membership) {
    const brand = await c.env.DB.prepare(
      'SELECT id FROM brands WHERE team_id = ? ORDER BY created_at LIMIT 1'
    ).bind(membership.team_id).first<{ id: string }>()
    brandId = brand?.id ?? null
  }

  // Create session
  const sessionToken = generateToken()
  const sessionExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()

  await c.env.DB.prepare(
    'INSERT INTO sessions (id, account_id, active_team_id, active_brand_id, token, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    crypto.randomUUID(),
    account.id,
    membership?.team_id ?? null,
    brandId,
    sessionToken,
    sessionExpiry
  ).run()

  // 302 redirect with session cookie
  const isSecure = new URL(c.req.url).protocol === 'https:'
  const securePart = isSecure ? ' Secure;' : ''
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': `aeo_session=${sessionToken}; Path=/; HttpOnly;${securePart} SameSite=Strict; Max-Age=259200`,
    },
  })
})

// POST /api/auth/logout — delete session + clear cookie
auth.post('/logout', async c => {
  const token = getCookie(c.req.header('Cookie'), 'aeo_session')
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Set-Cookie': 'aeo_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
      'Content-Type': 'application/json',
    },
  })
})

// GET /api/auth/me — current user + team info
auth.get('/me', async c => {
  const token = getCookie(c.req.header('Cookie'), 'aeo_session')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  const session = await validateSession(c.env.DB, token)
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  // Get team name
  let teamName = null
  if (session.active_team_id) {
    const team = await c.env.DB.prepare('SELECT name FROM teams WHERE id = ?')
      .bind(session.active_team_id).first<{ name: string }>()
    teamName = team?.name ?? null
  }

  return c.json({
    id: session.account_id,
    email: session.email,
    is_owner: session.is_owner,
    active_team_id: session.active_team_id,
    active_brand_id: session.active_brand_id,
    team_name: teamName,
  })
})

// PUT /api/auth/active — update active team/brand (with ownership validation)
auth.put('/active', async c => {
  const token = getCookie(c.req.header('Cookie'), 'aeo_session')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  const session = await validateSession(c.env.DB, token)
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<{ team_id?: string; brand_id?: string }>().catch(() => ({} as { team_id?: string; brand_id?: string }))

  // Validate team_id: user must be a member
  if (body.team_id) {
    const member = await c.env.DB.prepare(
      'SELECT 1 FROM team_members WHERE team_id = ? AND account_id = ?'
    ).bind(body.team_id, session.account_id).first()
    if (!member) return c.json({ error: 'Not a member of this team' }, 403)
  }

  const switchingTeam = body.team_id && body.team_id !== session.active_team_id
  const effectiveTeamId = body.team_id || session.active_team_id

  // Validate brand_id: brand must belong to the active (or new) team
  if (body.brand_id) {
    const brand = await c.env.DB.prepare(
      'SELECT 1 FROM brands WHERE id = ? AND team_id = ?'
    ).bind(body.brand_id, effectiveTeamId).first()
    if (!brand) return c.json({ error: 'Brand not found in this team' }, 404)
  }

  // When switching teams, reset brand to first brand in new team (or null)
  let newBrandId: string | null | undefined = body.brand_id || undefined
  if (switchingTeam && !body.brand_id) {
    const firstBrand = await c.env.DB.prepare(
      'SELECT id FROM brands WHERE team_id = ? ORDER BY created_at LIMIT 1'
    ).bind(body.team_id).first<{ id: string }>()
    newBrandId = firstBrand?.id ?? null
  }

  // Update session
  if (switchingTeam) {
    await c.env.DB.prepare(`
      UPDATE sessions SET
        active_team_id = ?,
        active_brand_id = ?
      WHERE id = ?
    `).bind(body.team_id, newBrandId ?? null, session.session_id).run()
  } else {
    await c.env.DB.prepare(`
      UPDATE sessions SET
        active_brand_id = COALESCE(?, active_brand_id)
      WHERE id = ?
    `).bind(body.brand_id || null, session.session_id).run()
  }

  return c.json({ ok: true })
})

export { auth }
