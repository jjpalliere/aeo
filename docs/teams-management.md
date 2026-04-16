# Teams Management Plan

**Status:** Planning doc. No code yet.

## Executive summary

The single global owner (`is_owner=1`) has no admin-portal teams UI, and users end up with multiple auto-created "Personal" teams across emails. Ship: keep `is_owner` as global super-admin, add a per-team `role` column so team creators implicitly manage their own team, build a "Teams" admin section for list/create/rename/delete/member-manage/move-brand, and add a lightweight sidebar team switcher. Defer full RBAC.

## 1. Permission model

**Two-tier, minimal per-team signal.**

- **Global:** keep `accounts.is_owner` (conceptually "super-admin") — sees/acts on every team, admin portal, cross-team actions.
- **Per-team:** add `team_members.role TEXT NOT NULL DEFAULT 'member'` with `'admin' | 'member'`. On team creation, creator becomes `'admin'`. `teams.created_by` kept as historical pointer; permissions derive from `role`.
- **Non-owner team admins** can rename, rotate invite code, kick, promote/demote, delete their own team (if empty or with typed-name cascade confirm).
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
Row actions: View members, Rename, Delete, Copy/rotate invite code.

### 2b. Create
Inline form: Name + optional "Assign to user" email (defaults to super-admin). `POST /api/admin/teams`.

### 2c. Rename
Inline edit → `PATCH /api/teams/:id`.

### 2d. Delete — cascade policy
Modal with three choices:
- **Move brands first** (default). Dropdown target team; server moves brands → deletes team.
- **Delete with all brands** (full cascade). Requires typing team name. Reuses brand-delete cascade (runs, queries, mentions, citations, prompts, personas, similarity_runs, KV).
- **Cancel.**

Teams with brands cannot be silently orphaned.

### 2e. Members panel
Lists members with role pill, join date, actions:
- **Promote / Demote** (toggle `role`).
- **Remove** (kick; blocked if last admin with other members — must promote first).
- **Add member by email** (dropdown of existing accounts + free-form; super-admin only here).

### 2f. Move brand between teams
Modal with target dropdown → `PATCH /api/admin/brands/:id/team`. Server updates `brands.team_id`, cascades to `runs.team_id`, `prompts.team_id`, `personas.team_id`, rewrites KV keys.

### 2g. is_owner toggle
Accounts section gets per-row toggle → `PATCH /api/admin/accounts/:id`. Guard: cannot remove self's last super-admin status.

## 3. Team switcher for the user

**Add to sidebar, above the brand switcher, reusing `sb-brand-switcher` pattern.**
- Render only when user belongs to ≥ 2 teams.
- Select → `PUT /api/auth/active { team_id }` → resets `active_brand_id` to first brand in new team.
- After switch, `sidebar.js` refetches `/api/auth/me` + `/api/brands` and re-renders.

### /team.html
Stays as per-active-team management: invite code (rotatable), member list, leave, and for team admins: rename/kick/promote/add-by-email.

### Session fix-ups
When a team is deleted or user is kicked from their current `active_team_id`, server sets `active_team_id` to any remaining team (or `null`). Mirrors the existing `active_brand_id` fix-up pattern.

## 4. API endpoints

All require valid session. `/api/admin/*` enforces `is_owner`. Team-scoped endpoints check `is_owner` OR `team_members.role='admin'` via `requireTeamAdmin(c, teamId)`.

| Method | Path | Auth | Body | Purpose |
|---|---|---|---|---|
| PATCH | `/api/teams/:id` | team admin or owner | `{ name? }` | Rename |
| DELETE | `/api/teams/:id` | team admin or owner | `{ cascade: 'move'\|'delete', moveBrandsTo? }` | Delete |
| POST | `/api/teams/:id/rotate-invite` | team admin or owner | — | New code, old invalid |
| POST | `/api/teams/:id/members` | team admin or owner | `{ email, role? }` | Add by email |
| DELETE | `/api/teams/:id/members/:accountId` | team admin or owner | — | Kick |
| PATCH | `/api/teams/:id/members/:accountId` | team admin or owner | `{ role }` | Promote/demote |
| PATCH | `/api/brands/:id/team` | owner only (MVP) | `{ team_id }` | Move brand |
| GET | `/api/admin/teams` | owner | — | All teams with counts |
| POST | `/api/admin/teams` | owner | `{ name, assigneeEmail? }` | Create on behalf |
| PATCH | `/api/admin/accounts/:id` | owner | `{ is_owner }` | Toggle super-admin |
| GET | `/api/admin/teams/:id/members` | owner | — | Any team's members |

Phase-2 extra: `POST /api/admin/teams/:id/merge { intoTeamId }` — one-click consolidation.

## 5. Schema changes

```sql
ALTER TABLE team_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
UPDATE team_members
  SET role = 'admin'
  WHERE account_id IN (
    SELECT created_by FROM teams WHERE teams.id = team_members.team_id
  );
```

Cascade integrity: keep cascades in code (D1 lacks easy FK alter). New helper `deleteTeamCascade(teamId)`:
1. Delete `team_members` for team.
2. For each brand: run existing brand-delete cascade.
3. Delete `teams.id`.
4. Fix up `sessions.active_team_id` / `active_brand_id`.

Optional phase-2: `teams.archived_at TIMESTAMP` for soft delete; `teams.invite_code_expires_at`.

## 6. Edge cases

| Case | Decision |
|---|---|
| Team deletion with brands | Move-first (default) or typed-name cascade delete. Never orphan. |
| Self-kick | Short-circuit to existing `/leave` code. |
| Last admin kicked/demoted | Reject unless another admin exists. Super-admin bypasses. |
| Last member leaves team | Cannot leave (existing). Owner can delete team outright. |
| User with zero teams | Allowed. Route to "No teams" screen at `/team.html`. |
| Removing last super-admin | Reject if there's only one `is_owner=1` account. |
| Invite rotation | Phase 2. Immediate invalidation. |
| Brand move: runs, KV? | Update `runs.team_id`, `prompts.team_id`, `personas.team_id`; rewrite KV `{teamId}:logs:{brandId}` etc. Block move if in-flight run. |
| Multiple personal teams | Move brands → delete empty teams. Phase-2 merge for one-click. |
| Race: two admins kick each other | Transactional check in UPDATE guards against zero-admin state. |
| Session cache after role change | No cache — middleware re-checks on every request. |

## 7. Phased implementation

### Phase 1 — MVP (unblocks user)

1. Migration `006_team_roles.sql` — add column + backfill.
2. `src/middleware/teamAdmin.ts` — `requireTeamAdmin` helper.
3. Expand `src/routes/teams.ts`: PATCH, DELETE, rotate-invite, members add/kick/promote.
4. New `src/routes/admin.ts` routes: `GET/POST /api/admin/teams`, `GET /api/admin/teams/:id/members`, `PATCH /api/admin/accounts/:id`.
5. `PATCH /api/brands/:id/team` in `src/routes/brands.ts` or `admin.ts`.
6. `public/admin.html` — Teams section (list, rename inline, create, delete modal, members accordion, move-brand).
7. Session fix-ups on delete/kick.

Complexity: **Medium**. ~600-900 LOC. Biggest risk: brand-move KV rekey — gate behind "no active run".

### Phase 2 — polish

- Sidebar team switcher in `sidebar.js`.
- `/team.html` editing UI for team admins (reuses phase-1 endpoints).
- `POST /api/admin/teams/:id/merge`.
- Rotatable/expirable invite codes.
- Soft-delete (`archived_at`).
- `team_audit_log` table.
- Background job for brand moves during active runs.

Complexity: small-to-medium per item, independent.

### Phase 3 — deferred

Multi-level roles (`billing`, `viewer`). Per-brand permissions. Team-scoped API keys.

## 8. Open questions

1. **Team admin delete authority.** Can non-owner team admins delete their own team with cascade? Default: yes, typed confirm.
2. **Cross-team brand move for team admins.** Owner-only in MVP, or enable team admins immediately?
3. **Personal team on signup.** Keep auto-creating, or add to an existing team instead?
4. **Email notification on add-by-email.** Silent or "you were added to X"?
5. **"Owner" terminology.** Rename `is_owner` → "super_admin" in UI copy?
6. **Merge endpoint in phase 1 or phase 2.**
7. **Brand move during active run.** Block, queue, or allow-with-risk? Recommend block for phase 1.

## 9. Critical files

- `src/routes/teams.ts`
- `src/routes/admin.ts`
- `src/routes/brands.ts`
- `public/admin.html`
- `migrations/002_accounts.sql` (reference for new `006_team_roles.sql`)
