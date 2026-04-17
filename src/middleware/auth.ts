// src/middleware/auth.ts — Session middleware with auto-extend + null team guard

import type { Context, Next } from 'hono'
import type { Env } from '../types'
import { validateSession, getCookie } from '../services/auth'

export async function sessionMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  // Skip auth routes — they handle session validation internally
  if (c.req.path.startsWith('/api/auth')) return next()
  // Public join-request submission
  if (c.req.path.startsWith('/api/join-requests')) return next()
  // Public invitation preview + acceptance — token is the auth
  if (c.req.path.startsWith('/api/invitations')) return next()
  // Skip health check
  if (c.req.path === '/api/health') return next()

  const token = getCookie(c.req.header('Cookie'), 'aeo_session')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  const session = await validateSession(c.env.DB, token)
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  // --- Null team_id guard ---
  let teamId = session.active_team_id
  if (!teamId) {
    const membership = await c.env.DB.prepare(
      'SELECT team_id FROM team_members WHERE account_id = ? ORDER BY joined_at LIMIT 1'
    ).bind(session.account_id).first<{ team_id: string }>()

    if (!membership) {
      return c.json({ error: 'No team found. Please contact support.' }, 403)
    }

    teamId = membership.team_id
    await c.env.DB.prepare(
      'UPDATE sessions SET active_team_id = ? WHERE id = ?'
    ).bind(teamId, session.session_id).run()
  }

  // --- Session auto-extend on activity ---
  // Always push expiry forward by 3 days from now.
  // This means sessions never expire while the user is active.
  // Cost: one UPDATE per request. Acceptable because D1 writes are cheap
  // and this ensures scheduleNextProcess self-fetches never hit expired sessions.
  const newExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
  await c.env.DB.prepare(
    'UPDATE sessions SET expires_at = ? WHERE id = ?'
  ).bind(newExpiry, session.session_id).run()

  c.set('account', { id: session.account_id, email: session.email, is_owner: session.is_owner })
  c.set('teamId', teamId)
  c.set('brandId', session.active_brand_id)
  c.set('sessionId', session.session_id)

  return next()
}
