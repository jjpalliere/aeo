# OLD AEO — Answer Engine Optimization Tool
## Project Spec v0.1

---

## 1. Overview

AEO is an internal web application that analyzes how AI language models (Claude, ChatGPT, Gemini) perceive and position a brand relative to its competitors. Given a brand URL, it generates contextual prompts, queries each LLM through multiple user personas, scrapes the cited sources, and delivers an interactive dashboard that answers: *why is this brand ranked the way it is, and what can be done about it?*

---

## 2. Goals & Success Criteria

A successful run produces:

- **Brand ranking across prompts**: for each prompt, which brands are mentioned and in what order, across all 3 LLMs
- **Citation map**: which URLs are most frequently cited, which domains, and what type of source (owned, competitor, news, industry non-competitor)
- **Competitor intelligence**: which competitors consistently rank above the brand and in which prompt categories
- **Positioning trends**: how each LLM frames the brand vs. competitors (language patterns, attributes assigned)
- **Owned page performance**: which of the brand's own pages are cited and how often
- **AI assistant**: a chat interface over the full dataset to answer ad-hoc questions

---

## 3. User Flow

```
1. USER enters brand URL
        ↓
2. SYSTEM scrapes the site (homepage + key pages)
        ↓
3. AI generates:
   - 15–20 prompts (split ToFu / MoFu / BoFu)
   - 3 user personas (with system message context)
        ↓
4. USER reviews and approves prompts + personas
   (can edit, remove, or add)
        ↓
5. SYSTEM runs LLM queries:
   20 prompts × 3 personas × 3 LLMs = ~180 queries
        ↓
6. SYSTEM extracts citations from each response
        ↓
7. SYSTEM scrapes each citation URL (skip JS-heavy or paywalled)
        ↓
8. SYSTEM analyzes:
   - Brand/competitor mentions + ranking per response
   - Citation metadata (URL, on-page text, company name, source type)
        ↓
9. USER views interactive dashboard
        ↓
10. USER queries AI assistant with follow-up questions
```

---

## 4. Core Modules

### 4.1 Brand Setup & Site Scraper

**Input**: URL entered by user

**Process**:
- Crawl homepage + up to ~20 internal links (product/service pages, about, blog)
- Extract: page titles, meta descriptions, headings, body text (stripped)
- Identify: brand name, core offering, industry, key terms

**Output**: structured brand profile object stored in D1

**Constraints**:
- Use native `fetch()` — no headless browser
- Skip pages that return non-200 or require JS to render
- Limit total scraped content to ~50k tokens to stay within LLM context windows

---

### 4.2 Prompt Generator

**Input**: brand profile

**Process**:
- Send brand profile to Claude with instruction to generate 15–20 prompts
- Distribute across funnel stages:
  - **ToFu (Top of Funnel)**: awareness questions ("what tools help with X?", "best platforms for Y")
  - **MoFu (Middle of Funnel)**: consideration questions ("how does X compare to competitors?")
  - **BoFu (Bottom of Funnel)**: decision questions ("what's the best X for [specific use case]?")
- Prompts should be phrased as a real user would ask an AI assistant — natural, not branded

**Output**: list of prompt objects with text + funnel stage, pending user approval

---

### 4.3 Persona Builder

**Input**: brand profile

**Process**:
- Send brand profile to Claude with instruction to generate 3 realistic user personas
- Each persona includes:
  - Name, role, company type
  - Pain points and goals relevant to the brand's space
  - A **system message** phrased as if the LLM is their assistant (e.g. "You are a helpful assistant. The user is a [role] at a [company type] looking to [goal].")

**Output**: 3 persona objects with name, description, system_message, pending user approval

---

### 4.4 LLM Query Engine

**Input**: approved prompts, approved personas, brand profile

**Process**:
- For each combination of (prompt × persona × LLM): fire API call
  - System message = persona's system_message
  - User message = prompt text
- Total: ~180 requests per run
- Run in parallel batches to stay within Cloudflare Worker execution limits (see §8)
- Store full raw response text per query

**LLMs**:
| LLM | API | Notes |
|-----|-----|-------|
| Claude | Anthropic API | claude-sonnet-4-6 |
| ChatGPT | OpenAI API | gpt-4o |
| Gemini | Google AI API | gemini-1.5-pro |

**Output**: query result objects stored in D1 (prompt_id, persona_id, llm, response_text, raw_citations)

---

### 4.5 Citation Extractor & Scraper

**Input**: raw LLM responses

**Process**:
- Parse responses for cited URLs (LLMs typically inline or footnote them)
- For each unique URL:
  - Attempt `fetch()` with a standard user-agent
  - Extract on-page text (strip HTML, keep body content)
  - Skip if: paywalled (detect login walls), JS-rendered (empty body), non-200 response
- Classify source type by domain:
  - **Owned**: matches brand domain
  - **Competitor**: domain appears in competitor list (inferred from LLM responses)
  - **News/Media**: detect by known media domains or heuristic (no product/pricing pages)
  - **Industry**: same sector, not a direct competitor
- Extract company name from page `<title>` or `og:site_name`

**Output**: citation objects per query (url, on_page_text, company_name, source_type, scraped_ok boolean)

---

### 4.6 Response Analyzer

**Input**: all query results + citations

**Process**:

**Brand & Competitor Mentions**:
- Parse each LLM response for company/brand name mentions
- Assign a rank (1 = first brand mentioned)
- Flag if brand is mentioned, not mentioned, or mentioned negatively
- Build competitor list by collecting all brands mentioned across all responses that are not the target brand

**Citation Analysis**:
- Count citation frequency per domain
- Identify most-cited owned pages
- Identify most-cited competitor domains
- Identify source type distribution

**Positioning**:
- For each brand mentioned: extract surrounding sentence(s) — what attribute is the brand associated with?
- Group by LLM, prompt, funnel stage

**Output**: structured analytics objects stored in D1

---

### 4.7 Dashboard

Single-page interactive dashboard. Views:

**Overview**
- Brand name + run date
- Visibility score: % of responses where brand appears in top 3
- Total queries run, citations scraped, competitors detected

**Ranking View**
- By prompt: table showing brand rank across 3 LLMs × 3 personas
- Filterable by funnel stage, LLM, persona

**Citation Map**
- Most-cited domains (bar chart)
- Source type breakdown (owned / competitor / news / industry) (pie/donut)
- Most-cited owned pages (list)
- Competitor citation strength vs. brand

**Competitor Intelligence**
- Competitor frequency table: how often each competitor appears
- Competitor ranking vs. brand: side-by-side rank comparison
- Attributes associated with each competitor (extracted text snippets)

**Prompt Explorer**
- Browse individual prompts: see each LLM's full response side-by-side
- Highlight brand and competitor mentions inline

**AI Assistant**
- Chat interface over the full dataset
- Pre-loaded system context: all query results, citations, analysis objects
- Example queries: "Which LLM ranks us worst?", "What pages should we create to get cited more?", "What are competitors doing that we aren't?"

---

### 4.8 AI Assistant

- Uses Claude (claude-sonnet-4-6) with a system prompt containing a structured summary of the full analysis dataset
- Operates over stored D1 data — retrieves relevant records dynamically per question
- Stateless per message (no conversation memory needed for v1)

---

## 5. Data Models

### `brands`
| field | type | notes |
|-------|------|-------|
| id | text (uuid) | PK |
| url | text | input URL |
| name | text | extracted brand name |
| scraped_content | text | JSON blob of scraped pages |
| created_at | timestamp | |

### `prompts`
| field | type | notes |
|-------|------|-------|
| id | text (uuid) | PK |
| brand_id | text | FK → brands |
| text | text | prompt content |
| funnel_stage | text | tofu / mofu / bofu |
| approved | integer | 0 or 1 |

### `personas`
| field | type | notes |
|-------|------|-------|
| id | text (uuid) | PK |
| brand_id | text | FK → brands |
| name | text | |
| description | text | role, company, goals |
| system_message | text | injected as LLM system prompt |
| approved | integer | 0 or 1 |

### `runs`
| field | type | notes |
|-------|------|-------|
| id | text (uuid) | PK |
| brand_id | text | FK → brands |
| status | text | pending / running / complete / failed |
| created_at | timestamp | |
| completed_at | timestamp | nullable |

### `queries`
| field | type | notes |
|-------|------|-------|
| id | text (uuid) | PK |
| run_id | text | FK → runs |
| prompt_id | text | FK → prompts |
| persona_id | text | FK → personas |
| llm | text | claude / chatgpt / gemini |
| response_text | text | full raw response |
| status | text | pending / complete / failed |

### `citations`
| field | type | notes |
|-------|------|-------|
| id | text (uuid) | PK |
| query_id | text | FK → queries |
| url | text | |
| domain | text | extracted domain |
| on_page_text | text | scraped body text (nullable) |
| company_name | text | extracted from page |
| source_type | text | owned / competitor / news / industry |
| scraped_ok | integer | 0 or 1 |

### `brand_mentions`
| field | type | notes |
|-------|------|-------|
| id | text (uuid) | PK |
| query_id | text | FK → queries |
| brand_name | text | |
| rank | integer | order of first mention |
| is_target | integer | 1 if this is the user's brand |
| context_snippet | text | surrounding sentence(s) |

---

## 6. LLM Integration Notes

- Each LLM call includes:
  - `system`: persona system_message
  - `user`: prompt text
- Parse citations from responses using regex + URL detection (LLMs format citations inconsistently — handle inline URLs, numbered footnotes, markdown links)
- Set temperature to 1 (default) for authentic responses — we want what real users see
- No streaming needed — wait for full response

---

## 7. Tech Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Backend | Cloudflare Workers | serverless, globally distributed |
| Database | Cloudflare D1 | SQLite, free tier, persistent |
| Job state | Cloudflare KV | track run progress/status |
| Frontend | Cloudflare Pages + vanilla JS (or lightweight framework) | free hosting |
| Scraping | `fetch()` native | no headless browser needed |
| Charts | Chart.js | lightweight, no build step required |
| LLMs | Anthropic / OpenAI / Google AI SDKs | via API keys stored as Worker secrets |

---

## 8. Architecture & Constraints

### The Core Problem
A full run = ~180 LLM queries + up to ~900 citation scrapes. This cannot happen in a single Worker request.

### Solution: Poll-based Job Queue via D1
1. `POST /api/runs` — creates run record, sets status = `pending`
2. Client polls `GET /api/runs/:id/status` every 5 seconds
3. Workers process the job in small batches triggered by the client (or a scheduled Worker cron)
4. Each batch: fetch N pending queries from D1, run them, mark complete
5. When all queries done → trigger citation scraping batch → trigger analysis
6. Status updates stored in D1; client reflects progress in UI

### Free Tier Limits to Watch
| Resource | Free Limit | Risk |
|----------|-----------|------|
| Worker CPU time | 10ms/request | LOW — most time is I/O (API calls), not CPU |
| Worker requests | 100k/day | LOW for internal use |
| D1 reads | 5M/day | LOW |
| D1 writes | 100k/day | MEDIUM — 180 queries + citations = ~1k writes per run |
| KV reads | 100k/day | LOW |
| KV writes | 1k/day | MEDIUM — use sparingly for status only |

> **Note**: If batch orchestration proves difficult on free tier, consider upgrading to Workers Paid ($5/mo) which unlocks Durable Objects and Queues — both would simplify the job pipeline significantly. Recommend starting on free and upgrading only if needed.

---

## 9. Open Questions

| # | Question | Impact |
|---|----------|--------|
| 1 | How do we handle LLM responses that don't contain citations? (Some models don't cite by default) | Need fallback — extract brand/competitor mentions from text only |
| 2 | Gemini's citation format differs from Claude/GPT — need to test and handle separately | Medium build complexity |
| 3 | Some brand sites may block scraping (Cloudflare protection, bot detection) | Scraper may return partial data — need graceful degradation |
| 4 | Competitor inference accuracy — if LLMs rarely mention competitors, the competitor list may be sparse | May need to allow manual competitor additions post-run |
| 5 | Citation scraping at scale — 900 fetches could hit rate limits or timeout | Need per-domain throttling and retry logic |
| 6 | AI assistant context window — full dataset may exceed model limits | Need to summarize/chunk data intelligently before sending to assistant |

---

## 10. Build Plan (Phased)

### Phase 1 — Foundation
- [ ] Cloudflare project setup (Workers + D1 + Pages)
- [ ] D1 schema creation
- [ ] Brand URL input + site scraper
- [ ] Prompt generator (Claude)
- [ ] Persona builder (Claude)
- [ ] Approval UI (review/edit prompts + personas)

### Phase 2 — Query Engine
- [ ] LLM query engine (Claude, ChatGPT, Gemini)
- [ ] Poll-based job runner
- [ ] Citation extractor (parse URLs from responses)
- [ ] Citation scraper + classifier
- [ ] Brand/competitor mention parser + ranker

### Phase 3 — Dashboard
- [ ] Overview panel
- [ ] Ranking view
- [ ] Citation map + charts
- [ ] Competitor intelligence view
- [ ] Prompt explorer

### Phase 4 — AI Assistant
- [ ] Chat UI
- [ ] Context builder (summarize run data for Claude)
- [ ] Query handler

---

*Last updated: 2026-03-02*
