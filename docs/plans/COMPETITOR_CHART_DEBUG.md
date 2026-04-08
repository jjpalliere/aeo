# Competitor Chart Pipeline Report

## What's Working

### 1. Data Pipeline
- **API**: `/api/runs/${runId}/results` returns `competitorDetail` and `competitorRanks`
- **Normalization**: `load()` normalizes `data.competitorDetail` and `data.competitorRanks`
- **buildCompetitors()**: Uses `competitorDetail?.length ? competitorDetail : competitorRanks`
- **Competitor Table**: Renders brands, mentions, ranks — **SHOWS DATA**
- **Competitor Analysis**: Accordion with brand names — **SHOWS DATA**

### 2. Chart Data (buildOverview)
- Same data source: `compsForOverview = competitorDetail?.length ? competitorDetail : competitorRanks`
- `competitors = compsForOverview.filter(r => !r.is_target)`
- `topComp = [...competitors].sort(...).slice(0,8)`
- `mentionValues = topComp.map(c => totalMentions(c))`
- If table has data, chart receives same data

### 3. Other Charts
- **chart-visibility** (LLM Top-3): In `#panel-ranking` — **WORKS**
- **chart-sourceTypes** (Citation Sources): In `#panel-ranking` — **WORKS**
- **chart-competitors**: In `#panel-competitors` — **BLACK/EMPTY**

## Root Cause

**Panel visibility on load:**
- `#panel-ranking` has class `active` on load → `display: block`
- `#panel-competitors` has NO active class → `display: none`

**Chart.js behavior:**
- Canvas inside `display: none` has **0 width, 0 height**
- Chart is created with 0 dimensions
- When user switches to Competitors, panel becomes visible but **Chart.js does not auto-resize**
- Chart stays at 0×0 → appears black/empty

## Fix

Call `charts.competitors?.resize()` when switching to the Competitors panel so the chart recalculates dimensions and redraws.
