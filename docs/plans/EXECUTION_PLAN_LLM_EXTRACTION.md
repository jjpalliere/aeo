# Execution Plan: LLM-Based Brand/Competitor Extraction

## Overview
Replace regex-based brand mention extraction with a dedicated LLM extraction step. Add a `positioning` field (~5 words) describing how each competitor is characterized in the response.

---

## Phase 1: Schema & Types

### 1.1 Database migration
- [ ] Add `positioning TEXT` column to `brand_mentions` (nullable)
- [ ] Create migration file (e.g. `migrations/0002_add_positioning.sql`)
- [ ] Run migration against local D1

### 1.2 TypeScript types
- [ ] Update `MentionResult` (or equivalent) in `analyzer.ts` to include `positioning?: string`
- [ ] Ensure any shared types reflect the new schema

---

## Phase 2: LLM Extraction Service

### 2.1 Create extraction function
- [ ] Add `extractBrandMentions(responseText, brandName, presetCompetitors)` in `generator.ts` or new `extractor.ts`
- [ ] Use `callClaudeWithTool` with a schema like:
  ```ts
  {
    mentions: Array<{
      brand_name: string
      rank: number      // 1 = first mentioned
      is_target: boolean
      positioning?: string  // ~5 words, how the response describes this brand
      context_snippet?: string
    }>
  }
  ```
- [ ] Prompt: instruct LLM to extract only actual company/brand names (not roles, concepts, services)
- [ ] Pass preset competitors + citation-derived names as hints in the prompt
- [ ] Use Haiku for cost/speed (extraction is simpler than generation)

### 2.2 Prompt design
- [ ] System: "You extract brand and competitor mentions from AI assistant responses. Output only actual company names, not roles (Founders), concepts (Knowledge Transfer), or services (Initial Consultation)."
- [ ] User: response text + target brand name + optional competitor hints
- [ ] Handle edge cases: no mentions, target only, empty positioning

---

## Phase 3: Remove Inline Extraction, Centralize in Analyzer

### 3.1 Remove inline brand mentions from runs.ts
- [ ] Delete the block that calls `extractListedEntities` + `findMentions` and inserts into `brand_mentions` (~lines 295–307)
- [ ] Remove imports of `extractListedEntities` and `findMentions` from runs.ts
- [ ] Inline pipeline will only handle citations; brand mentions deferred to analyzer

### 3.2 Rewrite analyzer.ts
- [ ] Remove `extractListedEntities` usage
- [ ] Remove `findMentions` usage (or keep only for target-brand matching if needed)
- [ ] For each unanalyzed query:
  - [ ] Call `extractBrandMentions(responseText, brandName, competitorNames)`
  - [ ] Insert results into `brand_mentions` with `positioning`
- [ ] Reuse `presetCompetitors` + `citationCompetitors` as hints for the extractor
- [ ] Batch LLM calls if desired (e.g. 5–10 responses per call) to reduce API cost—or keep per-query for simplicity

### 3.3 Revert stop-words change
- [ ] Revert the stop-words addition in `extractListedEntities` (we're replacing this path entirely, but clean up if the function remains for any reason)

---

## Phase 4: API & Queries

### 4.1 competitorRanks query
- [ ] Add positioning to the SELECT (e.g. use a subquery or `MAX(positioning)` to pick one per brand)
- [ ] Files: `runs.ts` (GET run data), `assistant.ts`

### 4.2 mentions query (for competitor snippets)
- [ ] Include `positioning` in the mentions payload
- [ ] Check the query that feeds `mentions` in runs.ts

### 4.3 promptDetail query
- [ ] Add `positioning` for the first-mentioned brand per query (already joins `brand_mentions` with `rank = 1`)

---

## Phase 5: Dashboard UI

### 5.1 Competitors table
- [ ] Add "Positioning" column to the competitor table
- [ ] Display positioning (or "—" if null)
- [ ] File: `dashboard.html` → `buildCompetitors()`

### 5.2 Competitor snippets
- [ ] Show positioning alongside each mention snippet when available
- [ ] File: `dashboard.html` → `buildCompetitors()` (snippets section)

---

## Phase 6: Assistant / Chat

### 6.1 Competitor summary

- [ ] Extend `competitorSummary` in `assistant.ts` to include positioning
- [ ] Format: e.g. `"Brand X: 3 mentions, avg rank 2.1 — 'enterprise B2B agency'"`
- [ ] Ensures the assistant has positioning context for answers

---

## Phase 7: Testing & Validation

### 7.1 Manual test
- [ ] Run a full flow: create brand → approve → launch run → wait for complete
- [ ] Verify Competitors tab shows real brands (not concepts)
- [ ] Verify positioning appears where expected
- [ ] Verify ranking still makes sense (target vs competitors)

### 7.2 Edge cases
- [ ] Response with no brand mentions
- [ ] Response with only target brand
- [ ] Response with citations but no list-style mentions
- [ ] Very long response (ensure we don't exceed context limits)

---

## Dependencies & Order

```
Phase 1 (Schema) → Phase 2 (Extractor) → Phase 3 (Analyzer) → Phase 4 (API) → Phase 5 (Dashboard) → Phase 6 (Assistant) → Phase 7 (Test)
```

- Phase 2 must be done before Phase 3.
- Phase 4 can be done in parallel with Phase 5/6 once Phase 3 is done.

---

## Risks & Premeditated Issues

### API cost & rate limits
- **Per-query = 180 calls/run.** Haiku helps but still adds cost. Consider batching (e.g. 5–10 responses per call) to reduce to ~20–40 calls.
- **429 burst risk:** Analyzer runs in a short window; many extraction calls could hit rate limits. Add delays between calls (e.g. 2–3s) or batch to reduce load.
- **Mitigation:** Start with per-query + delays; add batching if cost/rate limits become an issue.

### Analyzer phase latency
- **"Analyzing" could take 5–10+ minutes** with 180 extraction calls. User may think it's stuck.
- **Mitigation:** Add progress logging (e.g. `[analyzer] 45/180 queries extracted`) so the dashboard shows activity. Consider a progress indicator in the UI if the run page is visible during analyzing.

### Extractor reliability
- **Schema drift:** LLM might return malformed JSON or extra fields. Add try/catch and fallback: skip that query, log, continue. Don't fail the whole run.
- **Partial failure:** If 1 of 180 extractions fails, mark run complete and log the failure. The failed query stays without brand_mentions; acceptable.
- **Still extracts junk:** Despite instructions, LLM might occasionally return concepts. Consider a post-filter: if we have citation company names for this run, prefer those; treat extractor output as supplement. Or accept and iterate on prompt.

### Context window / long responses
- **Response text can be 2000–4000+ chars.** Ensure we stay under Haiku context. Truncate if needed (e.g. first 6000 chars) but risk losing mentions at the end.
- **Batching:** 10 responses × 500 chars = 5000 chars. Fine. But 10 × 2000 = 20k chars—watch for that.

### Positioning consistency
- **"~5 words" is subjective.** LLM may return 3 or 8. Add explicit instruction: "5 words max" or "brief phrase (3–7 words)".
- **Aggregation:** Multiple positionings per brand (one per query). Picking "one" for the table: first non-null vs most common. Start with first; iterate if it feels wrong.

### Target brand variants
- **Current logic:** "Column Five" matches when target is "Column Five Media". Extractor needs the same. Pass target brand name + optional short forms in the prompt.

### Migration & deployment
- **D1 migrations:** Ensure migration runs before deploy (e.g. `wrangler d1 migrations apply` in CI). Document in deploy steps.
- **Local dev:** User may need to run migration manually. Add to README or `npm run db:migrate`.

### Batching implementation complexity
- If batching: schema must map results back to `query_id`. E.g. `{ results: [{ query_index: 0, mentions: [...] }] }` and pass `[query_id_1, query_id_2, ...]` in order. Ensure prompt clearly numbers the responses.

---

## Rollback
- Keep `extractListedEntities` and `findMentions` in the codebase (commented or behind a flag) until the new flow is validated.
- Migration can add a nullable column; no data loss on revert.
