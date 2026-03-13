import type { Env } from '../types'
import { extractBrandMentions } from './generator'

const EXTRACT_DELAY_MS = 2500 // Avoid rate limits when processing many queries

function extractCompanyNamesFromCitations(
  citationRows: Array<{ company_name: string | null; domain: string; source_type: string }>
): string[] {
  return citationRows
    .filter(c => c.source_type !== 'owned' && c.company_name)
    .map(c => c.company_name!)
    .filter((name, idx, arr) => arr.indexOf(name) === idx) // dedupe
}

export async function analyzeRun(
  runId: string,
  brandName: string,
  brandDomain: string,
  env: Env,
  /** Optional preset competitor names (e.g. from brand config). Merged with citations. */
  presetCompetitors: string[] = []
): Promise<void> {
  console.log(`[analyzer] run ${runId.slice(0, 8)} — deleting existing brand_mentions for re-extraction`)
  await env.DB.prepare(
    `DELETE FROM brand_mentions WHERE query_id IN (SELECT id FROM queries WHERE run_id = ?)`
  )
    .bind(runId)
    .run()

  console.log(`[analyzer] run ${runId.slice(0, 8)} — scanning for complete queries`)
  const { results: queries } = await env.DB.prepare(
    `SELECT q.id, q.response_text
     FROM queries q
     WHERE q.run_id = ? AND q.status = 'complete' AND q.response_text IS NOT NULL`
  )
    .bind(runId)
    .all<{ id: string; response_text: string }>()

  if (queries.length === 0) {
    console.log(`[analyzer] run ${runId.slice(0, 8)} — no complete queries, marking complete`)
    await env.DB.prepare(
      `UPDATE runs SET status = 'complete', completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(runId)
      .run()
    console.log(`[analyzer] ✓ run ${runId.slice(0, 8)} complete`)
    return
  }
  console.log(`[analyzer] run ${runId.slice(0, 8)} — processing ${queries.length} queries (OpenAI extraction), brand="${brandName}"`)

  // Get all citations for this run with company names (competitor hints)
  const { results: allCitations } = await env.DB.prepare(
    `SELECT c.query_id, c.company_name, c.domain, c.source_type
     FROM citations c
     JOIN queries q ON q.id = c.query_id
     WHERE q.run_id = ?`
  )
    .bind(runId)
    .all<{ query_id: string; company_name: string | null; domain: string; source_type: string }>()
  console.log(`[analyzer] run ${runId.slice(0, 8)} — loaded ${allCitations.length} citations for competitor hints`)

  const citationCompetitors = extractCompanyNamesFromCitations(allCitations)
  const competitorHints = [...new Set([...presetCompetitors, ...citationCompetitors])].filter(Boolean)
  console.log(`[analyzer] run ${runId.slice(0, 8)} — competitor hints: ${competitorHints.length} (${competitorHints.slice(0, 5).join(', ')}${competitorHints.length > 5 ? '…' : ''})`)

  // Reclassify 'unknown' source citations that match competitor names
  const competitorDomains = new Set(
    allCitations
      .filter(c => c.source_type === 'unknown' && competitorHints.includes(c.company_name!))
      .map(c => c.domain)
  )

  if (competitorDomains.size > 0) {
    console.log(`[analyzer] run ${runId.slice(0, 8)} — reclassifying ${competitorDomains.size} unknown→competitor domains`)
    for (const domain of competitorDomains) {
      await env.DB.prepare(
        `UPDATE citations SET source_type = 'competitor'
         WHERE domain = ? AND source_type = 'unknown'`
      )
        .bind(domain)
        .run()
    }
  }

  const apiKey = env.OPENAI_API_KEY
  if (!apiKey) {
    console.error(`[analyzer] run ${runId.slice(0, 8)} — OPENAI_API_KEY not set, skipping extraction`)
    await env.DB.prepare(
      `UPDATE runs SET status = 'complete', completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(runId)
      .run()
    return
  }

  console.log(`[analyzer] run ${runId.slice(0, 8)} — starting extraction loop (${EXTRACT_DELAY_MS}ms delay between calls)`)

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i]
    const perQueryCitations = allCitations.filter(c => c.query_id === query.id)
    const perQueryHints = extractCompanyNamesFromCitations(perQueryCitations)
    const hints = [...new Set([...competitorHints, ...perQueryHints])]
    if (i === 0) {
      console.log(`[analyzer] run ${runId.slice(0, 8)} — query ${query.id.slice(0, 8)} has ${perQueryCitations.length} citations, ${hints.length} hints`)
    }

    try {
      const mentions = await extractBrandMentions(
        query.response_text ?? '',
        brandName,
        hints,
        apiKey,
        { queryId: query.id, env }
      )
      if (mentions.length > 0 && (i < 3 || (i + 1) % 20 === 0)) {
        const target = mentions.find(m => m.is_target)
        console.log(`[analyzer] run ${runId.slice(0, 8)} — query ${i + 1} extracted ${mentions.length} mentions${target ? ` (target: ${target.brand_name} rank ${target.rank})` : ''}`)
      }

      if ((i + 1) % 10 === 0 || i === queries.length - 1) {
        console.log(`[analyzer] run ${runId.slice(0, 8)} — ${i + 1}/${queries.length} queries extracted`)
      }
    } catch (err) {
      console.error(`[analyzer] run ${runId.slice(0, 8)} — extraction failed for query ${query.id.slice(0, 8)}: ${err}`)
      // Continue with other queries; this one stays without brand_mentions
    }

    // Delay between calls to avoid rate limits
    if (i < queries.length - 1) {
      await new Promise(r => setTimeout(r, EXTRACT_DELAY_MS))
    }
  }

  console.log(`[analyzer] run ${runId.slice(0, 8)} — marking run complete`)
  await env.DB.prepare(
    `UPDATE runs SET status = 'complete', completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(runId)
    .run()
  console.log(`[analyzer] ✓ run ${runId.slice(0, 8)} complete`)
}
