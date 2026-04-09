# Add Similarity tab to terrain.run sidebar

## Context
The Similarity Browser is a 3D visualization tool for hierarchical text clustering, deployed at `similarity-browser.pages.dev` (Cloudflare Pages + KV). It reads runs from KV and renders them as interactive 3D scatter plots. The user wants it as a tab in AEO's sidebar, with runs mapped to specific AEO brands (manual mapping via admin).

**Deploy:** This app’s Git repo should be connected to the **`similarity-browser`** Cloudflare Pages project (see `DEPLOY.md` in this repo and `docs/DEPLOY_GIT.md` in the AEO repo).

## Plan

### 1. Add D1 migration for brand↔run mapping
**New file**: `migrations/005_similarity_runs.sql`

```sql
CREATE TABLE IF NOT EXISTS similarity_runs (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  run_id TEXT NOT NULL,        -- run_id in Similarity KV
  label TEXT NOT NULL,         -- display name (e.g. "C5 Customer Service Bot")
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(brand_id, run_id)
);
```

> **Note**: No `team_id` column — derive team via `brands.team_id` in queries/middleware. Avoids duplication and sync issues.

### 2. Add API routes for mapping runs to brands
**New file**: `src/routes/similarity.ts`

All routes use the same brand/team scoping as `/api/brands` — reject `brand_id` not in the caller's active team (via `c.get('teamId')` from session middleware).

- `GET /api/similarity/runs` — list mapped runs for active brand
- `POST /api/similarity/runs` — create mapping (brand_id, run_id, label). Owner-only.
- `DELETE /api/similarity/runs/:id` — remove mapping. Owner-only.
- `GET /api/similarity/available-runs` — read directly from SIMILARITY_KV to list all runs in the KV namespace (so admin can pick which to map)

### 3. Register route in `src/index.ts`
```typescript
import { similarity } from './routes/similarity'
app.route('/api/similarity', similarity)
```

### 4. Add "Similarity" nav item to sidebar
**File**: `public/assets/sidebar.js` — add nav item in primary section

### 5. Create `public/similarity.html`
Page with auth + sidebar + main content area that:
- Fetches mapped runs for the active brand from `/api/similarity/runs`
- Shows a list of available runs for this brand
- When user clicks a run, loads the Similarity Browser iframe with `?run={run_id}` param (or directly loads the run)
- If no runs mapped, shows "No similarity analyses for this brand"

The iframe points to `https://similarity-browser.pages.dev/` and we pass the run_id context to auto-load.

### 6. Add KV binding for Similarity
**File**: `wrangler.toml` — add the Similarity KV namespace as a second binding so the Worker can read runs directly.

```toml
[[kv_namespaces]]
binding = "SIMILARITY_KV"
id = "942017366eb249cf99ab89efff1084e4"
```

### 7. Iframe / CSP prerequisite
Before this plan can work, confirm `similarity-browser.pages.dev` allows embedding via `frame-ancestors`. If the Pages app sends a restrictive CSP or `X-Frame-Options`, update its response headers (via `_headers` file in the Pages project) to allow `frame-ancestors https://terrain.run`.

### Admin UI scope (v1)
v1 is **API + curl only** for managing mappings. No admin UI changes. A dedicated admin page or settings panel for mapping runs to brands can be added in v2.

### Files to create/modify
| File | Action |
|------|--------|
| `migrations/005_similarity_runs.sql` | Create — mapping table |
| `src/routes/similarity.ts` | Create — API routes (scoped to active team) |
| `src/index.ts` | Modify — register similarity route |
| `wrangler.toml` | Modify — add SIMILARITY_KV binding |
| `src/types.ts` | Modify — add SIMILARITY_KV to Env type |
| `public/assets/sidebar.js` | Modify — add nav item |
| `public/similarity.html` | Create — page with run list + iframe |

### Verification
1. Run migration locally: `wrangler d1 execute aeo-db --local --file=./migrations/005_similarity_runs.sql`
2. `npm run dev` → log in → sidebar shows "Similarity" tab
3. Click it → shows "No analyses" for brands without mappings
4. Map a run via curl: `curl -X POST /api/similarity/runs -d '{"brand_id":"...","run_id":"...","label":"..."}'`
5. Refresh → run appears, click loads iframe with visualization
6. Confirm iframe loads without CSP errors
