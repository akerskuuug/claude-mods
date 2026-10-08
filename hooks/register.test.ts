import { describe, expect, test } from 'claude-code/testing'
import { barCells, formatModel, formatResetIn, formatTokens, parseGitStatus, parseWorktree, percentLeft } from './register'

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
