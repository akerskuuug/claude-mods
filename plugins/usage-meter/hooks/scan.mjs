// Estimates per-day API-list-price cost from local Claude Code / Cowork logs,
// the way ClaudeMeter does. Prints JSON { days: { 'YYYY-MM-DD': usd }, unpriced: [...] }.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DAYS = Number(process.argv[2] ?? 30)
const cutoff = Date.now() - (DAYS + 1) * 86_400_000
const roots = [
  join(homedir(), '.claude/projects'),
  join(homedir(), 'Library/Application Support/Claude/local-agent-mode-sessions'),
]

// $ per million tokens; mirrors ClaudeMeter's Pricing.rate(for:).
const rate = model => {
  const m = model.toLowerCase()
  if (m.includes('fable')) return { i: 10, o: 50, r: m.includes('5-1') ? 0.025 : 0.1, known: true }
  if (m.includes('opus')) {
    if (['opus-4-0', 'opus-4-1', 'opus-4-2025', '3-opus'].some(s => m.includes(s))) return { i: 15, o: 75, r: 0.1, known: true }
    return m.includes('opus-5-5') ? { i: 4, o: 20, r: 0.1, known: true } : { i: 5, o: 25, r: 0.1, known: true }
  }
  if (m.includes('sonnet')) return m.includes('sonnet-5') ? { i: 2, o: 10, r: 0.1, known: true } : { i: 3, o: 15, r: 0.1, known: true }
  if (m.includes('haiku')) {
    if (m.includes('haiku-4')) return { i: 1, o: 5, r: 0.1, known: true }
    if (m.includes('3-5-haiku')) return { i: 0.8, o: 4, r: 0.1, known: true }
    return { i: 0.25, o: 1.25, r: 0.1, known: true }
  }
  return { i: 3, o: 15, r: 0.1, known: false }
}

const day = ms => {
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const files = []
const walk = dir => {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.jsonl')) {
      try { if (statSync(p).mtimeMs >= cutoff) files.push(p) } catch {}
    }
  }
}
roots.forEach(walk)

const seen = new Set()
const days = {}
const unpriced = new Set()
for (const f of files) {
  let text
  try { text = readFileSync(f, 'utf8') } catch { continue }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    const u = o?.message?.usage
    if (o.type !== 'assistant' || !u || !o.timestamp) continue
    const model = o.message.model ?? 'unknown'
    if (model === '<synthetic>') continue
    const t = Date.parse(o.timestamp)
    if (Number.isNaN(t) || t < cutoff) continue
    const i = u.input_tokens ?? 0, out = u.output_tokens ?? 0
    const cw = u.cache_creation_input_tokens ?? 0, cr = u.cache_read_input_tokens ?? 0
    if (i + out + cw + cr === 0) continue
    const key = `${o.message.id ?? o.uuid ?? Math.random()}:${o.requestId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const r = rate(model)
    if (!r.known) unpriced.add(model)
    const usd = (i * r.i + out * r.o + cw * r.i * 1.25 + cr * r.i * r.r) / 1e6
    const k = day(t)
    days[k] = (days[k] ?? 0) + usd
  }
}
console.log(JSON.stringify({ days, unpriced: [...unpriced] }))
