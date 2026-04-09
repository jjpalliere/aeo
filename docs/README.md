# AEO Documentation

[← Project root](../README.md)

Technical documentation for the AEO (Answer Engine Optimization) codebase. Use this as a reference when developing, debugging, or extending the system.

---

## Contents

0. **[Deployment (Git + Cloudflare)](./DEPLOY_GIT.md)** — Two repos; push instead of local `wrangler deploy`
1. [Introduction](#introduction)
2. [System Overview](#system-overview)
3. [Key Concepts](#key-concepts)
4. [User Workflow](#user-workflow)
5. [Data Flow](#data-flow)
6. [Database](#database)
7. [LLM Instructions](#llm-instructions)
8. [API Reference](#api-reference)
9. [File-by-File Reference](#file-by-file-reference)

---

## Introduction

AEO audits how AI assistants (Claude, ChatGPT, Gemini) rank and cite your brand versus competitors across search-style queries. It simulates real user questions, sends them to each LLM with web search enabled, and analyzes which brands get mentioned, in what order, and how they’re positioned.

**Audience:** Developers working on the codebase, contributors, or anyone needing to understand internals.

**Stack:** Hono on Cloudflare Workers, D1 (SQLite), KV, static HTML frontend. LLM APIs: Anthropic, OpenAI, Google AI.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AEO Application                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  public/ (static)          src/ (Hono API)                                   │
│  ├── index.html     ──►    index.ts (auth, routing)                          │
│  ├── login.html            ├── routes/                                       │
│  ├── approve.html           │   ├── brands.ts   (CRUD, scrape, generate)      │
│  ├── run.html               │   ├── prompts.ts  (approve, edit)               │
│  ├── dashboard.html         │   ├── personas.ts (approve, edit)              │
│  ├── live.html              │   ├── runs.ts     (lifecycle, process, results) │
│  └── assets/                │   └── assistant.ts (Q&A over run data)         │
│                              └── services/                                   │
│                                  ├── scraper.ts   (crawl brand site)          │
│                                  ├── citation.ts  (fetch & classify URLs)    │
│                                  ├── llm.ts       (Claude/ChatGPT/Gemini)     │
│                                  ├── generator.ts (personas, prompts, LLM)   │
│                                  └── analyzer.ts  (brand mentions, reclassify)│
├─────────────────────────────────────────────────────────────────────────────┤
│  D1 (schema.sql)           KV                                                │
│  brands, prompts, personas  progress:{id}, logs:{id}, logs:run:{id},          │
│  runs, queries, citations   lock:process:{runId}, error:{id}                   │
│  brand_mentions                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Request flow:** Browser → Hono API → D1/KV/LLM APIs. Static pages are served via ASSETS binding; `/api/*` routes are protected by auth.

---

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Brand** | The company/product being audited. Has a URL, domain, name (LLM-extracted during persona generation), scraped content (or pasted text), and status. Must reach `ready` before runs. |
| **Persona** | A target-audience profile (name, description, goals, pain points, system message). Used to shape how each prompt is asked. |
| **Prompt** | A search-style question (e.g. “What’s the best CRM for startups?”). Has a funnel stage: `tofu`, `mofu`, `bofu`. |
| **Run** | One audit execution. Creates N queries (prompts × personas × 3 LLMs), runs them, scrapes citations, analyzes brand mentions. |
| **Query** | A single LLM call: one prompt + one persona + one LLM. Produces `response_text` and `citations`. |
| **Citation** | A URL cited by the LLM. Classified as `owned`, `competitor`, `news`, `industry`, or `unknown`. |
| **Brand mention** | A brand name extracted from the response, with rank, positioning, and context snippet. Written inline during querying (after each fulfilled query) and re-extracted in batch during the analyzing phase. |

**Funnel stages:** `tofu` (top of funnel, awareness), `mofu` (middle, consideration), `bofu` (bottom, decision).

**Source types:** `owned` = your domain; `competitor` = known competitor; `news` = reuters, bloomberg, etc.; `industry` = industry sites; `unknown` = unclassified (analyzer may reclassify).

---

## User Workflow

1. **Login** → `login.html` → POST `/api/auth` with password → cookie set.
2. **Add brand** → `index.html` → POST `/api/brands` with URL or pasted text.
   - Standard: scrape site → generate personas → user approves → generate prompts.
   - Quick-start: create brand + prompts + personas in one shot (no scrape).
   - Predict: paste text only → generate personas.
3. **Approve** → `approve.html` → PATCH prompts/personas, approve all. Brand becomes `ready`.
4. **Start run** → `run.html` → POST `/api/runs` → client polls `/api/runs/:id/process` every 1.5s.
5. **Monitor** → `live.html` shows live responses; `dashboard.html` shows results when complete.
6. **Ask assistant** → POST `/api/assistant` with `run_id` and `question` for natural-language Q&A over run data.

---

## Data Flow

### Brand setup

```
URL / pasted text
    → scraper.ts (scrapeSite) or pasted content
    → ScrapedContent (pages, summary, brand_name, industry_keywords)
    → generator.ts (generatePersonas)
        → returns { personas, brand_name } — LLM extracts actual brand name (not taglines)
        → brands.name updated with extracted brand_name
    → personas table
    → generator.ts (generatePrompts) — uses brands.name for brand context
    → prompts table
    → user approves
    → brand.status = 'ready'
```

**Brand name:** The scraper provides an initial `brand_name` (page title or domain). During persona generation, the LLM extracts the actual company name from the content (e.g. "Column Five Media" vs "B2B Marketing Agency for SaaS Companies"). The caller updates `brands.name`; downstream flows (prompts, runs, analyzer) use this value.

### Run execution

```
POST /api/runs
    → run created (status: pending)
    → POST /api/runs/:id/process (self-scheduled)

pending:
    → Create queries = prompts × personas × [claude, chatgpt, gemini]
    → status = querying

querying (batches of 3):
    → llm.ts (queryLLM) → response_text + citation URLs
    → citation.ts (scrapeCitation) per URL → INSERT citations
    → extractBrandMentions per fulfilled query → INSERT brand_mentions (inline, populates Competitors tab during run)
    → When no pending left → status = analyzing

analyzing:
    → analyzer.ts (analyzeRun)
        → Reclassify unknown citations using competitor hints
        → DELETE brand_mentions for run, extractBrandMentions per complete query → batch INSERT (re-extraction)
    → status = complete
```

### Results

- **GET /api/runs/:id/results** — Full analytics: rankings by LLM, competitor detail, top positionings.
- **GET /api/runs/:id/partial** — Same structure for in-progress runs.
- **GET /api/runs/:id/live-responses** — Raw responses grouped by LLM.

---

## Database

AEO uses a **single D1 (SQLite) database** for all data. One file holds all brands, runs, queries, citations, and brand mentions.

### Single file, multiple brands

- **One database** — All brands and runs live in the same file. Wrangler binds one D1 database (`aeo-db`).
- **Data size** — The file grows with more runs and brands. Each run stores full LLM responses and scraped citation text. SQLite handles large files well; consider archiving or deleting old runs if size becomes an issue.
- **Brand isolation** — Brands are logically separated by `brand_id`. No cross-brand data is mixed unless you explicitly query across brands.

### IDs and relationships

| ID | How it's created | Notes |
|----|-------------------|-------|
| **brand_id** | `crypto.randomUUID()` when you create a brand | Not derived from domain. Same domain added twice = two different brands. |
| **run_id** | `crypto.randomUUID()` when you create a run | Each run belongs to one brand. |
| **query_id** | `crypto.randomUUID()` when the run creates queries | One per (prompt × persona × LLM). |

### Same domain, multiple runs

- **One brand** → you create it once, approve prompts/personas.
- **Multiple runs** → each run creates new rows in `runs`, `queries`, `citations`, `brand_mentions` with the **same** `brand_id`.
- All runs for a brand share that brand; the sidebar shows them via `/api/runs/:id/siblings`.

### Same domain, multiple brands

- If you add the same domain again as a new brand (e.g. another “Add brand” for `example.com`), you get a **new** brand with a new random UUID.
- No deduplication by domain — each “Add brand” creates a separate brand.

### Switching databases

- The UI **cannot** switch which database file the server uses. The server is configured with one D1 binding.
- To use a different `.sqlite` file (e.g. a backup), you'd change wrangler config and restart the server.

### Deploy vs. database migrations

**Deploy** (`npx wrangler deploy`) updates the Worker code only. It does **not** change the D1 database.

**Migrations** must be run separately. Local (wrangler dev) and remote (deployed) use different D1 instances:

| Environment | Command | When |
|-------------|---------|------|
| Local | `npm run db:migrate` | After pulling schema changes; `--local` for migrations |
| Remote | `npm run db:migrate:remote` | After deploying; run `wrangler d1 execute aeo-db --remote --file=./migrations/...` for each migration |

If the remote DB is missing columns (e.g. `page_title`, `positioning`), the dashboard will return 500. The API surfaces DB errors in the response body for debugging.

### Migrations (additive only)

| File | Adds |
|------|------|
| `migrations/0002_add_positioning.sql` | `brand_mentions.positioning` |
| `migrations/0003_add_page_title.sql` | `citations.page_title` |
| `migrations/0004_add_persona_goals_pain_points.sql` | `personas.goals`, `personas.pain_points` |

Run on existing DBs: `npx wrangler d1 execute aeo-db --remote --file=./migrations/0002_add_positioning.sql` (etc.). "Duplicate column" means already applied.

### URL analyze flow (avoiding 30s waitUntil limit)

Cloudflare `waitUntil` has a 30s wall-clock limit. Scrape + persona generation can exceed that, causing the worker to be killed at "Identifying buyer archetypes". The fix: POST /api/brands returns immediately; the approve page calls POST /api/brands/:id/continue when it sees status `scraping`. That request runs scrape + generatePersonas in the main request (no limit). The approve page polls for logs and status.

### Secrets (production)

LLM API keys are set as Cloudflare secrets, not in code. For production: `npx wrangler secret put ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`. Local dev uses `.dev.vars` (gitignored).

---

## LLM Instructions

All prompts and system messages sent to LLMs (OpenAI, Anthropic, Google AI). Use this when tuning extraction quality, debugging rank/positioning issues, or extending generation logic.

### How the AI is instructed (no training)

AEO does **not** train or fine-tune any models. It uses pre-trained LLMs (Claude, ChatGPT, Gemini) via their APIs, with carefully designed instructions. The "training" is entirely **prompt engineering** and **structured output**:

1. **System message** — Sets the model's role and expertise (e.g. "You are an expert in user research and customer profiling"). This primes the model for the task without changing its weights.

2. **User message** — Contains the task, context (scraped content, personas, etc.), and explicit rules. The more specific the instructions, the more consistent the output.

3. **Tool / function calling** — Instead of asking for free-form JSON (which can drift or hallucinate), we use each provider's tool-calling API. The model is forced to call a function with arguments that conform to a JSON schema. This guarantees structured output (e.g. `submit_personas` with `personas[]` and `brand_name`).

4. **Examples and constraints** — We include inline examples (e.g. `system_message` format), enum constraints (e.g. `funnel_stage: tofu | mofu | bofu`), and anti-patterns (e.g. "Do not return taglines — return the actual company name").

5. **Context injection** — Brand content, personas, and supplement text are injected into the user message so the model grounds its output in the provided data rather than generic knowledge.

**Key files:** `generator.ts` (personas, prompts, classification, brand mention extraction), `llm.ts` (query execution). To change behavior, edit the system/user strings and tool schemas in `generator.ts`.

### 1. Persona generation — `generatePersonas` (generator.ts)

**Model:** gpt-4o  
**When:** Brand creation (after scrape or pasted text), proceed-blocked, supplement.

**System:**
```
You are an expert in user research and customer profiling.
You create realistic buyer personas for B2B and B2C products.
```

**User (template):**
```
Based on this brand's website, generate between 3 and 5 distinct user personas who would realistically use or buy this product/service. Generate as many as the site content meaningfully supports — 3 if the audience is narrow and focused, up to 5 if there are clearly distinct buyer types with different goals, roles, or contexts. Do not pad with redundant personas.

The site title or domain suggests: {brand_name}
Website summary:
{summary}
{supplementSection}

For each persona provide:
- description: 2-3 sentences on who they are, their role and day-to-day context
- goals: 3-5 specific professional goals they are actively trying to achieve (concrete, not generic)
- pain_points: 3-5 specific frustrations or blockers they face (concrete, not generic)
- system_message: frames the AI assistant as this persona's personal assistant

Example system_message format:
"You are a helpful AI assistant. The user is a [role] at a [company type]. They are [goals/context]. Help them find the best solutions for [specific needs]."

Call the submit_personas tool with your personas.
```

---

### 2. Prompt generation — `generatePrompts` (generator.ts)

**Model:** gpt-4o  
**When:** After user clicks "Generate Questions" on approve.

**System:**
```
You are an expert in buyer psychology and AI search behavior.
Your job is to generate the real questions that people ask AI assistants at different stages of purchase readiness.
Questions must emerge from the specific content and context provided — not from generic templates.
```

**User (template):**
```
Based on this brand's website content, generate exactly 20 questions that people would ask an AI assistant at different stages of buyer readiness.

Brand name: {brand_name}
Website content:
{summary}
{supplementSection}
{personasSection}

Distribute across three buyer readiness stages:

TOFU — 7 questions (problem-aware, solution-unaware)
These come from someone who experiences the problem or need this brand addresses, but has no knowledge of this brand or what category of solution to look for. They are trying to understand their situation or discover what kind of help exists.

MOFU — 7 questions (solution-aware, actively evaluating)
These come from someone who knows solutions in this category exist and is actively comparing or assessing fit. They are trying to understand trade-offs, capabilities, and differences between approaches.

BOFU — 6 questions (decided, seeking final fit)
These come from someone who has essentially decided they want this type of solution and is looking for validation of fit for their specific situation.

Rules:
- Do not anchor to any particular phrasing pattern. Let each question emerge naturally.
- Questions must feel like something a real person would type — not marketing copy.
- Never mention the brand name in any question.
- For each question, include a 1-sentence rationale citing the specific site content or audience context.

Call the submit_prompts tool with your 20 questions.
```

---

### 3. Prompt classification — `classifyPrompts` (generator.ts)

**Model:** claude-haiku-4-5  
**When:** User pastes prompts and clicks "Classify & Preview" in Import panel.

**System:**
```
You are an expert in buyer psychology and AEO (Answer Engine Optimization).
```

**User (template):**
```
Classify each of these imported prompts. For each prompt, do three things:

1. Assign a funnel stage:
   - tofu: broad awareness or education (what is X, how does X work, understanding a problem)
   - mofu: consideration or evaluation (comparing options, assessing fit, how to choose)
   - bofu: high purchase intent (pricing, demos, specific use case fit, vendor selection)

2. Check relevance: Is this prompt relevant to the brand being audited and its audience? If clearly off-topic, set keep=false.

3. Check similarity: Is this prompt substantially covered by an existing prompt already in the system? If the meaning is nearly identical, set keep=false.

Set keep=true if the prompt is both relevant and distinct. Set keep=false and explain why in filter_reason if not.
{brandSection}
{existingSection}

Prompts to classify:
{texts}

Call the submit_classifications tool with your classifications in the same order as the input.
```

---

### 4. Brand mention extraction — `extractBrandMentions` (generator.ts)

**Model:** gpt-4o-mini  
**When:** During querying (inline after each fulfilled query) and during analyzing (re-extraction).

**System:**
```
You extract brand and competitor mentions from AI assistant responses. Output only actual company or brand names — NOT roles (Founders, Engineers), concepts (Knowledge Transfer, Scalability), or services (Initial Consultation). The target brand is: "{targetBrandName}". Mark is_target=true for that brand (including short forms like "Column Five" for "Column Five Media"). For each mention, provide: (1) a positioning field of up to 2 sentences — sentence 1: overview of how the response characterizes this brand; sentence 2: the niche or segment targeted; (2) a context_snippet of ~80 chars of surrounding text showing exactly where in the response the brand appears. IMPORTANT: if a brand does not appear in the response text, do not include it. If no brands are mentioned at all, call submit_mentions with an empty array.

CRITICAL — rank field: rank = order of first appearance in the response text. 1 = first brand named, 2 = second, 3 = third, etc. Scan the response from top to bottom and assign ranks strictly by where each brand first appears. Do NOT assume the target brand is #1. If the target appears 5th in a list, rank=5.
```

**User (template):**
```
Target brand: {targetBrandName}
{Known competitors to look for (extract if mentioned): ...}

Response to analyze:
---
{truncated response}
---

Extract all brand/competitor mentions in order of first appearance. Assign rank strictly by position in the text: 1 = first brand named, 2 = second, etc. Only include brands that are explicitly named. Call the submit_mentions tool.
```

**Post-processing:** (1) Target mentions without `context_snippet` are dropped (hallucination guard). (2) Duplicate brand mentions per query are deduped — one mention per brand, keeping the one with lowest rank (first appearance).

---

### 5. AEO analyst assistant — `assistant.ts`

**Model:** claude-sonnet-4-6  
**When:** User asks a question in the AI Chat tab on the dashboard.

**System (template):**
```
You are an AEO (Answer Engine Optimization) analyst assistant with access to LLM visibility data for a brand.

BRAND: {brand_name} ({brand_domain})
RUN STATUS: {status} ({completed}/{total} queries complete, {pct}%)

## Brand & Competitor Rankings
{competitorSummary}

## Top Cited Domains
{domainSummary}

## Citation Source Type Distribution
{sourceTypeSummary}

## Most Cited Owned Pages
{ownedPageSummary}

## How the Brand Is Described (sample context snippets)
{snippetSummary}

Answer the user's question based on this data. Be specific, data-driven, and actionable.
If the data doesn't support a definitive answer, say so clearly.
Focus on what the user can actually do to improve their brand's AI visibility.
```

---

### 6. Default persona (fallback)

**When:** Run is created but no personas are approved. Used as `system_message` for all queries.

```
You are a helpful AI assistant. Answer the user's question thoughtfully and accurately. Do not mention that you are an AI.
```

**Location:** `runs.ts` (DEFAULT_SYSTEM_MESSAGE), `brands.ts` (quick-start).

---

### 7. Proceed-blocked fallback (no user paste)

**When:** Scrape blocked and user chooses AI fallback instead of pasting text. The `scraped_content` passed to `generatePersonas` includes:

```
Site: {url}
Domain: {domain}

This site blocked automated scraping. Generate personas and questions using your general knowledge of this company, its industry, and the kinds of buyers it typically attracts.
```

**Location:** `brands.ts` proceed-blocked handler. Uses same `generatePersonas` as normal flow.

---

## API Reference

All `/api/*` routes require auth (cookie `aeo_auth=aeo_ok`). Exception: `POST /api/auth`.

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth` | POST | Login with `{ password }` |
| `/api/health` | GET | Health check |
| `/api/brands` | POST, GET | Create brand, list brands |
| `/api/brands/:id` | GET | Brand + prompts + personas + logs |
| `/api/brands/quick-start` | POST | Create brand + prompts + personas (no scrape) |
| `/api/brands/:id/proceed-blocked` | POST | After scrape blocked: paste text or AI fallback |
| `/api/brands/:id/generate-prompts` | POST | Generate prompts from content + personas |
| `/api/brands/:id/classify-prompts` | POST | Classify pasted prompts (no storage) |
| `/api/brands/:id/import-prompts` | POST | Bulk insert pre-classified prompts |
| `/api/brands/:id/supplement` | POST | Upload ICP text, regenerate personas |
| `/api/prompts/:id` | PATCH, DELETE | Update or delete prompt |
| `/api/prompts/approve-all/:brandId` | POST | Approve all prompts for brand |
| `/api/personas/:id` | PATCH, DELETE | Update or delete persona |
| `/api/personas/approve-all/:brandId` | POST | Approve all personas for brand |
| `/api/runs/list` | GET | List all runs (all brands), for sidebar |
| `/api/runs` | POST | Create run |
| `/api/runs/:id` | GET | Run status |
| `/api/runs/:id/logs` | GET | Run logs (KV) |
| `/api/runs/:id/process` | POST | Advance one batch (self-scheduled) |
| `/api/runs/:id/results` | GET | Full analytics |
| `/api/runs/:id/partial` | GET | Partial analytics |
| `/api/runs/:id/live-responses` | GET | Responses grouped by LLM |
| `/api/runs/:id/queries/:queryId/response` | GET | Single query response |
| `/api/runs/:id/cancel` | POST | Abort run |
| `/api/runs/:id/siblings` | GET | Other runs for same brand |
| `/api/runs/:id` | DELETE | Cascade delete run |
| `/api/assistant` | POST | Q&A over run data |

---

## File-by-File Reference

### src/types.ts

Defines shared types and the `Env` binding.

**Env:** `DB` (D1), `KV`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`, `ASSETS`.

**Entities:** `Brand`, `ScrapedPage`, `ScrapedContent`, `Prompt`, `Persona`, `Run`, `Query`, `Citation`, `BrandMention`, `ProcessResult`, `LLMApiKeys`.

**Run status:** `pending` | `querying` | `scraping` | `analyzing` | `complete` | `failed`.

**Query status:** `pending` | `processing` | `complete` | `failed`.

**Citation source_type:** `owned` | `competitor` | `news` | `industry` | `unknown`.

---

### schema.sql

D1 schema. Tables and relationships.

| Table | Purpose |
|-------|---------|
| brands | URL, domain, scraped_content (JSON), status |
| prompts | brand_id, text, funnel_stage, approved |
| personas | brand_id, name, system_message, goals, pain_points, approved |
| runs | brand_id, status, total_queries, completed_queries |
| queries | run_id, prompt_id, persona_id, llm, response_text, status |
| citations | query_id, url, domain, page_title, company_name, source_type, scraped_ok |
| brand_mentions | query_id, brand_name, rank, is_target, context_snippet, positioning |

**Writes:** `brands` ← brands route; `prompts` ← brands/prompts; `personas` ← brands; `runs` ← runs; `queries` ← runs/process; `citations` ← runs/process (inline during querying); `brand_mentions` ← runs/process (inline after each fulfilled query) and analyzer (re-extraction at end of analyzing).

---

### src/index.ts

Hono app entry. Mounts routes, auth, CORS.

**Auth:** Cookie `aeo_auth=aeo_ok`; POST `/api/auth` with `{ password }` sets it. All `/api/*` except `/api/auth` require auth.

**Routes:** `/api/brands`, `/api/prompts`, `/api/personas`, `/api/runs`, `/api/assistant`, `/api/health`.

**Static:** Non-API requests fall through to ASSETS binding (public/).

---

### src/services/scraper.ts

Crawls a brand URL to build `ScrapedContent` for persona/prompt generation.

#### scrapeSite(startUrl, onProgress?, logFn?)

<!-- What / When / Why -->
> - **What:** Fetches homepage, extracts internal links (same-origin, path-below), crawls up to 20 pages in batches of 5. Returns `{ pages, summary, brand_name, industry_keywords }`. See table below for inputs, rules, output.
> - **When:** On brand creation (POST `/api/brands` with URL) or after scrape blocked (POST `/api/brands/:id/proceed-blocked` with pasted text). Triggered from index.html when user submits URL.
> - **Why:** This becomes the corpus that feeds persona generation. Personas appear in the **Personas** section of the approve tab; the summary also feeds the **Questions** (TOFU/MOFU/BOFU funnel columns) on approve. Progress logs stream to the terminal on approve.html.

| | |
|---|---|
| **Inputs** | `startUrl` (string) — homepage URL; optional `onProgress`, `logFn` callbacks |
| **Rules** | • Normalize URL: prepend `https://` if missing<br>• Fetch homepage first; if non-HTML, non-200, or password input detected → throw `ScrapeBlockedError`<br>• Extract internal links: same-origin, path at or below start path; skip `SKIP_EXTENSIONS` (.pdf, .jpg, etc.), `SKIP_PATHS` (/login, /admin, etc.)<br>• Prioritize links matching `/product`, `/service`, `/about`, `/pricing`, etc.<br>• Crawl in batches of 5, 800ms delay between batches; max 20 pages total<br>• Per page: extract `<title>`, `<meta name="description">` or `og:description`; prefer `<main>` or `<article>` for text; strip scripts, styles, nav, footer; max 8000 chars/page; skip if text &lt; 200 chars<br>• Dedupe by canonical URL<br>• Brand name: first part of homepage title before `|`, `-`, `:`, or domain if empty (fallback only — LLM extracts actual brand name during persona generation) |
| **Output** | `ScrapedContent`: `{ pages: ScrapedPage[], summary: string, brand_name: string, industry_keywords: [] }` — summary = concatenation of `## Title`, URL, description, text (1500 chars/page) per page |

**extractDomain(url):** Hostname without www. **ScrapeBlockedError:** Thrown when homepage blocked.

**Used by:** brands route (POST /, proceed-blocked).

---

### src/services/citation.ts

Fetches a single URL, parses HTML, classifies source type. Used during run querying.

#### scrapeCitation(url, brandDomain, knownCompetitorDomains)

<!-- What / When / Why -->
> - **What:** Fetches URL, extracts title/og:site_name, strips HTML to text, classifies source type (owned/competitor/news/unknown). Returns citation record. See table below for inputs, rules, output.
> - **When:** During run querying — inline after each LLM batch in POST `/api/runs/:id/process`. Called once per citation URL returned by the LLM.
> - **Why:** This becomes the **Citations** tab of the dashboard (citations table, domain filters, source-type badges). Each row shows Query, LLM, Source, Page Title (linked to URL), Domain. Also surfaces in the output modal when viewing a response.

| | |
|---|---|
| **Inputs** | `url` (string) — citation URL; `brandDomain` — brand’s domain; `knownCompetitorDomains` — Set of competitor domains |
| **Rules** | • Fetch with 8s timeout, follow redirects<br>• **Vertex URLs:** If URL starts with `vertexaisearch.cloud.google.com/grounding`, resolve via redirect target or HTML meta-refresh/first link<br>• Reject non-HTML content-type; reject if paywall-like (subscribe + sign in + premium + small page)<br>• Extract: `<title>`, `og:site_name`; company name = og:site_name or first part of title before `|`, `-`, `:`<br>• Text: strip scripts/styles/comments, replace tags with space, decode entities, max 6000 chars<br>• **Source classification:** `owned` if domain matches brand or is subdomain; `competitor` if domain in knownCompetitorDomains; `news` if domain in hardcoded list (reuters, bloomberg, techcrunch, etc.); else `unknown` |
| **Output** | `{ url, domain, page_title, on_page_text, company_name, source_type, scraped_ok }` — scraped_ok=1 if fetch succeeded and content extracted |

**Used by:** runs/process (inline pipeline after each LLM batch).

---

### src/services/llm.ts

Calls Claude, ChatGPT, or Gemini with a prompt; returns response text and extracted citation URLs.

#### queryLLM(llm, systemMessage, userMessage, apiKeys)

<!-- What / When / Why -->
> - **What:** Dispatches to Claude/ChatGPT/Gemini with web search enabled. Returns `{ response_text, citations }`. See table below for inputs, instructions, output.
> - **When:** During run querying — when processing a batch of 3 pending queries in POST `/api/runs/:id/process`. Client polls every 1.5s from run.html.
> - **Why:** The response text appears in the **response cards** of the Live tab (Claude/ChatGPT/Gemini columns), the **feeds** on the run tab, and the **LLM Output** modal on the dashboard when clicking a response. Citations are extracted and passed to scrapeCitation; the resulting records appear in the Citations tab.

| | |
|---|---|
| **Inputs** | `llm` — `'claude' \| 'chatgpt' \| 'gemini'`; `systemMessage` — persona system prompt; `userMessage` — the prompt text; `apiKeys` — LLMApiKeys |
| **Instructions (LLM)** | System + user passed through as-is. Each provider uses web search: Claude `web_search_20250305`, ChatGPT `web_search`, Gemini `google_search`. No extra instructions — the persona + prompt define behavior. |
| **Output** | `{ response_text: string, citations: string[] }` — citations = URLs the LLM cited |

#### Citation extraction (per provider)

| Provider | **Rules** |
|----------|-----------|
| **Claude** | From content blocks: `search_result.source`, `tool_result`/`web_search_tool_result` → `web_search_result.url`, `search_result.source`; fallback: `extractCitations(text)` |
| **ChatGPT** | From `url_citation` annotations + `web_search_call.action.sources`; fallback: `extractCitations(text)` |
| **Gemini** | From `groundingChunks[].web.uri` + title-as-domain when title looks like domain; fallback: `extractCitations(text)` |

#### extractCitations(text)

<!-- What / When / Why -->
> - **What:** Regex extraction of URLs from plain text (bare URLs, markdown links, footnote-style). Fallback when LLM doesn’t return structured citations.
> - **When:** Called by queryClaude, queryChatGPT, queryGemini after parsing the response.
> - **Why:** Ensures citation URLs are captured even when the provider’s structured format is empty; these URLs feed scrapeCitation and thus the Citations tab.

| | |
|---|---|
| **Inputs** | Plain text (LLM response) |
| **Rules** | Regex: `https?://[^\s\]"',]+` (bare URLs); `\[\d+\]:\s*(https?://...)` (footnotes); `\]\((https?://...)\)` (markdown links). Strip trailing `.,;:!?)]`. Validate with `new URL()`. Dedupe. |
| **Output** | `string[]` of unique URLs |

**Used by:** runs/process (querying phase).

---

### src/services/generator.ts

OpenAI/Claude tool-calling for structured generation and extraction.

#### generatePersonas(brand, supplement, apiKey, onProgress?, logFn?)

<!-- What / When / Why -->
> - **What:** Returns 3–5 personas plus an extracted brand name. Uses `submit_personas` tool. Also extracts the actual company/brand name from site content (avoids taglines like "B2B Marketing Agency for SaaS Companies"). See table below for inputs, instructions, output.
> - **When:** On brand creation (after scrape or pasted text), on proceed-blocked (after user pastes text), or on supplement (POST `/api/brands/:id/supplement`). Triggered from index.html or approve.html.
> - **Why:** This becomes the **Personas** section of the approve tab — the persona cards in the persona-grid, each with name, description, goals, pain points, approve checkbox.

| | |
|---|---|
| **Inputs** | `brand` — ScrapedContent (pages, summary, brand_name); `supplement` — optional ICP text from user; `apiKey` — OpenAI |
| **Instructions** | System: *"You are an expert in user research and customer profiling. You create realistic buyer personas for B2B and B2C products."* User: *"Based on this brand's website, generate 3–5 distinct personas. First extract the actual company/brand name (not taglines). For each persona: description (2–3 sentences), goals (3–5), pain_points (3–5), system_message (frames AI as personal assistant). Supplement from brand team overrides site when conflicting."* Tool: `submit_personas` — schema requires personas[], brand_name. |
| **Output** | `{ personas: GeneratedPersona[], brand_name: string }` — personas filtered to name+description+system_message present, max 5; brand_name is LLM-extracted (caller updates brands.name) |

#### generatePrompts(brand, supplement, personas, apiKey, onProgress?, logFn?)

<!-- What / When / Why -->
> - **What:** Returns up to 20 prompts with text, funnel_stage, rationale. Uses `submit_prompts` tool. See table below for inputs, instructions, output.
> - **When:** After user clicks “Generate Questions” on approve (POST `/api/brands/:id/generate-prompts`). Requires approved personas.
> - **Why:** This becomes the **Questions** section of the approve tab — the TOFU, MOFU, BOFU funnel columns with prompt cards and approve checkboxes.

| | |
|---|---|
| **Inputs** | `brand` — ScrapedContent; `supplement` — optional ICP; `personas` — `{ name, description }[]` or null |
| **Instructions** | System: *"Expert in buyer psychology and AI search behavior. Generate real questions people ask AI at different purchase stages."* User: *"Generate exactly 20 questions from site content. TOFU: 7 (problem-aware); MOFU: 7 (solution-aware, evaluating); BOFU: 6 (decided, validation). Never mention brand name. Each needs rationale citing site content."* Tool: `submit_prompts` — text, funnel_stage (tofu|mofu|bofu), rationale. |
| **Output** | `GeneratedPrompt[]` — filtered to valid funnel_stage, max 20 |

#### classifyPrompts(texts, apiKey, context?)

<!-- What / When / Why -->
> - **What:** Classifies imported prompts into funnel stages; filters duplicates/off-topic. Uses `submit_classifications` tool. Returns keep/filter_reason per prompt. See table below for inputs, instructions, output.
> - **When:** When user pastes prompts and clicks “Classify & Preview” in the Import panel on approve (POST `/api/brands/:id/classify-prompts`). No storage — preview only until user clicks “Add Selected”.
> - **Why:** This becomes the **Import Prompts** preview (import-results) on the approve tab — the classified list with keep/drop and funnel badges before adding to the Questions section.

| | |
|---|---|
| **Inputs** | `texts` — imported prompt strings; `context` — optional `{ brandName, brandSummary, existingPrompts }` |
| **Instructions** | System: *"Expert in buyer psychology and AEO."* User: *"Classify each prompt: (1) funnel stage (tofu/mofu/bofu); (2) keep=true if relevant and distinct from existing, else keep=false with filter_reason; (3) rationale for stage."* Tool: `submit_classifications` — text, funnel_stage, keep, filter_reason, rationale. |
| **Output** | `ClassifiedPrompt[]` — each with keep, filter_reason |

#### extractBrandMentions(responseText, targetBrandName, competitorHints, apiKey, options?)

<!-- What / When / Why -->
> - **What:** Extracts brand/competitor mentions from LLM response text. Returns rank, is_target, positioning, context_snippet. Uses `submit_mentions` tool. Drops target mentions without context_snippet (hallucination guard). Dedupes by brand (keeps lowest rank per query). Optional `{ queryId, env }` enables inline persist: DELETE existing mentions for that query, INSERT new ones. See table below for inputs, instructions, output.
> - **When:** (1) During querying — called by runs.ts after each fulfilled query (inline persist, 1.5s delay between calls) so the Competitors tab populates live. (2) During analyzing — called by analyzer.ts for each complete query (re-extraction, 2.5s delay) after deleting all run mentions.
> - **Why:** This becomes the **Ranking** tab (Brand Summary table, Brand Rank Per Query), **Competitors** tab (Competitor vs. Brand Ranking, Competitor Analysis), **Overview** charts (LLM Top-3 Visibility, Citation Sources), and **Report** tab of the dashboard.

| | |
|---|---|
| **Inputs** | `responseText` — LLM response (truncated to 6000 chars); `targetBrandName` — brand being audited; `competitorHints` — company names to look for |
| **Instructions** | System: *"Extract brand/competitor mentions. Output only company names — NOT roles, concepts, or services. Mark is_target=true for target (including short forms). For each: positioning (2 sentences), context_snippet (~80 chars). If no brands, return empty array."* User: *"Target: X. Known competitors: A, B. Extract mentions in order of first appearance. Only include brands explicitly named."* Tool: `submit_mentions` — brand_name, rank, is_target, positioning, context_snippet. |
| **Rules (post-LLM)** | Drop target mentions without `context_snippet` (hallucination guard). Competitors kept even without snippet. Dedupe: one brand per query, keep lowest rank (first appearance). |
| **Output** | `ExtractedMention[]` — brand_name, rank, is_target, positioning?, context_snippet? |

**pingOpenAI(apiKey):** Minimal `gpt-4o-mini` call; fails fast if key invalid.

**Used by:** brands (personas, prompts, supplement, classify, import); analyzer (extractBrandMentions).

---

### src/services/analyzer.ts

Runs the analyzing phase: reclassify citations, extract brand mentions, write brand_mentions.

#### analyzeRun(runId, brandName, brandDomain, env, presetCompetitors?)

<!-- What / When / Why -->
> - **What:** Reclassifies unknown citations → competitor when company_name matches hints; extracts brand mentions per query via extractBrandMentions; batch inserts into brand_mentions; marks run complete. See table below for inputs, transformations, output.
> - **When:** During run process — when querying phase finishes and status transitions to analyzing. Invoked by POST `/api/runs/:id/process` (self-scheduled). Client sees “Analyzing…” on run tab.
> - **Why:** The reclassified citations improve source-type badges in the **Citations** tab. The brand_mentions power the **Ranking** tab (Brand Summary, Brand Rank Per Query), **Competitors** tab (Competitor vs. Brand Ranking, Competitor Analysis), **Overview** charts, and **Report** tab of the dashboard.

| | |
|---|---|
| **Inputs** | `runId` — run to analyze; `brandName`, `brandDomain` — for extractBrandMentions; `env` — DB, KV, API keys; `presetCompetitors` — optional preset names |
| **Transformation 1: Reclassify** | **Input:** Citations with `source_type='unknown'`. **Rule:** If `company_name` is in competitor hints (from preset + citation company_names where source≠owned), set `source_type='competitor'`. **Output:** Updated `citations` rows. |
| **Transformation 2: Extract mentions** | **Input:** All queries with `status=complete` and `response_text` not null. **Rules:** DELETE all brand_mentions for the run. Build hints = presetCompetitors + company_names from citations (source≠owned). Call `extractBrandMentions(response_text, brandName, hints)` per query; 2.5s delay between calls. **Output:** `mentionInserts[]` — batch INSERT into `brand_mentions`. (Inline extraction during querying is overwritten by this re-extraction.) |
| **Transformation 3: Complete** | **Rule:** `UPDATE runs SET status='complete'`. On extraction failure for a query: skip, continue; no rows for that query. |
| **Output** | Void. Side effects: `citations` (reclassify), `brand_mentions` (batch insert), `runs.status` |

---

### src/routes/brands.ts

Brand CRUD and setup flows.

| Endpoint | Action |
|----------|--------|
| POST / | Create brand. Standard: scrape URL → generate personas. Predict: paste text → generate personas. |
| POST /quick-start | Create brand + prompts + personas in one shot; no scrape. |
| POST /:id/proceed-blocked | After scrape_blocked: user pastes text or uses AI fallback → generate personas. |
| POST /:id/generate-prompts | Generate prompts from scraped content + personas. |
| POST /:id/classify-prompts | Classify pasted prompts (no storage). |
| POST /:id/import-prompts | Bulk insert pre-classified prompts. |
| POST /:id/supplement | Upload ICP text, regenerate personas. |
| GET /:id | Brand + prompts + personas + currentStep + lastError + logs (from KV). |

**KV keys:** `progress:{id}`, `logs:{id}`, `error:{id}`. Progress/logs written during async generation.

---

### src/routes/prompts.ts

| Endpoint | Action |
|----------|--------|
| PATCH /:id | Update text, funnel_stage, approved |
| DELETE /:id | Delete prompt |
| POST /approve-all/:brandId | Approve all prompts for brand |

---

### src/routes/personas.ts

| Endpoint | Action |
|----------|--------|
| PATCH /:id | Update name, description, system_message, approved |
| DELETE /:id | Delete persona |
| POST /approve-all/:brandId | Approve all personas for brand |

---

### src/routes/runs.ts

Run lifecycle and results.

**Run phases:** `pending` → `querying` → `analyzing` → `complete`. Legacy `scraping` auto-transitions to `analyzing`.

| Endpoint | Action |
|----------|--------|
| POST / | Create run, schedule /process |
| GET /:id | Run status |
| GET /:id/logs | KV logs (terminal output) |
| POST /:id/process | Advance one batch; self-schedules next |
| GET /:id/results | Full analytics (complete runs) |
| GET /:id/partial | Partial analytics (in-progress runs) |
| GET /:id/live-responses | Completed responses grouped by LLM |
| GET /:id/queries/:queryId/response | Single query response for modal |
| POST /:id/cancel | Abort run |
| GET /:id/siblings | Other runs for same brand |
| DELETE /:id | Cascade delete run + queries + citations + brand_mentions |

**Process flow (POST /:id/process):**

1. **pending:** Create queries from approved prompts × personas × [claude, chatgpt, gemini]. Status → querying.
2. **querying:** Claim batch of 3 pending queries. queryLLM for each → update response_text. Inline: extractCitations + scrapeCitation → INSERT citations; extractBrandMentions (with persist) → INSERT brand_mentions per fulfilled query (1.5s delay between calls). If no pending left, reset stuck processing, or → analyzing.
3. **analyzing:** Call analyzeRun. On success → complete.
4. **complete/failed:** No further processing.

**Lock:** `lock:process:{runId}` prevents concurrent batches (90s TTL).

**Citations:** Written inline during querying, per batch. URLs from LLM structured citations + extractCitations(text). scrapeCitation fetches, classifies, INSERT.

**brand_mentions:** Written inline during querying (after each fulfilled query) so the Competitors tab populates live. Re-extracted and overwritten by analyzer at end of analyzing phase.

**Competitor aggregate:** /results and /partial run 3 SQL queries on brand_mentions (mentions_by_llm, top_positionings, top_positioning_by_llm), merge into competitorDetail.

---

### src/routes/assistant.ts

| Endpoint | Action |
|----------|--------|
| POST / | `{ run_id, question }` → Builds context from competitorRanks, topDomains, sourceTypes, ownedPages, brandSnippets. Calls Claude with system prompt. Returns `{ answer }`. |
