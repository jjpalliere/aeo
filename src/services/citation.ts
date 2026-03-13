import type { Citation } from '../types'

const TIMEOUT_MS = 8000
const MAX_TEXT = 6000

const NEWS_DOMAINS = new Set([
  'reuters.com', 'bloomberg.com', 'wsj.com', 'nytimes.com', 'ft.com',
  'techcrunch.com', 'wired.com', 'theverge.com', 'arstechnica.com',
  'forbes.com', 'businessinsider.com', 'cnbc.com', 'bbc.com', 'cnn.com',
  'axios.com', 'venturebeat.com', 'zdnet.com', 'cnet.com', 'engadget.com',
  'mashable.com', 'fastcompany.com', 'inc.com', 'hbr.org', 'medium.com',
  'substack.com', 'washingtonpost.com', 'guardian.com', 'economist.com',
])

const VERTEX_GROUNDING_PREFIX = 'https://vertexaisearch.cloud.google.com/grounding'

function isVertexGroundingUrl(url: string): boolean {
  return url.startsWith(VERTEX_GROUNDING_PREFIX)
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function extractPageMeta(html: string): { title: string; companyName: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const ogSiteMatch =
    html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)

  const fullTitle = titleMatch ? titleMatch[1].trim() : ''
  const ogSite = ogSiteMatch ? ogSiteMatch[1].trim() : ''

  // Company name: prefer og:site_name, fallback to first part of title
  const companyName =
    ogSite || fullTitle.split(/[|\-–—:]/)[0].trim() || ''

  return { title: fullTitle, companyName }
}

function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, MAX_TEXT)
}

function isLikelyPaywall(html: string): boolean {
  const lower = html.toLowerCase()
  return (
    (lower.includes('subscribe') || lower.includes('sign in')) &&
    html.length < 15000 &&
    lower.includes('premium')
  )
}

function classifySource(
  domain: string,
  brandDomain: string,
  allCompetitorDomains: Set<string>
): 'owned' | 'competitor' | 'news' | 'industry' | 'unknown' {
  if (domain === brandDomain || domain.endsWith(`.${brandDomain}`)) return 'owned'
  if (allCompetitorDomains.has(domain)) return 'competitor'
  if (NEWS_DOMAINS.has(domain)) return 'news'
  return 'unknown' // will be refined in analyzer after all citations are collected
}

export async function scrapeCitation(
  url: string,
  brandDomain: string,
  knownCompetitorDomains: Set<string>
): Promise<Omit<Citation, 'id' | 'query_id' | 'created_at'>> {
  const domain = extractDomain(url)
  const shortUrl = url.length > 60 ? url.slice(0, 57) + '...' : url

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
    console.log(`[citation] fetching ${domain} — ${shortUrl}`)

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AEO-Bot/1.0)',
        Accept: 'text/html',
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timeout)

    // Vertex grounding URLs: use redirect target, or parse HTML for target link if no redirect
    let resolvedUrl = url
    let resolvedDomain = domain
    if (isVertexGroundingUrl(url)) {
      if (response.url && response.url !== url && !response.url.includes('vertexaisearch')) {
        resolvedUrl = response.url
        resolvedDomain = extractDomain(resolvedUrl)
        console.log(`[citation] Vertex URL resolved via redirect → ${resolvedDomain}`)
      }
    }

    if (!response.ok) {
      console.log(`[citation] ✗ ${domain} — HTTP ${response.status} ${response.statusText}`)
      return {
        url: resolvedUrl,
        domain: resolvedDomain,
        page_title: null,
        on_page_text: null,
        company_name: null,
        source_type: classifySource(resolvedDomain, brandDomain, knownCompetitorDomains),
        scraped_ok: 0,
      }
    }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) {
      console.log(`[citation] ✗ ${resolvedDomain} — non-HTML content-type: ${contentType.slice(0, 50)}`)
      return {
        url: resolvedUrl,
        domain: resolvedDomain,
        page_title: null,
        on_page_text: null,
        company_name: null,
        source_type: classifySource(resolvedDomain, brandDomain, knownCompetitorDomains),
        scraped_ok: 0,
      }
    }

    const html = await response.text()
    console.log(`[citation] ${resolvedDomain} — ${html.length} chars HTML received`)

    // If Vertex URL didn't redirect, try to extract target from HTML (meta refresh or first external link)
    if (isVertexGroundingUrl(url) && resolvedUrl === url) {
      const metaRefresh = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'\s>]+)/i)
      const linkMatch = html.match(/<a[^>]+href=["'](https?:\/\/[^"']+)["']/i)
      const target = metaRefresh?.[1] ? decodeURIComponent(metaRefresh[1]) : linkMatch?.[1]
      if (target && !target.includes('vertexaisearch')) {
        resolvedUrl = target
        resolvedDomain = extractDomain(resolvedUrl)
        console.log(`[citation] Vertex URL resolved via HTML → ${resolvedDomain}`)
      }
    }

    if (isLikelyPaywall(html)) {
      console.log(`[citation] ✗ ${resolvedDomain} — likely paywall (subscribe/premium detected)`)
      return {
        url: resolvedUrl,
        domain: resolvedDomain,
        page_title: null,
        on_page_text: null,
        company_name: null,
        source_type: classifySource(resolvedDomain, brandDomain, knownCompetitorDomains),
        scraped_ok: 0,
      }
    }

    const { title, companyName } = extractPageMeta(html)
    const text = extractText(html)
    const sourceType = classifySource(resolvedDomain, brandDomain, knownCompetitorDomains)
    console.log(`[citation] ✓ ${resolvedDomain} — ${text.length} chars text, source=${sourceType}, title="${(title || '').slice(0, 40)}${(title?.length ?? 0) > 40 ? '…' : ''}"`)

    return {
      url: resolvedUrl,
      domain: resolvedDomain,
      page_title: title || null,
      on_page_text: text || null,
      company_name: companyName || domain,
      source_type: sourceType,
      scraped_ok: 1,
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const isTimeout = errMsg.includes('abort') || errMsg.includes('timeout')
    console.log(`[citation] ✗ ${domain} — ${isTimeout ? 'timeout/fetch aborted' : 'fetch failed'}: ${errMsg.slice(0, 80)}`)
    return {
      url,
      domain,
      page_title: null,
      on_page_text: null,
      company_name: null,
      source_type: classifySource(domain, brandDomain, knownCompetitorDomains),
      scraped_ok: 0,
    }
  }
}

export { extractDomain as getDomain }
