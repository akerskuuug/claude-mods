// Estimates per-day API-list-price cost from local Claude Code / Cowork logs,
// the way ClaudeMeter does. Prints JSON { days: { 'YYYY-MM-DD': usd }, unpriced: [...] }.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DAYS = Number(process.argv[2] ?? 30)
const cutoff = Date.now() - (DAYS + 1) * 86_400_000
const COWORK = 'local-agent-mode-sessions'
const roots = [
  join(homedir(), '.claude/projects'),
  join(homedir(), 'Library/Application Support/Claude', COWORK),
]
// Windows Cowork: %APPDATA%\Claude, or the MSIX package's virtualized copy of it.
if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'Claude', COWORK))
if (process.env.LOCALAPPDATA) {
  const pkgs = join(process.env.LOCALAPPDATA, 'Packages')
  try {
    for (const p of readdirSync(pkgs)) {
      if (p.startsWith('Claude')) roots.push(join(pkgs, p, 'LocalCache/Roaming/Claude', COWORK))
    }
  } catch {}
}

// Sonnet 5.5 cache reads dropped from $0.20 to $0.10 on 2026-10-07.
const SONNET_55_CUT = Date.UTC(2026, 9, 7)

// $ per million tokens; mirrors ClaudeMeter's Pricing.rate(for:). `prompt` is the request's
// input + cache tokens (Haiku 5.5 has a higher rate card above 100k); `t` is when it ran.
const rate = (model, prompt, t) => {
  const m = model.toLowerCase()
  if (m.includes('fable')) return { i: 10, o: 50, r: m.includes('5-1') ? 0.025 : 0.1, known: true }
  if (m.includes('opus')) {
    if (['opus-4-0', 'opus-4-1', 'opus-4-2025', '3-opus'].some(s => m.includes(s))) return { i: 15, o: 75, r: 0.1, known: true }
    return m.includes('opus-5-5') ? { i: 4, o: 20, r: 0.05, known: true } : { i: 5, o: 25, r: 0.1, known: true }
  }
  if (m.includes('sonnet-5-5')) return { i: 2, o: 10, r: t >= SONNET_55_CUT ? 0.05 : 0.1, known: true }
  if (m.includes('sonnet')) return m.includes('sonnet-5') ? { i: 2, o: 10, r: 0.1, known: true } : { i: 3, o: 15, r: 0.1, known: true }
  if (m.includes('haiku')) {
    if (m.includes('haiku-5')) return prompt > 100_000 ? { i: 0.5, o: 2.5, r: 0.1, known: true } : { i: 0.1, o: 0.5, r: 0.1, known: true }
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

const seen = new Map()
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
    const cr = u.cache_read_input_tokens ?? 0
    // Writes split by TTL when the log has it (1 h costs 2x, 5 min 1.25x); else all 5 min.
    const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const cw = u.cache_creation_input_tokens ?? 0
    const w5 = Math.max(0, cw - w1)
    const ws = u.server_tool_use?.web_search_requests ?? 0
    if (i + out + w5 + w1 + cr + ws === 0) continue
    const key = `${o.message.id ?? o.uuid ?? Math.random()}:${o.requestId ?? ''}`
    // A response can be logged in several records whose counts grow; keep the largest of each.
    const prev = seen.get(key)
    const cur = { t, model, fast: u.speed === 'fast' || prev?.fast, i, out, w5, w1, cr, ws }
    if (prev) for (const f of ['i', 'out', 'w5', 'w1', 'cr', 'ws']) cur[f] = Math.max(cur[f], prev[f])
    seen.set(key, cur)
  }
}
for (const c of seen.values()) {
  const r = rate(c.model, c.i + c.w5 + c.w1 + c.cr, c.t)
  if (!r.known) unpriced.add(c.model)
  // Fast mode is 2x the standard token rates on every model that offers it.
  const x = c.fast ? 2 : 1
  // Web search is $10 per 1,000 searches on top of tokens.
  const usd = x * (c.i * r.i + c.out * r.o + c.w5 * r.i * 1.25 + c.w1 * r.i * 2 + c.cr * r.i * r.r) / 1e6 + c.ws * 0.01
  const k = day(c.t)
  days[k] = (days[k] ?? 0) + usd
}
console.log(JSON.stringify({ days, unpriced: [...unpriced] }))
