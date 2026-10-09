import { describe, expect, mock, test } from 'claude-code/testing'
import { barFill, baseName, billingMode, resolveBilling, contextLeft, dayKey, formatCost, sumDays, barCells, formatModel, formatResetIn, formatTokens, locationLabel, parseGitStatus, parseWorktree, percentLeft } from './register'

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
    expect(parseWorktree('/r/.git\n/r/.git\n/r\n')).toEqual({ worktree: null, root: '/r' })
    expect(parseWorktree('/r/.git/worktrees/feat\n/r/.git\n/wt/feat-login\n')).toEqual({ worktree: 'feat-login', root: '/wt/feat-login' })
  })
})

describe('location label', () => {
  const wt = { branch: 'main', isDirty: false, worktree: 'feat-login', root: '/wt/feat-login' }
  test('leaves out a worktree root and keeps a subfolder relative', async () => {
    expect(locationLabel('/wt/feat-login', wt)).toBe(null)
    expect(locationLabel('/wt/feat-login/plugins/meter', wt)).toBe('plugins/meter')
  })
  test('leaves a directory the branch ends with to the branch', async () => {
    const repo = { branch: 'feat/issue-538', isDirty: false, worktree: null, root: '/r/issue-538' }
    expect(locationLabel('/r/issue-538', repo)).toBe(null)
    expect(locationLabel('/r/other', repo)).toBe('other')
  })
  test('names the directory outside git', async () => {
    expect(locationLabel('/home/me/notes', null)).toBe('notes')
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

describe('cached billing mode', () => {
  test('a live reading wins over the cache', async () => {
    expect(resolveBilling('subscription', 'metered')).toBe('subscription')
    expect(resolveBilling('metered', null)).toBe('metered')
  })
  test('the cache stands in until there is a reading', async () => {
    expect(resolveBilling('unknown', 'metered')).toBe('metered')
    expect(resolveBilling('unknown', null)).toBe('unknown')
  })
})

describe('directory', () => {
  test('names the last path segment', async () => {
    expect(baseName('/home/me/claude-mods')).toBe('claude-mods')
    expect(baseName('/home/me/claude-mods/')).toBe('claude-mods')
    expect(baseName('C:\\Users\\me\\repo')).toBe('repo')
    expect(baseName('/')).toBe('/')
  })
})

describe('worktree toggle', () => {
  test('shows ⎇ in place of the name and opens the details', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
    on('session.usage', async () => ({ value: { context: { tokens: 0, window: 200_000 }, rateLimits: [] } }) as never)
    on('session.model', async () => ({ value: 'claude-opus-5-5' }) as never)
    on('session.cwd', async () => ({ value: '/wt/issue-538' }) as never)
    on('process.run', async (_$, e) =>
      ({
        value: e.argv.includes('status')
          ? { exitCode: 0, stdout: '# branch.head feat/issue-538\n', stderr: '' }
          : { exitCode: 0, stdout: '/r/.git/worktrees/issue-538\n/r/.git\n/wt/issue-538\n', stderr: '' },
      }) as never,
    )
    await $.session.start({ cwd: '/wt/issue-538', surface: 'terminal' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'usage-meter',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never,
      })
      expect(await ui.find({ type: 'Text', text: /issue-538 on/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'feat/issue-538' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Worktree' })).toBeUndefined()
      await ui.press({ key: 'worktree-toggle' })
      expect(await ui.find({ type: 'Text', text: 'Worktree' })).toBeDefined()
      await ui.press({ key: 'worktree-toggle' })
      await ui.unmount()
    }
  })
})
