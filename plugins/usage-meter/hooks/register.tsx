import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { CostView, GitState, KnownBilling, Usage } from '../types'

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

const BAR_CELLS = 10
const CONTEXT_CELLS = BAR_CELLS * 2
// Dark-terminal track colour; ThemeKey has no neutral background.
const TRACK_COLOR = '#3a3a3a'
const BRANCH_CHARS = 56
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

export function parseGitStatus(porcelainV2: string): Omit<GitState, 'worktree'> | null {
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

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function barColor(left: number): Color {
  if (left > 50) return 'success'
  if (left > 20) return 'warning'
  return 'error'
}

export function parseWorktree(revParse: string): string | null {
  const [gitDir, commonDir, topLevel] = revParse.trim().split('\n')
  if (!gitDir || !commonDir || !topLevel || gitDir === commonDir) return null
  return topLevel.split('/').pop() ?? topLevel
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
    const worktree = paths.exitCode === 0 ? parseWorktree(paths.stdout) : null
    const state = parsed && { ...parsed, worktree }
    await update($, git, () => state)
  } catch {
    await update($, git, () => null)
  }
}

async function refreshDir($: EngineInterface) {
  const name = baseName(await $.session.cwd())
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
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    tick($).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || !u) return next(e)
    const repo = await read($, git)
    const dirName = await read($, dir)
    const modelId = await read($, model)
    const effortLevel = await read($, effort)
    const spentSession = await read($, sessionCost)
    const mode = await currentBilling($)
    const isMetered = mode === 'metered'

    const { Box, Button, Text } = $.ui.resolve(e)

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
            <Box key="git">
              {repo?.worktree && (
                <Text color="inverseText" backgroundColor="merged" bold>
                  {` ⎇ worktree: ${shorten(repo.worktree, BRANCH_CHARS)} `}
                </Text>
              )}
              {repo?.worktree && <Text> </Text>}
              {dirName && <Text>{shorten(dirName, BRANCH_CHARS)}</Text>}
              {dirName && repo && <Text dimColor> on </Text>}
              {repo && <Text color="suggestion">{shorten(repo.branch, BRANCH_CHARS)}</Text>}
              {repo?.isDirty && <Text color="warning"> ●</Text>}
            </Box>
          ) : (
            <Text key="git"> </Text>
          )}
          <Box key="right" columnGap={3}>
            {modelId && (
              <Box key="model">
                <Text color="claude">{formatModel(modelId)}</Text>
                {effortLevel && <Text dimColor> · {effortLevel}</Text>}
              </Box>
            )}
            {limits}
          </Box>
        </Box>
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
