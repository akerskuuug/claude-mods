import { atom, read } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Board, Claim, Sim } from '../types'

const PLUGIN = 'sim-board'
const PANE = 'sim-board'
const BOARD = { plugin: 'sim-board', key: 'board' } as const
const board = atom(BOARD, null as Board | null)

const MINUTE = 60_000
const REFRESH_MS = 15_000
const HEARTBEAT_MS = MINUTE
// A claim directory with no owner file yet is someone mid-claim; past this it is debris.
const ORPHAN_MS = MINUTE

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)

type SimctlJson = {
  devices?: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]>
}

// "com.apple.CoreSimulator.SimRuntime.iOS-26-1" -> "iOS 26.1"
export function runtimeName(key: string): string {
  const id = key.split('.').pop() ?? key
  const m = /^([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(id)
  return m ? `${m[1]} ${m[2]!.replace(/-/g, '.')}` : id
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function platformOf(runtime: string): string {
  return runtime.split(' ')[0] ?? ''
}

function versionOf(runtime: string): string {
  return runtime.split(' ')[1] ?? ''
}

// Available devices from `simctl list devices available -j`, newest runtime first, then by name.
export function parseDevices(json: string): Sim[] {
  const parsed = JSON.parse(json) as SimctlJson
  const sims: Sim[] = []
  for (const [key, list] of Object.entries(parsed.devices ?? {})) {
    const runtime = runtimeName(key)
    for (const d of list) {
      if (d.isAvailable === false) continue
      sims.push({ udid: d.udid, name: d.name, runtime, state: d.state })
    }
  }
  return sims.sort(
    (a, b) =>
      platformOf(a.runtime).localeCompare(platformOf(b.runtime)) ||
      compareVersions(versionOf(b.runtime), versionOf(a.runtime)) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  )
}

export function filterSims(sims: Sim[], filter: string): Sim[] {
  if (!filter.trim()) return sims
  let re: RegExp
  try {
    re = new RegExp(filter, 'i')
  } catch {
    return sims
  }
  return sims.filter(s => re.test(s.name) || re.test(s.runtime))
}

export function parseOwner(udid: string, text: string): Claim | null {
  try {
    const o = JSON.parse(text) as Partial<Claim>
    if (typeof o.sessionId !== 'string' || typeof o.heartbeatAt !== 'number') return null
    return {
      udid,
      sessionId: o.sessionId,
      label: typeof o.label === 'string' ? o.label : o.sessionId.slice(0, 8),
      claimedAt: typeof o.claimedAt === 'number' ? o.claimedAt : o.heartbeatAt,
      heartbeatAt: o.heartbeatAt,
      ...(typeof o.purpose === 'string' && o.purpose ? { purpose: o.purpose } : {}),
    }
  } catch {
    return null
  }
}

export function isStale(claim: Claim, nowMs: number, staleMinutes: number): boolean {
  return nowMs - claim.heartbeatAt > staleMinutes * MINUTE
}

export function formatAge(ms: number): string {
  const m = Math.max(0, Math.floor(ms / MINUTE))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h${m % 60}m` : `${h}h`
}

// Splits a shell command into words per simple command, honouring quotes and
// backslashes; `&&`, `||`, `;`, `|`, `(`, `)` and newlines end a command.
// Comments and heredoc bodies are data, not commands, and are dropped.
export function shellWords(command: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) out.push(words)
    words = []
  }
  // Heredoc delimiters whose bodies start after the current line.
  const heredocs: { delimiter: string; isDashed: boolean }[] = []
  const skipHeredocBodies = (from: number): number => {
    let i = from
    for (const { delimiter, isDashed } of heredocs.splice(0)) {
      while (i < command.length) {
        const end = command.indexOf('\n', i)
        const line = command.slice(i, end < 0 ? undefined : end)
        i = end < 0 ? command.length : end + 1
        if ((isDashed ? line.replace(/^\t+/, '') : line) === delimiter) break
      }
    }
    return i - 1
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === '#' && !hasWord) {
      const end = command.indexOf('\n', i)
      i = (end < 0 ? command.length : end) - 1
    } else if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      endWord()
      i += 2
      const isDashed = command[i] === '-'
      if (isDashed) i++
      while (command[i] === ' ' || command[i] === '\t') i++
      let delimiter = ''
      while (i < command.length && !' \t\n;|&<>()'.includes(command[i]!)) {
        if (command[i] !== "'" && command[i] !== '"' && command[i] !== '\\') delimiter += command[i]
        i++
      }
      if (delimiter) heredocs.push({ delimiter, isDashed })
      i--
    } else if (c === "'") {
      const j = command.indexOf("'", i + 1)
      word += command.slice(i + 1, j < 0 ? undefined : j)
      hasWord = true
      i = j < 0 ? command.length : j
    } else if (c === '"') {
      i++
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) {
          i++
          // Inside double quotes a backslash escapes only these; elsewhere it stays.
          if (command[i] === '\n') {
            i++
            continue
          }
          if (!'"\\$`'.includes(command[i]!)) word += '\\'
        }
        word += command[i]
        i++
      }
      hasWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      // A backslash-newline is removed from the input, joining the lines.
      if (command[++i] !== '\n') {
        word += command[i]
        hasWord = true
      }
    } else if (c === '\n') {
      endCommand()
      if (heredocs.length) i = skipHeredocBodies(i + 1)
    } else if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      endCommand()
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else {
      word += c
      hasWord = true
    }
  }
  endCommand()
  return out
}

export type Target = {
  // The simulators the command would act on.
  udids: string[]
  // Whether running it should claim them (testing, booting, installing) or only
  // not disturb another session's (shutdown, erase).
  isClaiming: boolean
  // What it was, for messages.
  what: string
}

const TEST_ACTIONS = new Set(['test', 'test-without-building'])
const SIMCTL_CHECK_ONLY = new Set(['shutdown', 'erase', 'delete'])
const SIMCTL_DEVICE_FIRST = new Set([
  'boot',
  'shutdown',
  'erase',
  'delete',
  'install',
  'uninstall',
  'launch',
  'terminate',
  'openurl',
  'io',
  'addmedia',
  'privacy',
  'push',
  'status_bar',
  'ui',
  'location',
  'keychain',
  'spawn',
  'get_app_container',
  'listapps',
  'appinfo',
])

// Parses `platform=iOS Simulator,name=iPhone 17,OS=26.1` into its keys.
export function parseDestination(spec: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const part of spec.split(',')) {
    const eq = part.indexOf('=')
    if (eq > 0) fields[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim()
  }
  return fields
}

// The simulator an xcodebuild destination names, as xcodebuild would pick it:
// by id, else by name, on the OS given or the newest one.
export function resolveDestination(spec: string, sims: Sim[]): string | null {
  const d = parseDestination(spec)
  if (d.id) return sims.some(s => s.udid === d.id) ? d.id : null
  if (!d.name) return null
  const platform = (d.platform ?? 'iOS Simulator').replace(/\s*Simulator$/i, '')
  let matches = sims.filter(s => s.name === d.name && platformOf(s.runtime).toLowerCase() === platform.toLowerCase())
  const os = d.os
  if (os && os !== 'latest') matches = matches.filter(s => versionOf(s.runtime) === os || versionOf(s.runtime).startsWith(`${os}.`))
  matches.sort((a, b) => compareVersions(versionOf(b.runtime), versionOf(a.runtime)))
  return matches[0]?.udid ?? null
}

function resolveDevice(arg: string, sims: Sim[]): string[] {
  if (arg === 'all') return sims.map(s => s.udid)
  if (arg === 'booted') {
    const booted = sims.filter(s => s.state === 'Booted')
    // With several booted simctl's pick is not ours to guess.
    return booted.length === 1 ? [booted[0]!.udid] : []
  }
  const byId = sims.find(s => s.udid === arg)
  if (byId) return [byId.udid]
  const byName = sims
    .filter(s => s.name === arg)
    .sort((a, b) => compareVersions(versionOf(b.runtime), versionOf(a.runtime)))
  return byName.length ? [byName[0]!.udid] : []
}

// Shell keywords that run the command after them.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{'])
// Wrappers that run the command after them, with the options of each that take
// a value as the next word (`env -u NAME`, `sudo -u USER`).
const WRAPPERS: Record<string, Set<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout']),
  time: new Set(['-f', '--format', '-o', '--output']),
  nice: new Set(['-n', '--adjustment']),
  caffeinate: new Set(['-t', '-w']),
  exec: new Set(['-a']),
  command: new Set(),
  nohup: new Set(),
}
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
const XCRUN_VALUE_OPTIONS = new Set(['-sdk', '--sdk', '-toolchain', '--toolchain'])

function baseName(word: string): string {
  return word.split('/').pop() ?? word
}

// The program a simple command runs and its arguments, past assignments
// (`FOO=1`), keywords, wrappers (`env`, `sudo`, `time`, ...) with their options
// and option values, and xcrun's options. Null when nothing runs (`command -v`).
export function commandOf(input: string[]): { program: string; args: string[] } | null {
  let words = input
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || KEYWORDS.has(w)) {
      i++
      continue
    }
    const takesValue = WRAPPERS[baseName(w)]
    if (!takesValue) break
    const wrapper = baseName(w)
    i++
    while (i < words.length) {
      const o = words[i]!
      if (o === '--') {
        i++
        break
      }
      if (wrapper === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(o)) {
        i++
        continue
      }
      if (!o.startsWith('-') || o === '-') break
      // `command -v name` / `-V` only describe a command; nothing runs.
      if (wrapper === 'command' && (o === '-v' || o === '-V')) return null
      // `env -S 'prog args'` splits its value into the command to run.
      if (wrapper === 'env' && (o === '-S' || o === '--split-string' || o.startsWith('--split-string='))) {
        const value = o.includes('=') ? o.slice(o.indexOf('=') + 1) : words[i + 1]
        const split = value ? (shellWords(value)[0] ?? []) : []
        words = [...split, ...words.slice(i + (o.includes('=') ? 1 : 2))]
        i = 0
        break
      }
      i += takesValue.has(o) ? 2 : 1
    }
  }
  if (i >= words.length) return null
  let program = baseName(words[i]!)
  let args = words.slice(i + 1)
  if (program === 'xcrun') {
    let j = 0
    while (j < args.length && args[j]!.startsWith('-')) j += XCRUN_VALUE_OPTIONS.has(args[j]!) ? 2 : 1
    if (j >= args.length) return null
    program = baseName(args[j]!)
    args = args.slice(j + 1)
  }
  return { program, args }
}

// The script a shell runs with -c: like the shell, take `c` anywhere in a
// group of short options (`-lc`, `-ec`), and the script as the first word that
// is not an option (`-o name` and `-O name` take theirs).
export function shellScript(args: string[]): string | null {
  let hasC = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--' || a === '-') return hasC ? (args[i + 1] ?? null) : null
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a[0] === '-' && a.includes('c')) hasC = true
      if (/[oO]$/.test(a)) i++
      continue
    }
    if (a.startsWith('--')) continue
    return hasC ? a : null
  }
  return null
}

// What simulators a Bash command would act on, if any: only where `xcodebuild`
// or `simctl` is the program run, never as an argument (`echo xcodebuild ...`).
export function targetsOf(command: string, sims: Sim[], depth = 0): Target[] {
  const targets: Target[] = []
  for (const words of shellWords(command)) {
    const cmd = commandOf(words)
    if (!cmd) continue
    const { program, args } = cmd
    if (SHELLS.has(program) && depth < 3) {
      // `bash -c '...'`, also `-lc`, `-ec`, ...: runs its argument as a script.
      const script = shellScript(args)
      if (script) targets.push(...targetsOf(script, sims, depth + 1))
      continue
    }
    if (program === 'xcodebuild') {
      if (!args.some(w => TEST_ACTIONS.has(w))) continue
      const udids: string[] = []
      for (let i = 0; i < args.length; i++) {
        const w = args[i]!
        let spec: string | undefined
        if (w === '-destination') spec = args[++i]
        else if (w.startsWith('-destination=')) spec = w.slice('-destination='.length)
        const udid = spec ? resolveDestination(spec, sims) : null
        if (udid && !udids.includes(udid)) udids.push(udid)
      }
      if (udids.length) targets.push({ udids, isClaiming: true, what: 'xcodebuild test' })
      continue
    }
    if (program === 'simctl') {
      const sub = args[0]
      const device = args[1]
      if (!sub || !device || !SIMCTL_DEVICE_FIRST.has(sub)) continue
      const udids = resolveDevice(device, sims)
      if (udids.length) targets.push({ udids, isClaiming: !SIMCTL_CHECK_ONLY.has(sub) && device !== 'all', what: `simctl ${sub}` })
    }
  }
  return targets
}

export type Holder = { kind: 'free' } | { kind: 'yours'; claim: Claim } | { kind: 'held'; claim: Claim; isStale: boolean }

export function holderOf(udid: string, claims: Claim[], me: string, nowMs: number, staleMinutes: number): Holder {
  const claim = claims.find(c => c.udid === udid)
  if (!claim) return { kind: 'free' }
  if (claim.sessionId === me) return { kind: 'yours', claim }
  return { kind: 'held', claim, isStale: isStale(claim, nowMs, staleMinutes) }
}

function isTaken(holder: Holder): boolean {
  return holder.kind === 'held' && !holder.isStale
}

// A free simulator matching the ask: booted ones first (no boot wait), then the newest runtime.
export function pickFree(
  sims: Sim[],
  claims: Claim[],
  me: string,
  nowMs: number,
  staleMinutes: number,
  want: { name?: string; runtime?: string } = {},
): Sim | null {
  const name = want.name?.toLowerCase()
  const runtime = want.runtime?.toLowerCase()
  const candidates = sims.filter(s => {
    if (name && !s.name.toLowerCase().includes(name)) return false
    if (runtime && !s.runtime.toLowerCase().includes(runtime)) return false
    const holder = holderOf(s.udid, claims, me, nowMs, staleMinutes)
    return holder.kind === 'free' || (holder.kind === 'held' && holder.isStale)
  })
  const booted = candidates.find(s => s.state === 'Booted')
  return booted ?? candidates[0] ?? null
}

export function summarize(b: Board, me: string, nowMs: number, staleMinutes: number): string {
  if (b.error) return b.error
  let free = 0
  let held = 0
  let yours = 0
  for (const s of b.sims) {
    const holder = holderOf(s.udid, b.claims, me, nowMs, staleMinutes)
    if (holder.kind === 'yours') yours++
    else if (isTaken(holder)) held++
    else free++
  }
  const booted = b.sims.filter(s => s.state === 'Booted').length
  return `${free} free · ${held} held · ${yours} yours · ${booted} booted`
}

export function holderText(holder: Holder, nowMs: number): string {
  if (holder.kind === 'free') return 'free'
  if (holder.kind === 'yours') return `yours · ${formatAge(nowMs - holder.claim.claimedAt)}`
  return `${holder.claim.label} · ${formatAge(nowMs - holder.claim.claimedAt)}${holder.isStale ? ' (stale)' : ''}`
}

export function destinationFor(sim: Sim): string {
  return `-destination 'platform=${platformOf(sim.runtime)} Simulator,id=${sim.udid}'`
}

export function listText(b: Board, me: string, nowMs: number, staleMinutes: number): string {
  if (b.error) return b.error
  if (!b.sims.length) return 'No available simulators.'
  const lines = [summarize(b, me, nowMs, staleMinutes), '']
  let runtime = ''
  for (const s of b.sims) {
    if (s.runtime !== runtime) {
      runtime = s.runtime
      lines.push(`${runtime}:`)
    }
    const holder = holderOf(s.udid, b.claims, me, nowMs, staleMinutes)
    const purpose = holder.kind !== 'free' && holder.claim.purpose ? ` — ${holder.claim.purpose}` : ''
    lines.push(`  ${s.name} [${s.udid}] ${s.state}, ${holderText(holder, nowMs)}${purpose}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Claims on disk: ~/.claude/sim-board/claims/<udid>/owner.json, one directory
// per claim so `mkdir` is the atomic test-and-set across sessions.

type Ctx = { root: string; label: string; filter: string; staleMinutes: number }
let ctx: Ctx | null = null
let hasSimctl = false

async function context($: EngineInterface): Promise<Ctx> {
  if (ctx) return ctx
  const home = (await $.env.get('HOME')) ?? '/tmp'
  ctx = { root: `${home}/.claude/sim-board/claims`, label: 'session', filter: '', staleMinutes: 15 }
  return ctx
}

async function readClaims($: EngineInterface): Promise<Claim[]> {
  const { root } = await context($)
  let entries: { name: string; kind: string; mtimeMs?: number }[]
  try {
    entries = await $.fs.list(root)
  } catch {
    return []
  }
  const now = await $.clock.now()
  const claims: Claim[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue
    let claim: Claim | null = null
    try {
      claim = parseOwner(entry.name, String(await $.fs.read(`${root}/${entry.name}/owner.json`)))
    } catch {
      claim = null
    }
    if (claim) claims.push(claim)
    else {
      // Mid-claim, or left behind: hold it as unknown for a minute, then let it go.
      let mtime = now
      try {
        mtime = (await $.fs.stat(`${root}/${entry.name}`)).mtimeMs ?? now
      } catch {}
      if (now - mtime < ORPHAN_MS) {
        claims.push({ udid: entry.name, sessionId: '?', label: 'claiming…', claimedAt: mtime, heartbeatAt: mtime })
      }
    }
  }
  return claims
}

async function listSims($: EngineInterface): Promise<{ sims: Sim[]; error: string | null }> {
  try {
    const run = await $.process.run(['xcrun', 'simctl', 'list', 'devices', 'available', '-j'], { timeoutMs: 20_000 })
    if (run.exitCode !== 0) return { sims: [], error: `simctl failed: ${run.stderr.trim().split('\n')[0] ?? run.exitCode}` }
    // The full inventory: the guard must see a held simulator the filter hides.
    return { sims: parseDevices(run.stdout), error: null }
  } catch {
    return { sims: [], error: 'simctl not available (Xcode command line tools are needed)' }
  }
}

async function refresh($: EngineInterface): Promise<Board> {
  const [{ sims, error }, claims] = await Promise.all([listSims($), readClaims($)])
  const b: Board = { sims, claims, error, at: await $.clock.now() }
  await $.state.set(BOARD, b)
  const me = await $.session.id()
  const mine = sims.filter(s => claims.some(c => c.udid === s.udid && c.sessionId === me))
  $.ui.status(mine.length ? `sims: ${mine.map(s => s.name).join(', ')}` : undefined)
  return b
}

export type ClaimOutcome = { ok: true } | { ok: false; holder: Claim }

type CtlResult = { ok: boolean; holder?: unknown; error?: string }

// Every change to a claim runs in hooks/claimctl.py under an flock the kernel
// releases when that process exits: reading, deciding and writing can't
// interleave with another session's, and no lock is ever left to break.
async function claimctl($: EngineInterface, command: 'claim' | 'renew' | 'release', udid: string, args: Record<string, unknown>): Promise<CtlResult> {
  const { root, staleMinutes } = await context($)
  if (!/^[A-Fa-f0-9-]+$/.test(udid)) return { ok: false, error: 'bad udid' }
  const full = { ...args, me: await $.session.id(), now: await $.clock.now(), staleMs: staleMinutes * MINUTE, orphanMs: ORPHAN_MS }
  const run = await $.process.run(['python3', `${$.plugin.root}/hooks/claimctl.py`, command, root, udid, JSON.stringify(full)], {
    timeoutMs: 15_000,
  })
  try {
    return JSON.parse(run.stdout) as CtlResult
  } catch {
    return { ok: false, error: run.stderr.trim().split('\n').pop() || `claimctl exited ${run.exitCode}` }
  }
}

function holderFrom(result: CtlResult, udid: string): Claim {
  const parsed = result.holder ? parseOwner(udid, JSON.stringify(result.holder)) : null
  return parsed ?? { udid, sessionId: '?', label: result.error ? `unknown (${result.error})` : 'another session (claiming…)', claimedAt: 0, heartbeatAt: 0 }
}

async function claimSim($: EngineInterface, udid: string, purpose?: string, force = false): Promise<ClaimOutcome> {
  const { label } = await context($)
  const result = await claimctl($, 'claim', udid, { owner: { label, ...(purpose ? { purpose } : {}) }, force })
  return result.ok ? { ok: true } : { ok: false, holder: holderFrom(result, udid) }
}

async function releaseSim($: EngineInterface, udid: string, force = false): Promise<boolean> {
  return (await claimctl($, 'release', udid, { force })).ok
}

async function releaseMine($: EngineInterface): Promise<string[]> {
  const me = await $.session.id()
  const released: string[] = []
  for (const c of await readClaims($)) {
    if (c.sessionId === me && (await claimctl($, 'release', c.udid, {})).ok) released.push(c.udid)
  }
  return released
}

async function heartbeat($: EngineInterface): Promise<void> {
  const me = await $.session.id()
  for (const c of await readClaims($)) if (c.sessionId === me) await claimctl($, 'renew', c.udid, {})
}

// ---------------------------------------------------------------------------

const GUIDANCE = `# Simulators (sim-board)
Several sessions share this Mac's iOS Simulators. Before running UI tests or booting/installing on a simulator, call mcp__sim-board__sims_claim and target the simulator it returns by id (its -destination string), not by name. Never test on a simulator another session holds; mcp__sim-board__sims_list shows who holds what. When you are done with UI tests, call mcp__sim-board__sims_release. Commands that target a simulator held by another session are refused.`

const tool = (name: string) => `mcp__${PLUGIN}__${name}`
const toolRe = (name: string) => new RegExp(`^mcp__${PLUGIN}__${name}$`)

export const register: Register = (on, options) => {
  const filter = typeof options.filter === 'string' ? options.filter : ''
  const staleMinutes = typeof options.staleMinutes === 'number' && options.staleMinutes > 0 ? options.staleMinutes : 15
  // The filter narrows what is listed and picked, never what the guard checks.
  const view = (b: Board): Board => ({ ...b, sims: filterSims(b.sims, filter) })

  on('session.start', async ($, e, next) => {
    ctx = null
    const base = await context($)
    const dir = e.cwd.split(/[\\/]/).filter(Boolean).pop() ?? e.cwd
    let label = dir
    try {
      const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5_000 })
      const branch = head.exitCode === 0 ? head.stdout.trim() : ''
      if (branch && branch !== 'HEAD' && !branch.endsWith(dir)) label = `${dir} (${branch})`
      else if (branch && branch !== 'HEAD') label = branch
    } catch {}
    ctx = { ...base, label, filter, staleMinutes }

    const b = await refresh($)
    hasSimctl = b.error === null || !b.error.startsWith('simctl not available')
    if (hasSimctl) {
      await $.command.register({ name: 'sims', description: 'Show which simulators are free, booted or held by which session' })
      await $.tool.register({
        name: 'sims_list',
        description: 'List the available simulators with their state and which Claude Code session holds each.',
        inputSchema: { type: 'object', properties: {} },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'sims_claim',
        description:
          'Claim a simulator for this session before UI tests. With no arguments, picks a free one (booted first). Returns its udid and the -destination to pass to xcodebuild.',
        inputSchema: {
          type: 'object',
          properties: {
            udid: { type: 'string', description: 'A specific simulator to claim' },
            name: { type: 'string', description: 'Part of the device name to match, e.g. "iPhone 17"' },
            runtime: { type: 'string', description: 'Part of the runtime to match, e.g. "iOS 26"' },
            purpose: { type: 'string', description: 'A few words on what it is for, shown to others' },
            boot: { type: 'boolean', description: 'Boot it if it is shut down (default true)' },
          },
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'sims_release',
        description: "Release a simulator this session claimed (all of this session's when no udid is given). It stays booted.",
        inputSchema: { type: 'object', properties: { udid: { type: 'string' } } },
        isDeferred: false,
      })
      $.clock.every(REFRESH_MS, () => void refresh($).catch(() => {}))
      $.clock.every(HEARTBEAT_MS, () => void heartbeat($).catch(() => {}))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      await releaseMine($)
    } catch {}
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!hasSimctl) return composed
    return { sections: [...composed.sections, { id: `${PLUGIN}:guidance`, text: GUIDANCE, scope: 'session' as const }] }
  })

  on('command.run', { command: 'sims' }, async $ => {
    const b = await refresh($)
    void $.ui.open({ id: PANE, title: 'Simulators' })
    return { text: summarize(view(b), await $.session.id(), b.at, staleMinutes) }
  })

  on('tool.call', { tool: toolRe('sims_list') }, async $ => {
    const b = await refresh($)
    return { result: listText(view(b), await $.session.id(), b.at, staleMinutes) }
  })

  on('tool.call', { tool: toolRe('sims_claim') }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const str = (k: string) => (typeof input[k] === 'string' && input[k] ? (input[k] as string) : undefined)
    const b = await refresh($)
    if (b.error) return { result: b.error }
    const me = await $.session.id()
    const udid = str('udid')
    const sim = udid
      ? b.sims.find(s => s.udid === udid)
      : pickFree(view(b).sims, b.claims, me, b.at, staleMinutes, { name: str('name'), runtime: str('runtime') })
    if (!sim) return { result: udid ? `No available simulator has udid ${udid}.` : `No free simulator matches.\n\n${listText(view(b), me, b.at, staleMinutes)}` }
    const outcome = await claimSim($, sim.udid, str('purpose'))
    if (!outcome.ok) {
      const alt = pickFree(view(b).sims, b.claims, me, b.at, staleMinutes)
      return {
        result: `${sim.name} is held by ${outcome.holder.label}.${alt ? ` ${alt.name} [${alt.udid}] is free.` : ' No other simulator is free.'}`,
      }
    }
    let note = ''
    if (input.boot !== false && sim.state === 'Shutdown') {
      const boot = await $.process.run(['xcrun', 'simctl', 'boot', sim.udid], { timeoutMs: 120_000 })
      note = boot.exitCode === 0 ? ' Booted it.' : ` Boot failed: ${boot.stderr.trim().split('\n')[0]}`
    }
    await refresh($)
    return { result: `Claimed ${sim.name} (${sim.runtime}) [${sim.udid}] for this session.${note}\nUse: ${destinationFor(sim)}` }
  })

  on('tool.call', { tool: toolRe('sims_release') }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const udid = typeof input.udid === 'string' && input.udid ? input.udid : undefined
    let text: string
    if (udid) text = (await releaseSim($, udid)) ? `Released ${udid}.` : `${udid} is held by another session; not released.`
    else {
      const released = await releaseMine($)
      text = released.length ? `Released ${released.join(', ')}.` : 'This session held no simulators.'
    }
    await refresh($)
    return { result: text }
  })

  // The guard: a command on a simulator another session holds is refused; one on a free simulator claims it.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!hasSimctl || !/xcodebuild|simctl/.test(e.command)) return next(e)
    const b = await refresh($)
    const targets = targetsOf(e.command, b.sims)
    if (!targets.length) return next(e)
    const me = await $.session.id()
    for (const t of targets) {
      for (const udid of t.udids) {
        const holder = holderOf(udid, b.claims, me, b.at, staleMinutes)
        if (!isTaken(holder) || holder.kind !== 'held') continue
        const sim = b.sims.find(s => s.udid === udid)!
        const alt = pickFree(view(b).sims, b.claims, me, b.at, staleMinutes)
        return {
          deny:
            `sim-board: ${sim.name} [${udid}] is in use by ${holder.claim.label} (claimed ${formatAge(b.at - holder.claim.claimedAt)} ago${holder.claim.purpose ? `, ${holder.claim.purpose}` : ''}); ${t.what} on it is refused. ` +
            (alt
              ? `${alt.name} (${alt.runtime}) is free: call ${tool('sims_claim')} with udid ${alt.udid} and use ${destinationFor(alt)}.`
              : `No simulator is free right now; call ${tool('sims_list')} and wait, or ask the person.`),
        }
      }
    }
    // Claim every target or none: a refused command keeps no claim it made.
    const acquired: string[] = []
    for (const t of targets) {
      if (!t.isClaiming) continue
      for (const udid of t.udids) {
        if (acquired.includes(udid)) continue
        const wasMine = holderOf(udid, b.claims, me, b.at, staleMinutes).kind === 'yours'
        const outcome = await claimSim($, udid, t.what)
        if (!outcome.ok) {
          for (const got of acquired) await releaseSim($, got)
          void refresh($).catch(() => {})
          return { deny: `sim-board: ${udid} was just claimed by ${outcome.holder.label}; pick another with ${tool('sims_claim')}.` }
        }
        if (!wasMine) acquired.push(udid)
      }
    }
    void refresh($).catch(() => {})
    return next(e)
    // A guard that fails lets the command run rather than wedge Bash.
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, board)
    if (!b) return <Text dimColor>Loading simulators…</Text>
    if (b.error) return <Text color="warning">{b.error}</Text>
    const me = await $.session.id()
    const now = b.at
    const shown = view(b)
    const rows: RenderChildren[] = []
    let runtime = ''
    for (const s of shown.sims) {
      if (s.runtime !== runtime) {
        runtime = s.runtime
        rows.push(
          <Text bold key={`rt-${runtime}`}>
            {runtime}
          </Text>,
        )
      }
      const holder = holderOf(s.udid, b.claims, me, now, staleMinutes)
      const color = holder.kind === 'free' || (holder.kind === 'held' && holder.isStale) ? 'success' : holder.kind === 'yours' ? 'suggestion' : 'warning'
      const isBooted = s.state === 'Booted'
      rows.push(
        <Box key={s.udid} flexDirection="row" gap={1}>
          <Text color={isBooted ? 'success' : undefined} dimColor={!isBooted}>
            {isBooted ? '●' : '○'}
          </Text>
          <Text dimColor={!isBooted}>{s.name}</Text>
          <Text color={color}>{holderText(holder, now)}</Text>
          {holder.kind === 'yours' && <Button key={`release-${s.udid}`} label="Release" dimColor onPress={() => void releaseSim($, s.udid).then(() => refresh($))} />}
          {holder.kind === 'held' && (
            <Button key={`free-${s.udid}`} label="Free" dimColor onPress={() => void releaseSim($, s.udid, true).then(() => refresh($))} />
          )}
          {holder.kind === 'free' && <Button key={`claim-${s.udid}`} label="Claim" dimColor onPress={() => void claimSim($, s.udid, 'claimed by hand').then(() => refresh($))} />}
        </Box>,
      )
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{summarize(shown, me, now, staleMinutes)}</Text>
          <Button key="refresh" hotkey="r" label="Refresh" dimColor onPress={() => void refresh($)} />
        </Box>
        {shown.sims.length ? rows : <Text dimColor>No available simulators.</Text>}
      </Box>
    )
  })
}
