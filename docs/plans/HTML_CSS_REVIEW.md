# HTML & CSS Review — terrain.run

**Date:** March 2026  
**Scope:** `public/*.html`, `public/assets/styles.css`

---

## Executive Summary

The codebase has a solid design-token foundation and consistent dark theme. Main issues: **duplication** between inline styles and `styles.css`, **inconsistencies** in shared components, and **remaining `!important`** in a few places. Responsive behavior is well-handled; accessibility could be improved.

---

## 1. Design Tokens & Architecture

**Strengths:**
- Clear token hierarchy in `:root` (surfaces, text, borders, LLM colors)
- Good documentation in CSS comments
- Consistent use of `var(--*)` for colors, spacing, typography

**Issues:**
- `--text` is `rgb(238, 82, 24)` (orange) — primary content color. Ensure this is intentional for brand.
- `--dash-section-header` maps to `--accent` (white); chart titles correctly override to `--text2`.

---

## 2. Duplication

### 2.1 `rank-badge` — duplicated in dashboard.html and styles.css

| Location | `.rank-other` color |
|----------|---------------------|
| `dashboard.html` (inline) | `var(--dash-row-muted)` |
| `styles.css` | `var(--text3)` |

**Recommendation:** Remove from `dashboard.html`; rely on `styles.css`. Align on `--text3` (both map to `#9f9a9a`; `--dash-row-muted` is an alias).

### 2.2 `#runs-sidebar` and sidebar styles — duplicated in index.html and dashboard.html

Both files define nearly identical sidebar styles (~80 lines each):
- `#runs-sidebar`, `.collapsed`, `.sidebar-toggle`, `.sidebar-header`, `.sidebar-run`, etc.

**Recommendation:** Move shared sidebar styles to `styles.css` under a `.runs-sidebar` section. Use a shared class (e.g. `.runs-sidebar-layout`) for pages that use it. Keep page-specific overrides (e.g. `.index-main` vs `.dash-main`) in each file or in a small `dashboard-sidebar.css` / `index-sidebar.css` if needed.

### 2.3 `target-row` — conflicting definitions

| Location | Value |
|----------|-------|
| `dashboard.html` | `var(--accent-dim)` |
| `styles.css` | `var(--w-02)` |

**Recommendation:** Use a single definition in `styles.css`. `--accent-dim` is `var(--w-04)` (stronger highlight); `--w-02` is subtler. Choose one and remove the other.

---

## 3. Inline Styles in HTML

### 3.1 Large `<style>` blocks

Each HTML file has 50–250+ lines of page-specific CSS. This is acceptable for page-unique layout, but:

- **dashboard.html** (~270 lines): Citation filters, pg-sub, charts-split, sidebar, modal, etc.
- **index.html** (~200 lines): Sidebar, setup-wrap, hero, predict panels
- **approve.html** (~150 lines): Funnel columns, persona grid
- **login.html** (~80 lines): Login container, frost overlay
- **run.html**, **live.html**: Similar patterns

**Recommendation:** Extract shared patterns into `styles.css`. For example:
- `.citation-*` rules → `styles.css` (or `citation-panel.css`)
- `.pg-*` (prompt groups) → `styles.css`
- Sidebar rules → `styles.css`

Keep only truly page-specific rules inline (e.g. `.login-brand` on login only).

### 3.2 Inline `style=""` attributes

Used sparingly and mostly for layout (e.g. `display:flex`, `gap:12px`). Consider replacing with utility classes (`.flex`, `.gap-3`) where they already exist in `styles.css`.

---

## 4. Remaining `!important`

| File | Selector | Purpose |
|------|----------|---------|
| `index.html` | `html, body` | `background: #0a0a0a; overflow-x: hidden` |
| `run.html` | `html, body` | Same |
| `login.html` | `html, body` | `background: #080807` |
| `styles.css` | `@media (max-width: 768px)` | Mobile overrides (sidebar hide, layout) |

**Recommendation:**
- **Page backgrounds:** Set `body { background: var(--bg); }` in `styles.css` and ensure no other rule overrides it. If pages need different backgrounds, use a body class (e.g. `body.login-page`) and target that.
- **Mobile overrides:** These are in a media query and often need to override layout. Consider increasing specificity instead of `!important` (e.g. `body.mobile .dash-main` or a wrapper class) so the cascade can be managed without `!important`.

---

## 5. Stylesheet Loading

- **dashboard.html:** `href="/assets/styles.css?v=3"` — cache busting present
- **Other pages:** `href="/assets/styles.css"` — no cache busting

**Recommendation:** Use a build step or shared partial to inject a version hash, or add `?v=` consistently. For now, at least align dashboard with others (or add `?v=1` everywhere).

---

## 6. HTML Structure & Semantics

**Strengths:**
- `lang="en"` on `<html>`
- `<meta charset="UTF-8">` and viewport
- Semantic use of `<main>`, `<aside>`, `<section>` where applicable

**Improvements:**
- Add `aria-label` to icon-only buttons (e.g. sidebar toggle, modal close)
- Ensure form inputs have associated `<label>` (some use placeholder-only)
- Tables: add `scope="col"` on `<th>` where appropriate
- Loading state: consider `aria-live="polite"` for dynamic content updates

---

## 7. Responsive Design

**Strengths:**
- Single breakpoint at 768px (and 1100px, 600px for specific cases)
- Sidebar hidden on mobile; nav scrolls horizontally
- Tables get horizontal scroll via `.table-wrap`
- Grids collapse to single column

**Considerations:**
- `overflow-x: clip` on body (768px) — good for preventing horizontal scroll
- Print styles use `!important` for layout overrides — acceptable for print

---

## 8. Specific Recommendations (Priority Order)

### High
1. **Remove `rank-badge` duplication** — delete from dashboard, use styles.css only.
2. **Unify `target-row`** — pick one definition, remove the other.
3. **Consolidate sidebar styles** — move to styles.css, reduce index/dashboard inline CSS.

### Medium
4. **Extract citation panel CSS** — move `.citation-*` from dashboard to styles.css.
5. **Replace page `!important` on body** — use body classes and cascade.
6. **Align cache busting** — consistent `?v=` or build-based versioning.

### Low
7. **Add ARIA where needed** — icon buttons, live regions.
8. **Reduce inline `style=""`** — use utility classes where possible.

---

## 9. File-by-File Notes

| File | Lines (est.) | Notes |
|------|--------------|------|
| `styles.css` | ~1130 | Well-organized, good comments. Print block could be split. |
| `dashboard.html` | ~1950 | Largest; most duplication. Good candidate for extraction. |
| `index.html` | ~785 | Sidebar + setup UI. Hero and predict panels are page-specific. |
| `approve.html` | ~1520 | Funnel/persona layout is unique; keep inline or extract to approve.css. |
| `run.html` | ~450 | Lean; shares run layout styles. |
| `live.html` | ~450 | Similar to run. |
| `login.html` | ~190 | Minimal; login-specific styles are fine inline. |

---

## 10. Conclusion

The design system is coherent and the token approach is sound. The main gains will come from:

1. Reducing duplication (rank-badge, sidebar, target-row)
2. Moving shared components from inline `<style>` into `styles.css`
3. Cleaning up remaining `!important` with better specificity

These changes will make the codebase easier to maintain and keep styling consistent across pages.
