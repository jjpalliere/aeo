import type { LLMApiKeys } from '../types'

export interface LLMResponse {
  response_text: string
  citations: string[]
}

// ─── Citation extraction ─────────────────────────────────────────────────────

// Allow ) in URLs (e.g. Wikipedia /wiki/Example_(disambiguation)); trailing ) stripped by clean step
const URL_REGEX = /https?:\/\/[^\s\]"',]+/g

export function extractCitations(text: string): string[] {
  const found = new Set<string>()

  // Bare URLs and markdown links
  const matches = text.match(URL_REGEX) || []
  for (const url of matches) {
    // Clean trailing punctuation
    const clean = url.replace(/[.,;:!?)]+$/, '')
    try {
      new URL(clean) // validate
      found.add(clean)
    } catch {}
  }

  // Numbered footnote-style [1]: https://...
  const footnoteRegex = /\[\d+\]:\s*(https?:\/\/[^\s]+)/g
  let m
  while ((m = footnoteRegex.exec(text)) !== null) {
    const clean = m[1].replace(/[.,;:!?)]+$/, '')
    try {
      new URL(clean)
      found.add(clean)
    } catch {}
  }

  // Markdown links [text](url)
  const mdLinkRegex = /\]\((https?:\/\/[^)\s]+)\)/g
  while ((m = mdLinkRegex.exec(text)) !== null) {
    const clean = m[1].replace(/[.,;:!?)]+$/, '')
    try {
      new URL(clean)
      found.add(clean)
    } catch {}
  }

  return [...found]
}

// ─── Claude ──────────────────────────────────────────────────────────────────

async function queryClaude(
  systemMessage: string,
  userMessage: string,
  apiKey: string
): Promise<LLMResponse> {
  const start = Date.now()
  console.log(`[llm] claude → querying (${userMessage.length} chars)`)

  const attempt = async (): Promise<Response> => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: systemMessage,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: userMessage }],
      }),
    })
    if (!response.ok) {
      const err = await response.text()
      throw Object.assign(new Error(`Claude API error ${response.status}: ${err}`), {
        status: response.status,
        response,
      })
    }
    return response
  }

  let response: Response | null = null
  for (let attemptNum = 0; attemptNum <= 3; attemptNum++) {
    try {
      response = await attempt()
      break
    } catch (err: any) {
      if (err.status === 429 && attemptNum < 3) {
        const retryAfter = err.response?.headers?.get?.('retry-after')
        const waitSec = retryAfter ? Math.min(parseInt(retryAfter, 10) || 60, 120) : 60
        console.log(`[llm] claude 429 — waiting ${waitSec}s (retry ${attemptNum + 1}/3)`)
        await new Promise(r => setTimeout(r, waitSec * 1000))
      } else {
        console.error(`[llm] claude ✗ ${err.status ?? '?'}: ${err.message?.substring(0, 200)}`)
        throw err
      }
    }
  }
  if (!response) throw new Error('Claude API: no response after retries')

  const data = await response.json() as {
    content?: Array<Record<string, unknown>>
  }

  const content = data.content ?? []

  // Concatenate all text blocks (tool_use and tool_result blocks are skipped for text)
  const text = content
    .filter((c): c is Record<string, unknown> & { type: string; text?: string } => c?.type === 'text')
    .map(c => (c.text ?? '') as string)
    .join('')

  // Extract URLs from Claude citations (see docs/LLM_CITATION_STRUCTURES.md):
  // 1. search_result blocks: { type: "search_result", source: "https://..." }
  // 2. tool_result / web_search_tool_result: content array with { url?, source? } or { type: "web_search_result", url: "..." }
  // 3. Recursively handle nested content
  function extractUrlsFromBlocks(blocks: unknown[]): string[] {
    const urls: string[] = []
    for (const c of blocks) {
      if (!c || typeof c !== 'object') continue
      const obj = c as Record<string, unknown>
      const t = String(obj.type ?? '')
      if (t === 'search_result' && typeof obj.source === 'string') urls.push(obj.source)
      // web_search_20250305 returns web_search_tool_result with web_search_result items (url field)
      if ((t === 'tool_result' || t === 'web_search_tool_result') && obj.content) {
        const items = Array.isArray(obj.content) ? obj.content : [obj.content]
        for (const r of items) {
          if (r && typeof r === 'object') {
            const rObj = r as Record<string, unknown>
            const rType = String(rObj.type ?? '')
            const u = (rObj.url ?? rObj.source) as string | undefined
            if (typeof u === 'string' && u.length > 0) urls.push(u)
            if (rType === 'search_result' && typeof rObj.source === 'string') urls.push(rObj.source)
            if (rType === 'web_search_result' && typeof rObj.url === 'string') urls.push(rObj.url)
            if (Array.isArray(rObj.content)) urls.push(...extractUrlsFromBlocks(rObj.content))
          }
        }
      }
    }
    return urls
  }

  const searchResultUrls = extractUrlsFromBlocks(content)
  const inlineUrls = extractCitations(text)
  const allCitations = [...new Set([...searchResultUrls, ...inlineUrls])]

  if (searchResultUrls.length === 0 && inlineUrls.length > 0) {
    console.log(`[llm] claude — 0 structured citations, ${inlineUrls.length} from inline text`)
  }
  console.log(`[llm] claude ✓ ${((Date.now() - start) / 1000).toFixed(1)}s — ${text.length} chars, ${allCitations.length} citations`)
  return { response_text: text, citations: allCitations }
}

// ─── ChatGPT ─────────────────────────────────────────────────────────────────

async function queryChatGPT(
  systemMessage: string,
  userMessage: string,
  apiKey: string
): Promise<LLMResponse> {
  const start = Date.now()
  console.log(`[llm] chatgpt → querying`)

  const attempt = async () => {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        tools: [{ type: 'web_search' }],
        tool_choice: { type: 'web_search' },
        instructions: systemMessage,
        input: userMessage,
        max_output_tokens: 2048,
        include: ['web_search_call.action.sources'],
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw Object.assign(new Error(`OpenAI API error ${res.status}: ${err}`), { status: res.status, body: err })
    }
    return res
  }

  let response: Response
  try {
    response = await attempt()
  } catch (err: any) {
    if (err.status === 429) {
      console.log(`[llm] chatgpt 429 — waiting 5s then retrying`)
      await new Promise(r => setTimeout(r, 5000))
      try {
        response = await attempt()
      } catch (retryErr: any) {
        console.error(`[llm] chatgpt ✗ retry failed: ${retryErr.message?.substring(0, 200)}`)
        throw retryErr
      }
    } else {
      console.error(`[llm] chatgpt ✗ ${err.status ?? '?'}: ${err.message?.substring(0, 200)}`)
      throw err
    }
  }

  // OpenAI Responses API: annotations (url_citation) + web_search_call.action.sources fallback
  // Annotations are inconsistent; sources is more reliable when include is requested
  const data = await response.json() as {
    output?: Array<{
      type: string
      content?: Array<{
        type: string
        text?: string
        annotations?: Array<{ type: string; url?: string; title?: string }>
      }>
      action?: { type?: string; sources?: Array<{ type?: string; url?: string }> }
    }>
  }

  const messageItem = data.output?.find((o: { type: string }) => o.type === 'message')
  const content = messageItem?.content ?? []
  const text = content
    .filter((c: { type: string }) => c.type === 'output_text')
    .map((c: { text?: string }) => c.text ?? '')
    .join('')

  const annotationUrls: string[] = content
    .flatMap((c: { annotations?: Array<{ type: string; url?: string }> }) => c.annotations ?? [])
    .filter((a): a is { type: string; url: string } => a.type === 'url_citation' && typeof a.url === 'string')
    .map(a => a.url)

  const sourceUrls: string[] = (data.output ?? [])
    .filter((o: { type?: string }) => o.type === 'web_search_call')
    .flatMap((o: { action?: { sources?: Array<{ url?: string }> } }) => o.action?.sources ?? [])
    .map((s: { url?: string }) => s.url)
    .filter((u): u is string => typeof u === 'string' && u.startsWith('http'))

  const inlineUrls = extractCitations(text)
  const allCitations = [...new Set([...annotationUrls, ...sourceUrls, ...inlineUrls])]

  console.log(`[llm] chatgpt ✓ ${((Date.now() - start) / 1000).toFixed(1)}s — ${text.length} chars, ${allCitations.length} citations`)
  return { response_text: text, citations: allCitations }
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

async function queryGemini(
  systemMessage: string,
  userMessage: string,
  apiKey: string
): Promise<LLMResponse> {
  const start = Date.now()
  console.log(`[llm] gemini → querying`)

  const attempt = async () => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemMessage }] },
          contents: [{ parts: [{ text: userMessage }] }],
          generationConfig: { maxOutputTokens: 2048 },
          tools: [{ google_search: {} }],
        }),
      }
    )
    if (!res.ok) {
      const err = await res.text()
      throw Object.assign(new Error(`Gemini API error ${res.status}: ${err}`), { status: res.status })
    }
    return res
  }

  let response: Response
  try {
    response = await attempt()
  } catch (err: any) {
    if (err.status === 429) {
      console.log(`[llm] gemini 429 — waiting 5s then retrying`)
      await new Promise(r => setTimeout(r, 5000))
      try {
        response = await attempt()
      } catch (retryErr: any) {
        console.error(`[llm] gemini ✗ retry failed: ${retryErr.message?.substring(0, 200)}`)
        throw retryErr
      }
    } else {
      console.error(`[llm] gemini ✗ ${err.status ?? '?'}: ${err.message?.substring(0, 200)}`)
      throw err
    }
  }

  // Gemini API: groundingChunks[].web.uri (Vertex redirect) + title (domain fallback)
  const data = await response.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> }
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>
      }
    }>
  }

  const text = data.candidates?.[0]?.content?.parts
    ?.map(p => p.text ?? '')
    .join('') ?? ''

  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []
  const groundingUrls: string[] = []
  for (const c of chunks) {
    const uri = c.web?.uri
    const title = c.web?.title
    if (typeof uri === 'string' && uri) groundingUrls.push(uri)
    // When uri is Vertex, add https://title as fallback (title is often domain like "example.com")
    if (typeof title === 'string' && title && /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(title.trim())) {
      groundingUrls.push(`https://${title.trim()}`)
    }
  }

  const inlineUrls = extractCitations(text)
  const allCitations = [...new Set([...inlineUrls, ...groundingUrls])]

  console.log(`[llm] gemini ✓ ${((Date.now() - start) / 1000).toFixed(1)}s — ${text.length} chars, ${allCitations.length} citations`)
  return { response_text: text, citations: allCitations }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export async function queryLLM(
  llm: 'claude' | 'chatgpt' | 'gemini',
  systemMessage: string,
  userMessage: string,
  apiKeys: LLMApiKeys
): Promise<LLMResponse> {
  switch (llm) {
    case 'claude':
      return queryClaude(systemMessage, userMessage, apiKeys.anthropic)
    case 'chatgpt':
      return queryChatGPT(systemMessage, userMessage, apiKeys.openai)
    case 'gemini':
      return queryGemini(systemMessage, userMessage, apiKeys.google)
    default:
      throw new Error(`Unknown LLM: ${llm}`)
  }
}
