// src/middleware/teamAdmin.ts — gate team-scoped mutations to team admin OR super-admin

import type { Context } from 'hono'
import type { Env } from '../types'

/**
 * Returns true if the current account can administer the given team
 * (is a team member with role='admin', OR is the global super-admin).
 */
export async function isTeamAdmin(
  c: Context<{ Bindings: Env }>,
  teamId: string,
): Promise<boolean> {
  const account = c.get('account')
  if (!account) return false
  if (account.is_owner) return true
  const row = await c.env.DB.prepare(
    `SELECT 1 FROM team_members WHERE team_id = ? AND account_id = ? AND role = 'admin'`
  ).bind(teamId, account.id).first()
  return !!row
}
