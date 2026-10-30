import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { CacheTtl, CostView, GitState, KnownBilling, Usage } from '../types'
import { rate } from './rates.mjs'

const usage = atom({ plugin: 'usage-meter', key: 'usage' } as const, null)
const now = atom({ plugin: 'usage-meter', key: 'now' } as const, null)
const git = atom({ plugin: 'usage-meter', key: 'git' } as const, null)
const model = atom({ plugin: 'usage-meter', key: 'model' } as const, null)
const effort = atom({ plugin: 'usage-meter', key: 'effort' } as const, null)

const costView = atom({ plugin: 'usage-meter', key: 'costView' } as const, 'session' as CostView)
const costOpen = atom({ plugin: 'usage-meter', key: 'costOpen' } as const, false)
const costInfo = atom({ plugin: 'usage-meter', key: 'costInfo' } as const, false)
const ledger = atom({ plugin: 'usage-meter', key: 'ledger' } as const, {} as Record<string, number>)
const sessionCost = atom({ plugin: 'usage-meter', key: 'sessionCost' } as const, 0)
const knownBilling = atom({ plugin: 'usage-meter', key: 'knownBilling' } as const, null as KnownBilling | null)
const dir = atom({ plugin: 'usage-meter', key: 'dir' } as const, null)
const worktreeOpen = atom({ plugin: 'usage-meter', key: 'worktreeOpen' } as const, false)
// When the main thread last sent a request (clock ms).
const cacheAt = atom({ plugin: 'usage-meter', key: 'cacheAt' } as const, null as number | null)
const cacheTtl = atom({ plugin: 'usage-meter', key: 'cacheTtl' } as const, null as CacheTtl | null)
const cacheInfo = atom({ plugin: 'usage-meter', key: 'cacheInfo' } as const, false)

const BAR_CELLS = 10
const CONTEXT_CELLS = BAR_CELLS * 2
// Dark-terminal track colour; ThemeKey has no neutral background.
const TRACK_COLOR = '#3a3a3a'
const MINUTE = 60_000

export type BillingMode = KnownBilling | 'unknown'

// Rate-limit windows only exist on a subscription (Pro/Max/Team/Enterprise
// seats). With none and a priced response already in, billing is per token.
// Before the first response there is no reading, so it is unknown.
export function billingMode(u: Usage | null, cost: number): BillingMode {
  if (u?.rateLimits.some(r => r.kind === 'five_hour' || r.kind === 'seven_day')) return 'subscription'
  return u && cost > 0 ? 'metered' : 'unknown'
}

// The live reading wins; until there is one, the mode last seen (in any
// session) stands in, so a metered seat does not flash the limit bars.
export function resolveBilling(live: BillingMode, cached: KnownBilling | null): BillingMode {
  return live === 'unknown' ? (cached ?? 'unknown') : live
}

// Last path segment, for either separator; the root stays itself.
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export const COST_VIEWS: { id: CostView; label: string; days: number }[] = [
  { id: 'session', label: 'Session', days: 0 },
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
]

// Local-date key, so "today" rolls over at local midnight.
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// Sum of the last `days` local days including today.
export function sumDays(map: Record<string, number>, nowMs: number, days: number): number {
  let total = 0
  const d = new Date(nowMs)
  // Step by local calendar date: a day is not always 24 h across DST changes.
  for (let i = 0; i < days; i++, d.setDate(d.getDate() - 1)) total += map[dayKey(d.getTime())] ?? 0
  return total
}

// Session is exact (reported by Claude Code); the rest are marked as estimates.
export function formatCost(id: CostView, usd: number): string {
  return `${id === 'session' ? '' : '~'}$${usd.toFixed(2)}`
}

const COST_EXPLANATION = [
  'You appear to be billed per token, so cost is shown instead of 5-hour and weekly limits.',
  'Session is the exact cost Claude Code reports for this session.',
  "Today, 7 days and 30 days (~) are estimates: this mod scans the local logs in ~/.claude/projects and Cowork sessions, counts each message's token usage once, and prices it at public API list prices per model.",
  'Discounts, other machines and logs older than 30 days are not reflected, usage billed to a subscription is priced the same way, and unrecognised models are priced as Sonnet. Refreshed at most once a minute.',
]

export type CacheMode = 'warm' | 'cold'

// The engine reports the TTL only around a model switch. Until one has been
// seen, a subscription is taken to cache for an hour and a metered key for 5 minutes.
export function cacheTtlOf(seen: CacheTtl | null, billing: BillingMode): CacheTtl {
  return seen ?? (billing === 'metered' ? '5m' : '1h')
}

export function cacheTtlMs(ttl: CacheTtl): number {
  return ttl === '5m' ? 5 * MINUTE : LONGEST_TTL
}

// List-price USD to write `tokens` of context back to the cache: a 1 h write
// costs 2x input, a 5 min write 1.25x.
export function recacheCost(model: string, tokens: number, ttl: CacheTtl, nowMs: number): number {
  return (tokens * rate(model, tokens, nowMs).i * (ttl === '1h' ? 2 : 1.25)) / 1e6
}

// The one line the cache's ⓘ opens. Cost only where billing is per token.
export function cacheExplanation(
  cache: { mode: CacheMode; minutesLeft: number },
  ttl: CacheTtl,
  isTtlSeen: boolean,
  tokens: number,
  cost: number | null,
): string {
  const recache = `${formatTokens(tokens)} tokens${cost === null ? '' : `, ~$${cost.toFixed(2)}`}`
  const lifetime = `${ttl === '1h' ? '1 h' : '5 min'} TTL${isTtlSeen ? '' : ', assumed'}`
  return cache.mode === 'warm'
    ? `Prompt cache warm for ${cache.minutesLeft} more min (${lifetime}). Once cold, the next message re-caches ${recache}.`
    : `Prompt cache cold (${lifetime}): the next message re-caches ${recache}.`
}

// Stamped as the last request's time, this reads as cold under any TTL.
const LONGEST_TTL = 60 * MINUTE

// Warm until the TTL has passed since the last request, with whole minutes left.
export function cacheState(lastAt: number | null, nowMs: number, ttlMs: number): { mode: CacheMode; minutesLeft: number } | null {
  if (lastAt === null) return null
  const left = Math.min(ttlMs, lastAt + ttlMs - nowMs)
  return left > 0 ? { mode: 'warm', minutesLeft: Math.ceil(left / MINUTE) } : { mode: 'cold', minutesLeft: 0 }
}

// Outline pixel art, one cell per pixel: drawn as an Image in the terminal
// (2 columns by 1 row) and as an Svg elsewhere.
export const CACHE_ICONS: Record<CacheMode, { rows: string[]; color: number; alt: string }> = {
  warm: {
    color: 0xe07a4a,
    alt: '🔥',
    rows: [
      '...............',
      '.......#.......',
      '......#.#......',
      '.....#...#.....',
      '.....#....#....',
      '....#......#.#.',
      '...#........##.',
      '...#..#......#.',
      '..#..#.#.....#.',
      '..#..#..#....#.',
      '..#.#....#...#.',
      '..#.#....#...#.',
      '..#..#..#...#..',
      '...#..##...#...',
      '....##....##...',
      '......####.....',
    ],
  },
  cold: {
    color: 0x6aaabd,
    alt: '🧊',
    rows: [
      '...............',
      '.......#.......',
      '.....##.##.....',
      '...##.....##...',
      '.##.........##.',
      '.#.##.....##.#.',
      '.#...##.##...#.',
      '.#.....#.....#.',
      '.#.#...#.....#.',
      '.#.#...#.....#.',
      '.#.....#.....#.',
      '.#.....#.....#.',
      '.##....#....##.',
      '...##..#..##...',
      '.....##.##.....',
      '.......#.......',
    ],
  },
}

export function iconRgba(rows: string[], color: number): Uint8Array {
  const width = rows[0]!.length
  const px = new Uint8Array(width * rows.length * 4)
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c !== '#') return
      px.set([(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff, 0xff], (y * width + x) * 4)
    }),
  )
  return px
}

export function iconSvg(rows: string[], color: number): string {
  const d = rows.flatMap((row, y) => [...row].flatMap((c, x) => (c === '#' ? [`M${x} ${y}h1v1h-1z`] : []))).join('')
  const fill = `#${color.toString(16).padStart(6, '0')}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${rows[0]!.length} ${rows.length}" shape-rendering="crispEdges"><path fill="${fill}" d="${d}"/></svg>`
}

const ICON_SOURCES = Object.fromEntries(
  Object.entries(CACHE_ICONS).map(([mode, { rows, color, alt }]) => [
    mode,
    { rgba: iconRgba(rows, color).toBase64(), width: rows[0]!.length, height: rows.length, svg: iconSvg(rows, color), alt },
  ]),
) as Record<CacheMode, { rgba: string; width: number; height: number; svg: string; alt: string }>

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${n}`
}

export function percentLeft(kind: string, u: Usage | null): number | null {
  const window = u?.rateLimits.find(r => r.kind === kind)
  if (!window) return null
  return Math.max(0, Math.min(100, Math.round(100 - window.percentUsed)))
}

export function formatResetIn(resetsAt: string | undefined, nowMs: number | null): string | null {
  if (!resetsAt || nowMs === null) return null
  const minutes = Math.max(0, Math.ceil((Date.parse(resetsAt) - nowMs) / MINUTE))
  if (Number.isNaN(minutes)) return null
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${minutes % 60}m`
  return `${minutes}m`
}

export function parseGitStatus(porcelainV2: string): Omit<GitState, 'worktree' | 'root'> | null {
  const lines = porcelainV2.split('\n').filter(line => line.length > 0)
  const head = lines.find(line => line.startsWith('# branch.head '))
  if (!head) return null
  const branch = head.slice('# branch.head '.length)
  return {
    branch: branch === '(detached)' ? 'detached' : branch,
    isDirty: lines.some(line => !line.startsWith('#')),
  }
}

export function barCells(left: number, cells: number): { filled: string; empty: string } {
  const label = `${left}%`
  const start = Math.max(0, Math.floor((cells - label.length) / 2))
  const text = (' '.repeat(start) + label).padEnd(cells).slice(0, cells)
  const filledCount = Math.round((left / 100) * cells)
  return { filled: text.slice(0, filledCount), empty: text.slice(filledCount) }
}

// Percent of the context window still free, from the tokens in use.
export function contextLeft(u: Usage): number {
  const used = u.context.percent ?? (u.context.window > 0 ? ((u.context.tokens ?? 0) / u.context.window) * 100 : 0)
  return Math.max(0, Math.min(100, Math.round(100 - used)))
}

// A bar with no text inside: just the filled and empty runs.
export function barFill(left: number, cells: number): { filled: string; empty: string } {
  const filledCount = Math.round((left / 100) * cells)
  return { filled: ' '.repeat(filledCount), empty: ' '.repeat(cells - filledCount) }
}

export function formatModel(id: string): string {
  const bare = id.replace(/\[.*\]$/, '')
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(bare)
  if (!match) return bare
  const [, family = '', major, minor] = match
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return minor ? `${name} ${major}.${minor}` : `${name} ${major}`
}

async function refreshModel($: EngineInterface) {
  const name = await $.session.model()
  await update($, model, () => name)
}

function barColor(left: number): Color {
  if (left > 50) return 'success'
  if (left > 20) return 'warning'
  return 'error'
}

export function parseWorktree(revParse: string): { worktree: string | null; root: string | null } {
  const [gitDir, commonDir, topLevel] = revParse.trim().split('\n')
  if (!topLevel) return { worktree: null, root: null }
  const linked = gitDir && commonDir && gitDir !== commonDir
  return { worktree: linked ? baseName(topLevel) : null, root: topLevel }
}

// What the git row names, without saying the same thing twice. In a worktree
// the directory is its root, so only a subfolder (relative) is worth naming;
// the worktree itself is behind the ⎇ toggle. A directory the branch already
// ends with (feat/x in x) is left to the branch.
export function locationLabel(cwd: string | null, repo: GitState | null): string | null {
  if (!cwd) return null
  let label: string | null = baseName(cwd)
  if (repo?.worktree) {
    const root = repo.root?.replace(/\/+$/, '')
    if (root && cwd.startsWith(`${root}/`)) label = cwd.slice(root.length + 1).replace(/\/+$/, '') || null
    else if (root === cwd.replace(/\/+$/, '') || label === repo.worktree) label = null
  }
  if (label && repo && (repo.branch === label || repo.branch.endsWith(`/${label}`))) return null
  return label
}

async function refreshGit($: EngineInterface) {
  try {
    const [status, paths] = await Promise.all([
      $.process.run(['git', 'status', '--porcelain=v2', '--branch'], { timeoutMs: 5_000 }),
      $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], {
        timeoutMs: 5_000,
      }),
    ])
    const parsed = status.exitCode === 0 ? parseGitStatus(status.stdout) : null
    const where = paths.exitCode === 0 ? parseWorktree(paths.stdout) : { worktree: null, root: null }
    const state = parsed && { ...parsed, ...where }
    await update($, git, () => state)
  } catch {
    await update($, git, () => null)
  }
}

async function refreshDir($: EngineInterface) {
  const name = await $.session.cwd()
  await update($, dir, () => name)
}

let lastScan = 0
let lastDays: Record<string, number> | null = null

// Re-estimates the per-day cost from local logs; throttled to 60 s and only
// run for metered users. Where a host refuses $.process, the last value stays.
async function refreshLedger($: EngineInterface) {
  const time = await $.clock.now()
  if (time - lastScan < MINUTE) {
    // /clear, /resume and /branch reset the ledger atom; put the last scan back.
    if (lastDays && Object.keys(await read($, ledger)).length === 0) await update($, ledger, () => lastDays!)
    return
  }
  lastScan = time
  try {
    const run = await $.process.run(['node', `${$.plugin.root}/hooks/scan.mjs`, '30'], { timeoutMs: 60_000 })
    if (run.exitCode !== 0) return
    const { days } = JSON.parse(run.stdout) as { days: Record<string, number> }
    lastDays = days
    await update($, ledger, () => days)
  } catch {}
}

async function noteCost($: EngineInterface, cost: { usd: number } | undefined, u: Usage) {
  // The store is the source of truth: /clear and /resume reset state without a session.start.
  const picked = await $.store.get('costView')
  if (picked && picked !== (await read($, costView))) await update($, costView, () => picked as CostView)
  if (cost) await update($, sessionCost, () => cost.usd)
  const live = billingMode(u, await read($, sessionCost))
  const stored = await $.store.get('billing')
  const cached = live !== 'unknown' ? live : stored === 'subscription' || stored === 'metered' ? stored : null
  if (cached !== (await read($, knownBilling))) await update($, knownBilling, () => cached)
  if (live !== 'unknown' && live !== stored) await $.store.set('billing', live)
  if (cached === 'metered') refreshLedger($).catch(() => {})
}

async function currentBilling($: EngineInterface): Promise<BillingMode> {
  return resolveBilling(billingMode(await read($, usage), await read($, sessionCost)), await read($, knownBilling))
}

async function restoreCacheTtl($: EngineInterface) {
  const ttl = await $.store.get('cacheTtl')
  if (ttl === '5m' || ttl === '1h') await update($, cacheTtl, () => ttl)
}

async function tick($: EngineInterface) {
  const time = await $.clock.now()
  await update($, now, () => time)
  await Promise.all([refreshGit($), refreshDir($).catch(() => {})])
  // Other sessions keep writing logs while this one is idle; pick their usage up too.
  if ((await currentBilling($)) === 'metered') refreshLedger($).catch(() => {})
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const { context, rateLimits, cost } = await $.session.usage()
    await update($, usage, () => ({ context, rateLimits }))
    await noteCost($, cost, { context, rateLimits })
    await tick($)
    await refreshModel($)
    await restoreCacheTtl($)
    $.clock.every(MINUTE, () => tick($))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const u = { context: e.context, rateLimits: e.rateLimits }
    await update($, usage, () => u)
    await noteCost($, e.cost, u)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    refreshGit($).catch(() => {})
    refreshDir($).catch(() => {})
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const level = e.effort === undefined ? null : `${e.effort}`
      update($, effort, () => level).catch(() => {})
      update($, model, () => e.model).catch(() => {})
      const sentAt = await $.clock.now()
      update($, cacheAt, () => sentAt).catch(() => {})
    }
    return yield* next(e)
  })

  // A resumed or forked transcript's cache is as old as its last response;
  // /clear and /compact start the next request from nothing.
  on('classic.SessionStart', async ($, e, next) => {
    // /clear and /resume reset state without a session.start.
    await restoreCacheTtl($)
    if (e.source === 'clear' || e.source === 'compact') await update($, cacheAt, () => null)
    else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const time = await $.clock.now()
      const lastAt = time - e.seconds_since_last_response * 1000
      await update($, cacheAt, () => (e.prompt_cache_likely_expired ? Math.min(lastAt, time - LONGEST_TTL) : lastAt))
    }
    return next(e)
  })

  // The only place the engine names the TTL. A switch leaves the new model's cache cold.
  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, cacheTtl, () => e.cache_ttl)
    await $.store.set('cacheTtl', e.cache_ttl)
    const time = await $.clock.now()
    if (e.from_model !== e.to_model) await update($, cacheAt, v => (v === null ? null : time - LONGEST_TTL))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    tick($).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || !u) return next(e)
    const repo = await read($, git)
    const cwd = await read($, dir)
    const dirName = locationLabel(cwd, repo)
    const isWorktreeOpen = !!repo?.worktree && (await read($, worktreeOpen))
    const modelId = await read($, model)
    const effortLevel = await read($, effort)
    const spentSession = await read($, sessionCost)
    const mode = await currentBilling($)
    const isMetered = mode === 'metered'
    const lastAt = await read($, cacheAt)
    // Reading `now` redraws on the minute tick; the clock itself is read fresh,
    // since /clear and /resume reset `now` until the next tick.
    await read($, now)
    const seenTtl = await read($, cacheTtl)
    const ttl = cacheTtlOf(seenTtl, mode)
    const cache = cacheState(lastAt, await $.clock.now(), cacheTtlMs(ttl))
    const isCacheInfo = !!cache && (await read($, cacheInfo))

    const { Box, Button, Text } = $.ui.resolve(e)

    const cacheIcon = (m: CacheMode) => {
      const icon = ICON_SOURCES[m]
      if (e.surface === 'terminal') {
        const { Image } = $.ui.resolve(e)
        return <Image source={{ rgba: icon.rgba, width: icon.width, height: icon.height }} columns={2} rows={1} alt={icon.alt} />
      }
      const { Svg } = $.ui.resolve(e)
      return <Svg source={icon.svg} alt={m === 'warm' ? 'Prompt cache warm' : 'Prompt cache cold'} width={14} height={15} />
    }

    const meter = (label: string, kind: string, nowMs: number | null) => {
      const left = percentLeft(kind, u)
      if (left === null) {
        return (
          <Box key={kind}>
            <Text dimColor>{label} –</Text>
          </Box>
        )
      }
      const { filled, empty } = barCells(left, BAR_CELLS)
      const resetIn = formatResetIn(u.rateLimits.find(r => r.kind === kind)?.resetsAt, nowMs)
      return (
        <Box key={kind}>
          <Text dimColor>{label} </Text>
          <Text color="inverseText" backgroundColor={barColor(left)} bold>
            {filled}
          </Text>
          <Text backgroundColor={TRACK_COLOR}>{empty}</Text>
          {resetIn && <Text dimColor> · {resetIn}</Text>}
        </Box>
      )
    }

    const current = await read($, costView)
    const isOpen = await read($, costOpen)
    const isInfo = await read($, costInfo)
    const ledgerNow = await read($, ledger)
    const nowMs = await $.clock.now()
    const costs = COST_VIEWS.map(v => formatCost(v.id, v.id === 'session' ? spentSession : sumDays(ledgerNow, nowMs, v.days)))
    const index = COST_VIEWS.findIndex(v => v.id === current)
    const estimated = current !== 'session'

    // Subscription: the two limit bars. Metered: the cost control. Unknown: nothing yet.
    const limits = mode === 'unknown' ? null : isMetered ? (
      <Box key="cost" columnGap={1}>
        <Text dimColor>Cost</Text>
        <Button
          key="cost-toggle"
          label={`${COST_VIEWS[index]!.label} ${isOpen ? '▴' : '▾'}`}
          onPress={() => update($, costOpen, v => !v)}
        />
        <Text>
          {costs[index]}
          {estimated ? ' est.' : ''}
        </Text>
        <Button key="cost-info" label={isInfo ? 'ⓘ Hide' : 'ⓘ'} onPress={() => update($, costInfo, v => !v)} />
      </Box>
    ) : (
      <Box key="limits" columnGap={3}>
        {meter('5h', 'five_hour', await read($, now))}
        {meter('Weekly', 'seven_day', await read($, now))}
      </Box>
    )

    const costWidth = Math.max(...costs.map(c => c.length))
    const labelWidth = Math.max(...COST_VIEWS.map(v => v.label.length))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" width={e.props.bodyColumns} justifyContent="space-between" columnGap={3}>
          {repo || dirName ? (
            <Box key="git" flexShrink={1} minWidth={0} columnGap={1}>
              {repo?.worktree && (
                <Button
                  key="worktree-toggle"
                  label={isWorktreeOpen ? '⎇ Hide' : '⎇'}
                  onPress={() => update($, worktreeOpen, v => !v)}
                />
              )}
              <Text wrap="truncate-end">
                {dirName && <Text>{dirName}</Text>}
                {dirName && repo && <Text dimColor> on </Text>}
                {repo && <Text color="suggestion">{repo.branch}</Text>}
                {repo?.isDirty && <Text color="warning"> ●</Text>}
              </Text>
            </Box>
          ) : (
            <Text key="git"> </Text>
          )}
          <Box key="right" columnGap={3} flexShrink={0}>
            {modelId && (
              <Box key="model">
                <Text color="claude">{formatModel(modelId)}</Text>
                {effortLevel && <Text dimColor> · {effortLevel}</Text>}
              </Box>
            )}
            {cache && (
              <Box key="cache" columnGap={1}>
                {cacheIcon(cache.mode)}
                {cache.mode === 'warm' && <Text dimColor>{`${cache.minutesLeft}m`}</Text>}
                <Button key="cache-info" label={isCacheInfo ? 'ⓘ Hide' : 'ⓘ'} onPress={() => update($, cacheInfo, v => !v)} />
              </Box>
            )}
            {limits}
          </Box>
        </Box>
        {isWorktreeOpen && repo?.worktree && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            {[
              ['Worktree', repo.worktree],
              ['Directory', cwd ?? ''],
              ['Branch', repo.branch],
            ].map(([label, value]) => (
              <Box key={label}>
                <Box width={11} flexShrink={0}>
                  <Text dimColor>{label}</Text>
                </Box>
                <Text>{value}</Text>
              </Box>
            ))}
          </Box>
        )}
        {cache && isCacheInfo && (
          <Box alignSelf="flex-end">
            <Text dimColor>
              {cacheExplanation(
                cache,
                ttl,
                seenTtl !== null,
                u.context.tokens ?? 0,
                isMetered && modelId ? recacheCost(modelId, u.context.tokens ?? 0, ttl, await $.clock.now()) : null,
              )}
            </Text>
          </Box>
        )}
        {isMetered && isInfo && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            {COST_EXPLANATION.map((paragraph, i) => (
              <Box key={i} marginTop={i === 0 ? 0 : 1}>
                <Text dimColor>{paragraph}</Text>
              </Box>
            ))}
          </Box>
        )}
        {isMetered && isOpen && (
          <Box flexDirection="column" alignSelf="flex-end">
            {COST_VIEWS.map((v, i) => (
              <Box key={v.id}>
                <Box width={labelWidth + 8}>
                  <Button
                    key={v.id}
                    label={`${v.id === current ? '●' : '○'} ${v.label}`}
                    onPress={async () => {
                      await update($, costView, () => v.id)
                      await update($, costOpen, () => false)
                      await $.store.set('costView', v.id)
                    }}
                  />
                </Box>
                <Box width={costWidth + 1} justifyContent="flex-end">
                  <Text>{costs[i]}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const u = await read($, usage)
    if (!u) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    const left = contextLeft(u)
    // Fills as the window is used; the colour still turns red as little is left.
    const { filled, empty } = barFill(100 - left, CONTEXT_CELLS)

    return (
      <Box flexDirection="row" flexGrow={1} flexShrink={1} justifyContent="flex-end">
        <Text dimColor>Context </Text>
        <Text backgroundColor={barColor(left)}>{filled}</Text>
        <Text backgroundColor={TRACK_COLOR}>{empty}</Text>
        <Text dimColor>
          {' '}
          {formatTokens(u.context.tokens ?? 0)}/{formatTokens(u.context.window)}
        </Text>
      </Box>
    )
  })
}
