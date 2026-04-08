// src/middleware/scope.ts — Team-scoped resource authorization

import type { Context } from 'hono'
import type { Env, Brand, Run } from '../types'

/** Fetch brand, verifying team ownership. Returns null if not found or wrong team. */
export async function requireBrand(c: Context<{ Bindings: Env }>, brandId: string): Promise<Brand | null> {
  const teamId = c.get('teamId')
  return c.env.DB.prepare(
    'SELECT * FROM brands WHERE id = ? AND team_id = ?'
  ).bind(brandId, teamId).first<Brand>()
}

/** Fetch run, verifying team ownership. Returns null if not found or wrong team. */
export async function requireRun(c: Context<{ Bindings: Env }>, runId: string): Promise<Run | null> {
  const teamId = c.get('teamId')
  return c.env.DB.prepare(
    'SELECT * FROM runs WHERE id = ? AND team_id = ?'
  ).bind(runId, teamId).first<Run>()
}
