// sidebar.js — shared sidebar component with brand picker
// Include after auth.js on any page that needs the sidebar.
// Usage: <div id="aeo-sidebar"></div> then call initSidebar()

/** Shown app-wide wherever Similarity is referenced (nav, pages, admin). */
window.AEO_SIMILARITY_EXAMPLE = 'Example: C5 Customer Service Bot'

/** Global default runs (KV run_id + chip label) — same for every brand; no D1 row required. Merged with optional per-brand rows from /api/similarity/runs. */
window.AEO_SIMILARITY_DEFAULT_RUNS = [
  { run_id: 'a76731db', label: 'C5 History' },
]

;(function () {
  'use strict'

  // State
  let brands = []
  let currentBrandId = null
  let pickerOpen = false

  function escHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function getUser() {
    return window.__aeo_user || {}
  }

  // Render the sidebar HTML
  function render(container) {
    const user = getUser()
    const brand = brands.find(b => b.id === currentBrandId)
    const brandLabel = brand ? (brand.name || brand.domain || 'Brand') : 'No brand selected'

    if (pickerOpen) {
      // State B — Brand picker
      container.innerHTML = `
        <div class="sb-header">
          <span class="sb-section-title">Select Brand</span>
        </div>
        <div class="sb-brand-list">
          ${brands.map(b => `
            <div class="sb-brand-item ${b.id === currentBrandId ? 'active' : ''}" onclick="window.__sbSelectBrand('${b.id}')">
              <span class="sb-brand-radio">${b.id === currentBrandId ? '●' : '○'}</span>
              <div class="sb-brand-info">
                <div class="sb-brand-name">${escHtml(b.name || b.domain || 'Brand')}</div>
                <div class="sb-brand-domain">${escHtml(b.domain || '')}</div>
              </div>
            </div>
          `).join('')}
          <a href="/" class="sb-add-brand">+ Add Brand</a>
        </div>
      `
    } else {
      // State A — Navigation
      const brandParam = currentBrandId ? `?brandId=${currentBrandId}` : ''
      container.innerHTML = `
        <div class="sb-header">
          <a href="/" class="sb-logo"><img src="/assets/tr-logo.svg" alt="Terrain" style="height:22px;width:auto" /></a>
        </div>
        <div class="sb-brand-switcher" onclick="window.__sbTogglePicker()">
          <span class="sb-caret">▲</span>
          <span class="sb-active-brand">${escHtml(brandLabel)}</span>
          <span class="sb-caret">▼</span>
        </div>
        <nav class="sb-nav">
          <a href="/approve.html${brandParam}" class="sb-nav-item">Review</a>
          <a href="/dashboard.html" class="sb-nav-item">Dashboard</a>
          <a href="/similarity.html${brandParam}" class="sb-nav-item">Similarity</a>
          <a href="/live.html" class="sb-nav-item">Live Runs</a>
          <a href="/" class="sb-nav-item">Run History</a>
        </nav>
        <div class="sb-spacer"></div>
        <nav class="sb-nav sb-nav-bottom">
          <a href="/settings.html" class="sb-nav-item">Settings</a>
          <a href="/team.html" class="sb-nav-item">Team</a>
          ${user.is_owner ? '<a href="/admin.html" class="sb-nav-item">Admin</a>' : ''}
        </nav>
        <div class="sb-footer">
          <div class="sb-footer-top">
            <div class="sb-footer-info">
              <div class="sb-user-email">${escHtml(user.email || '')}</div>
              <div class="sb-team-name">${escHtml(user.team_name || '')}</div>
            </div>
            <button class="sb-toggle" onclick="window.__sbToggleSidebar()" title="Collapse sidebar">◀</button>
          </div>
        </div>
      `
    }
  }

  // Load brands for current team
  async function loadBrands() {
    try {
      // We don't have a dedicated list-brands endpoint yet; use the user's active brand
      // and the brands that show up in runs list as a proxy
      const user = getUser()
      currentBrandId = user.active_brand_id || null

      // Get all brands for current team
      const res = await fetch('/api/brands')
      if (res.ok) {
        const data = await res.json()
        brands = (data.brands || []).map(b => ({ id: b.id, name: b.name, domain: b.domain }))
      }

      // Auto-select first brand if none selected
      if (!currentBrandId && brands.length > 0) {
        currentBrandId = brands[0].id
        // Persist selection
        fetch('/api/auth/active', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brand_id: currentBrandId }),
        }).catch(() => {})
      }
    } catch { /* non-fatal */ }
  }

  // Select a brand
  window.__sbSelectBrand = async function (brandId) {
    currentBrandId = brandId
    pickerOpen = false
    const container = document.getElementById('aeo-sidebar')
    if (container) render(container)

    // Persist selection
    try {
      await fetch('/api/auth/active', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand_id: brandId }),
      })
    } catch { /* non-fatal */ }

    // Notify page
    if (typeof window.onBrandChanged === 'function') {
      window.onBrandChanged(brandId)
    }
  }

  // Toggle picker
  window.__sbTogglePicker = function () {
    pickerOpen = !pickerOpen
    const container = document.getElementById('aeo-sidebar')
    if (container) render(container)
  }

  // Toggle sidebar collapse
  window.__sbToggleSidebar = function () {
    const sidebar = document.getElementById('aeo-sidebar')
    if (!sidebar) return
    sidebar.classList.toggle('collapsed')
    // Ensure floating button exists
    if (!document.getElementById('sb-float-toggle')) {
      const btn = document.createElement('button')
      btn.id = 'sb-float-toggle'
      btn.className = 'sb-toggle-floating'
      btn.innerHTML = '▶'
      btn.title = 'Open sidebar'
      btn.onclick = function () { window.__sbToggleSidebar() }
      sidebar.parentNode.insertBefore(btn, sidebar.nextSibling)
    }
  }

  // Init
  window.initSidebar = async function () {
    const container = document.getElementById('aeo-sidebar')
    if (!container) return

    // Wait for auth to complete
    const waitForUser = () => new Promise(resolve => {
      if (window.__aeo_user) return resolve()
      const check = setInterval(() => {
        if (window.__aeo_user) { clearInterval(check); resolve() }
      }, 50)
      // Timeout after 5s
      setTimeout(() => { clearInterval(check); resolve() }, 5000)
    })

    await waitForUser()
    await loadBrands()
    render(container)
  }
})()
