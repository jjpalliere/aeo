# Teams Management Plan

**Status:** Planning doc. No code yet.

## Executive summary

The single global owner (`is_owner=1`) has no admin-portal teams UI, and users end up with multiple auto-created "Personal" teams across emails. Ship: keep `is_owner` as global super-admin, add a per-team `role` column so team creators implicitly manage their own team, build a "Teams" admin section for list/create/rename/delete/member-manage/move-brand, add a lightweight sidebar team switcher, **move-to-archive on team delete (no destructive cascade)**, and **email-based invitations for non-users**. Defer full RBAC.

Two MVP-critical behaviors guide the rest of the design:

1. **Deleting a team never deletes brands or downstream data.** All brands (and their runs, queries, prompts, personas, brand_mentions, citations, similarity_runs, KV logs) are moved to the global super-admin's archive team. The user who deleted the team sees everything gone; the super-admin retains the data.
2. **Invitations work for emails that do not yet have an account.** The inviter enters an email, the invitee gets a magic link, and clicking it either creates their account and drops them into the team or logs them in and adds them to the team.

Both land in Phase 1.

## 1. Permission model

**Two-tier, minimal per-team signal.**

- **Global:** keep `accounts.is_owner` (conceptually "super-admin") — sees/acts on every team, admin portal, cross-team actions. The archive destination for deleted teams.
- **Per-team:** add `team_members.role TEXT NOT NULL DEFAULT 'member'` with `'admin' | 'member'`. On team creation, creator becomes `'admin'`. `teams.created_by` kept as historical pointer; permissions derive from `role`.
- **Non-owner team admins** can rename, rotate invite code, kick, promote/demote, invite by email, delete their own team (deletion triggers archive-to-admin, not cascade destruction).
- **Global `is_owner`** bypasses all team-role checks.

### Why not alternatives
- Just `is_owner`: too restrictive for consolidation flows across emails.
- Full RBAC (roles table, permissions): overkill for one super-admin + handful of personal teams.

### Backfill
Migration sets `role = 'admin'` for `team_members.account_id = teams.created_by`, `'member'` otherwise.

## 2. Admin portal teams section (owner-only)

New section in `public/admin.html`, between Join Requests and Similarity Mappings.

### 2a. List
Columns: Name | Members | Brands | Runs | Created | Actions.
Source: `GET /api/admin/teams` with left-joined counts.
Row actions: View members, Rename, Delete, Copy/rotate invite code, View pending invitations.

### 2b. Create
Inline form: Name + optional "Assign to user" email (defaults to super-admin). `POST /api/admin/teams`.

### 2c. Rename
Inline edit → `PATCH /api/teams/:id`.

### 2d. Delete (archive-to-admin policy)

**No cascade-destructive option. No "move brands first" dropdown.** There is a single destructive-looking-but-non-destructive operation:

Confirmation modal copy (roughly):
> Delete team "**X**"? This removes the team and all of its members. The team's brands will be removed from your view.
>
> (Type team name to confirm.)

On confirm the server:

1. Collects every `brand.id` where `team_id = :deletedTeamId`.
2. Moves each brand to the super-admin's archive team (see §5b for target selection):
   - `UPDATE brands SET team_id = :archiveTeamId, archived_at = CURRENT_TIMESTAMP, archived_from_team_name = :oldTeamName, archived_from_account_id = :deleter WHERE id IN (...)`.
   - Cascades `team_id` on `runs`, `prompts`, `personas` (same brand ids).
   - `similarity_runs` has no `team_id` column (verified against D1); it is scoped via `brand_id` → `brands.team_id`, so it follows the brand automatically. No rewrite needed.
   - `brand_mentions`, `citations`, `queries` are scoped via their parent `run` / `query`; no `team_id` column to rewrite.
   - **Pre-check:** reject the delete with 409 if any brand in the team has an active run (`runs.status IN ('pending','querying','scraping','analyzing')`). Mirrors the in-flight guard used by individual brand moves (§2g). Prevents the KV rekey from yanking keys out from under a running process.
   - Rewrites KV keys whose prefix embeds `teamId` (see §5c).
3. Fixes up sessions referencing the deleted team (§5d).
4. Deletes `team_members` rows for the team.
5. Revokes pending invitations for the team (§6).
6. Deletes the `teams` row. Check `result.meta.changes` — if zero, another admin already deleted the team in a race; return 409 so the caller can refresh. The whole flow runs as a D1 `batch()` so a partial failure is rolled back.
7. Writes an audit row to `team_deletion_log` (§5e).
8. Optional: enqueues a notification to the super-admin (§5f).

The caller's API response is identical to a normal successful delete. No hint that data was retained.

**Guardrail:** deleting the archive team itself is rejected. See §7 Edge cases.

### 2e. Members panel
Lists members with role pill, join date, actions:
- **Promote / Demote** (toggle `role`).
- **Remove** (kick; blocked if last admin with other members — must promote first).
- **Add member by email (immediate)** — only works if the email already has an account. Otherwise use "Invite by email" (§6) which sends a magic-link invitation.

### 2f. Invitations panel (new — Phase 1)
Per-team drawer inside the admin portal and `/team.html` listing pending invitations:

Columns: Email | Invited by | Sent | Expires | Status | Actions.
Row actions: Resend link, Revoke.

Also provides an "Invite by email" form (one email per submit, multiline accepted in a stretch goal). See §6 for full spec.

### 2g. Move brand between teams
Modal with target dropdown → `PATCH /api/admin/brands/:id/team`. Server updates `brands.team_id`, cascades to `runs.team_id`, `prompts.team_id`, `personas.team_id`, `similarity_runs.team_id`, rewrites KV keys. Owner-only in MVP.

### 2h. is_owner toggle
Accounts section gets per-row toggle → `PATCH /api/admin/accounts/:id`. Guard: cannot remove self's last super-admin status. Also guard: archive team must always belong to at least one `is_owner=1` account.

## 3. Team switcher for the user

**Add to sidebar, above the brand switcher, reusing `sb-brand-switcher` pattern.**
- Render only when user belongs to ≥ 2 teams.
- Select → `PUT /api/auth/active { team_id }` → resets `active_brand_id` to first brand in new team.
- After switch, `sidebar.js` refetches `/api/auth/me` + `/api/brands` and re-renders.

### /team.html
Stays as per-active-team management: invite code (rotatable), member list, leave, and for team admins: rename, kick/promote, **invite by email** (§6), delete (archive flow), pending invitations list.

### Session fix-ups
When a team is deleted, or a user is kicked from their current `active_team_id`, server sets `active_team_id` to any remaining team (or `null`). Likewise `active_brand_id` becomes the first brand in the new active team or `null`. Archived brands never reappear in the deleter's session because their `team_id` now points to the archive team.

## 4. API endpoints

All require valid session. `/api/admin/*` enforces `is_owner`. Team-scoped endpoints check `is_owner` OR `team_members.role='admin'` via `requireTeamAdmin(c, teamId)`. Invitation-acceptance is anonymous (token-gated).

### 4a. Team management

| Method | Path | Auth | Body | Purpose |
|---|---|---|---|---|
| PATCH | `/api/teams/:id` | team admin or owner | `{ name? }` | Rename |
| DELETE | `/api/teams/:id` | team admin or owner | `{ confirmName }` | Delete — triggers archive-to-admin flow |
| POST | `/api/teams/:id/rotate-invite` | team admin or owner | — | New code, old invalid |
| POST | `/api/teams/:id/members` | team admin or owner | `{ email, role? }` | Add existing account by email |
| DELETE | `/api/teams/:id/members/:accountId` | team admin or owner | — | Kick |
| PATCH | `/api/teams/:id/members/:accountId` | team admin or owner | `{ role }` | Promote/demote |
| PATCH | `/api/brands/:id/team` | owner only (MVP) | `{ team_id }` | Move brand |

Body for `DELETE /api/teams/:id` no longer takes `cascade` / `moveBrandsTo`. `confirmName` is validated server-side against the team's current `name` (case-insensitive trim) before the archive flow runs. The response is generic `{ ok: true }` with no mention of archival.

### 4b. Admin portal

| Method | Path | Auth | Body | Purpose |
|---|---|---|---|---|
| GET | `/api/admin/teams` | owner | — | All teams with counts; each row includes `is_archive: boolean` so the UI can disable the delete button on the archive team. |
| POST | `/api/admin/teams` | owner | `{ name, assigneeEmail? }` | Create on behalf |
| PATCH | `/api/admin/accounts/:id` | owner | `{ is_owner }` | Toggle super-admin |
| GET | `/api/admin/teams/:id/members` | owner | — | Any team's members |
| GET | `/api/admin/archive` | owner | — | List archived brands with `archived_from_team_name`, `archived_from_account_id`, `archived_at` |

### 4c. Invitations (new — Phase 1)

| Method | Path | Auth | Body | Purpose |
|---|---|---|---|---|
| POST | `/api/teams/:id/invitations` | team admin or owner | `{ email }` | Create invitation, issue token, send email |
| GET | `/api/teams/:id/invitations` | team admin or owner | — | List pending + recently-accepted/revoked (paginated) |
| POST | `/api/teams/:id/invitations/:invitationId/resend` | team admin or owner | — | Rotate token, reset expiry, re-send email |
| DELETE | `/api/teams/:id/invitations/:invitationId` | team admin or owner | — | Revoke |
| POST | `/api/invitations/accept` | anonymous | `{ token }` | Accept an invitation (magic-link style). Creates account + session if new, otherwise logs in and adds to team. |
| GET | `/api/invitations/:token` | anonymous | — | Preview: returns team name + inviter email so the landing page can show "You were invited to X by y@z". Does not consume the token. |

Phase-2 extra: `POST /api/admin/teams/:id/merge { intoTeamId }` — one-click consolidation.

## 5. Schema changes (Phase 1)

### 5a. Roles

```sql
ALTER TABLE team_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
UPDATE team_members
  SET role = 'admin'
  WHERE account_id IN (
    SELECT created_by FROM teams WHERE teams.id = team_members.team_id
  );
```

### 5b. Archive metadata on brands

```sql
ALTER TABLE brands ADD COLUMN archived_at TIMESTAMP;
ALTER TABLE brands ADD COLUMN archived_from_team_name TEXT;
ALTER TABLE brands ADD COLUMN archived_from_account_id TEXT REFERENCES accounts(id);

CREATE INDEX idx_brands_archived_at ON brands(archived_at);
```

**Why a metadata column, not a name prefix.** Renaming brands on archive loses their original name and mutates a user-facing field. A nullable `archived_at` plus two context columns keeps the original name intact and drives the sidebar filter. UI renders archived brands in a collapsed "Archive" group within the super-admin's sidebar, labeled e.g. `<brand.name> — from "<archived_from_team_name>"`.

**Archive target team selection.** `getArchiveTeamId(DB)` resolves the archive team per-request with a fallback chain:

1. **Primary:** the first team (by `team_members.joined_at`) belonging to the `is_owner=1` account with the smallest `created_at`.
2. **Fallback:** if the primary owner was demoted or their account was deleted, pick any remaining `is_owner=1` account's first team.
3. **Error:** if no `is_owner=1` account exists at all, throw — the platform is misconfigured. The `PATCH /api/admin/accounts/:id` endpoint must guard against removing the last super-admin (§2h), which makes this branch unreachable in practice.

The resolver is cached at the request scope (not process-global, to avoid staleness after is_owner toggles). No new column needed; Phase 2 may add a `platform_settings.archive_team_id` row for explicit configurability.

Rationale: zero new migration surface, no "dedicated archive team" row that could disappear. The super-admin already has a team they live in; archived brands land there under an "Archive" filter in the sidebar.

### 5c. KV rekey

KV keys that embed `teamId`: `{teamId}:logs:{brandId}`, any similarity-run queues keyed by team. On team delete, for each key under the prefix `{deletedTeamId}:`:

```
list({prefix: `${deletedTeamId}:`}) → for each key:
  newKey = `${archiveTeamId}:` + key.slice(deletedTeamId.length + 1)
  // Collision guard: if the brand was previously archived and re-appeared in the
  // deleted team, newKey may already exist. Do not overwrite the archive's data.
  if (await kv.get(newKey) != null) {
    newKey = newKey + `:from:${deletedTeamId}`
  }
  put(newKey, value)
  delete(oldKey)
```

Wrapped in a best-effort loop (KV isn't transactional). If the worker dies mid-loop, remaining old keys are orphaned — the nightly cleanup job (future) can delete keys whose team no longer exists. Acceptable for Phase 1.

### 5d. Session fix-ups

Scope the update to sessions owned by users who were *members* of the deleted team. The super-admin (archive destination) is left alone — their session stays on whatever `active_team_id` it was on, which is almost never the deleted team.

```sql
UPDATE sessions
  SET active_team_id = NULL, active_brand_id = NULL
  WHERE active_team_id = :deletedTeamId
    AND account_id IN (
      SELECT account_id FROM team_members WHERE team_id = :deletedTeamId
    );
```

(The inner subquery runs *before* the team_members rows are deleted in step 4 of §2d — order matters in the batch.)

On the next `/api/auth/me` the session middleware re-resolves to the first team the user still belongs to. Archived brands point to the archive team, so they never match `active_team_id` for the deleter.

### 5e. Deletion audit log

```sql
CREATE TABLE team_deletion_log (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  deleted_by TEXT NOT NULL REFERENCES accounts(id),
  brand_ids TEXT NOT NULL,            -- JSON array
  archive_team_id TEXT NOT NULL REFERENCES teams(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_team_deletion_log_created ON team_deletion_log(created_at DESC);
```

Admin portal gets a simple "Deletion history" view reading this table. Gives the super-admin a single-query view of every archive event.

### 5f. Notifications (optional Phase 1, fall back to Phase 2)

Minimum viable: an in-app notification row under the admin portal's Teams section ("Archive activity") reading `team_deletion_log`. No new table needed. Email is deferred to Phase 2 (would reuse Resend infra); leaving out of MVP keeps deployment cost low.

### 5g. Invitations table

```sql
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  email TEXT NOT NULL,                              -- lowercased, trimmed
  invited_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  token TEXT UNIQUE NOT NULL,                       -- generated via auth.ts::generateToken()
  status TEXT NOT NULL DEFAULT 'pending',           -- 'pending' | 'accepted' | 'revoked' | 'expired'
  expires_at TIMESTAMP NOT NULL,                    -- created_at + 7 days
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMP,
  accepted_by_account_id TEXT REFERENCES accounts(id),
  signup_code_id TEXT REFERENCES signup_codes(id)   -- nullable: only set when invitee had no account at invite time
);

CREATE INDEX idx_invitations_token ON invitations(token);
CREATE INDEX idx_invitations_team ON invitations(team_id, status);
CREATE INDEX idx_invitations_email ON invitations(email, status);
```

Cascade integrity remains in code. New helper `deleteTeamArchiveFlow(teamId, deleter)` does steps 1–8 of §2d in a single function.

Optional phase-2: `teams.archived_at TIMESTAMP` for soft-delete of the `teams` row itself (currently we hard-delete); `teams.invite_code_expires_at`.

## 6. Invitations by email for non-users

### 6a. Why a new concept

Existing `signup_codes` are **general**: "here's a code, anyone with it can sign up and then get their own Personal team." Existing `magic_links` are **login-only**: they presume an account exists. Neither handles "this specific email is invited to this specific team."

We add an `invitations` table (§5g) and a dedicated acceptance endpoint. The magic-link verify endpoint stays focused on login; invitation acceptance is a parallel flow that composes magic-link behavior internally (create-session-and-redirect).

### 6b. Creation flow — inviter side

1. Inviter opens the team's Invitations panel in admin portal or `/team.html` and enters an email.
2. `POST /api/teams/:id/invitations { email }`.
3. Server normalizes email (lowercase + trim, validate shape).
4. Server checks for duplicates:
   - Existing pending invitation for same `(team_id, email)` → reject with 409 and suggest resend.
   - Email already belongs to an account that is already a member → reject with 409 "already a member".
5. Server calls the existing `generateToken()` helper from `auth.ts` for consistency with magic-link tokens (same entropy, same format, one code path to audit).
6. **If the invited email has no account yet**, the server also reserves a single-use signup code by inserting a row into `signup_codes` (or the equivalent existing mechanism) with `max_uses = 1`, and stores its id on the invitation row. Invitations bundle their own signup code — the invitee still has to go through the signup-code check when their account is created, satisfying the site-wide policy. If the email already has an account, no code is reserved (account creation is skipped).
7. Insert invitation row with `token`, `expires_at = now + 7 days`, `status = 'pending'`, and the optional reserved `signup_code_id`. Row + signup code insert run in a single D1 `batch()` so a partial failure rolls back.
8. Send email via Resend (existing service used by magic-link flow). See §6e for contents.
9. Return `{ ok: true, invitation_id }`. Email-send failure leaves the invitation row + code in place so the inviter can retry via the resend endpoint — consistent with how magic-link handles Resend outages.

### 6c. Acceptance flow — invitee side

Email link points to `https://<site>/invite?token=<token>` (a static HTML page — `public/invite.html`) which:

1. On load, calls `GET /api/invitations/:token` to fetch team name + inviter email for display. If token is revoked/expired/used, render a friendly error.
2. Shows "You were invited to **Team X** by inviter@example.com" with a single **Accept** button.
3. On click, calls `POST /api/invitations/accept { token }`.

Server-side `POST /api/invitations/accept`:

1. Look up invitation by token. Must be `status='pending'` and `expires_at > now`. Otherwise 400.
2. Atomic claim: `UPDATE invitations SET status='accepted', accepted_at=now, accepted_by_account_id=:accountId WHERE id=:id AND status='pending'`. **Check `result.meta.changes`**: if zero, the invitation was claimed/revoked between our SELECT and UPDATE — return 400 "invitation no longer valid". This is the real guard against double-claim and forwarded-link races; the earlier SELECT is not authoritative.
3. All remaining writes go in a single D1 `batch()`:
   - If `email` has no account yet: create it via `createAccountWithDefaultTeam` (still gets a Personal team for consistency; they can leave it later). Account creation **consumes** the signup code that was reserved on the invitation row (§6b step 6) — the signup-code requirement is still enforced on the acceptance path, the invitation just bundled the code. Increment `signup_codes.times_used` atomically.
   - Insert `team_members` row for `(invitation.team_id, accountId)` with `role='member'`.
   - Create a session (pattern from `/api/auth/verify`): generate session token, `active_team_id = invitation.team_id`, `active_brand_id = first brand in that team or null`.
4. Set cookie, 302 redirect to `/`.

The batch ensures no orphaned account rows if one of the later steps fails — either the whole acceptance succeeds or none of it sticks. Endpoint is anonymous: the token is the auth.

### 6d. Security model

- **Single-use token.** The atomic `UPDATE ... WHERE status='pending'` guards against double-claim (and therefore forwarding): second click sees changed rows = 0 and errors out.
- **7-day expiry.** Matches common industry default; long enough for travel/holiday, short enough to limit exposure. Configurable constant — not a config row.
- **Email-match at acceptance?** No. The token is the bearer credential. Requiring the invitee to re-enter the invited email adds friction and provides only pseudo-security (they already have the link). If the user wants stricter posture in a future phase, add an optional `require_email_match` flag on the invitation that asks the invitee to confirm the email before claim.
- **Rate limit** on `POST /api/teams/:id/invitations` (reuse the `checkRateLimit` helper keyed by inviter email + team id). Prevents spam-inviting.
- **Resend** rotates the token (new hex, new 7-day expiry) and invalidates the previous one by `UPDATE invitations SET token = :new, expires_at = :new, created_at = now`. Old token stops working because lookup-by-token returns nothing.
- **Revoke** sets `status='revoked'`. Subsequent acceptances fail.
- **Cleanup.** Nightly (future) job marks `status='expired'` where `expires_at < now AND status='pending'`. Not required for correctness — expired tokens still fail the acceptance check.

### 6e. Email contents

Subject: `You've been invited to join ${teamName} on terrain`

Body (plain text + simple HTML, via Resend — mirror the existing magic-link template in `src/services/magic-link.ts`):

```
Hi,

${inviterEmail} has invited you to join the team "${teamName}" on terrain.

Click the link below to accept. It expires in 7 days.

${SITE_URL}/invite?token=${token}

If you weren't expecting this, you can ignore this email.

— terrain
```

### 6f. UI placement

- **Admin portal** (`public/admin.html`, new Teams section): a per-team drawer with the Invitations list and "Invite by email" form.
- **`/team.html`**: team admins get the same drawer for their own team. Members do not see it.
- **`public/invite.html`** (new): the anonymous acceptance landing page.

### 6g. Edge cases

| Case | Behavior |
|---|---|
| Email already has an account that's already a team member | 409 on create; UI says "already a member". |
| Email already has an account (not a member) | Invitation flow proceeds. Acceptance logs them in and adds to team. |
| Token expired | Acceptance fails 400. Inviter can resend. |
| Token already used | Same as expired: 400 on second use. |
| Email forwarded | Whoever clicks first wins because the token is single-use. Acceptable per product stance. |
| Invitation revoked after send | Acceptance fails 400 "invitation no longer valid". |
| Team deleted between send and accept | Acceptance fails 404 (FK lookup misses). Explicit cleanup in the archive flow: `UPDATE invitations SET status='revoked' WHERE team_id=:deleted AND status='pending'`. |
| Inviter removed from team before acceptance | Invitation still honored (token is team-scoped, not inviter-scoped). |
| Invitee already logged in as a different email when they click | Acceptance endpoint is anonymous and creates its own session — this replaces the cookie. That's the simplest behavior and matches how magic-link login already overwrites. |
| Double-submit / network retry | Atomic UPDATE guards against double-claim. Retry sees 400 and UI can treat it as "already accepted, you're in". |
| New account creation path when no account exists | Uses `createAccountWithDefaultTeam` so the invitee still gets their own Personal team. They're added to the invited team as `role='member'`. |
| Super-admin invites themselves to a team they're already in | Treated like "already a member" — 409. |

## 7. Edge cases (overall)

| Case | Decision |
|---|---|
| Team deletion with brands | Archive-to-admin. Brands, runs, prompts, personas, similarity_runs move to the super-admin's archive team; KV keys rekeyed; `archived_at` set on brands. No option to truly delete downstream data via this path. |
| Deleting the archive team itself | Rejected with 400 "cannot delete the platform archive team". Detection: `teamId === getArchiveTeamId()`. |
| Super-admin deletes a non-archive team of their own | Works the same as any other team. Brands move from the deleted team to the archive team. If they were already the same team, see the row above. |
| Self-kick | Short-circuit to existing `/leave` code. |
| Last admin kicked/demoted | Reject unless another admin exists. Super-admin bypasses. |
| Last member leaves team | Cannot leave (existing). Owner/team admin can delete team outright, which archives. |
| User with zero teams | Allowed. Route to "No teams" screen at `/team.html`. |
| Removing last super-admin | Reject if there's only one `is_owner=1` account. Also protects the archive-team resolver. |
| Invite rotation | Phase 1 (team invite codes). Immediate invalidation. Independent of invitation tokens. |
| Brand move between teams | Update `brands.team_id`, `runs.team_id`, `prompts.team_id`, `personas.team_id`, `similarity_runs.team_id`; rewrite KV `{teamId}:logs:{brandId}` etc. Block move if in-flight run. |
| Multiple personal teams for one user | Delete empty teams → archive flow (no brands, so archive is a no-op for data). Phase-2 merge for one-click. |
| Race: two admins kick each other | Transactional check in UPDATE guards against zero-admin state. |
| Session cache after role change | No cache — middleware re-checks on every request. |
| Archived brands cluttering super-admin sidebar | Sidebar groups `archived_at IS NOT NULL` brands into a collapsible "Archive" section at the bottom, off by default; admin can expand to see them with their `archived_from_team_name` label. |
| Name collision: archived brand same URL as existing admin brand | Both exist as separate `brands` rows; that's already how `brands` uniqueness works (no unique on `url`). |

## 8. Phased implementation

### Phase 1 — MVP

1. Migration `006_team_roles_and_archive.sql`:
   - Add `team_members.role` + backfill (§5a).
   - Add `brands.archived_at`, `archived_from_team_name`, `archived_from_account_id` + index (§5b).
   - Create `team_deletion_log` (§5e).
   - Create `invitations` + indexes (§5g).
2. `src/middleware/teamAdmin.ts` — `requireTeamAdmin` helper.
3. `src/services/archive.ts` — `getArchiveTeamId(DB)` resolver (cached per-request), `deleteTeamArchiveFlow(DB, KV, teamId, deleterId)`.
4. Expand `src/routes/teams.ts`: PATCH, DELETE (archive flow), rotate-invite, members add/kick/promote, invitations endpoints (create/list/resend/revoke).
5. New `src/routes/invitations.ts` or additions to `src/routes/auth.ts` for anonymous `POST /api/invitations/accept` and `GET /api/invitations/:token`.
6. Extend `src/routes/admin.ts`: `GET/POST /api/admin/teams`, `GET /api/admin/teams/:id/members`, `PATCH /api/admin/accounts/:id`, `GET /api/admin/archive`.
7. `PATCH /api/brands/:id/team` in `src/routes/brands.ts` or `admin.ts`.
8. `src/services/email.ts` (or extend magic-link service) — send invitation emails.
9. `public/admin.html` — Teams section (list, rename inline, create, delete modal — archive semantics, members accordion, invitations drawer, move-brand, deletion history, archive view, is_owner toggle).
10. `public/team.html` — invite-by-email form + pending invitations list for team admins.
11. `public/invite.html` — new anonymous acceptance landing page.
12. Sidebar team switcher + Archive group in `public/sidebar.js`.
13. Session fix-ups on delete/kick (§5d).

Complexity: **Medium-to-Large**. ~1100–1500 LOC. Biggest risks:
- **KV rekey during delete** — wrap in a loop with try/catch per-key, tolerate partial failure, emit audit row listing any keys that failed to move.
- **Brand-move KV rekey** — gate behind "no active run" (Phase 1 assertion).
- **Acceptance race** — must use atomic UPDATE on `invitations.status` to prevent double-claim.

### Phase 2 — polish

- `/team.html` deeper editing UI for team admins (reuses phase-1 endpoints).
- `POST /api/admin/teams/:id/merge`.
- Email notifications to super-admin on team deletion (not just in-app).
- Rotatable/expirable invite codes.
- Soft-delete (`teams.archived_at`) so archive flow could be reverted by super-admin.
- `team_audit_log` table for non-deletion events (member add/kick/role change).
- Background job for brand moves during active runs.
- Nightly job: mark expired invitations, clean orphaned KV keys.
- Optional `require_email_match` on invitations.

Complexity: small-to-medium per item, independent.

### Phase 3 — deferred

Multi-level roles (`billing`, `viewer`). Per-brand permissions. Team-scoped API keys.

## 9. Open questions

1. **Archive team UX posture.** Single "Archive" collapsible group (this plan), or a dedicated `/archive` route? Default: group in sidebar, Phase-2 dedicated route if it gets noisy.
2. **Notification channel to super-admin.** In-app only (Phase 1) vs. email (Phase 2)? Default as written.
3. **Team admin delete authority.** Non-owner team admins can delete — and trigger archive-to-admin. Confirmed yes; archive semantics make this safe.
4. **Cross-team brand move for team admins.** Owner-only in MVP, or enable team admins immediately? Owner-only.
5. **Personal team on signup via invitation.** Keep auto-creating Personal team for new accounts (invited or not), or skip Personal when signup came through an invitation? Default: keep Personal for consistency; revisit if users complain.
6. **"Owner" terminology.** Rename `is_owner` → "super_admin" in UI copy? Non-blocking.
7. **Merge endpoint in phase 1 or phase 2.** Phase 2.
8. **Brand move during active run.** Block, queue, or allow-with-risk? Recommend block for phase 1.
9. **Archive target configurability.** Phase 1 hard-codes "primary super-admin's first team". Phase 2 may expose a setting.

## 10. Critical files

- `src/routes/teams.ts` — delete (archive flow), rename, members, invitations CRUD.
- `src/routes/admin.ts` — admin teams CRUD, account `is_owner` toggle, archive view, deletion history.
- `src/routes/auth.ts` — anonymous `/api/invitations/:token` and `/api/invitations/accept`, session creation on acceptance.
- `src/services/archive.ts` (new) — `getArchiveTeamId`, `deleteTeamArchiveFlow`, KV rekey loop.
- `src/services/magic-link.ts` — extended or mirrored for invitation-email sending.
- `public/admin.html` — Teams section, archive UI, invitations drawer.
- `public/team.html` — invite-by-email, pending-invitations list.
- `public/invite.html` (new) — anonymous acceptance landing page.
- `migrations/006_team_roles_and_archive.sql` (new) — see §8 Phase 1 step 1.
- `migrations/002_accounts.sql` — reference schema for the new migration.
