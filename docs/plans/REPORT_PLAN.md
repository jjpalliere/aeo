# terrain.run — Auto-Generated Report Plan

## Reference: IBM AEO Report Structure
The report the user liked analyzes across 4 dimensions:
- **Channels** (where citations come from: owned site, LinkedIn, Wikipedia, third-party pubs)
- **Personas** (per C-suite role: coverage, query patterns, gap assessment)
- **Topics** (competitive gaps vs saturated territory)
- **Formats** (what content structures drive AEO visibility)

Each dimension is broken down by AI platform (Claude, ChatGPT, Gemini).

---

## Mapping Report Dimensions → Dashboard Tabs

| Report Dimension | Dashboard Tab | Data Available |
|---|---|---|
| Executive Summary | **Report tab** (standalone) | Aggregated from all tables |
| Channels / Sources | **Citations tab** | `citations` table: url, domain, source_type, llm |
| Personas | **Personas tab** | `brand_mentions` joined through `queries` → `prompts` → persona_id |
| Topics / Queries | **Ranking tab** | `prompts` (text, funnel_stage) + `brand_mentions` (rank, mentioned) |
| Competitors | **Competitors tab** | `brand_mentions` grouped by brand_name |
| Formats | **Citations tab** (via `content_format` column) | `citations.content_format`: listicle, guide, review, research, unknown |

---

## Report Sections

### Section 1: Executive Summary
**Tab:** Report tab (top section) + no inline placement
**Tone:** Consultative, data-forward, 3–4 sentences. No lead recommendation.
**Data inputs:**
- Target brand avg rank across LLMs
- Top-3 visibility rate (% of queries where brand ranks 1–3)
- Per-LLM visibility split (Claude vs ChatGPT vs Gemini)
- Total queries analyzed, total citations found
- Brand mention count vs top competitor mention count

**Prompt to LLM (draft):**
> Write a 3–4 sentence executive summary of this brand's AEO position. State the brand's current visibility, strongest/weakest AI platform, and how it compares to the top competitor. Be specific with numbers. Do not include recommendations.

---

### Section 2: Channel & Citation Analysis
**Tab:** Citations tab (inline summary) + Report tab (full section)
**Maps to:** IBM report §2.1 Channels + §1.x per-competitor Channels
**Data inputs:**
- Top cited domains grouped by source_type (owned, competitor, news, review, other)
- Per-LLM citation breakdown (which domains cited on which LLM)
- Owned pages that get cited (url + count)
- Domains citing competitors but NOT target brand (PR hit list)
- Total citation count per LLM

**Analysis the LLM should produce:**
- Which channels drive the brand's citation volume (owned site, third-party, etc.)
- Per-LLM channel preference (e.g., "Claude cites your blog; ChatGPT cites Wikipedia")
- Owned page performance (which pages earn citations, page-level specifics for what IS cited)
- PR hit list: publications citing competitors but not the target brand, ranked by frequency
- Gap assessment: numbered gaps, not bulleted

**Prompt structure (draft):**
> Analyze the citation data for {brand}. Break down by channel type and AI platform. Identify which owned pages are being cited. List publications that cite competitors but not {brand}, ranked by citation frequency. Number the gaps.

**Inline summary (Citations tab):** 2–3 sentences on citation health + top gap.

---

### Section 3: Persona Gap Analysis
**Tab:** Personas tab (inline summary) + Report tab (full section)
**Maps to:** IBM report §2.2 Personas
**Data inputs:**
- Per-persona avg rank across LLMs
- Per-persona top-3 rate
- Per-persona mention count
- Specific prompts where brand is absent per persona
- Per-persona per-LLM breakdown
- Competitor performance per persona (who ranks above brand for each persona)

**Analysis the LLM should produce:**
- Per-persona block (one paragraph each):
  - Current visibility for this persona
  - Which LLMs surface the brand for this persona's queries
  - Specific prompts where the brand is missing
  - Which competitors own this persona's queries
- Gap assessment: numbered

**Prompt structure (draft):**
> Analyze how {brand} performs for each buyer persona. For each persona, describe visibility, LLM-specific performance, name specific prompts where the brand is absent, and identify which competitors dominate. Write one block per persona. Number the gaps.

**Inline summary (Personas tab):** 2–3 sentences on strongest/weakest persona.

---

### Section 4: Topic & Query Performance
**Tab:** Ranking tab (inline summary) + Report tab (full section)
**Maps to:** IBM report §2.3 Topics
**Data inputs:**
- Prompts grouped by funnel_stage (TOFU/MOFU/BOFU)
- Per-prompt avg rank and top-3 rate
- Prompts where brand is absent vs dominant
- Per-LLM performance by funnel stage
- Competitor rankings on same prompts

**Analysis the LLM should produce:**
- Funnel-stage breakdown: how the brand performs at awareness (TOFU) vs consideration (MOFU) vs decision (BOFU)
- Topic clusters where brand is strong vs absent
- Per-LLM topic preference (e.g., "Claude ranks you well on BOFU; Gemini doesn't")
- Competitive territory: topics where competitors are established
- Gap assessment: numbered

**Prompt structure (draft):**
> Analyze {brand}'s query performance by funnel stage and topic area. Identify where the brand is strong vs absent. Break down by AI platform. Identify competitive territory vs white space. Number the gaps.

**Inline summary (Ranking tab):** 2–3 sentences on funnel-stage performance.

---

### Section 5: Competitor Landscape
**Tab:** Competitors tab (inline summary) + Report tab (full section)
**Maps to:** IBM report §1.1–1.3 Competitor Deep-Dives
**Data inputs:**
- Top 3–5 competitors by mention count
- Per-competitor avg rank and mention frequency
- Per-competitor per-LLM performance
- Head-to-head: queries where competitor outranks target brand
- LLM-specific competitive dynamics

**Analysis the LLM should produce:**
- Top 3–5 competitor overview (mention count, avg rank, positioning)
- Per-competitor LLM-specific performance ("Competitor X dominates ChatGPT but is absent on Claude")
- Head-to-head comparison on key queries
- Neutral tone — no "worry about" editorializing
- Gap assessment: numbered

**Prompt structure (draft):**
> Analyze the top 3–5 competitors for {brand}. For each, describe mention frequency, average rank, and AI platform-specific performance. Identify LLM-specific competitive dynamics. Stay neutral and data-forward. Number the gaps.

**Inline summary (Competitors tab):** 2–3 sentences on competitive position.

---

### Section 6: Recommendations
**Tab:** Report tab only (end section)
**Maps to:** IBM report Key Takeaways
**Data inputs:** Synthesis of all above sections (passed as context, not raw data)
**Structure:** Grouped by category:
- **Content** — what to create/optimize
- **PR / Distribution** — where to get cited
- **Technical** — structural/SEO actions

Each recommendation backed by specific data point from the analysis.
No effort tags. No lead rec in executive summary (all recs here).

**Prompt structure (draft):**
> Based on the analysis above, provide recommendations grouped into three categories: Content, PR/Distribution, and Technical. Each recommendation must cite a specific data point. Do not tag by effort level.

---

## Tone Instructions (for all sections)

```
You are a senior AEO strategist writing a competitive analysis report.

Tone rules:
- Consultative and authoritative — write like a senior strategist briefing a peer
- Data-forward — lead with evidence, surface numbers and percentages, let findings carry the argument
- Descriptive rather than prescriptive — state what the data shows
- No hedging qualifiers — drop "effectively," "essentially," "largely" where they soften a clean claim
- No trailing emphasis — drop "entirely," "completely," "at all" that add drama without meaning
- No punchy short sentences for dramatic effect
- No vague filler phrases — avoid "table stakes," "set the tone," "it's worth noting"
- Parentheticals over em-dashes for nested clauses
- Bullets where they add clarity, particularly for platform-level breakdowns
- Gaps numbered rather than bulleted
```

---

## Architecture

### Storage
New D1 table: `report_sections`
```sql
CREATE TABLE report_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  section_key TEXT NOT NULL,  -- 'executive_summary', 'channels', 'personas', 'topics', 'competitors', 'recommendations'
  content TEXT NOT NULL,       -- markdown output from LLM
  generated_at TEXT NOT NULL,
  UNIQUE(run_id, section_key)
);
```

### Inline summaries
Separate section_key per tab inline:
- `inline_ranking`
- `inline_personas`
- `inline_citations`
- `inline_competitors`

Stored in same table. Generated alongside their parent section or independently.

### Generation flow
1. User clicks "Generate Report" button (or per-section "Generate" button)
2. Frontend sends POST to `/api/report/generate` with `{ run_id, section_key? }`
3. Backend assembles data context for that section (aggregated queries, not raw dumps)
4. Backend calls Claude via same Anthropic endpoint as assistant chat
5. Backend stores result in `report_sections` table
6. Frontend renders markdown → HTML

### Per-section data assembly
Each section gets a tailored data payload (not the full dump):
- **Executive Summary:** brand stats summary (5–10 lines of aggregated numbers)
- **Channels:** citation domains + source types + content_format distribution + per-LLM breakdown + owned pages + competitor domains
- **Personas:** per-persona rank/mention stats + absent prompts + competitor ranks per persona
- **Topics:** per-prompt performance + funnel stage grouping + per-LLM topic breakdown
- **Competitors:** top 5 competitor stats + per-LLM + head-to-head on key queries
- **Recommendations:** summaries of sections 2–5 (not raw data, the generated text)

### Regeneration
- Per-section "Regenerate" button replaces content via UPSERT on (run_id, section_key)
- No manual editing
- No highlight-to-ask

---

## Decisions (resolved)

1. **Formats dimension:** Add `content_format` column to citations table. Classify at scrape time via title + URL heuristic. New runs only (no backfill).
2. **Format categories:** `listicle` · `guide` · `review` · `research` · `unknown`
3. **Format detection rules:**
   - `listicle`: title matches `/^\d+\s/` or `/top\s+\d+/i` or `/best\s+\d+/i`
   - `guide`: title/URL contains `how to`, `guide`, `tutorial`, `step-by-step`, `101`
   - `review`: title/URL contains `vs`, `review`, `comparison`, `compare`, `alternative`
   - `research`: title/URL contains `report`, `study`, `survey`, `benchmark`, `data`
   - `unknown`: everything else
4. **Format storage:** `ALTER TABLE citations ADD COLUMN content_format TEXT` — simple column, no separate table. Redundancy across runs is negligible (short string, deterministic heuristic).
5. **Channel taxonomy:** `source_type` (owned/competitor/news/review/other) is sufficient. No new field.
6. **Report tab UI:** Sub-tabs within the Report tab (one per section).
7. **Generation flow:** Per-section API calls. Independent generation, partial gen OK, per-section regeneration.
8. **Inline summary trigger:** Auto-generate alongside parent section.
9. **Max tokens:** 4096 per section.
10. **Tone:** Consultative, data-forward, descriptive not prescriptive. No hedging, no trailing emphasis, no punchy kickers, no filler. Parentheticals over em-dashes. Bullets for platform breakdowns. Gaps numbered.
11. **Executive summary:** 3–4 sentences, no lead recommendation.
12. **Persona gaps:** Per-persona blocks, name specific missing prompts, inline + report.
13. **Competitors:** Top 3–5 only, neutral (no editorializing), yes LLM-specific dynamics.
14. **Citations:** PR hit list included, page-level (mention what IS cited), inline + report.
15. **Recommendations:** Grouped by category (Content/PR-Distribution/Technical), data-backed, no effort tags.
16. **Storage:** D1 `report_sections` table, read-only (no user edits), per-section regeneration via UPSERT.
17. **Inline summaries:** All 4 tabs (Ranking, Personas, Citations, Competitors).
