# Brand Alias & Disambiguation Matching

## The problem

Two failure modes in the extraction pipeline when a brand's canonical name differs from the name LLMs naturally use in responses:

**Problem A — False positives.** The extractor sees "Prisma" in a response and marks it as target, even when the response is clearly about Prisma Cloud (Palo Alto Networks) or Prisma ORM.

**Problem B — False negatives.** The extractor correctly marks a target mention, but the downstream hallucination filter at [`generator.ts:643`](../src/services/generator.ts#L643) does `responseText.toLowerCase().includes(brandName.toLowerCase())`. If `brandName = "poweredbyprisma"` but the response only says "Prisma", the substring check fails and the mention gets dropped.

This is structural: the name we store and the name LLMs actually speak are different words.

---

## What the extractor does today

`extractBrandMentions()` at [`generator.ts:597`](../src/services/generator.ts#L597) is an `gpt-4o-mini` tool-call that turns raw LLM responses into structured brand-mention rows for the database.

**Inputs:**
- `responseText` — raw text from Claude/ChatGPT/Gemini (truncated to 6000 chars)
- `targetBrandName` — from `brands.name`
- `competitorHints` — company names from citation analysis
- `queryId` — for DB write scoping

**Questions the LLM answers:**
1. Which specific companies/brands are named in this text?
2. What order do they first appear? (rank 1, 2, 3…)
3. Is each one the target brand? (`is_target`)
4. How does the response characterize each brand? (`positioning`)
5. Where in the text does each brand appear? (`context_snippet`)

**Post-processing:**
- Drop target mentions with no `context_snippet`
- Drop target mentions whose `brand_name` isn't in `responseText` (the `.includes()` filter — Problem B lives here)
- Dedupe on brand name, keeping lowest rank

**Writes:** rows to `brand_mentions` table (deleted + re-inserted per `queryId`).

---

## How `targetBrandName` flows

```
brands.name (DB)
  ↓ set by: generatePersonas() LLM  OR  manual edit via PATCH /api/brands/:id/name
  ↓
runs.ts:460   brandName = (brand.name ?? brand.domain ?? 'unknown')
  ↓
extractBrandMentions(responseText, brandName, hints, ...)
  ↓
  • System prompt: 'The target brand is: "${targetBrandName}"'
  • User prompt:   'Target brand: ${targetBrandName}'
  • Filter:        responseText.includes(targetBrandName)
```

So the name is the **only anchor** the extractor gets. Everything downstream depends on it being both correct AND matching how LLMs speak about the brand — which is impossible when those diverge.

---

## Separately: the citation flow

The citation flow at [`citation.ts`](../src/services/citation.ts) is **not** the extractor. It processes URLs found in LLM responses:

1. HTTP-fetch each cited page
2. Parse `<title>` and `<meta og:site_name>`
3. `company_name = og:site_name || title.split('|')[0]`
4. Classify `source_type` by **exact domain match** (`domain === brandDomain`)

The `company_name` field gets passed into the extractor later as `competitorHints` — a one-way feed. The citation flow doesn't compare against the brand name, so it's mostly unaffected by the Prisma issue. One edge case: a cited news article with misleading `og:site_name` could inject a confusing competitor hint.

---

## Solution: alias-aware matching

Add three optional fields to each brand. All plug into the same injection points in the extractor — no new pipelines.

| Field | Example (poweredbyprisma) | Purpose |
|-------|--------------------------|---------|
| `name` (canonical) | `poweredbyprisma` | What we store, display, aggregate by |
| `aliases` | `Prisma, Prisma Agency` | Alternate names LLMs use for this brand |
| `exclusions` | `Prisma Cloud, Palo Alto, Prisma ORM, prisma.io` | Similarly-named entities to disqualify |
| `identity_note` (optional) | `Brooklyn marketing agency, sister brand of Column Five, makes Docblok` | One-line context for the extractor |

### Mental model

| Lever | What it solves |
|-------|----------------|
| `brand.name` (set well) | Gives the extractor *one* correct anchor |
| `aliases` | Lets the extractor recognize shorthand ("Prisma" → target) |
| `exclusions` | Tells the extractor what NOT to treat as target |
| Filter update (canonical OR any alias) | Stops the hallucination-guard from dropping valid alias matches (fixes Problem B) |

---

## Implementation plan

### 1. Schema
Add to `brands` table:
- `aliases TEXT` — JSON array of strings
- `exclusions TEXT` — JSON array of strings
- `identity_note TEXT`

### 2. Backend API
- Extend `PATCH /api/brands/:id/name` → `PATCH /api/brands/:id` to accept any of `name`, `aliases`, `exclusions`, `identity_note`
- Update `extractBrandMentions()` in [`generator.ts`](../src/services/generator.ts):
  - Inject a "target profile" block into the system prompt:
    > Target brand: **poweredbyprisma**
    > Also referred to as: Prisma, Prisma Agency
    > Do NOT confuse with: Prisma Cloud (Palo Alto Networks), Prisma ORM, prisma.io
    > About: Brooklyn marketing agency, sister brand of Column Five, makes Docblok
  - Modify the hallucination filter at line 643: response text must contain **canonical OR any alias** (not just canonical).

### 3. Frontend (approve page)
Add beside the existing editable Brand Name in the Source Material panel:
- **"Also referred to as"** (comma-separated input)
- **"Not to be confused with"** (comma-separated input)
- **"Identity note"** (one-line textarea, optional)

Same save-on-blur UX as the name field. All persist via the same PATCH endpoint.

---

## Behavior summary

- Brands without collisions: leave fields empty → zero behavior change.
- Brands with collisions: user lists confusion terms once → extractor disambiguates via context, filter accepts alias text as valid.
- Aggregation and dashboard display still use canonical `name`, so reports stay consistent regardless of which alias appears in the response.

---

## Open questions

- Auto-suggest aliases from scraped content (titles, `<h1>` tags)? Probably not for v1 — keep it user-controlled.
- Store the matching alias (not just canonical) in `brand_mentions` for debugging? Nice-to-have.
- Should the `identity_note` also be passed to `generatePrompts()` so generated search queries use the right framing? Maybe.
