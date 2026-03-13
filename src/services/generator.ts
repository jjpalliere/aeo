import type { Env, ScrapedContent } from '../types'

export interface GeneratedPrompt {
  text: string
  funnel_stage: 'tofu' | 'mofu' | 'bofu'
  rationale: string
}

export interface ClassifiedPrompt extends GeneratedPrompt {
  keep: boolean
  filter_reason: string | null
}

export interface GeneratedPersona {
  name: string
  description: string
  goals: string[]
  pain_points: string[]
  system_message: string
  rationale: string
}

// ---------------------------------------------------------------------------
// Core API helpers
// ---------------------------------------------------------------------------

/**
 * pingOpenAI — fast API key / connectivity check using the cheapest possible call.
 * Run this BEFORE any scraping or generation so bad-key errors surface in ~2s, not 4+ minutes.
 */
export async function pingOpenAI(apiKey: string): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      signal: ctrl.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      const parsed = (() => { try { return JSON.parse(errBody) as { error?: { message?: string } } } catch { return {} } })()
      throw new Error(parsed?.error?.message ? `OpenAI API error: ${parsed.error.message}` : `OpenAI API error ${response.status}`)
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('OpenAI API ping timed out (10s) — check your network or API status')
    throw e
  } finally {
    clearTimeout(t)
  }
}

/** @deprecated Use pingOpenAI for brand creation to avoid Claude overload. */
export async function pingClaude(apiKey: string): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      signal: ctrl.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    if (!response.ok) await handleApiError(response)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('Claude API ping timed out (10s) — check your network or API status')
    throw e
  } finally {
    clearTimeout(t)
  }
}

async function handleApiError(response: Response): Promise<never> {
  let errBody = '(could not read body)'
  try { errBody = await response.text() } catch {}
  try {
    const parsed = JSON.parse(errBody) as { error?: { message?: string } }
    if (parsed?.error?.message) throw new Error(`Claude API error: ${parsed.error.message}`)
  } catch (inner) {
    if ((inner as Error).message.startsWith('Claude API error:')) throw inner
  }
  throw new Error(`Claude API error ${response.status}: ${errBody.substring(0, 300)}`)
}

/**
 * callClaudeWithTool — uses Anthropic tool use (function calling) to force
 * structured JSON output validated by a schema.  No text parsing needed at all.
 * The API guarantees the output matches the schema before returning it.
 */
async function callClaudeWithTool<T>(
  systemMessage: string,
  userMessage: string,
  apiKey: string,
  toolName: string,
  toolDescription: string,
  inputSchema: object,
  model = 'claude-sonnet-4-6',
  logFn?: (line: string) => Promise<void>,
): Promise<T> {
  const start = Date.now()
  const startMsg = `[claude] → ${toolName} (${model})`
  console.log(startMsg)
  await logFn?.(startMsg)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 90_000) // 90s hard limit per Claude call
  let response: Response
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      signal: ctrl.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemMessage,
        tools: [{ name: toolName, description: toolDescription, input_schema: inputSchema }],
        tool_choice: { type: 'tool', name: toolName },
        messages: [{ role: 'user', content: userMessage }],
      }),
    })
  } catch (e) {
    clearTimeout(t)
    if ((e as Error).name === 'AbortError') throw new Error(`Claude API call timed out after 90s (model: ${model})`)
    throw e
  }
  clearTimeout(t)

  if (!response.ok) await handleApiError(response)
  const doneMsg = `[claude] ✓ ${toolName} done in ${((Date.now() - start) / 1000).toFixed(1)}s`
  console.log(doneMsg)
  await logFn?.(doneMsg)

  const data = await response.json() as {
    content: Array<{ type: string; name?: string; input?: unknown }>
  }

  // The tool_use block is what we want — its .input is already a parsed JS object
  const toolBlock = data.content?.find(c => c.type === 'tool_use' && c.name === toolName)
  if (!toolBlock || toolBlock.input == null) {
    throw new Error('Claude did not return the expected tool call — please try again')
  }

  return toolBlock.input as T
}

/**
 * callOpenAIWithTool — uses OpenAI function calling for structured JSON output.
 * Fallback when Claude is overloaded.
 */
async function callOpenAIWithTool<T>(
  systemMessage: string,
  userMessage: string,
  apiKey: string,
  toolName: string,
  toolDescription: string,
  inputSchema: object,
  model = 'gpt-4o-mini',
): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 90_000)
  let response: Response
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      signal: ctrl.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userMessage },
        ],
        tools: [{
          type: 'function',
          function: {
            name: toolName,
            description: toolDescription,
            parameters: inputSchema,
          },
        }],
        tool_choice: { type: 'function', function: { name: toolName } },
      }),
    })
  } catch (e) {
    clearTimeout(t)
    if ((e as Error).name === 'AbortError') throw new Error(`OpenAI API call timed out after 90s (model: ${model})`)
    throw e
  }
  clearTimeout(t)

  if (!response.ok) {
    let errBody = '(could not read body)'
    try { errBody = await response.text() } catch {}
    const parsed = (() => { try { return JSON.parse(errBody) as { error?: { message?: string } } } catch { return {} } })()
    throw new Error(parsed?.error?.message ? `OpenAI API error: ${parsed.error.message}` : `OpenAI API error ${response.status}: ${errBody.substring(0, 300)}`)
  }

  const data = await response.json() as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{
          function?: { name: string; arguments: string }
        }>
      }
    }>
  }

  const toolCall = data.choices?.[0]?.message?.tool_calls?.find(tc => tc.function?.name === toolName)
  if (!toolCall?.function?.arguments) {
    throw new Error('OpenAI did not return the expected tool call — please try again')
  }

  return JSON.parse(toolCall.function.arguments) as T
}

// ---------------------------------------------------------------------------
// Generate prompts
// ---------------------------------------------------------------------------

export interface PersonaForPrompts {
  id: string
  name: string
  description: string
  goals: string[]
  pain_points: string[]
}

const PROMPTS_SCHEMA = {
  type: 'object',
  properties: {
    prompts: {
      type: 'array',
      description: 'Exactly 10 buyer-journey questions for this persona',
      items: {
        type: 'object',
        properties: {
          text:         { type: 'string', description: 'The question a real person would type into an AI assistant' },
          funnel_stage: { type: 'string', enum: ['tofu', 'mofu', 'bofu'] },
          rationale:    { type: 'string', description: '1-sentence rationale citing specific site content or persona context' },
        },
        required: ['text', 'funnel_stage', 'rationale'],
      },
    },
  },
  required: ['prompts'],
}

export async function generatePrompts(
  brand: ScrapedContent,
  supplement: string | null,
  persona: PersonaForPrompts,
  openaiApiKey: string,
  onProgress?: (step: string) => Promise<void>,
  logFn?: (line: string) => Promise<void>,
): Promise<GeneratedPrompt[]> {
  const system = `You are an expert in buyer psychology and AI search behavior.
Your job is to generate the real questions that a specific buyer persona would ask AI assistants at different stages of purchase readiness.
Questions must emerge from the persona's goals, pain points, and the brand's context — not from generic templates.`

  const supplementSection = supplement
    ? `\nAdditional ICP / audience context from the brand team (treat this as authoritative):\n${supplement}\n`
    : ''

  const goals = persona.goals.length > 0
    ? persona.goals.map(g => `  - ${g}`).join('\n')
    : '  (none specified)'
  const painPoints = persona.pain_points.length > 0
    ? persona.pain_points.map(p => `  - ${p}`).join('\n')
    : '  (none specified)'

  const user = `Generate exactly 10 questions that this specific persona would ask an AI assistant at different stages of buyer readiness.

PERSONA: ${persona.name}
Description: ${persona.description}
Goals:
${goals}
Pain Points:
${painPoints}

BRAND CONTEXT:
Brand name: ${brand.brand_name}
Website content:
${brand.summary}
${supplementSection}
Distribute across three buyer readiness stages:

TOFU — 4 questions (problem-aware, solution-unaware)
These come from this persona experiencing the problems or needs described in their pain points, but with no knowledge of this brand or what category of solution to look for. They are trying to understand their situation or discover what kind of help exists.

MOFU — 3 questions (solution-aware, actively evaluating)
These come from this persona knowing solutions in this category exist and actively comparing or assessing fit for their specific goals. They are trying to understand trade-offs, capabilities, and differences between approaches.

BOFU — 3 questions (decided, seeking final fit)
These come from this persona having essentially decided they want this type of solution and looking for validation of fit for their specific situation, role, and context.

CRITICAL — Gap-finding:
- Include questions this persona would naturally ask that the website might NOT directly address. Think about: pricing, competitor comparisons, category education, ROI justification, use-case fit, implementation concerns.
- Do NOT just mirror back what the website says. The most valuable questions are ones where there is a gap between what the persona needs to know and what the brand currently communicates.
- Ground each question in the persona's specific goals and pain points — a CFO asks different questions than a DevOps engineer, even about the same product.

Rules:
- Do not anchor to any particular phrasing pattern. Let each question emerge naturally from this persona's perspective.
- Questions must feel like something this specific person would type — not marketing copy.
- Never mention the brand name in any question.
- Never mention the persona name or role title verbatim in the question (the question should read as if the persona typed it, not as if someone is asking about them).
- For each question, include a 1-sentence rationale citing the specific site content, persona goal, or pain point that motivated it.

Call the submit_prompts tool with your 10 questions.`

  await onProgress?.(`Generating questions for ${persona.name}`)

  const result = await callOpenAIWithTool<{ prompts: GeneratedPrompt[] }>(
    system, user, openaiApiKey,
    'submit_prompts',
    'Submit the 10 generated buyer-journey questions for this persona',
    PROMPTS_SCHEMA,
    'gpt-4o',
  )

  return (result.prompts ?? [])
    .filter(p => p.text && ['tofu', 'mofu', 'bofu'].includes(p.funnel_stage))
    .slice(0, 10)
}

// ---------------------------------------------------------------------------
// Classify prompts
// ---------------------------------------------------------------------------

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      description: 'Classification for each prompt, in the same order as the input',
      items: {
        type: 'object',
        properties: {
          text:          { type: 'string', description: 'The exact prompt text (copied verbatim from input)' },
          funnel_stage:  { type: 'string', enum: ['tofu', 'mofu', 'bofu'] },
          keep:          { type: 'boolean', description: 'true if this prompt should be kept, false if it should be filtered out' },
          filter_reason: { type: 'string', description: 'If keep=false: brief reason why (e.g. "too similar to: [existing question]" or "not relevant to this brand"). If keep=true: empty string.' },
          rationale:     { type: 'string', description: '1-sentence explanation of the funnel stage classification' },
        },
        required: ['text', 'funnel_stage', 'keep', 'filter_reason', 'rationale'],
      },
    },
  },
  required: ['classifications'],
}

export interface ClassifyContext {
  brandName: string
  brandSummary: string
  existingPrompts: string[]
}

export async function classifyPrompts(
  texts: string[],
  apiKey: string,
  context?: ClassifyContext,
): Promise<ClassifiedPrompt[]> {
  const system = `You are an expert in buyer psychology and AEO (Answer Engine Optimization).`

  const existingSection = context?.existingPrompts.length
    ? `\nExisting prompts already in the system (use these to check for duplicates):\n${context.existingPrompts.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`
    : ''

  const brandSection = context
    ? `\nBrand being audited: ${context.brandName}\nBrand context: ${context.brandSummary.substring(0, 800)}\n`
    : ''

  const user = `Classify each of these imported prompts. For each prompt, do three things:

1. Assign a funnel stage:
   - tofu: broad awareness or education (what is X, how does X work, understanding a problem)
   - mofu: consideration or evaluation (comparing options, assessing fit, how to choose)
   - bofu: high purchase intent (pricing, demos, specific use case fit, vendor selection)

2. Check relevance: Is this prompt relevant to the brand being audited and its audience? If clearly off-topic, set keep=false.

3. Check similarity: Is this prompt substantially covered by an existing prompt already in the system? If the meaning is nearly identical, set keep=false.

Set keep=true if the prompt is both relevant and distinct. Set keep=false and explain why in filter_reason if not.
${brandSection}${existingSection}
Prompts to classify:
${texts.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Call the submit_classifications tool with your classifications in the same order as the input.`

  const result = await callClaudeWithTool<{ classifications: ClassifiedPrompt[] }>(
    system, user, apiKey,
    'submit_classifications',
    'Submit the classifications for each prompt',
    CLASSIFY_SCHEMA,
    'claude-haiku-4-5',
  )

  return (result.classifications ?? [])
    .filter(p => p.text && ['tofu', 'mofu', 'bofu'].includes(p.funnel_stage))
}

// ---------------------------------------------------------------------------
// Generate personas
// ---------------------------------------------------------------------------

const PERSONAS_SCHEMA = {
  type: 'object',
  properties: {
    personas: {
      type: 'array',
      description: '3 to 5 distinct buyer personas',
      items: {
        type: 'object',
        properties: {
          name:           { type: 'string', description: 'Persona Name (Role at Company Type)' },
          description:    { type: 'string', description: '2-3 sentences about who this person is — their role, context, and day-to-day reality' },
          goals:          {
            type: 'array',
            description: '3 to 5 specific professional goals this persona is actively trying to achieve',
            items: { type: 'string' },
          },
          pain_points:    {
            type: 'array',
            description: '3 to 5 specific frustrations, blockers, or problems this persona experiences',
            items: { type: 'string' },
          },
          system_message: { type: 'string', description: 'System message framing the AI as this persona\'s personal assistant' },
          rationale:      { type: 'string', description: '1-sentence explanation of the evidence that suggested this persona' },
        },
        required: ['name', 'description', 'goals', 'pain_points', 'system_message', 'rationale'],
      },
    },
    brand_name: {
      type: 'string',
      description: 'The actual company or brand name as it appears on the site — not a tagline or value proposition. E.g. "Column Five Media" not "B2B Marketing Agency for SaaS Companies". Use the domain-derived name if the content does not clearly state the brand.',
    },
  },
  required: ['personas', 'brand_name'],
}

export interface GeneratePersonasResult {
  personas: GeneratedPersona[]
  brand_name: string
}

export async function generatePersonas(
  brand: ScrapedContent,
  supplement: string | null,
  openaiApiKey: string,
  onProgress?: (step: string) => Promise<void>,
  logFn?: (line: string) => Promise<void>,
): Promise<GeneratePersonasResult> {
  const system = `You are an expert in user research and customer profiling.
You create realistic buyer personas for B2B and B2C products.`

  const supplementSection = supplement
    ? `\nAdditional ICP context provided by the brand team (prioritise this over the site content when there is a conflict):\n${supplement}\n`
    : ''

  const user = `Based on this brand's website, generate between 3 and 5 distinct user personas who would realistically use or buy this product/service. Generate as many as the site content meaningfully supports — 3 if the audience is narrow and focused, up to 5 if there are clearly distinct buyer types with different goals, roles, or contexts. Do not pad with redundant personas.

The site title or domain suggests: ${brand.brand_name}
Website summary:
${brand.summary}
${supplementSection}
First, extract the actual company/brand name from the content. Return it in brand_name. Do not return taglines or value propositions (e.g. "B2B Marketing Agency for SaaS Companies") — return the real company name (e.g. "Column Five Media"). If unclear, use the domain-derived name above.

For each persona provide:
- description: 2-3 sentences on who they are, their role and day-to-day context
- goals: 3-5 specific professional goals they are actively trying to achieve (concrete, not generic)
- pain_points: 3-5 specific frustrations or blockers they face (concrete, not generic)
- system_message: frames the AI assistant as this persona's personal assistant

Example system_message format:
"You are a helpful AI assistant. The user is a [role] at a [company type]. They are [goals/context]. Help them find the best solutions for [specific needs]."

Call the submit_personas tool with your personas.`

  await onProgress?.('Submitting to LLM: Identifying buyer archetypes')

  const result = await callOpenAIWithTool<{ personas: GeneratedPersona[]; brand_name: string }>(
    system, user, openaiApiKey,
    'submit_personas',
    'Submit the generated buyer personas and extracted brand name',
    PERSONAS_SCHEMA,
    'gpt-4o',
  )

  await onProgress?.('Generating persona profiles')
  await onProgress?.('Finalising output')

  const personas = (result.personas ?? [])
    .filter(p => p.name && p.description && p.system_message)
    .slice(0, 5)
  const brandName = (result.brand_name ?? brand.brand_name ?? '').trim() || brand.brand_name || ''
  return { personas, brand_name: brandName }
}

// ---------------------------------------------------------------------------
// Extract brand mentions from LLM response (replaces regex-based extraction)
// ---------------------------------------------------------------------------

export interface ExtractedMention {
  brand_name: string
  rank: number
  is_target: boolean
  positioning?: string
  context_snippet?: string
}

/**
 * Tool schema for submit_mentions — used by OpenAI function calling.
 * Each mention is one brand occurrence in a single query response.
 *
 * Full schema (JSON Schema for OpenAI):
 * {
 *   type: 'object',
 *   properties: {
 *     mentions: {
 *       type: 'array',
 *       description: 'Brand and competitor mentions found in the response',
 *       items: {
 *         type: 'object',
 *         properties: {
 *           brand_name: { type: 'string', description: 'Company or brand name' },
 *           rank: { type: 'number', description: 'Order of first appearance: 1=first brand named, 2=second, etc. Assign strictly by scanning the text top to bottom.' },
 *           is_target: { type: 'boolean', description: 'True if this is the target brand being audited' },
 *           positioning: { type: 'string', description: '2 sentences max. Sentence 1: overview of how the response characterizes this brand. Sentence 2: niche or segment targeted.' },
 *           context_snippet: { type: 'string', description: '~80 chars of surrounding text showing where the brand appears' },
 *         },
 *         required: ['brand_name', 'rank', 'is_target', 'context_snippet'],
 *       },
 *     },
 *   },
 *   required: ['mentions'],
 * }
 */
const EXTRACT_MENTIONS_SCHEMA = {
  type: 'object',
  properties: {
    mentions: {
      type: 'array',
      description: 'Brand and competitor mentions found in the response',
      items: {
        type: 'object',
        properties: {
          brand_name: { type: 'string', description: 'Company or brand name' },
          rank: { type: 'number', description: 'Order of first appearance: 1=first brand named, 2=second, etc. Assign strictly by scanning the text top to bottom.' },
          is_target: { type: 'boolean', description: 'True if this is the target brand being audited' },
          positioning: {
            type: 'string',
            description: '2 sentences max. Sentence 1: overview of how the response characterizes this brand. Sentence 2: niche or segment targeted.',
          },
          context_snippet: { type: 'string', description: '~80 chars of surrounding text showing where the brand appears' },
        },
        required: ['brand_name', 'rank', 'is_target', 'context_snippet'],
      },
    },
  },
  required: ['mentions'],
}

export interface ExtractBrandMentionsOptions {
  queryId: string
  env: Env
}

export async function extractBrandMentions(
  responseText: string,
  targetBrandName: string,
  competitorHints: string[],
  openaiApiKey: string,
  options?: ExtractBrandMentionsOptions,
): Promise<ExtractedMention[]> {
  const start = Date.now()
  console.log(`[extract] → brand mentions (target: ${targetBrandName}, ${competitorHints.length} hints, ${responseText.length} chars)`)
  const truncated = responseText.length > 6000 ? responseText.slice(0, 6000) + '\n[...truncated]' : responseText
  const hintsSection = competitorHints.length > 0
    ? `\nKnown competitors to look for (extract if mentioned): ${competitorHints.join(', ')}`
    : ''

  const system = `You extract brand and competitor mentions from AI assistant responses. Output only actual company or brand names — NOT roles (Founders, Engineers), concepts (Knowledge Transfer, Scalability), or services (Initial Consultation). The target brand is: "${targetBrandName}". Mark is_target=true for that brand (including short forms like "Column Five" for "Column Five Media"). For each mention, provide: (1) a positioning field of up to 2 sentences — sentence 1: overview of how the response characterizes this brand; sentence 2: the niche or segment targeted; (2) a context_snippet of ~80 chars of surrounding text showing exactly where in the response the brand appears. IMPORTANT: if a brand does not appear in the response text, do not include it. If no brands are mentioned at all, call submit_mentions with an empty array.

CRITICAL — rank field: rank = order of first appearance in the response text. 1 = first brand named, 2 = second, 3 = third, etc. Scan the response from top to bottom and assign ranks strictly by where each brand first appears. Do NOT assume the target brand is #1. If the target appears 5th in a list, rank=5.`

  const user = `Target brand: ${targetBrandName}${hintsSection}

Response to analyze:
---
${truncated}
---

Extract all brand/competitor mentions in order of first appearance. Assign rank strictly by position in the text: 1 = first brand named, 2 = second, etc. Only include brands that are explicitly named. Call the submit_mentions tool.`

  const result = await callOpenAIWithTool<{ mentions: ExtractedMention[] }>(
    system,
    user,
    openaiApiKey,
    'submit_mentions',
    'Submit the extracted brand mentions',
    EXTRACT_MENTIONS_SCHEMA,
    'gpt-4o-mini',
  )

  const raw = (Array.isArray(result.mentions) ? result.mentions : []).filter(m => m.brand_name && m.rank >= 1)
  const filtered = raw.filter(m => {
    // Only guard the target brand — hallucinated target mentions won't have a real snippet.
    if (m.is_target && !m.context_snippet?.trim()) {
      console.warn(`[extract] dropping target brand mention "${m.brand_name}" — no context_snippet, likely hallucinated`)
      return false
    }
    // Verify target mention: brand name must appear in response (catches LLM hallucination)
    if (m.is_target && responseText && m.brand_name) {
      const brandInResponse = responseText.toLowerCase().includes(m.brand_name.toLowerCase())
      if (!brandInResponse) {
        console.warn(`[extract] dropping target brand mention "${m.brand_name}" — not found in response text, likely hallucinated`)
        return false
      }
    }
    return true
  })
  // Dedupe: one mention per brand per query — keep the one with lowest rank (first appearance).
  // Prevents duplicate rows from skewing AVG/MIN and displaying wrong rank; fewer inserts = better perf.
  const seen = new Map<string, ExtractedMention>()
  for (const m of filtered) {
    const key = m.brand_name.toLowerCase().trim()
    const existing = seen.get(key)
    if (!existing || m.rank < existing.rank) seen.set(key, m)
  }
  const mentions = Array.from(seen.values())
  console.log(`[extract] ✓ brand mentions done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${mentions.length} mentions (${raw.length - filtered.length} target dropped, ${filtered.length - mentions.length} dupes removed)`)

  if (options) {
    await options.env.DB.prepare(`DELETE FROM brand_mentions WHERE query_id = ?`)
      .bind(options.queryId)
      .run()
    if (mentions.length > 0) {
      const inserts = mentions.map(m =>
        options.env.DB.prepare(
          `INSERT INTO brand_mentions (id, query_id, brand_name, rank, is_target, context_snippet, positioning)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(),
          options.queryId,
          m.brand_name,
          m.rank,
          m.is_target ? 1 : 0,
          m.context_snippet ?? null,
          (m.positioning && m.positioning.trim()) || null
        )
      )
      await options.env.DB.batch(inserts)
    }
  }

  return mentions
}
