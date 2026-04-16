# Brand Alias & Disambiguation Matching

## Problem

When a brand's LLM-facing name differs from its legal/canonical name, the current extraction pipeline has two failure modes:

**A. False positives** — The extractor sees "Prisma" in a response and marks it as target, even when the response is clearly about Prisma Cloud (Palo Alto Networks) or Prisma ORM.

**B. False negatives** — Even when the extractor correctly identifies a target mention, the downstream filter at [`generator.ts:638`](../src/services/generator.ts#L638) checks `responseText.includes(brandName)` (canonical name). If the response text only uses the alias ("Prisma") and not the canonical ("poweredbyprisma"), the mention gets dropped.

This is structural: the stored brand name and the name LLMs naturally use are different words.

## Solution: Alias-aware matching

Each brand gets three optional fields in addition to `name`:

| Field | Example (poweredbyprisma) | Purpose |
|-------|--------------------------|---------|
| `name` (canonical) | `poweredbyprisma` | What we store, display, and aggregate by |
| `aliases` | `Prisma, Prisma Agency` | Alternate names LLMs use for this brand |
| `exclusions` | `Prisma Cloud, Palo Alto, Prisma ORM, prisma.io` | Similarly-named entities to disqualify |
| `identity_note` (optional) | `Brooklyn marketing agency, sister brand of Column Five, makes Docblok` | One-line context for the extractor |

## Changes

### 1. Schema
Add to `brands` table:
- `aliases TEXT` — JSON array of strings
- `exclusions TEXT` — JSON array of strings
- `identity_note TEXT`

### 2. Backend API
- `PATCH /api/brands/:id` — accept any of `name`, `aliases`, `exclusions`, `identity_note`
- Update `extractBrandMentions()` in [`generator.ts`](../src/services/generator.ts):
  - Inject a "target profile" block into the extractor system prompt with name, aliases, exclusions, identity note
  - Example:
    > Target brand: **poweredbyprisma**
    > Also referred to as: Prisma, Prisma Agency
    > Do NOT confuse with: Prisma Cloud (Palo Alto Networks), Prisma ORM, prisma.io
    > About: Brooklyn marketing agency, sister brand of Column Five, makes Docblok
- Modify the downstream hallucination filter at line 638: the response text must include **canonical OR any alias** (not just canonical).

### 3. Frontend (approve page)
Add two optional inputs beside the existing editable Brand Name in the Source Material panel:
- **"Also referred to as"** (comma-separated)
- **"Not to be confused with"** (comma-separated)
- **"Identity note"** (one-line textarea, optional)

All three persist via the same PATCH endpoint. Same save-on-blur UX as the name field.

## Behavior summary

- Brands without collisions: leave aliases/exclusions empty → zero behavior change.
- Brands with collisions: user lists the common confusion terms → extractor disambiguates using context, filter accepts alias text as valid.
- Aggregation and dashboard display still use canonical `name`, so reports remain consistent regardless of which alias appears in the response.

## Open questions

- Should aliases be auto-suggested from scraped content (e.g. titles, `<h1>` tags, founder mentions)? Probably not for v1 — keep it user-controlled.
- Should we store the match that triggered `is_target` (which alias was hit) in `brand_mentions` for debugging? Nice-to-have.
