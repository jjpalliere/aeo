import type { ScrapedPage, ScrapedContent } from '../types'

export class ScrapeBlockedError extends Error {
  constructor(url: string) {
    super(`Could not access ${url} — site blocked automated access.`)
    this.name = 'ScrapeBlockedError'
  }
}

const SKIP_EXTENSIONS = /\.(pdf|jpg|jpeg|png|gif|svg|ico|css|js|zip|mp4|mp3|woff|woff2|ttf)$/i
const SKIP_PATHS = /\/(wp-admin|wp-login|login|admin|auth|api|feed|rss|sitemap)/i
const MAX_PAGES = 20
const MAX_TEXT_PER_PAGE = 8000
const DELAY_BETWEEN_BATCHES_MS = 800 // Rate limit: ~1 req/sec per batch of 5

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function extractMeta(html: string): { title: string; description: string } {
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

/** Normalize URL for deduplication: strip www, consistent path. */
function normalizePageUrl(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const path = u.pathname.replace(/\/$/, '') || '/'
    return `${u.protocol}//${host}${path}`
  } catch {
    return url
  }
}

/** Extract canonical URL if same-origin; returns normalized origin+path or null. */
function extractCanonical(html: string, baseUrl: string): string | null {
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

/** Get HTML to extract text from: prefer <main>, else <article>(s), else full doc. */
function getContentHtml(html: string): string {
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  if (mainMatch) return mainMatch[1]

  const articleMatches = [...html.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)]
  if (articleMatches.length > 0) return articleMatches.map(m => m[1]).join('\n\n')

  return html
}

function extractText(html: string): string {
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

function extractInternalLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl)
  // Path prefix: crawl DOWN only — never up to parent paths.
  // e.g. start=/blog/ → allow /blog/post-1 but not / or /about
  const basePath = base.pathname.replace(/\/$/, '') // '' for root, '/foo/bar' otherwise

  const linkRegex = /href=["']([^"'#?]+)["']/gi
  const seen = new Set<string>()
  const links: string[] = []
  let match

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1].trim()
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:') || href.startsWith('data:')) continue

    try {
      const url = new URL(href, baseUrl)
      const urlPath = url.pathname.replace(/\/$/, '')
      // Allow only paths that are at or below the starting path
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
    } catch {
      // ignore bad URLs
    }
  }

  // Prioritize pages that look like product/service/about pages
  const priority = links.filter(l =>
    /\/(product|service|solution|platform|about|feature|pricing|how)/i.test(l)
  )
  const rest = links.filter(l => !priority.includes(l))

  return [...priority, ...rest].slice(0, MAX_PAGES)
}

async function fetchPage(url: string): Promise<{ html: string; ok: boolean }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; AEO-Bot/1.0; +https://aeo.app)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    })

    if (!response.ok) return { html: '', ok: false }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) return { html: '', ok: false }

    const html = await response.text()

    // Detect paywalls / login walls
    if (
      /<input[^>]+type=["']password["']/i.test(html) &&
      html.length < 20000
    ) {
      return { html: '', ok: false }
    }

    return { html, ok: true }
  } catch {
    return { html: '', ok: false }
  } finally {
    clearTimeout(timeout)
  }
}

export async function scrapeSite(
  startUrl: string,
  onProgress?: (step: string) => Promise<void>,
  logFn?: (line: string) => Promise<void>,
): Promise<ScrapedContent> {
  const normalized = startUrl.startsWith('http') ? startUrl : `https://${startUrl}`
  const domain = extractDomain(normalized)

  console.log(`[scraper] fetching homepage: ${normalized}`)
  const { html: homeHtml, ok: homeOk } = await fetchPage(normalized)
  if (!homeOk || !homeHtml) {
    console.error(`[scraper] ✗ homepage blocked or unreachable: ${normalized}`)
    throw new ScrapeBlockedError(normalized)
  }
  console.log(`[scraper] ✓ homepage ok (${homeHtml.length} chars)`)
  await onProgress?.('Fetching homepage')

  const homeMeta = extractMeta(homeHtml)
  const homeText = extractText(homeHtml)
  const homeCanonical = extractCanonical(homeHtml, normalized)
  const homePageUrl = normalizePageUrl(homeCanonical ?? normalized)
  const internalLinks = extractInternalLinks(homeHtml, normalized)
  console.log(`[scraper] ${internalLinks.length} internal links found`)
  await onProgress?.('Extracting internal links')

  const pages: ScrapedPage[] = [
    { url: homePageUrl, title: homeMeta.title, description: homeMeta.description, text: homeText },
  ]

  const BATCH = 5
  for (let i = 0; i < internalLinks.length; i += BATCH) {
    if (i > 0) await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES_MS))

    const batch = internalLinks.slice(i, i + BATCH)
    const results = await Promise.allSettled(batch.map(url => fetchPage(url)))

    if (i === 0) await onProgress?.('Crawling subpages')

    let batchOk = 0
    for (let j = 0; j < results.length; j++) {
      const result = results[j]
      if (result.status === 'fulfilled' && result.value.ok) {
        const { html } = result.value
        const fetchedUrl = batch[j]
        const canonical = extractCanonical(html, fetchedUrl)
        const pageUrl = normalizePageUrl(canonical ?? fetchedUrl)

        if (pages.some(p => normalizePageUrl(p.url) === pageUrl)) continue // Dedupe by canonical

        const meta = extractMeta(html)
        const text = extractText(html)
        if (text.length > 200) {
          pages.push({ url: pageUrl, title: meta.title, description: meta.description, text })
          batchOk++
        }
      }
    }
    const batchMsg = `[scraper] crawl batch ${Math.floor(i / BATCH) + 1}: ${batchOk}/${batch.length} ok — ${pages.length} pages total`
    console.log(batchMsg)
    await logFn?.(batchMsg)

    if (pages.length >= MAX_PAGES) break
  }

  await onProgress?.('Extracting text content')

  const rawTitle = homeMeta.title
  const titlePart = rawTitle.split(/[|\-–—:]/)[0].trim()
  const domainBase = domain.split('.')[0] || ''

  // Simple fallback: title or domain. LLM extracts the real brand name during persona generation.
  function formatDomainAsBrand(d: string): string {
    if (!d) return ''
    // Insert space before common words: columnfivemedia → column five media
    const withSpaces = d
      .replace(/(five|media|digital|group|studio|agency|inc|llc|co|io|ai|hq)/gi, ' $1')
      .replace(/\s+/g, ' ')
      .trim()
    return withSpaces
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ')
      || d.charAt(0).toUpperCase() + d.slice(1).toLowerCase()
  }
  const brandName = titlePart || formatDomainAsBrand(domainBase)

  const summary = pages
    .map(p => [
      `## ${p.title || p.url}`,
      `URL: ${p.url}`,
      p.description ? `Description: ${p.description}` : '',
      p.text.substring(0, 1500),
    ].filter(Boolean).join('\n'))
    .join('\n\n---\n\n')

  await onProgress?.('Building corpus')
  const doneMsg = `[scraper] ✓ done — "${brandName}", ${pages.length} pages, ${summary.length} chars corpus`
  console.log(doneMsg)
  await logFn?.(doneMsg)

  return { pages, summary, brand_name: brandName, industry_keywords: [] }
}

export { extractDomain }
