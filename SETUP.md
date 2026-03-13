# AEO — Setup Guide

## Prerequisites

- Node.js 18+
- A Cloudflare account (free tier works) — [dash.cloudflare.com](https://dash.cloudflare.com)
- API keys for:
  - [Anthropic (Claude)](https://console.anthropic.com/settings/keys)
  - [OpenAI (ChatGPT)](https://platform.openai.com/api-keys)
  - [Google AI (Gemini)](https://aistudio.google.com/app/apikey)

---

## Step 1 — Install dependencies

```bash
cd /Users/julienpalliere/AEO
npm install
```

---

## Step 2 — Authenticate Wrangler

```bash
npx wrangler login
```

This opens a browser window. Log in with your Cloudflare account.

---

## Step 3 — Create the D1 database

```bash
npm run db:create
```

Copy the `database_id` from the output and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "aeo-db"
database_id = "PASTE_YOUR_ID_HERE"   # ← replace this
```

---

## Step 4 — Create the KV namespace

```bash
npm run kv:create
```

Copy the `id` from the output and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "PASTE_YOUR_ID_HERE"   # ← replace this
```

---

## Step 5 — Run the DB migration (local)

```bash
npm run db:migrate
```

---

## Step 6 — Set API key secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GOOGLE_AI_API_KEY
```

Each command prompts you to paste the key. These are stored encrypted in Cloudflare — never in your code.

For **local development**, create a `.dev.vars` file (git-ignored):

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_AI_API_KEY=AIza...
```

---

## Step 7 — Run locally

```bash
npm run dev
```

Open [http://localhost:8787](http://localhost:8787)

---

## Step 8 — Deploy to Cloudflare

First, migrate the remote database:

```bash
npm run db:migrate:remote
```

Then deploy:

```bash
npm run deploy
```

Your app will be live at `https://aeo.<your-subdomain>.workers.dev`

---

## Troubleshooting

**"Could not fetch [url]"** — The brand URL may be blocking bots. Try a simpler URL or check that the site is publicly accessible.

**LLM API errors** — Double-check your secret keys with `npx wrangler secret list`.

**Run stuck on "querying"** — The client polls `/api/runs/:id/process` every 1.5s. If it stops, refresh `run.html` — it will resume from where it left off.
