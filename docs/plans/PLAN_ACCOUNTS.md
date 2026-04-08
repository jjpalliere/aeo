# AEO Account System — Implementation Plan (v3)

*Incorporates all gap analysis, resiliency review, and breakage fixes from v1/v2.*

## 1. Architecture Overview

```
                  ┌──────────────────────────────────────────┐
                  │             terrain.run                    │
                  │          Cloudflare Workers                │
                  ├──────────────────────────────────────────┤
                  │                                          │
                  │   Magic Link Auth (Resend transactional)  │
                  │              ↓                             │
                  │   accounts ──→ team_members ──→ teams      │
                  │                     ↓                      │
                  │        brands / runs / prompts /           │
                  │        personas (scoped by team_id)        │
                  │        queries / citations / brand_mentions│
                  │          (scoped via parent run/brand)     │
                  │                                          │
                  │   KV keys prefixed: {team_id}:logs:...    │
                  │                                          │
                  ├──────────┬───────────────────────────────┤
                  │  Dev D1  │         Prod D1                │
                  └──────────┴───────────────────────────────┘
```

**Auth model:** Magic link (no passwords)
**Email provider:** Resend (100 free emails/day, HTTP API from Workers)
**Signup:** Invite code required (format: `XXXX-XXXX`, case-insensitive)
**Roles:** None (all users equal) + `is_owner` superadmin flag
**Teams:** Users create/join teams; teams own all data
**Sessions:** 3-day base expiry, **auto-extended on every activity** (effectively never expires while user is active)
**Profiles:** Email only (v1)
**Billing:** None (v1)
**IDs:** `crypto.randomUUID()` throughout (no nanoid dependency)

---

## 2. Database Schema

### New Tables

```sql
-- 002_accounts.sql

-- Migration tracking
CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                -- crypto.randomUUID()
  email TEXT UNIQUE NOT NULL,
  is_owner INTEGER DEFAULT 0,        -- superadmin flag
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,   -- XXXX-XXXX format, for joining existing team
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id, account_id)
);

CREATE TABLE magic_links (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,         -- crypto random 64-char hex
  expires_at TIMESTAMP NOT NULL,     -- 15 min TTL
  used INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  active_team_id TEXT REFERENCES teams(id),
  active_brand_id TEXT,               -- NO FK constraint (see §2.1 below)
  token TEXT UNIQUE NOT NULL,         -- crypto random 64-char hex
  expires_at TIMESTAMP NOT NULL,     -- 3-day base, auto-extended on activity
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE signup_codes (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,          -- XXXX-XXXX, stored uppercase, matched case-insensitive
  max_uses INTEGER DEFAULT 1,
  times_used INTEGER DEFAULT 0,
  created_by TEXT REFERENCES accounts(id),  -- NULL for bootstrap seed codes
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX idx_magic_links_token ON magic_links(token);
CREATE INDEX idx_magic_links_email ON magic_links(email, used);
CREATE INDEX idx_team_members_account ON team_members(account_id);
CREATE INDEX idx_signup_codes_code ON signup_codes(code);
```

### §2.1 — Why `active_brand_id` Has No FK Constraint

If `active_brand_id REFERENCES brands(id)` were a real FK:
- Deleting a brand would fail (FK violation) or require `ON DELETE SET NULL`
- D1/SQLite FK enforcement behavior is inconsistent across versions
- A stale `active_brand_id` is harmless — the sidebar simply auto-selects the first brand

**Decision:** Store as plain TEXT. Application code validates it on read.

### Altered Existing Tables

```sql
ALTER TABLE brands ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE runs ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE prompts ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE personas ADD COLUMN team_id TEXT REFERENCES teams(id);

CREATE INDEX idx_brands_team ON brands(team_id);
CREATE INDEX idx_runs_team ON runs(team_id);
CREATE INDEX idx_prompts_team ON prompts(team_id);
CREATE INDEX idx_personas_team ON personas(team_id);
```

### Scoping Strategy for Child Tables

**`queries`, `citations`, `brand_mentions` do NOT get `team_id` columns.**

These tables are always accessed through their parent chain:
```
brand_mentions → queries → runs → team_id
citations      → queries → runs → team_id
queries        → runs    → team_id
```

**Rule:** Every code path that reads queries/citations/brand_mentions MUST first validate the parent run or brand belongs to the requesting team via `requireBrand()` / `requireRun()` (see Section 10). This includes `assistant.ts`, which directly queries `brand_mentions` and `citations` — it must call `requireRun()` before any data access.

If direct team-level queries are needed later (e.g. "all citations across all runs for a team"), add `team_id` to `queries` in a future migration.

---

## 3. Versioned Migrations

```
migrations/
  001_initial.sql      ← exact copy of current schema.sql
  002_accounts.sql     ← new tables + ALTER existing tables (team_id nullable)
  003_seed_owner.sql   ← create owner account, team, team_member; backfill team_id
```

**No `004_not_null.sql`.** team_id remains nullable in SQLite; NOT NULL is enforced in the TypeScript layer (`team_id: string`, not `string | null`). This avoids the dangerous table-recreation pattern in SQLite which breaks foreign keys, requires `PRAGMA foreign_keys = OFF`, and risks data loss. App-level enforcement is sufficient.

### Migration Runner

```bash
#!/bin/bash
# scripts/migrate.sh
# Usage:
#   ./scripts/migrate.sh --local           # local SQLite
#   ./scripts/migrate.sh --env dev         # remote dev D1
#   ./scripts/migrate.sh                   # remote prod D1 (default)

set -e

WRANGLER_FLAGS=""
DB_NAME="aeo-db"

while [[ $# -gt 0 ]]; do
  case $1 in
    --env)
      WRANGLER_FLAGS="--env $2"
      if [ "$2" = "dev" ]; then DB_NAME="aeo-db-dev"; fi
      shift 2
      ;;
    --local)
      WRANGLER_FLAGS="--local"
      shift
      ;;
    *)
      echo "Unknown arg: $1"; exit 1
      ;;
  esac
done

# Ensure _migrations table exists
wrangler d1 execute "$DB_NAME" $WRANGLER_FLAGS \
  --command "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"

for file in migrations/*.sql; do
  name=$(basename "$file")
  applied=$(wrangler d1 execute "$DB_NAME" $WRANGLER_FLAGS \
    --command "SELECT name FROM _migrations WHERE name = '$name'" 2>&1)
  if echo "$applied" | grep -q "$name"; then
    echo "SKIP  $name (already applied)"
    continue
  fi
  echo "APPLY $name..."
  wrangler d1 execute "$DB_NAME" $WRANGLER_FLAGS --file "$file"
  wrangler d1 execute "$DB_NAME" $WRANGLER_FLAGS \
    --command "INSERT INTO _migrations (name) VALUES ('$name')"
  echo "  ✓ $name applied"
done

echo "Done."
```

### 001_initial.sql

Must be an **exact copy** of the current `schema.sql` as it exists in production, including:
- All 7 tables: brands, prompts, personas, runs, queries, citations, brand_mentions
- All columns including: `rationale` on prompts/personas, `supplement` on brands, `goals`/`pain_points` on personas
- All 8 indexes
- All column defaults and foreign keys

**Verify before committing:** diff `schema.sql` against prod DB schema to catch any drift.

### 003_seed_owner.sql

```sql
-- Bootstrap: create owner account, personal team, and membership
-- Replace <YOUR_EMAIL> before running

INSERT INTO accounts (id, email, is_owner, created_at)
VALUES ('owner_001', '<YOUR_EMAIL>', 1, datetime('now'));

INSERT INTO teams (id, name, invite_code, created_by, created_at)
VALUES ('team_001', 'Personal', 'BOOT-STRAP', 'owner_001', datetime('now'));

INSERT INTO team_members (team_id, account_id, joined_at)
VALUES ('team_001', 'owner_001', datetime('now'));

-- Backfill all existing data to owner's team
UPDATE brands SET team_id = 'team_001' WHERE team_id IS NULL;
UPDATE runs SET team_id = 'team_001' WHERE team_id IS NULL;
UPDATE prompts SET team_id = 'team_001' WHERE team_id IS NULL;
UPDATE personas SET team_id = 'team_001' WHERE team_id IS NULL;

-- Create first signup code for inviting others
INSERT INTO signup_codes (id, code, max_uses, times_used, created_by, created_at)
VALUES ('code_001', 'FIRST-CODE', 10, 0, 'owner_001', datetime('now'));
```

**Deploy timing:** Run 003 and deploy new code in quick succession. Between migration and deploy, old code could create brands with `team_id = NULL`. The `WHERE team_id IS NULL` clause in the backfill handles this, but minimize the window. Ideally: run 003, verify backfill, deploy within minutes.

---

## 4. Dev vs Prod Databases

### wrangler.toml

```toml
name = "aeo"
main = "src/index.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./public"
binding = "ASSETS"

# --- Production (default) ---
[[d1_databases]]
binding = "DB"
database_name = "aeo-db"
database_id = "c8328931-24a2-421c-a73a-e732c00b49a7"

[[kv_namespaces]]
binding = "KV"
id = "6f792aef4e41455f92397167aac95e9b"

# Cron: garbage collection + stalled run recovery
[triggers]
crons = ["0 3 * * *"]

# --- Dev environment ---
[env.dev]

[[env.dev.d1_databases]]
binding = "DB"
database_name = "aeo-db-dev"
database_id = "<create-via: wrangler d1 create aeo-db-dev>"

[[env.dev.kv_namespaces]]
binding = "KV"
id = "<create-via: wrangler kv namespace create KV --env dev>"
```

### Commands
```bash
wrangler dev --local              # local SQLite (DB_NAME ignored, uses .wrangler/)
wrangler dev --env dev            # remote dev D1
wrangler deploy                   # deploy to production

./scripts/migrate.sh --local      # migrate local SQLite
./scripts/migrate.sh --env dev    # migrate dev D1
./scripts/migrate.sh              # migrate prod D1
```

**Note on `--local`:** `wrangler dev --local` creates a local SQLite file in `.wrangler/state/`. The `--local` flag for `wrangler d1 execute` targets this same local file. The `DB_NAME` used in the migrate script doesn't matter for local — wrangler resolves the binding from `wrangler.toml`.

---

## 5. Email Provider — Resend

### Why NOT Cloudflare Email Workers
CF Email Workers `send_email` bindings can only send to **verified destination addresses** pre-configured in Email Routing. They cannot send to arbitrary recipients. This is a **hard blocker** for magic link auth.

### Why Resend
- 100 free emails/day (sufficient for auth)
- Simple HTTP API (one `fetch()` call from Workers, no SDK needed)
- SPF/DKIM built-in via DNS records
- Good deliverability

### Setup (do this BEFORE deploying code)
1. Create Resend account at resend.com
2. Add `terrain.run` domain → get DNS records (SPF, DKIM, DMARC)
3. Add DNS records in Cloudflare dashboard
4. **Wait for propagation** (minutes to hours; verify in Resend dashboard)
5. Test send from Resend dashboard
6. Set API key: `wrangler secret put RESEND_API_KEY`

### Implementation

```typescript
// src/services/email.ts

export async function sendMagicLink(email: string, token: string, resendApiKey: string) {
  // IMPORTANT: /api/auth/verify, not /auth/verify (ASSETS would 404)
  const verifyUrl = `https://terrain.run/api/auth/verify?token=${token}`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'terrain.run <auth@terrain.run>',
      to: [email],
      subject: 'Your login link — terrain.run',
      html: `
        <div style="font-family: monospace; background: #0a0a0a; color: #f0ebeb; padding: 40px; max-width: 480px;">
          <h2 style="color: rgb(238, 82, 24); font-size: 18px; margin-bottom: 24px;">TERRAIN.RUN</h2>
          <p>Click below to log in. This link expires in 15 minutes.</p>
          <a href="${verifyUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 24px; background: rgb(238, 82, 24); color: #0a0a0a; text-decoration: none; font-weight: bold;">Log In</a>
          <p style="color: #9f9a9a; font-size: 12px;">If you didn't request this, ignore this email.</p>
        </div>
      `,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Resend error: ${err}`)
  }
}
```

### Fallback (double try/catch)

```typescript
try {
  await sendMagicLink(email, token, env.RESEND_API_KEY)
} catch (err) {
  console.error('Email send failed:', err)
  try {
    await env.KV.put(`magic_link_fallback:${email}`, token, { expirationTtl: 900 })
  } catch (kvErr) {
    console.error('KV fallback also failed:', kvErr)
  }
  // Still return success to user — they can contact admin for the link
}
```

### Env

```typescript
export interface Env {
  DB: D1Database
  KV: KVNamespace
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  GOOGLE_AI_API_KEY: string
  RESEND_API_KEY: string
  ASSETS: Fetcher
  // Removed: AEO_PASSWORD
}
```

---

## 6. Auth Flow

### Route Layout

Replaces the existing `app.post('/api/auth', ...)` password endpoint:

```
POST /api/auth/login     ← send magic link (public, rate-limited)
GET  /api/auth/verify    ← validate token, set session cookie, 302 redirect (public)
POST /api/auth/logout    ← delete session + clear cookie (authenticated via manual check)
GET  /api/auth/me        ← current user + team info (authenticated via shared helper)
PUT  /api/auth/active    ← update active_team_id / active_brand_id (authenticated via shared helper, with ownership checks)
```

### Shared Session Validator

`/api/auth/me`, `/api/auth/logout`, and `/api/auth/active` are under `/api/auth/*` and therefore **excluded from the middleware** (which skips all auth routes). They must validate the session themselves. To avoid duplication and drift, use a shared helper:

```typescript
// src/services/auth.ts

export async function validateSession(db: D1Database, token: string) {
  return db.prepare(`
    SELECT s.id as session_id, s.token, s.expires_at,
           s.active_team_id, s.active_brand_id,
           a.id as account_id, a.email, a.is_owner
    FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).bind(token).first()
}
```

Used by both the middleware and the auth route handlers.

### Auth Middleware

```typescript
// src/middleware/auth.ts

app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/auth')) return next()

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
})
```

**Why always extend:** The `scheduleNextProcess` self-fetch loop forwards the user's session cookie. If the session expired mid-run, the loop would 401 and the run would die silently. By extending on every activity (including the self-fetch), sessions never expire during active use. Runs complete in minutes, never days — so there is no scenario where a run outlasts an actively-refreshed session.

### Magic Link Login Flow

```
User visits terrain.run
       │
       ▼
┌──────────────────────┐
│     Login Page        │
│  [email input]        │
│  [invite code]        │  ← toggle: "First time? Enter invite code"
│  [Send Login Link]    │
└────────┬─────────────┘
         │
         ▼
POST /api/auth/login { email, invite_code? }
         │
         ├─ Rate limit check: ~3 requests per email per 15 min
         │   (KV key: rate:auth:{email}, TTL 900)
         │   Exceeded? → 429 Too Many Requests
         │   NOTE: KV is eventually consistent, so limit is approximate.
         │   Two concurrent requests could both pass. This is acceptable
         │   for auth rate limiting — at worst allows 4 instead of 3.
         │
         ├─ Email validation (basic regex + lowercase + trim)
         │
         ├─ Account exists?
         │   YES → proceed to magic link
         │   NO  → invite_code required
         │         ├─ Atomic code claim (see §6.1 below)?
         │         │   → Create account + team + member atomically (DB.batch)
         │         │
         │         └─ Invalid/missing/exhausted code?
         │              → 400 { error: "Invite code required" }
         │
         ├─ Invalidate all existing unused magic links for this email:
         │   UPDATE magic_links SET used = 1 WHERE email = ? AND used = 0
         │
         └─ Generate magic_link
            Token: 64-char hex (crypto.getRandomValues)
            Expires: 15 minutes
            → Send via Resend (with KV fallback, double try/catch)
            → Return { ok: true, message: "Check your email" }
            → Frontend shows "Check your email" UI state

User clicks link in email
         │
         ▼
GET /api/auth/verify?token=xxx
         │
         ├─ Token valid + not expired + not used?
         │   → Mark magic_link.used = 1
         │   → Create session (3-day base TTL, extended on activity)
         │   → Set active_team_id to user's first team
         │   → Set active_brand_id to team's first brand (or null)
         │   → Set cookie: aeo_session=<token>
         │   → **302 redirect** to / (MUST be server-side 302, not client-side)
         │     This ensures the cookie is set on the redirect response,
         │     which is same-origin. SameSite=Strict is fine because the
         │     cookie is set on the 302 response, not on the cross-origin
         │     email link click.
         │
         └─ Invalid/expired/used?
              → 302 redirect to /login.html?error=expired
```

### §6.1 — Atomic Signup Code Claim

Race condition: two concurrent signups with the same `max_uses=1` code could both pass a SELECT check. Fix with an atomic UPDATE:

```typescript
// Claim the code atomically — if 0 rows changed, code is exhausted or invalid
const claim = await c.env.DB.prepare(
  `UPDATE signup_codes SET times_used = times_used + 1
   WHERE UPPER(code) = UPPER(?) AND times_used < max_uses`
).bind(inviteCode).run()

if (claim.meta.changes === 0) {
  return c.json({ error: 'Invalid or exhausted invite code' }, 400)
}

// Code claimed — create account + team + member atomically
await c.env.DB.batch([
  c.env.DB.prepare('INSERT INTO accounts (id, email, is_owner) VALUES (?, ?, 0)')
    .bind(accountId, email),
  c.env.DB.prepare('INSERT INTO teams (id, name, invite_code, created_by) VALUES (?, ?, ?, ?)')
    .bind(teamId, emailPrefix, teamInviteCode, accountId),
  c.env.DB.prepare('INSERT INTO team_members (team_id, account_id) VALUES (?, ?)')
    .bind(teamId, accountId),
])
```

`DB.batch()` is transactional in D1 — all statements succeed or all fail. No orphaned accounts.

### Logout

```typescript
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
```

### /api/auth/me

```typescript
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
```

### PUT /api/auth/active — With Ownership Validation

```typescript
auth.put('/active', async c => {
  const token = getCookie(c.req.header('Cookie'), 'aeo_session')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  const session = await validateSession(c.env.DB, token)
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<{ team_id?: string; brand_id?: string }>()

  // Validate team_id: user must be a member
  if (body.team_id) {
    const member = await c.env.DB.prepare(
      'SELECT 1 FROM team_members WHERE team_id = ? AND account_id = ?'
    ).bind(body.team_id, session.account_id).first()
    if (!member) return c.json({ error: 'Not a member of this team' }, 403)
  }

  const effectiveTeamId = body.team_id || session.active_team_id

  // Validate brand_id: brand must belong to the active (or new) team
  if (body.brand_id) {
    const brand = await c.env.DB.prepare(
      'SELECT 1 FROM brands WHERE id = ? AND team_id = ?'
    ).bind(body.brand_id, effectiveTeamId).first()
    if (!brand) return c.json({ error: 'Brand not found in this team' }, 404)
  }

  // Update session
  await c.env.DB.prepare(`
    UPDATE sessions SET
      active_team_id = COALESCE(?, active_team_id),
      active_brand_id = COALESCE(?, active_brand_id)
    WHERE id = ?
  `).bind(body.team_id || null, body.brand_id || null, session.session_id).run()

  return c.json({ ok: true })
})
```

### Cookie Spec

```
Name:     aeo_session
Value:    <crypto-random-64-char-hex>
Path:     /
HttpOnly: true
Secure:   auto-detect (true if request URL is https)
SameSite: Strict
Max-Age:  259200 (3 days — but extended on every API call, so effectively infinite while active)
```

---

## 7. Rate Limiting

```typescript
// src/services/auth.ts

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
```

Applied to: `POST /api/auth/login` only.
Future: IP-based limiting via `cf-connecting-ip` header.

---

## 8. Cron: Garbage Collection + Stalled Run Recovery

```typescript
// src/index.ts

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      // 1. Clean up expired sessions and magic links
      const sessions = await env.DB.prepare(
        'DELETE FROM sessions WHERE expires_at < datetime("now")'
      ).run()
      const links = await env.DB.prepare(
        'DELETE FROM magic_links WHERE expires_at < datetime("now")'
      ).run()
      console.log(`[cron] Cleaned ${sessions.meta.changes} sessions, ${links.meta.changes} magic links`)

      // 2. Detect stalled runs (stuck in active status for > 1 hour)
      const { results: stalled } = await env.DB.prepare(`
        SELECT id, status FROM runs
        WHERE status IN ('pending', 'querying', 'scraping', 'analyzing')
          AND created_at < datetime('now', '-1 hour')
      `).all<{ id: string; status: string }>()

      if (stalled.length > 0) {
        console.warn(`[cron] Found ${stalled.length} stalled runs: ${stalled.map(r => r.id.slice(0,8)).join(', ')}`)
        // Mark as failed so the user knows something went wrong
        for (const run of stalled) {
          await env.DB.prepare(
            `UPDATE runs SET status = 'failed', error = 'Stalled — timed out after 1 hour' WHERE id = ? AND status = ?`
          ).bind(run.id, run.status).run()
        }
      }
    } catch (err) {
      // Cloudflare does NOT retry failed crons. Log clearly for debugging.
      console.error('[cron] Scheduled handler failed:', err)
    }
  },
}
```

---

## 9. KV Key Namespacing

### Current → New Key Format
```
logs:{brandId}           → {teamId}:logs:{brandId}
progress:{brandId}       → {teamId}:progress:{brandId}
error:{brandId}          → {teamId}:error:{brandId}
logs:run:{runId}         → {teamId}:logs:run:{runId}
lock:process:{runId}     → {teamId}:lock:process:{runId}
```

### Implementation

Update `makeReporter()`, `makeRunReporter()`, and `scheduleNextProcess()` to accept and use `teamId`:

```typescript
function makeReporter(brandId: string, teamId: string, env: Env) {
  const short = brandId.slice(0, 8)
  const logsKey = `${teamId}:logs:${brandId}`
  const progressKey = `${teamId}:progress:${brandId}`
  // ... rest unchanged
}

function makeRunReporter(runId: string, teamId: string, env: Env) {
  const logsKey = `${teamId}:logs:run:${runId}`
  // ... rest unchanged
}
```

### Transition: Dual-Read During Deploy

Active runs at deploy time will have logs under old keys. New code reads new keys. To avoid losing logs mid-run:

```typescript
// Temporary (remove after 2 hours when old KV TTLs expire):
const logs = await env.KV.get(`${teamId}:logs:run:${runId}`)
  || await env.KV.get(`logs:run:${runId}`)  // fallback to old format
  || ''
```

Old keys expire naturally (TTL 3600). Remove the fallback after 1 deploy cycle.

### Global Keys (not team-scoped)
```
rate:auth:{email}
magic_link_fallback:{email}
```

---

## 10. Data Query Scoping & Authorization

### Helper Functions

```typescript
// src/middleware/scope.ts

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
```

### Usage Pattern

Every route handler that takes a resource `:id` must:
```typescript
const brand = await requireBrand(c, brandId)
if (!brand) return c.json({ error: 'Not found' }, 404)
```

Returning 404 (not 403) prevents leaking whether a resource exists in another team.

### Routes That Need Scoping

**brands.ts:**
- `GET /api/brands/:id`
- `POST /api/brands/:id/continue`
- `POST /api/brands/:id/proceed-blocked`
- `POST /api/brands/:id/generate-prompts`
- `POST /api/brands/:id/supplement`
- `POST /api/brands/:id/classify-prompts`
- `POST /api/brands/:id/import-prompts`

**runs.ts:**
- `GET /api/runs/:id`
- `GET /api/runs/:id/logs`
- `POST /api/runs/:id/process`
- `GET /api/runs/list` (add `WHERE team_id = ?`)
- `POST /api/runs` (validate brand ownership, add team_id to INSERT)

**assistant.ts:**
- Validate run ownership via `requireRun()` before accessing brand_mentions/citations

### Insert Scoping

All INSERT statements include team_id:
```typescript
const teamId = c.get('teamId')
await c.env.DB.prepare(
  'INSERT INTO brands (id, url, domain, status, team_id) VALUES (?, ?, ?, ?, ?)'
).bind(id, url, domain, 'scraping', teamId).run()
```

---

## 11. Invite System

### Two Separate Concepts

| Concept | Purpose | When Used |
|---------|---------|-----------|
| **Signup Code** | Permission to create an account | First-time signup (login page) |
| **Team Invite Code** | Join an existing team | After signup (Settings/Team page) |

### Flow
1. New user: enters email + signup code → account + personal team created → magic link sent
2. Existing user: enters email only → magic link sent
3. Joining a team: from Settings, enter team invite code → added to team_members

### Code Format
- `XXXX-XXXX` (8 alphanumeric chars, case-insensitive)
- Generated: `crypto.getRandomValues()` → base36 → uppercase → hyphen at position 4
- Stored uppercase, matched with `WHERE UPPER(code) = UPPER(?)`
- Claimed atomically: `UPDATE ... SET times_used = times_used + 1 WHERE times_used < max_uses`

### Bootstrap
Owner account created by `003_seed_owner.sql`. Owner logs in via magic link (account exists, no signup code needed). Owner generates codes from admin panel.

---

## 12. Sidebar Redesign

### Hierarchy: Team → Brands

Teams own brands. Sidebar operates within one team. Team switching via Settings.

**State A — Brand Navigation (default)**
```
┌──────────────────────┐
│  ▲                   │
│  Acme Corp           │  ← click ▲/▼ swaps to State B
│  ▼                   │
├──────────────────────┤
│  Dashboard           │
│  Approve             │
│  Live Runs           │
│  Run History         │
├──────────────────────┤
│  Settings            │
│  API Costs           │
│  Team Members        │
└──────────────────────┘
```

**State B — Brand Picker (replaces sidebar)**
```
┌──────────────────────┐
│  Select Brand        │
├──────────────────────┤
│  ● Acme Corp         │
│    acme.com          │
│  ○ Globex Inc        │
│    globex.com        │
│  [+ Add Brand]       │
└──────────────────────┘
```

### Persistence
- `sessions.active_team_id` + `sessions.active_brand_id`
- Updated via `PUT /api/auth/active` (with ownership checks — see §6)
- Sidebar reads from `/api/auth/me` on page load
- Stale `active_brand_id` (deleted brand): sidebar auto-selects first brand in team

---

## 13. Client-Side Auth Gate

### Updated auth.js

```javascript
// public/assets/auth.js
document.documentElement.style.visibility = 'hidden'
fetch('/api/auth/me')
  .then(function (r) {
    if (r.status === 401) {
      window.location.replace('/login.html')
      return
    }
    if (!r.ok) {
      // 5xx or other error — show retry, don't reveal page
      throw new Error('Server error: ' + r.status)
    }
    return r.json()
  })
  .then(function (user) {
    if (!user) return
    window.__aeo_user = user
    document.documentElement.style.visibility = ''
  })
  .catch(function (err) {
    // Network error or 5xx — show error state, don't reveal page content
    document.body.innerHTML =
      '<div style="text-align:center;margin-top:40vh;font-family:monospace;color:#9f9a9a">' +
      '<p>Connection error</p>' +
      '<a href="/" style="color:rgb(238,82,24)">Retry</a></div>'
    document.documentElement.style.visibility = ''
  })
```

### Login Page States

```
State 1: Email input (default)
  [email input]
  [toggle: "First time? I have an invite code"]
  [Send Login Link]

State 2: Email + Invite Code (toggled)
  [email input]
  [invite code input]
  [Send Login Link]

State 3: Check Your Email (after successful submit)
  "We sent a login link to you@example.com"
  "Check your inbox (and spam folder)"
  [Didn't receive it? Send again] ← re-enables after 60s countdown

State 4: Error (from verify redirect or API error)
  "Link expired" / "Invalid invite code" / etc.
  [Try Again]
```

---

## 14. New Files

### Backend

| File | Purpose |
|------|---------|
| `src/services/email.ts` | Resend HTTP API — sends magic link emails, double try/catch fallback |
| `src/services/auth.ts` | `validateSession()`, `checkRateLimit()`, token generation, invite code claim |
| `src/routes/auth.ts` | `/api/auth/login`, `/api/auth/verify`, `/api/auth/logout`, `/api/auth/me`, `/api/auth/active` |
| `src/routes/teams.ts` | `/api/teams` — create, list, switch active team, join via invite code |
| `src/routes/admin.ts` | `/api/admin` — generate signup codes, list accounts, view fallback tokens (owner only) |
| `src/middleware/auth.ts` | Session middleware: validate, null team_id guard, auto-extend, context injection |
| `src/middleware/scope.ts` | `requireBrand()`, `requireRun()` — team-scoped resource access |
| `migrations/001_initial.sql` | Exact copy of current schema.sql (verify against prod!) |
| `migrations/002_accounts.sql` | New tables + ALTER existing tables |
| `migrations/003_seed_owner.sql` | Bootstrap owner account + team + backfill team_id |
| `scripts/migrate.sh` | Migration runner with proper arg parsing |

### Frontend

| File | Purpose |
|------|---------|
| `public/login.html` | Redesigned — email + invite code + magic link states |
| `public/assets/auth.js` | `/api/auth/me` check with 5xx/network error handling |
| `public/assets/sidebar.js` | Shared sidebar component with brand picker |
| `public/settings.html` | Account settings, team switcher, logout |
| `public/team.html` | Team management — members, invite link, leave team |
| `public/admin.html` | Owner-only — signup codes, accounts, fallback tokens |

### Modified Files

| File | Changes |
|------|---------|
| `src/index.ts` | Replace password auth with session middleware, add route mounts, add cron handler (GC + stalled runs), remove `AEO_PASSWORD` |
| `src/types.ts` | New interfaces, update Env, add team_id to Brand/Run/Prompt/Persona, Hono context types |
| `src/routes/brands.ts` | `requireBrand()` on all `:id` routes; team_id in INSERTs; team-prefix KV keys; pass teamId to `makeReporter()` |
| `src/routes/prompts.ts` | `WHERE team_id = ?` on all queries + INSERTs |
| `src/routes/personas.ts` | `WHERE team_id = ?` on all queries + INSERTs |
| `src/routes/runs.ts` | `requireRun()` on all `:id` routes; team_id in INSERTs; team-prefix KV keys; pass teamId to `makeRunReporter()` AND `scheduleNextProcess()` |
| `src/routes/assistant.ts` | `requireRun()` before accessing brand_mentions/citations |
| `wrangler.toml` | Add dev env, add cron trigger |
| All `public/*.html` | Sidebar component, remove old nav |

---

## 15. TypeScript Types

```typescript
// types.ts — complete file

export interface Env {
  DB: D1Database
  KV: KVNamespace
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  GOOGLE_AI_API_KEY: string
  RESEND_API_KEY: string
  ASSETS: Fetcher
}

export interface Account {
  id: string
  email: string
  is_owner: number
  created_at: string
}

export interface Team {
  id: string
  name: string
  invite_code: string
  created_by: string
  created_at: string
}

export interface Session {
  id: string
  account_id: string
  active_team_id: string | null
  active_brand_id: string | null
  token: string
  expires_at: string
  created_at: string
}

export interface MagicLink {
  id: string
  email: string
  token: string
  expires_at: string
  used: number
  created_at: string
}

export interface SignupCode {
  id: string
  code: string
  max_uses: number
  times_used: number
  created_by: string | null
  created_at: string
}

export interface Brand {
  id: string
  url: string
  domain: string
  name: string | null
  scraped_content: string | null
  supplement: string | null
  status: 'scraping' | 'generating' | 'personas_ready' | 'generating_prompts' | 'ready' | 'failed' | 'scrape_blocked'
  team_id: string          // nullable in SQLite, enforced NOT NULL in app layer
  created_at: string
}

export interface Prompt {
  id: string
  brand_id: string
  persona_id: string | null
  text: string
  funnel_stage: 'tofu' | 'mofu' | 'bofu'
  rationale: string | null
  approved: number
  team_id: string
  created_at: string
}

export interface Persona {
  id: string
  brand_id: string
  name: string
  description: string
  goals: string | null
  pain_points: string | null
  system_message: string
  rationale: string | null
  approved: number
  team_id: string
  created_at: string
}

export interface Run {
  id: string
  brand_id: string
  status: 'pending' | 'querying' | 'scraping' | 'analyzing' | 'complete' | 'failed'
  total_queries: number
  completed_queries: number
  error: string | null
  team_id: string
  created_at: string
  completed_at: string | null
}

// Query, Citation, BrandMention — UNCHANGED (no team_id)
// Scoped via parent run/brand — see Section 2

export interface Query {
  id: string
  run_id: string
  prompt_id: string
  persona_id: string
  llm: 'claude' | 'chatgpt' | 'gemini'
  response_text: string | null
  status: 'pending' | 'processing' | 'complete' | 'failed'
  created_at: string
  prompt_text?: string
  system_message?: string
  funnel_stage?: string
}

export interface Citation {
  id: string
  query_id: string
  url: string
  domain: string
  page_title?: string | null
  on_page_text: string | null
  company_name: string | null
  source_type: 'owned' | 'competitor' | 'news' | 'industry' | 'unknown'
  scraped_ok: number
  created_at: string
}

export interface BrandMention {
  id: string
  query_id: string
  brand_name: string
  rank: number
  is_target: number
  context_snippet: string | null
  created_at: string
}

export interface ProcessResult {
  phase: string
  total: number
  completed: number
  done: boolean
  error?: string
}

export interface LLMApiKeys {
  anthropic: string
  openai: string
  google: string
}

// Hono context variables
// NOTE: verify ContextVariableMap export path with Hono v4.6.0
// May need 'hono' or 'hono/context' depending on version
declare module 'hono' {
  interface ContextVariableMap {
    account: { id: string; email: string; is_owner: number }
    teamId: string
    brandId: string | null
    sessionId: string
  }
}
```

---

## 16. Implementation Order

### Phase 0 — Pre-requisites (before any code changes)
1. Create Resend account, add terrain.run domain, add DNS records
2. **Wait for DNS propagation and verify** in Resend dashboard
3. Test email send from Resend dashboard

### Phase 1 — Foundation
4. Create `migrations/` directory
5. Copy `schema.sql` → `migrations/001_initial.sql` — verify it matches prod exactly (diff against `wrangler d1 execute aeo-db --command ".schema"`)
6. Write `migrations/002_accounts.sql`
7. Write `scripts/migrate.sh` with proper arg parsing
8. Create dev D1: `wrangler d1 create aeo-db-dev`
9. Create dev KV: `wrangler kv namespace create KV --env dev`
10. Update `wrangler.toml` with dev env + cron trigger
11. Run migrations locally: `./scripts/migrate.sh --local`
12. Verify: `wrangler d1 execute aeo-db --local --command ".tables"`

### Phase 2 — Auth Backend
13. Write `src/services/auth.ts` — `validateSession()`, `checkRateLimit()`, token gen
14. Write `src/services/email.ts` — Resend API + double try/catch fallback
15. Write `src/middleware/auth.ts` — session middleware with auto-extend + null guard
16. Write `src/middleware/scope.ts` — `requireBrand()`, `requireRun()`
17. Write `src/routes/auth.ts` — login, verify (302 redirect!), logout, me, active (with ownership checks)
18. Update `src/types.ts` — all new interfaces
19. Update `src/index.ts` — swap auth, mount routes, add cron handler
20. Set secret: `wrangler secret put RESEND_API_KEY`
21. Test auth flow locally

### Phase 3 — Data Scoping
22. Update `src/routes/brands.ts` — `requireBrand()`, team_id INSERTs, KV prefixing, dual-read fallback
23. Update `src/routes/prompts.ts` — team_id scoping
24. Update `src/routes/personas.ts` — team_id scoping
25. Update `src/routes/runs.ts` — `requireRun()`, team_id INSERTs, KV prefixing, pass teamId to `scheduleNextProcess()`
26. Update `src/routes/assistant.ts` — `requireRun()` before data access
27. Test scoping (cross-team access → 404)

### Phase 4 — Teams & Admin Backend
28. Write `src/routes/teams.ts` — create, list, switch, join
29. Write `src/routes/admin.ts` — signup codes, accounts, fallback tokens (owner only)
30. Mount in `src/index.ts`

### Phase 5 — Frontend
31. Rewrite `public/login.html` — magic link flow, 4 states
32. Update `public/assets/auth.js` — `/api/auth/me` with error handling
33. Build `public/assets/sidebar.js` — brand picker
34. Build `public/settings.html`, `public/team.html`, `public/admin.html`
35. Update all existing pages to use sidebar

### Phase 6 — Deploy
36. Write `migrations/003_seed_owner.sql` with your email
37. Backup prod D1: `wrangler d1 export aeo-db`
38. Run migrations on prod: `./scripts/migrate.sh` (runs 001, 002, 003)
39. Verify backfill: `SELECT COUNT(*) FROM brands WHERE team_id IS NULL` → 0
40. Deploy immediately: `wrangler deploy` (minimize window between migration and deploy)
41. Test magic link flow end-to-end on production
42. Remove old secret: `wrangler secret delete AEO_PASSWORD`
43. Generate signup codes via admin panel
44. **After 2 hours:** Remove KV dual-read fallback code (old keys have expired)

---

## 17. Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Resend delivery / spam | Medium | SPF + DKIM verified before deploy; KV fallback for admin retrieval |
| Session token leaked | Medium | HttpOnly + Secure + SameSite=Strict; auto-extend means token rotates expiry, not value |
| Migration breaks prod data | High | Backup via `wrangler d1 export`; run on local + dev first; no table recreation |
| Cross-team data access | High | `requireBrand()`/`requireRun()` on every `:id` route; returns 404 not 403 |
| `scheduleNextProcess` auth | **Resolved** | Session auto-extends on every API call; self-fetch forwards cookie; runs complete in minutes |
| Window between migration and deploy | Medium | Run 003 then deploy within minutes; backfill uses `WHERE team_id IS NULL` |
| Rate limit race (KV) | Low | Approximate limit (~3), at worst allows 4; acceptable for auth |
| Signup code race | Low | Atomic `UPDATE ... WHERE times_used < max_uses`; `DB.batch()` for account creation |
| KV key format transition | Medium | Dual-read fallback during deploy; old keys expire in 1 hour |
| Cron failure (no retry) | Low | Errors logged; expired rows accumulate but don't break functionality; manual cleanup documented |
| Stale `active_brand_id` | Low | No FK constraint; sidebar handles gracefully (auto-select first brand) |
| Multiple sessions per user | Low | Allowed by design; GC cleans expired daily |
| `auth.js` network error | Low | Shows error/retry UI instead of revealing page content |

---

## 18. Future Considerations (not in v1)

- **OAuth (Google sign-in)** — alternative auth method
- **Billing / run credits** — Stripe, usage tracking per team
- **API keys per team** — move from env secrets to DB
- **AI Snippet column** — additional live runs column (horizontal scroll)
- **Role-based access** — admin/member/viewer within teams
- **Account/team deletion** — GDPR, cascade delete
- **IP-based rate limiting** — `cf-connecting-ip` header
- **team_id on queries table** — for direct team-level analytics
- **Audit log** — who did what, when
- **team_id NOT NULL in SQLite** — if D1 improves ALTER COLUMN support, add it later
