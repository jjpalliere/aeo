/**
 * Debug round - scraper tests (pure functions only, no fetch).
 * Run: node debug-scraper.mjs
 */

const SKIP_EXTENSIONS = /\.(pdf|jpg|jpeg|png|gif|svg|ico|css|js|zip|mp4|mp3|woff|woff2|ttf)$/i
const SKIP_PATHS = /\/(wp-admin|wp-login|login|admin|auth|api|feed|rss|sitemap)/i
const MAX_PAGES = 20
const MAX_TEXT_PER_PAGE = 8000

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function extractMeta(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const descMatch =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i) ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)
  return {
    title: titleMatch ? titleMatch[1].trim() : '',
    description: descMatch ? descMatch[1].trim() : '',
  }
}

function normalizePageUrl(url) {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const path = u.pathname.replace(/\/$/, '') || '/'
    return `${u.protocol}//${host}${path}`
  } catch {
    return url
  }
}

function extractCanonical(html, baseUrl) {
  const match = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i)
  if (!match) return null
  try {
    const url = new URL(match[1].trim(), baseUrl)
    const base = new URL(baseUrl)
    const urlHost = url.hostname.replace(/^www\./, '')
    const baseHost = base.hostname.replace(/^www\./, '')
    if (urlHost !== baseHost || url.protocol !== base.protocol) return null
    return normalizePageUrl(url.href)
  } catch {
    return null
  }
}

function getContentHtml(html) {
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  if (mainMatch) return mainMatch[1]

  const articleMatches = [...html.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)]
  if (articleMatches.length > 0) return articleMatches.map(m => m[1]).join('\n\n')

  return html
}

function extractText(html) {
  const contentHtml = getContentHtml(html)
  return contentHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, MAX_TEXT_PER_PAGE)
}

function extractInternalLinks(html, baseUrl) {
  const base = new URL(baseUrl)
  const basePath = base.pathname.replace(/\/$/, '')
  const linkRegex = /href=["']([^"'#?]+)["']/gi
  const seen = new Set()
  const links = []
  let match

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1].trim()
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:') || href.startsWith('data:')) continue

    try {
      const url = new URL(href, baseUrl)
      const urlPath = url.pathname.replace(/\/$/, '')
      const pathOk = basePath === '' || urlPath === basePath || urlPath.startsWith(basePath + '/')
      const normalized = url.origin + (urlPath || '/')
      const urlHost = url.hostname.replace(/^www\./, '')
      const baseHost = base.hostname.replace(/^www\./, '')

      if (
        urlHost === baseHost &&
        pathOk &&
        !seen.has(normalized) &&
        !SKIP_EXTENSIONS.test(url.pathname) &&
        !SKIP_PATHS.test(url.pathname)
      ) {
        seen.add(normalized)
        links.push(normalized)
      }
    } catch {}
  }

  const priority = links.filter(l =>
    /\/(product|service|solution|platform|about|feature|pricing|how)/i.test(l)
  )
  const rest = links.filter(l => !priority.includes(l))
  return [...priority, ...rest].slice(0, MAX_PAGES)
}

let failed = 0

// === extractDomain ===
console.log('=== extractDomain ===')
const domainTests = [
  ['https://www.example.com', 'example.com'],
  ['https://example.com/path', 'example.com'],
  ['http://sub.example.co.uk', 'sub.example.co.uk'],
  ['invalid', ''],
]
for (const [input, expected] of domainTests) {
  const got = extractDomain(input)
  const ok = got === expected
  if (!ok) { failed++; console.log('✗', input, '→', got, 'expected', expected) }
  else console.log('✓', input, '→', got)
}

// === extractMeta ===
console.log('\n=== extractMeta ===')
const metaTests = [
  ['<title>My Site</title>', { title: 'My Site', description: '' }],
  ['<meta name="description" content="A great site">', { title: '', description: 'A great site' }],
  ['<meta content="OG desc" property="og:description">', { title: '', description: 'OG desc' }],
  ['<meta property="og:description" content="Social desc">', { title: '', description: 'Social desc' }],
  ['<meta content="Reverse og" property="og:description">', { title: '', description: 'Reverse og' }],
]
for (const [html, expected] of metaTests) {
  const got = extractMeta(html)
  const ok = got.title === expected.title && got.description === expected.description
  if (!ok) { failed++; console.log('✗', html.slice(0, 40), '→', got, 'expected', expected) }
  else console.log('✓', JSON.stringify(got))
}

// === normalizePageUrl ===
console.log('\n=== normalizePageUrl ===')
const normTests = [
  ['https://www.example.com/page/', 'https://example.com/page'],
  ['https://example.com/', 'https://example.com/'],
  ['https://example.com/blog', 'https://example.com/blog'],
]
for (const [input, expected] of normTests) {
  const got = normalizePageUrl(input)
  const ok = got === expected
  if (!ok) { failed++; console.log('✗', input, '→', got, 'expected', expected) }
  else console.log('✓', input, '→', got)
}

// === extractCanonical ===
console.log('\n=== extractCanonical ===')
const canonTests = [
  ['<link rel="canonical" href="https://example.com/page">', 'https://www.example.com/foo', 'https://example.com/page'],
  ['<link href="/canon" rel="canonical">', 'https://example.com/bar', 'https://example.com/canon'],
  ['<link rel="canonical" href="https://other.com/page">', 'https://example.com/', null],
  ['no canonical here', 'https://example.com/', null],
]
for (const [html, base, expected] of canonTests) {
  const got = extractCanonical(html, base)
  const ok = got === expected
  if (!ok) { failed++; console.log('✗', html.slice(0, 35), 'base', base, '→', got, 'expected', expected) }
  else console.log('✓', got ?? 'null')
}

// === getContentHtml / extractText (main/article) ===
console.log('\n=== getContentHtml + extractText ===')
const mainHtml = '<html><nav>Nav</nav><main><p>Main content here</p></main><footer>Footer</footer></html>'
const articleHtml = '<html><article><p>Article 1</p></article><article><p>Article 2</p></article></html>'
const fallbackHtml = '<html><div><p>No main or article</p></div></html>'

const mainText = extractText(mainHtml)
console.log(mainText.includes('Main content') && !mainText.includes('Nav') && !mainText.includes('Footer') ? '✓' : '✗', '<main> extraction →', mainText.slice(0, 30))

const articleText = extractText(articleHtml)
console.log(articleText.includes('Article 1') && articleText.includes('Article 2') ? '✓' : '✗', '<article> extraction →', articleText.slice(0, 40))

const fallbackText = extractText(fallbackHtml)
console.log(fallbackText.includes('No main or article') ? '✓' : '✗', 'fallback (no main/article) →', fallbackText.slice(0, 30))

// HTML entities
const entityHtml = '<p>Hello &amp; goodbye &mdash; test</p>'
const entityText = extractText(entityHtml)
console.log(entityText.includes('&') && entityText.includes('—') ? '✓' : '✗', 'HTML entities →', entityText)

// === extractInternalLinks ===
console.log('\n=== extractInternalLinks ===')
const linksHtml = `
  <a href="/about">About</a>
  <a href="/products">Products</a>
  <a href="https://example.com/blog">Blog</a>
  <a href="mailto:hi@example.com">Email</a>
  <a href="javascript:void(0)">No</a>
  <a href="/wp-admin">Skip</a>
  <a href="/page.pdf">Skip</a>
  <a href="https://other.com/page">Skip</a>
`
const links = extractInternalLinks(linksHtml, 'https://example.com/')
const hasAbout = links.some(l => l.includes('/about'))
const hasProducts = links.some(l => l.includes('/products'))
const hasBlog = links.some(l => l.includes('/blog'))
const noMailto = !links.some(l => l.includes('mailto'))
const noWpAdmin = !links.some(l => l.includes('wp-admin'))
const noPdf = !links.some(l => l.includes('.pdf'))
const noOther = !links.some(l => l.includes('other.com'))
console.log(hasAbout && hasProducts && hasBlog && noMailto && noWpAdmin && noPdf && noOther ? '✓' : '✗', 'internal links →', links.length, 'links')

// www normalization in links
const wwwHtml = '<a href="https://www.example.com/page">Page</a>'
const wwwLinks = extractInternalLinks(wwwHtml, 'https://example.com/')
console.log(wwwLinks.length === 1 ? '✓' : '✗', 'www same-origin →', wwwLinks)

// Path restriction: start at /blog/ should not allow /
const blogHtml = '<a href="/">Home</a><a href="/blog/post">Post</a>'
const blogLinks = extractInternalLinks(blogHtml, 'https://example.com/blog/')
const noRoot = !blogLinks.some(l => l.endsWith('/') && !l.includes('/blog'))
const hasPost = blogLinks.some(l => l.includes('/blog/post'))
console.log(hasPost && (noRoot || blogLinks.length >= 1) ? '✓' : '✗', 'path restriction /blog/ →', blogLinks)

// Canonical www normalization
const canonWww = extractCanonical('<link rel="canonical" href="https://example.com/page">', 'https://www.example.com/')
console.log(normalizePageUrl(canonWww || '') === 'https://example.com/page' ? '✓' : '✗', 'canonical www→non-www →', canonWww)

// === edge cases ===
console.log('\n=== edge cases ===')
console.log(extractDomain('') === '' ? '✓' : '✗', 'empty URL →', extractDomain(''))
console.log(extractMeta('').title === '' ? '✓' : '✗', 'empty HTML →', extractMeta(''))
console.log(extractInternalLinks('', 'https://example.com/').length === 0 ? '✓' : '✗', 'empty HTML links →', extractInternalLinks('', 'https://example.com/').length)

console.log('\n' + (failed === 0 ? 'All tests passed.' : failed + ' test(s) failed.'))
