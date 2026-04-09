// src/middleware/owner.ts — shared owner check for routes that use per-handler auth (not admin/* blanket)

import type { Context } from 'hono'
import type { Env } from '../types'

/** Use: `const denied = rejectIfNotOwner(c); if (denied) return denied` */
export function rejectIfNotOwner(c: Context<{ Bindings: Env }>) {
  if (!c.get('account')?.is_owner) return c.json({ error: 'Forbidden' }, 403)
  return undefined
}
