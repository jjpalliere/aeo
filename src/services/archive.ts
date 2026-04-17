// src/services/archive.ts
// Archive-on-delete flow: when a team is deleted, its brands and downstream
// data move to the super-admin's archive team rather than being destroyed.
// The deleter sees everything gone; the super-admin retains the data.

import type { Env } from '../types'

/**
 * Resolve the archive team for this platform.
 * Primary: the first team (by joined_at) of the oldest is_owner=1 account.
 * Fallback: any remaining is_owner=1 account's first team.
 * Throws if no is_owner=1 account exists — the /api/admin/accounts/:id
 * guard in admin.ts prevents that state in practice.
 */
export async function getArchiveTeamId(db: D1Database): Promise<string> {
  const primary = await db.prepare(`
    SELECT tm.team_id
    FROM accounts a
    JOIN team_members tm ON tm.account_id = a.id
    WHERE a.is_owner = 1
    ORDER BY a.created_at ASC, tm.joined_at ASC
    LIMIT 1
  `).first<{ team_id: string }>()

  if (primary?.team_id) return primary.team_id

  throw new Error('No super-admin account with a team exists — cannot resolve archive team')
}

/** True if the given team is the current archive team. UI uses this to disable the delete button. */
export async function isArchiveTeam(db: D1Database, teamId: string): Promise<boolean> {
  try {
    const archiveId = await getArchiveTeamId(db)
    return archiveId === teamId
  } catch {
    return false
  }
}

export interface DeleteTeamOptions {
  db: D1Database
  kv: KVNamespace
  teamId: string
  deleterAccountId: string
}

export interface DeleteTeamResult {
  archivedBrandIds: string[]
  archiveTeamId: string
}

/**
 * Execute the archive-on-delete flow.
 *  - Rejects if teamId is the archive team itself.
 *  - Rejects if any brand in the team has an active run.
 *  - Moves brands (and their downstream team_id-scoped tables) to the archive team.
 *  - Rewrites KV keys prefixed with {teamId}: to {archiveTeamId}: (collision-guarded).
 *  - Nulls sessions.active_team_id for sessions owned by former members.
 *  - Deletes team_members, pending invitations, and the teams row.
 *  - Writes a team_deletion_log row.
 *
 * Throws with a .statusCode hint for the route to translate.
 */
export async function deleteTeamArchiveFlow(opts: DeleteTeamOptions): Promise<DeleteTeamResult> {
  const { db, kv, teamId, deleterAccountId } = opts

  const archiveTeamId = await getArchiveTeamId(db)
  if (archiveTeamId === teamId) {
    throwWithStatus('Cannot delete the platform archive team', 400)
  }

  const team = await db.prepare(`SELECT id, name FROM teams WHERE id = ?`)
    .bind(teamId).first<{ id: string; name: string }>()
  if (!team) throwWithStatus('Team not found', 404)

  // Block if any brand has an active run (KV rekey would yank keys mid-flight).
  const active = await db.prepare(`
    SELECT r.id FROM runs r
    JOIN brands b ON b.id = r.brand_id
    WHERE b.team_id = ? AND r.status IN ('pending', 'querying', 'scraping', 'analyzing')
    LIMIT 1
  `).bind(teamId).first()
  if (active) {
    throwWithStatus('Team has an in-flight run. Wait for it to complete, then try again.', 409)
  }

  // Brand ids to archive.
  const { results: brandRows } = await db.prepare(
    `SELECT id FROM brands WHERE team_id = ?`
  ).bind(teamId).all<{ id: string }>()
  const brandIds = (brandRows ?? []).map(r => r.id)

  // --- SQL mutations (single batch so partial failure rolls back) ---
  const stmts: D1PreparedStatement[] = []

  // Brands: move to archive team, stamp archive metadata, preserve original name.
  if (brandIds.length > 0) {
    const q = '?,'.repeat(brandIds.length).slice(0, -1)
    stmts.push(
      db.prepare(`UPDATE brands
                  SET team_id = ?,
                      archived_at = CURRENT_TIMESTAMP,
                      archived_from_team_name = ?,
                      archived_from_account_id = ?
                  WHERE id IN (${q})`)
        .bind(archiveTeamId, team!.name, deleterAccountId, ...brandIds)
    )
    // Downstream team_id-scoped tables (schema: brands, runs, prompts, personas have team_id).
    // similarity_runs has no team_id column — it's scoped via brand_id which already followed.
    stmts.push(
      db.prepare(`UPDATE runs SET team_id = ? WHERE brand_id IN (${q})`)
        .bind(archiveTeamId, ...brandIds)
    )
    stmts.push(
      db.prepare(`UPDATE prompts SET team_id = ? WHERE brand_id IN (${q})`)
        .bind(archiveTeamId, ...brandIds)
    )
    stmts.push(
      db.prepare(`UPDATE personas SET team_id = ? WHERE brand_id IN (${q})`)
        .bind(archiveTeamId, ...brandIds)
    )
  }

  // Session fix-up: scope to users who WERE members of the deleted team.
  // Inner subquery must run before team_members is wiped, so stage this
  // before the team_members DELETE.
  stmts.push(
    db.prepare(`UPDATE sessions
                SET active_team_id = NULL, active_brand_id = NULL
                WHERE active_team_id = ?
                  AND account_id IN (
                    SELECT account_id FROM team_members WHERE team_id = ?
                  )`)
      .bind(teamId, teamId)
  )

  // Revoke pending invitations for this team.
  stmts.push(
    db.prepare(`UPDATE invitations SET status = 'revoked'
                WHERE team_id = ? AND status = 'pending'`)
      .bind(teamId)
  )

  // Delete team_members, then the teams row.
  stmts.push(db.prepare(`DELETE FROM team_members WHERE team_id = ?`).bind(teamId))
  stmts.push(db.prepare(`DELETE FROM teams WHERE id = ?`).bind(teamId))

  // Audit log.
  stmts.push(
    db.prepare(`INSERT INTO team_deletion_log
                (id, team_id, team_name, deleted_by, brand_ids, archive_team_id)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), teamId, team!.name, deleterAccountId,
            JSON.stringify(brandIds), archiveTeamId)
  )

  const results = await db.batch(stmts)
  // Last statement (insert into team_deletion_log) always succeeds; check the teams
  // delete (second-to-last) for meta.changes === 0 (race: another admin deleted
  // simultaneously).
  const teamsDeleteResult = results[results.length - 2]
  if (teamsDeleteResult?.meta?.changes === 0) {
    throwWithStatus('Team was already deleted', 409)
  }

  // --- KV rekey (best-effort, not transactional) ---
  try {
    await rekeyKvPrefix(kv, teamId, archiveTeamId)
  } catch (err) {
    console.error('[archive] KV rekey failed (non-fatal):', err)
  }

  return { archivedBrandIds: brandIds, archiveTeamId }
}

async function rekeyKvPrefix(kv: KVNamespace, oldTeamId: string, newTeamId: string): Promise<void> {
  const oldPrefix = `${oldTeamId}:`
  let cursor: string | undefined
  // Loop through all keys under the old prefix.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const list = await kv.list({ prefix: oldPrefix, cursor })
    for (const { name } of list.keys) {
      const rest = name.slice(oldPrefix.length)
      let newKey = `${newTeamId}:${rest}`
      try {
        // Collision guard: if brand had previously been archived, key may exist.
        const existing = await kv.get(newKey)
        if (existing !== null) newKey = `${newKey}:from:${oldTeamId}`
        const value = await kv.get(name)
        if (value !== null) await kv.put(newKey, value)
        await kv.delete(name)
      } catch (err) {
        console.error('[archive] KV key copy failed:', name, err)
      }
    }
    if (list.list_complete) break
    cursor = list.cursor
  }
}

function throwWithStatus(message: string, status: number): never {
  const err = new Error(message) as Error & { statusCode?: number }
  err.statusCode = status
  throw err
}
