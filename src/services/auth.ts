// src/services/auth.ts — Session validation, rate limiting, token/code generation

/** Validate a session token, returning account + session data or null */
export async function validateSession(db: D1Database, token: string) {
  return db.prepare(`
    SELECT s.id as session_id, s.token, s.expires_at,
           s.active_team_id, s.active_brand_id,
           a.id as account_id, a.email, a.is_owner
    FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).bind(token).first<{
    session_id: string
    token: string
    expires_at: string
    active_team_id: string | null
    active_brand_id: string | null
    account_id: string
    email: string
    is_owner: number
  }>()
}

/** Approximate rate limit: ~3 requests per email per 15 min window.
 *  KV is eventually consistent, so concurrent requests may both pass.
 *  At worst allows 4 instead of 3 — acceptable for auth. */
export async function checkRateLimit(email: string, kv: KVNamespace): Promise<boolean> {
  const key = `rate:auth:${email.toLowerCase()}`
  const current = parseInt(await kv.get(key) || '0', 10)
  if (current >= 3) return false
  await kv.put(key, String(current + 1), { expirationTtl: 900 })
  return true
}

/** Generate a 64-char hex token using crypto.getRandomValues */
export function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Generate a XXXX-XXXX invite/signup code */
export function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I/O/0/1 to avoid confusion
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  const code = Array.from(bytes).map(b => chars[b % chars.length]).join('')
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Parse aeo_session cookie from Cookie header */
export function getCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))
  return match ? match.slice(name.length + 1) : null
}
