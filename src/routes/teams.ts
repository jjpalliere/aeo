// src/routes/teams.ts — Team management: create, list, join

import { Hono } from 'hono'
import type { Env } from '../types'
import { generateInviteCode } from '../services/auth'

const teams = new Hono<{ Bindings: Env }>()

// GET /api/teams — list teams the current user belongs to
teams.get('/', async c => {
  const account = c.get('account')
  const { results } = await c.env.DB.prepare(`
    SELECT t.id, t.name, t.invite_code, t.created_at,
           (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count,
           (SELECT COUNT(*) FROM brands WHERE team_id = t.id) as brand_count
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE tm.account_id = ?
    ORDER BY tm.joined_at
  `).bind(account.id).all()

  return c.json({ teams: results })
})

// POST /api/teams — create a new team
teams.post('/', async c => {
  const account = c.get('account')
  const body = await c.req.json<{ name?: string }>()
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'Team name is required' }, 400)

  const teamId = crypto.randomUUID()
  const inviteCode = generateInviteCode()

  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO teams (id, name, invite_code, created_by) VALUES (?, ?, ?, ?)')
      .bind(teamId, name, inviteCode, account.id),
    c.env.DB.prepare('INSERT INTO team_members (team_id, account_id) VALUES (?, ?)')
      .bind(teamId, account.id),
  ])

  return c.json({ id: teamId, name, invite_code: inviteCode }, 201)
})

// POST /api/teams/join — join an existing team via invite code
teams.post('/join', async c => {
  const account = c.get('account')
  const body = await c.req.json<{ invite_code?: string }>()
  const code = body.invite_code?.trim()
  if (!code) return c.json({ error: 'Invite code is required' }, 400)

  const team = await c.env.DB.prepare(
    'SELECT id, name FROM teams WHERE UPPER(invite_code) = UPPER(?)'
  ).bind(code).first<{ id: string; name: string }>()

  if (!team) return c.json({ error: 'Invalid invite code' }, 404)

  // Check if already a member
  const existing = await c.env.DB.prepare(
    'SELECT 1 FROM team_members WHERE team_id = ? AND account_id = ?'
  ).bind(team.id, account.id).first()

  if (existing) return c.json({ error: 'Already a member of this team' }, 409)

  await c.env.DB.prepare(
    'INSERT INTO team_members (team_id, account_id) VALUES (?, ?)'
  ).bind(team.id, account.id).run()

  return c.json({ ok: true, team_id: team.id, team_name: team.name })
})

// GET /api/teams/:id/members — list team members
teams.get('/:id/members', async c => {
  const teamId = c.req.param('id')
  const account = c.get('account')

  // Verify user is a member
  const member = await c.env.DB.prepare(
    'SELECT 1 FROM team_members WHERE team_id = ? AND account_id = ?'
  ).bind(teamId, account.id).first()
  if (!member) return c.json({ error: 'Not found' }, 404)

  const { results } = await c.env.DB.prepare(`
    SELECT a.id, a.email, tm.joined_at
    FROM accounts a
    JOIN team_members tm ON tm.account_id = a.id
    WHERE tm.team_id = ?
    ORDER BY tm.joined_at
  `).bind(teamId).all()

  return c.json({ members: results })
})

// DELETE /api/teams/:id/leave — leave a team
teams.delete('/:id/leave', async c => {
  const teamId = c.req.param('id')
  const account = c.get('account')

  // Can't leave if you're the only member
  const { results: members } = await c.env.DB.prepare(
    'SELECT account_id FROM team_members WHERE team_id = ?'
  ).bind(teamId).all<{ account_id: string }>()

  if (members.length <= 1) {
    return c.json({ error: 'Cannot leave — you are the only member. Delete the team instead.' }, 400)
  }

  await c.env.DB.prepare(
    'DELETE FROM team_members WHERE team_id = ? AND account_id = ?'
  ).bind(teamId, account.id).run()

  return c.json({ ok: true })
})

export { teams }
