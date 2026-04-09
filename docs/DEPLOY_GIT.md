# Deployment via Git (Cloudflare)

Production deploys use **two separate GitHub repositories**, each connected in the Cloudflare dashboard. You **push** to Git; Cloudflare runs the build and deploy—you do **not** need `npm run deploy` / `wrangler deploy` from your laptop for routine releases.

| GitHub repo | Cloudflare project | Product | What runs on push |
|-------------|-------------------|---------|-------------------|
| **[jjpalliere/aeo](https://github.com/jjpalliere/aeo)** | `aeo` (Worker) | Workers Builds | `npx wrangler deploy` |
| **[jjpalliere/Similarity-Browser](https://github.com/jjpalliere/Similarity-Browser)** | `similarity-browser` (Pages) | Pages | Root `frontend/`, `npm run build` → `dist` |

---

## AEO (`terrain.run` / custom domain)

1. **Workers & Pages** → Worker **`aeo`** → **Settings** → Git / Workers Builds.
2. Repository: **`jjpalliere/aeo`**, production branch (e.g. `main`).
3. Deploy command: **`npx wrangler deploy`** (matches local `npm run deploy`).
4. Root directory: **`/`** (repo root).

**Still manual when you change the database:** D1 migrations are not automatic. After schema changes, run remote migration commands (see [SETUP.md](./SETUP.md) and [docs/README.md](./README.md)) before or after deploy as documented.

---

## Similarity Browser (`similarity-browser.pages.dev`)

1. **Workers & Pages** → **`similarity-browser`** → **Settings** → **Pages configuration** (or **Builds & deployments**).
2. Connect **`jjpalliere/Similarity-Browser`** (the **`frontend/`** app lives in that repo).
3. **Root directory:** `frontend` (if the app lives there).
4. **Build command:** e.g. `npm run build` (or `npm ci && npm run build`).
5. **Build output:** `dist` (see `frontend/wrangler.toml` → `pages_build_output_dir`).

AEO’s **`public/similarity.html`** iframe loads **`https://similarity-browser.pages.dev`**; updating the Similarity repo updates what users see in the terrain tab after Pages finishes deploying.

---

## Optional: GitHub Actions in this repo

If `.github/workflows/deploy.yml` exists, it also deploys on push. **Either** use **Cloudflare Git** (above) **or** Actions—not both—or you risk double deploys. Remove or disable the workflow if you rely only on the dashboard.

---

## Manual deploy (fallback)

```bash
# AEO (repo root)
npm run deploy

# Similarity (from frontend/)
cd frontend && npm run build && npx wrangler pages deploy dist
```

Use when debugging CI or before Git is connected.
