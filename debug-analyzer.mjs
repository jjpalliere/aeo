/**
 * Debug round 2 - comprehensive analyzer tests.
 * Run: node debug-analyzer.mjs
 */

// Inline extractListedEntities (must match analyzer.ts)
function extractListedEntities(text) {
  const articles = new Set(['The', 'A', 'An'])
  const stopWords = new Set([
    'Our','Your','My','Its','This','That','These','Those',
    'Some','Any','All','For','With','By','On','In','At','If','When',
    'How','Why','What','And','Or','Not','Use','Consider','Check',
  ])
  const results = []

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const listMatch = trimmed.match(/^(?:\d+[.)]\s+|[-•*·]\s+)(.+)/)
    if (!listMatch) continue
    const content = listMatch[1].replace(/\*+/g, '').replace(/_+/g, '').trim()

    const titleMatch = content.match(
      /^([A-Z][A-Za-z0-9]*(?:[-'][A-Za-z0-9]+)*(?:\s+[A-Z][A-Za-z0-9]*(?:[-'][A-Za-z0-9]+)*){0,5})\s*(?:[-:—.,(/]|$)/
    )
    const lowerMatch = content.match(
      /^([a-z][a-z0-9]*(?:[-'][a-z0-9]+)*(?:\s+[a-z][a-z0-9]*(?:[-'][a-z0-9]+)*){0,5})\s*(?:[-:—.,(/]|$)/
    )
    const rawName = (titleMatch ?? lowerMatch)?.[1]?.trim()
    if (!rawName) continue

    const name = titleMatch
      ? rawName
      : rawName.length === 2 && rawName === rawName.toLowerCase()
        ? rawName.toUpperCase()
        : rawName.includes(' ')
          ? rawName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
          : rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase()
    const firstWord = name.split(' ')[0]

    if (articles.has(firstWord)) {
      const rest = name.split(' ').slice(1).join(' ')
      if (rest.length >= 2) results.push(rest)
      continue
    }

    if (stopWords.has(firstWord)) continue
    if (name.length < 2) continue
    if (name.length === 2 && name !== name.toUpperCase()) continue
    results.push(name)
  }

  return [...new Set(results)]
}

function indexWithBoundary(text, needle) {
  const nLen = needle.length
  let pos = 0
  while (pos <= text.length - nLen) {
    const idx = text.indexOf(needle, pos)
    if (idx === -1) return -1
    const charBefore = idx > 0 ? text[idx - 1] : ' '
    const charAfter = idx + nLen < text.length ? text[idx + nLen] : ' '
    if (!/[a-z0-9]/i.test(charBefore) && !/[a-z0-9]/i.test(charAfter)) return idx
    pos = idx + 1
  }
  return -1
}

function findMentions(text, targetBrandName, competitorNames) {
  const targetVariants = [targetBrandName]
  const words = targetBrandName.split(/\s+/)
  if (words.length >= 3) targetVariants.push(words.slice(0, -1).join(' '))
  if (words.length >= 4 && words[0].length >= 4) targetVariants.push(words[0])

  const candidates = [...new Set([...targetVariants, ...competitorNames])].filter(Boolean)
  const results = []
  const lowerText = text.toLowerCase()

  for (const name of candidates) {
    if (!name || name.length < 2) continue
    const lowerName = name.toLowerCase()
    const idx = indexWithBoundary(lowerText, lowerName)
    if (idx === -1) continue

    const snippetStart = Math.max(0, idx - 80)
    const snippetEnd = Math.min(text.length, idx + name.length + 80)
    const snippet = text.substring(snippetStart, snippetEnd).trim()

    const isTarget =
      targetVariants.some(v => v.toLowerCase() === lowerName) ||
      targetVariants.some(v => lowerName.startsWith(v.toLowerCase()))

    results.push({ brand_name: name, rank: idx, is_target: isTarget, context_snippet: snippet })
  }

  results.sort((a, b) => a.rank - b.rank)
  results.forEach((r, i) => { r.rank = i + 1 })
  return results
}

let failed = 0

// === extractListedEntities ===
console.log('=== extractListedEntities ===')
const extractTests = [
  ['1. Paycor-ATS - HR platform', ['Paycor-ATS']],
  ["1. McDonald's - fast food", ["McDonald's"]],
  ['1. HR - human resources', ['HR']],
  ['1. hr - human resources', ['HR']],
  ['1. AI - artificial intelligence', ['AI']],
  ['1. spotify - music', ['Spotify']],
  ['1. adobe creative cloud - software', ['Adobe Creative Cloud']],
  ['1. The New York Times - newspaper', ['New York Times']],
  ['1. The Economist - magazine', ['Economist']],
  ['1. Use Slack for messaging', []],
  ['1. Consider BambooHR for HR', []],  // "Consider" is stop word
  ['- BambooHR\n- Workday\n- Paycor', ['BambooHR', 'Workday', 'Paycor']],
  ['1. X - company', []],  // single char after article strip
  ['1. A Company - description', ['Company']],
  ['1. Oracle HCM Cloud Suite Pro - enterprise', ['Oracle HCM Cloud Suite Pro']],  // 5 words
  ['1. Acme Brand Name Here Extra Word - desc', ['Acme Brand Name Here Extra Word']],  // 6 words
  ['1. IBM - tech', ['IBM']],
  ['1. E-E Corp - company', ['E-E Corp']],  // hyphenated
]
for (const [input, expected] of extractTests) {
  const got = extractListedEntities(input)
  const ok = JSON.stringify([...got].sort()) === JSON.stringify([...expected].sort())
  if (!ok) { failed++; console.log('✗', input.slice(0, 45).padEnd(45), '→', JSON.stringify(got), 'expected', JSON.stringify(expected)) }
  else console.log('✓', input.slice(0, 45).padEnd(45), '→', JSON.stringify(got))
}

// === findMentions ===
console.log('\n=== findMentions (substring / word boundary) ===')
const findTests = [
  { text: 'Pineapple is great but Apple leads.', target: 'Apple', comp: [], expect: ['Apple'], noSubstring: true },
  { text: 'Consider Google and Microsoft.', target: 'Go', comp: [], expect: [], noSubstring: true },
  { text: 'LinkedIn and Intel are tech.', target: 'In', comp: [], expect: [], noSubstring: true },
  { text: 'Atlassian Jira is popular.', target: 'At', comp: [], expect: [], noSubstring: true },
  { text: 'Apple, Microsoft, and Google.', target: 'Apple', comp: ['Microsoft', 'Google'], expect: ['Apple'], expectMentions: ['Apple', 'Microsoft', 'Google'] },
]
for (const t of findTests) {
  const m = findMentions(t.text, t.target, t.comp)
  const names = m.map(x => x.brand_name)
  const targets = m.filter(x => x.is_target).map(x => x.brand_name)
  const ok = JSON.stringify([...targets].sort()) === JSON.stringify([...t.expect].sort())
  const mentionsOk = !t.expectMentions || JSON.stringify([...names].sort()) === JSON.stringify([...t.expectMentions].sort())
  const subBug = t.noSubstring && m.some(x => {
    const re = new RegExp(`\\b${x.brand_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    return !re.test(t.text) && t.text.toLowerCase().includes(x.brand_name.toLowerCase())
  })
  if (!ok || !mentionsOk || subBug) { failed++; console.log('✗', t.target, '→', { targets, names }, ok ? '' : 'expected targets ' + JSON.stringify(t.expect), mentionsOk ? '' : 'expected mentions ' + JSON.stringify(t.expectMentions), subBug ? 'SUBSTRING BUG' : '') }
  else console.log('✓', t.target, '→', { targets, names })
}

// === is_target ===
console.log('\n=== findMentions (is_target) ===')
const isTargetTests = [
  { text: 'Column A and Column Five Media', target: 'Column Five Media', comp: ['Column'], expectTarget: ['Column Five Media', 'Column Five'], expectNotTarget: ['Column'] },
  { text: 'Column Five offers design.', target: 'Column Five Media', comp: [], expectTarget: ['Column Five'] },
  { text: 'We use Column Five Media.', target: 'Column Five Media', comp: [], expectTarget: ['Column Five Media'] },
]
for (const t of isTargetTests) {
  const m = findMentions(t.text, t.target, t.comp)
  const targets = m.filter(x => x.is_target).map(x => x.brand_name)
  const notTargets = m.filter(x => !x.is_target).map(x => x.brand_name)
  const ok = t.expectNotTarget?.every(n => notTargets.includes(n)) ?? true
  const ok2 = t.expectTarget.every(n => targets.includes(n))
  if (!ok || !ok2) { failed++; console.log('✗', t.target, '→ targets:', targets, 'not:', notTargets, 'expected targets:', t.expectTarget, 'expected NOT:', t.expectNotTarget) }
  else console.log('✓', t.target, '→', { targets, notTargets })
}

// === snippet & rank ===
console.log('\n=== snippet & rank ===')
const m = findMentions('First Apple. Second Microsoft. Third Google.', 'Apple', ['Microsoft', 'Google'])
const ranks = Object.fromEntries(m.map(x => [x.brand_name, x.rank]))
const expectRanks = { Apple: 1, Microsoft: 2, Google: 3 }
const rankOk = JSON.stringify(ranks) === JSON.stringify(expectRanks)
const snippetOk = m.every(x => x.context_snippet && x.context_snippet.length > 0 && x.context_snippet.includes(x.brand_name))
if (!rankOk || !snippetOk) { failed++; console.log('✗ ranks:', ranks, 'expected:', expectRanks, 'snippets ok:', snippetOk) }
else console.log('✓ ranks:', ranks, 'snippets ok')

// === edge cases ===
console.log('\n=== edge cases ===')
const edge1 = extractListedEntities('1. ')
console.log(edge1.length === 0 ? '✓' : '✗', 'empty list item →', edge1)

const edge2 = findMentions('', 'Apple', [])
console.log(edge2.length === 0 ? '✓' : '✗', 'empty text →', edge2.length, 'mentions')

const edge3 = findMentions('Apple', 'Apple', ['Apple'])
console.log(edge3.length === 1 ? '✓' : '✗', 'target in both target and comp (dedupe) →', edge3.length, 'mention(s)')

const edge4 = extractListedEntities('1. **BambooHR** - HR software')
console.log(edge4.includes('BambooHR') ? '✓' : '✗', 'markdown bold stripped →', edge4)

// Duplicate in same list
const edge5 = extractListedEntities('- BambooHR\n- Workday\n- BambooHR')
console.log(edge5.filter(x => x === 'BambooHR').length === 1 ? '✓' : '✗', 'dedupe in list →', edge5)

// Snippet uses original text (not lowercased)
const edge6 = findMentions('Try APPLE for great products.', 'Apple', [])
console.log(edge6[0]?.context_snippet?.includes('APPLE') ? '✓' : '✗', 'snippet preserves original case →', edge6[0]?.context_snippet?.slice(0, 30))

// 2-word target variant
const edge7 = findMentions('Column Five is great.', 'Column Five', [])
console.log(edge7.some(x => x.brand_name === 'Column Five' && x.is_target) ? '✓' : '✗', '2-word target exact match →', edge7)

// Same brand mentioned twice - one result per candidate
const edge8 = findMentions('Apple first. Apple second.', 'Apple', [])
console.log(edge8.length === 1 && edge8[0].rank === 1 ? '✓' : '✗', 'duplicate mention → one result, rank 1 →', edge8.length, edge8[0]?.rank)

// Overlapping: Column Five and Column Five Media
const edge9 = findMentions('Column Five Media and Column Five.', 'Column Five Media', [])
const cf = edge9.find(x => x.brand_name === 'Column Five')
const cfm = edge9.find(x => x.brand_name === 'Column Five Media')
console.log(cf?.is_target && cfm?.is_target ? '✓' : '✗', 'overlapping variants both target →', { cf: cf?.is_target, cfm: cfm?.is_target })

console.log('\n' + (failed === 0 ? 'All tests passed.' : failed + ' test(s) failed.'))
