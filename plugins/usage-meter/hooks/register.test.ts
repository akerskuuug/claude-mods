import { describe, expect, test } from 'claude-code/testing'
import { barFill, billingMode, contextLeft, dayKey, formatCost, sumDays, barCells, formatModel, formatResetIn, formatTokens, parseGitStatus, parseWorktree, percentLeft } from './register'

describe('usage-meter', () => {
  test('formats tokens like 10k/1M', async () => {
    expect(formatTokens(10_200)).toBe('10k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(200_000)).toBe('200k')
    expect(formatTokens(512)).toBe('512')
  })

  test('reports percent left of a window', async () => {
    const u = { context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }] }
    expect(percentLeft('five_hour', u)).toBe(77)
    expect(percentLeft('seven_day', u)).toBe(null)
  })
})

describe('reset times', () => {
  const now = Date.parse('2026-10-08T06:00:00Z')
  test('formats minutes, hours and days until reset', async () => {
    expect(formatResetIn('2026-10-08T06:14:00Z', now)).toBe('14m')
    expect(formatResetIn('2026-10-08T08:14:00Z', now)).toBe('2h14m')
    expect(formatResetIn('2026-10-11T10:00:00Z', now)).toBe('3d4h')
    expect(formatResetIn(undefined, now)).toBe(null)
  })
})

describe('git status', () => {
  test('reads branch and dirty state from porcelain v2', async () => {
    expect(parseGitStatus('# branch.oid abc\n# branch.head main\n')).toEqual({ branch: 'main', isDirty: false })
    expect(parseGitStatus('# branch.head fix/x\n1 .M N... 100644 100644 100644 a b CONTEXT.md\n')).toEqual({
      branch: 'fix/x',
      isDirty: true,
    })
    expect(parseGitStatus('# branch.head (detached)\n? new.txt\n')).toEqual({ branch: 'detached', isDirty: true })
  })
})

describe('bar cells', () => {
  test('centres the percent and splits it at the fill edge', async () => {
    expect(barCells(90, 10)).toEqual({ filled: '   90%   ', empty: ' ' })
    expect(barCells(31, 10)).toEqual({ filled: '   ', empty: '31%    ' })
    expect(barCells(100, 10)).toEqual({ filled: '   100%   ', empty: '' })
    expect(barCells(0, 10)).toEqual({ filled: '', empty: '    0%    ' })
  })
})

describe('worktree', () => {
  test('names a linked worktree and ignores the main checkout', async () => {
    expect(parseWorktree('/r/.git\n/r/.git\n/r\n')).toBe(null)
    expect(parseWorktree('/r/.git/worktrees/feat\n/r/.git\n/wt/feat-login\n')).toBe('feat-login')
  })
})

describe('model', () => {
  test('turns model ids into display names', async () => {
    expect(formatModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(formatModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
    expect(formatModel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(formatModel('Opus 5.5')).toBe('Opus 5.5')
  })
})

describe('billing mode', () => {
  const ctx = { window: 1_000_000 }
  test('rate-limit windows mean subscription', async () => {
    expect(billingMode({ context: ctx, rateLimits: [{ kind: 'five_hour', percentUsed: 1 }] }, 0)).toBe('subscription')
  })
  test('no windows but a priced response means metered', async () => {
    expect(billingMode({ context: ctx, rateLimits: [] }, 0.42)).toBe('metered')
    expect(billingMode({ context: ctx, rateLimits: [{ kind: 'spend_limit', percentUsed: 5 }] }, 0.42)).toBe('metered')
  })
  test('nothing read yet is unknown', async () => {
    expect(billingMode(null, 0)).toBe('unknown')
    expect(billingMode({ context: ctx, rateLimits: [] }, 0)).toBe('unknown')
  })
})

describe('cost', () => {
  test('sumDays adds the last N local days', async () => {
    const now = Date.now()
    const map = { [dayKey(now)]: 1, [dayKey(now - 86_400_000)]: 2, [dayKey(now - 10 * 86_400_000)]: 4 }
    expect(sumDays(map, now, 1)).toBe(1)
    expect(sumDays(map, now, 7)).toBe(3)
    expect(sumDays(map, now, 30)).toBe(7)
  })
  test('marks estimates with ~', async () => {
    expect(formatCost('session', 1.5)).toBe('$1.50')
    expect(formatCost('7d', 1.5)).toBe('~$1.50')
  })
})

describe('context bar', () => {
  test('is the free share of the window, with no text inside', async () => {
    expect(contextLeft({ context: { window: 1_000_000, tokens: 250_000 }, rateLimits: [] })).toBe(75)
    expect(contextLeft({ context: { window: 200_000, percent: 40 }, rateLimits: [] })).toBe(60)
    expect(contextLeft({ context: { window: 0 }, rateLimits: [] })).toBe(100)
    expect(barFill(75, 20)).toEqual({ filled: ' '.repeat(15), empty: ' '.repeat(5) })
  })
})

describe('sumDays across DST', () => {
  test('counts local calendar days, not 24 h steps', async () => {
    const noon = new Date(2026, 2, 9, 12) // a spring-forward week in many zones
    const map: Record<string, number> = {}
    for (let i = 0; i < 7; i++) map[dayKey(new Date(2026, 2, 9 - i, 12).getTime())] = 1
    expect(sumDays(map, noon.getTime(), 7)).toBe(7)
  })
})
