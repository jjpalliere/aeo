# Approach: Developer Mode + Enhanced Citations

## 1. Developer Mode Button

**Goal:** Let developers skip the live run view and go straight to the outputs (dashboard).

**Placement:** On `live.html` — a prominent "Skip to outputs" button in the header/top bar.

**Behavior:**
- Click → navigate to `dashboard.html?runId={currentRunId}`
- Dashboard already supports partial data (via `/api/runs/:id/partial` during run, `/api/runs/:id/results` when complete)
- No backend changes needed; purely a navigation shortcut

**Edge case:** If run has zero completed queries, dashboard will show empty panels. Acceptable — dev can still inspect the UI structure.

---

## 2. Citations Section Redesign

**Current state:**
- `citationList` = aggregated by URL: `{ url, domain, count }`
- No query association, no page title, no output link

**Target state:**
- Each row = one citation instance (one query citing one URL)
- Columns: Query (prompt snippet), Page title, URL/domain, [chatbot icon]
- Clicking chatbot icon → show the LLM output (response_text) for that query

---

## 3. Data Pipeline & Timing

### 3.1 When citations are created

| Phase    | When                    | What we have                          |
|----------|-------------------------|---------------------------------------|
| Querying | After each query completes | query_id, url, domain, scraped data   |
| Scraping | Batch for unprocessed   | Same, for queries that had no URLs   |

### 3.2 What we need per citation

| Field          | Source                    | When available                    |
|----------------|---------------------------|------------------------------------|
| query_id       | Citation insert           | At creation                        |
| url, domain    | Citation insert           | At creation                        |
| page_title     | Scrape (extractPageMeta)  | At scrape — **not currently stored** |
| prompt_text    | queries → prompts         | When query exists                  |
| persona_name   | queries → personas        | When query exists                  |
| llm            | queries                   | When query exists                  |
| response_text  | queries                   | When query.status = 'complete'     |

### 3.3 Timing constraints

- **response_text** exists only after the query completes. During querying, citations are created inline with the query completion, so we always have response_text when we have the citation (inline path).
- **Scraping phase:** Citations are created for queries that had no URLs in the inline pass. Those queries are already complete, so response_text exists.
- **Conclusion:** By the time we have a citation row, the query is complete and response_text is available. No race.

### 3.4 Page title

- `scrapeCitation` calls `extractPageMeta(html)` which returns `{ title, companyName }`
- We use `companyName` but not `title`
- **Change:** Add `page_title` to citations table; return it from scrape; store it on insert

---

## 4. Schema Change

```sql
ALTER TABLE citations ADD COLUMN page_title TEXT;
```

- Add to `schema.sql` for new installs
- Migration for existing DBs

---

## 5. Backend Changes

### 5.1 Citation type & scraper

- Extend `Citation` type (or scrape return) with `page_title`
- `scrapeCitation` already has `extractPageMeta` → add `title` to return value
- All citation INSERTs: add `page_title` column

### 5.2 New API shape: `citationDetail`

Replace (or supplement) `citationList` with a **per-citation** list that includes query context and output:

```ts
// New query: one row per citation, joined to query + prompt + persona
SELECT c.id, c.query_id, c.url, c.domain, c.page_title, c.company_name, c.source_type,
       p.text as prompt_text, p.funnel_stage,
       pe.name as persona_name,
       q.llm, q.response_text, q.status
FROM citations c
JOIN queries q ON q.id = c.query_id
JOIN prompts p ON p.id = q.prompt_id
JOIN personas pe ON pe.id = q.persona_id
WHERE q.run_id = ? AND c.url != '_none_'
ORDER BY c.url, q.llm, pe.name
```

- **response_text:** Prefer **on-demand fetch** (see §11 Weak Points). Omit from list; add `GET /api/runs/:id/queries/:queryId/response` and fetch when chatbot icon is clicked. Keeps list lean (~50KB vs ~1.5MB).

### 5.3 Partial endpoint

- `/api/runs/:id/partial` must return the same `citationDetail` shape (without response_text)
- During run: only citations for completed queries exist
- Queries still in progress have no citations yet (citations come from response)

---

## 6. Frontend Changes

### 6.1 Citations list UI

- **Layout:** Table or card list
- **Columns:** Query (truncated prompt), Page title, URL, Domain, [chatbot icon]
- **Chatbot icon:** Right-aligned; click opens modal/drawer with full `response_text`
- **Domain filter:** Keep existing filter bubbles; filter by `citationDetail[].domain`

### 6.2 Output modal

- Click chatbot → fetch `GET /api/runs/:id/queries/:queryId/response` → show modal/panel
- Content: prompt (full), persona, LLM badge, and full response text
- Optional: highlight or scroll to the citation URL within the response if present

### 6.3 Data flow

- `data.citationDetail` (or `citationList` with new shape) replaces current `citationList`
- `buildCitations` / `renderCitationsList` consume new shape
- Partial polling: merge `citationDetail` like other partial fields

---

## 7. Implementation Order

1. **Schema:** Add `page_title` to citations (schema + migration `0003_add_page_title.sql`)
2. **Scraper:** Return `page_title` from `scrapeCitation`; extend `Citation` type
3. **Inserts:** Update all 4 citation INSERTs in `runs.ts` to include `page_title`
4a. **API (additive):** Add `citationDetail` (no response_text) + `GET .../queries/:queryId/response`; keep `citationList` for now
4b. **API (cleanup):** Remove `citationList` after frontend is verified
5. **Dashboard:** Redesign citations section (table, columns, chatbot icon)
6. **Modal:** Implement output viewer; fetch response on chatbot click
7. **Developer mode:** Add prominent "Skip to outputs" button on live.html (upgrade from existing dashboard link)

---

## 8. Backward Compatibility

- Old runs: `page_title` = null → show "—" or domain as fallback
- API: Add `citationDetail`; can keep `citationList` (aggregated) for domain filters if needed, or derive from `citationDetail`

---

## 9. Edge Cases

| Case                    | Handling                                                |
|-------------------------|---------------------------------------------------------|
| Citation, query not complete | Not possible — citations created only when query completes |
| Scrape fails, no title  | `page_title` = null; show "—" or URL                    |
| Very long response_text | Modal with scroll; consider truncation in list view     |
| Same URL, multiple queries | Multiple rows (one per citation instance) — intended  |

---

## 10. Potential Breakages

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Replacing citationList** | `loadPartial()` and `load()` explicitly normalize `citationList` to `{ url, domain, count }`. Changing the shape breaks the merge. | Update merge logic in both places. Use `citationDetail` as the new key; update `renderCitationsList` and `buildCitations` to consume it. Remove or repurpose `citationList`. |
| **Domain filter bubbles** | Built from `topDomains`, not citationList. | No change needed — topDomains stays separate. Filter `citationDetail` by `domain` when rendering. |
| **Report download** | Uses topDomains, sourceTypes, etc. — not citationList. | No impact. |

---

## 11. Weak Points

| Weak point | Concern | Mitigation |
|------------|---------|------------|
| **Payload size** | citationDetail with `response_text` per row: ~500 rows × 3KB ≈ 1.5MB. Slow for API + browser. | **Option A:** Include response_text; add LIMIT 500 if needed. **Option B (preferred):** Omit response_text from list; add `GET /api/runs/:id/queries/:queryId/response` and fetch on chatbot click. Keeps list lean, fetches output on demand. |
| **Partial merge** | `loadPartial` currently does `citationList.map(c => ({ url, domain, count }))` — expects aggregated shape. | When switching to citationDetail, partial must return the same per-row shape. Update merge to `data.citationDetail = partial.citationDetail` (no aggregation). |
| **Scrape failure** | If fetch fails, we never call extractPageMeta. `page_title` = null. | Already handled — show "—" or domain. |
| **Developer mode** | Button needs runId. If user lands on live.html without runId (e.g. direct nav), button is useless. | Get runId from URL params. Hide or disable button if missing. |

---

## 12. Over-Fitting

| Over-fit | Risk | Mitigation |
|----------|------|------------|
| **Assuming citation ⇒ query complete** | Plan assumes citations only exist when query is complete. If we ever add async citation extraction, this breaks. | Document the invariant. Add assertion or defensive null check for response_text in API. |
| **Baking response_text into list** | Ties the list API to "always include output." If we add pagination or lazy-load later, we'd have to change the shape again. | Prefer **on-demand fetch** for response_text (separate endpoint). List stays stable; output is a detail view. |
| **Domain filter from topDomains** | Filter bubbles use topDomains (aggregated). citationDetail has domain per row. If we ever want "filter by prompt" or "filter by LLM," current design doesn't support it. | Accept for now. Filter by domain is the primary use case. Can add more filters later. |
| **Developer mode = live.html only** | Assumes dev is on the live run page. What if they want "dev mode" from the approve page or dashboard? | Start with live.html. Add elsewhere if needed. |

---

## 13. General & Executional Review

### 13.1 Insert Sites (Don’t Miss Any)

| Location | File | Phase | Variant |
|---------|------|-------|---------|
| 1 | `runs.ts` ~272 | Querying | Scraped (on_page_text, company_name) |
| 2 | `runs.ts` ~283 | Querying | Placeholder (_none_) |
| 3 | `runs.ts` ~364 | Scraping | Scraped |
| 4 | `runs.ts` ~384 | Scraping | Placeholder |

All 4 INSERTs must add `page_title`. Placeholders use `null`.

---

### 13.2 Scraper Change Scope

- `extractPageMeta(html)` already returns `{ title, companyName }`; only `companyName` is used today.
- Add `page_title` to the object returned by `scrapeCitation`. When `scraped_ok = 0` (fetch fails, paywall, non-HTML), return `page_title: null`.
- Update the `Citation` type to include `page_title?: string | null`.

---

### 13.3 Migration & Deploy Order

1. Run migration (`0003_add_page_title.sql`) **before** deploying new code.
2. If migration fails (e.g. column already exists), handle idempotently: `IF NOT EXISTS` or catch "duplicate column" and no-op.
3. New installs: update `schema.sql` so fresh DBs have `page_title` from the start.

---

### 13.4 Deployment Strategy

| Strategy | Pros | Cons |
|----------|------|------|
| **Big bang** (API + frontend together) | Simple, no transition state | Single deploy surface; harder rollback |
| **Phased** (API first, keep citationList; then frontend) | Can deploy API, verify, then switch UI | Two deploys; temporary dual payload |

**Recommendation:** Phased. Step 4a: Add `citationDetail` and `GET .../response`; keep `citationList` in results + partial. Step 4b: Update dashboard to use `citationDetail`; remove `citationList` from API. Allows rollback of frontend only if issues appear.

---

### 13.5 Rollback Plan

| Change | Rollback |
|--------|----------|
| Schema `page_title` | Additive, nullable. No rollback needed; old code ignores it. |
| Scraper returns `page_title` | New column stays null if we revert scraper. Harmless. |
| API `citationDetail` | If we keep `citationList` during transition, revert frontend to use `citationList`; leave `citationDetail` in API. |
| New `/response` endpoint | 404 harmless; modal just won’t load. |

---

### 13.6 Developer Mode vs Existing Link

`live.html` already has `dashboard-link` → `dashboard.html?runId=...` (line 232). The "Skip to outputs" button is a **prominence upgrade**, not new behavior. Ensure it’s clearly visible (e.g. header CTA) so devs don’t overlook it.

---

### 13.7 Verification Checklist (Post-Implement)

- [ ] Migration runs on existing DB; `schema.sql` updated for new installs.
- [ ] All 4 citation INSERTs include `page_title`.
- [ ] Scraped citations have `page_title` when fetch succeeds; null when it fails.
- [ ] `/api/runs/:id/results` and `/partial` return `citationDetail` (and optionally `citationList` during transition).
- [ ] `GET /api/runs/:id/queries/:queryId/response` returns `{ prompt_text, persona_name, llm, response_text }`.
- [ ] Dashboard Citations tab shows per-row data (query snippet, page title, URL, chatbot icon).
- [ ] Chatbot icon fetches response on demand and shows modal.
- [ ] Domain filter still works (from `topDomains`; filters `citationDetail`).
- [ ] Partial polling during run shows new citations as they complete.
- [ ] "Skip to outputs" on live.html navigates to dashboard with runId.

---

### 13.8 Execution Risks

| Risk | Mitigation |
|------|-------------|
| **Forgetting an INSERT** | Grep `INSERT.*citations` before PR; use checklist above. |
| **Partial merge bug** | `load()` and `loadPartial()` both merge `citationDetail`; test with run in progress. |
| **Response endpoint 404** | Ensure route is `/:id/queries/:queryId/response` and query belongs to run. Add 404 handling in modal. |
| **Old runs, null page_title** | UI shows "—" or domain; no backfill needed. |
