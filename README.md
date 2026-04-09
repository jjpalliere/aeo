# AEO — Answer Engine Optimization

Audit how AI assistants (Claude, ChatGPT, Gemini) rank and cite your brand vs competitors across search-style queries.

**📖 [Documentation →](./docs/README.md)** — File-by-file docs from the codebase.  
**🔧 [Setup Guide →](./docs/SETUP.md)** — Step-by-step first-time setup.  
**🚀 [Deploy via Git →](./docs/DEPLOY_GIT.md)** — Two repos (AEO + Similarity) → Cloudflare; push instead of local `npm run deploy`.

---

## Quick Start

```bash
npm install
cp .dev.vars.example .dev.vars   # add your API keys
npm run db:create                # first time only
npm run db:migrate               # local D1 schema
npm run kv:create                # optional, for run logs — update wrangler.toml
npm run dev                      # http://localhost:8787
```

1. Log in (password-protected; see auth in `src/index.ts`)
2. Add a brand (URL + domain)
3. Approve prompts & personas
4. Start a run → dashboard shows rankings, citations, competitor analysis

---

## Prerequisites

- Node 18+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (via `npm install`)
- API keys: [Anthropic](https://console.anthropic.com/settings/keys), [OpenAI](https://platform.openai.com/api-keys), [Google AI](https://aistudio.google.com/app/apikey)

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Environment

Copy `.dev.vars.example` to `.dev.vars` and add your API keys:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_AI_API_KEY=...
```

For production: `wrangler secret put ANTHROPIC_API_KEY` (etc.)

### 3. Database

```bash
npm run db:create      # creates D1 DB (first time) — paste database_id into wrangler.toml
npm run db:migrate     # apply full schema to local D1
```

For **upgrading existing databases** (schema already applied before these columns existed):

```bash
npm run db:migrate:positioning
npm run db:migrate:page_title
npm run db:migrate:persona_goals
```

### 4. KV (optional, for run logs)

```bash
npm run kv:create
```

Update `wrangler.toml` with the returned namespace ID.

---

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Local dev server (Wrangler) |
| `npm run deploy` | Deploy Worker manually (prefer [Git → Cloudflare](./docs/DEPLOY_GIT.md) in production) |
| `npm run db:create` | Create D1 database (first time) |
| `npm run db:migrate` | Apply schema to local D1 |
| `npm run db:migrate:remote` | Apply schema to remote D1 |
| `npm run db:migrate:positioning` | Add positioning column (upgrade only) |
| `npm run db:migrate:page_title` | Add page_title to citations (upgrade only) |
| `npm run db:migrate:persona_goals` | Add persona goals/pain_points (upgrade only) |
| `npm run kv:create` | Create KV namespace for run logs |

---

## Project Structure

```
AEO/
├── public/           # Static HTML (index, login, approve, run, dashboard, live)
├── src/
│   ├── index.ts     # Hono app, auth, routes
│   ├── routes/      # brands, prompts, personas, runs, assistant
│   ├── services/    # llm, citation, analyzer, generator, scraper
│   └── types.ts
├── docs/            # File-by-file documentation
├── schema.sql       # D1 schema
├── migrations/      # Incremental migrations (upgrade only)
└── wrangler.toml    # Cloudflare config
```
