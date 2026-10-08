import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { GitState, Usage } from '../types'

const usage = atom({ plugin: 'usage-meter', key: 'usage' } as const, null)
const now = atom({ plugin: 'usage-meter', key: 'now' } as const, null)
const git = atom({ plugin: 'usage-meter', key: 'git' } as const, null)
const model = atom({ plugin: 'usage-meter', key: 'model' } as const, null)
const effort = atom({ plugin: 'usage-meter', key: 'effort' } as const, null)

const BAR_CELLS = 10
// Dark-terminal track colour; ThemeKey has no neutral background.
const TRACK_COLOR = '#3a3a3a'
const BRANCH_CHARS = 56
const MINUTE = 60_000

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

async function tick($: EngineInterface) {
  const time = await $.clock.now()
  await update($, now, () => time)
  await refreshGit($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const { context, rateLimits } = await $.session.usage()
    await update($, usage, () => ({ context, rateLimits }))
    await tick($)
    await refreshModel($)
    $.clock.every(MINUTE, () => tick($))
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => ({ context: e.context, rateLimits: e.rateLimits }))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    refreshGit($).catch(() => {})
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
    const modelId = await read($, model)
    const effortLevel = await read($, effort)

    const { Box, Text } = $.ui.resolve(e)
    const used = u.context.tokens ?? 0

    return (
      <Box flexDirection="row" width={e.props.bodyColumns} justifyContent="space-between" columnGap={3}>
        {repo ? (
          <Box key="git">
            {repo.worktree && (
              <Text color="inverseText" backgroundColor="merged" bold>
                {` ⎇ worktree: ${shorten(repo.worktree, BRANCH_CHARS)} `}
              </Text>
            )}
            {repo.worktree && <Text> </Text>}
            <Text color="suggestion">{shorten(repo.branch, BRANCH_CHARS)}</Text>
            {repo.isDirty && <Text color="warning"> ●</Text>}
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
          <Text key="context">
            Context {formatTokens(used)}/{formatTokens(u.context.window)}
          </Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const u = await read($, usage)
    if (!u) return next(e)
    const nowMs = await read($, now)

    const { Box, Text } = $.ui.resolve(e)

    const meter = (label: string, kind: string) => {
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

    return (
      <Box flexDirection="row" flexGrow={1} flexShrink={1} justifyContent="flex-end" columnGap={3}>
        {meter('5h', 'five_hour')}
        {meter('Weekly', 'seven_day')}
      </Box>
    )
  })
}
