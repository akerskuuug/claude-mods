import { expect, test } from 'claude-code/testing'

const SIMCTL = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [
      { udid: 'BBBB-26', name: 'iPhone 17', state: 'Booted', isAvailable: true },
      { udid: 'CCCC-26', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
    ],
  },
})
const ROOT = '/home/me/.claude/sim-board/claims'
const NOW = 1_000_000_000

// A tiny claim store standing in for the disk, simctl standing in for Xcode,
// and claimctl.py's protocol answered from that store (claimctl_test.py tests
// the script itself, locking included). `dirs` maps a claim directory to its
// owner file (null: not written yet); `mtime` dates such a directory.
function engine(
  on: any,
  dirs: Map<string, string | null>,
  ran: string[][],
  mtime = new Map<string, number>(),
  beforeCtl: (command: string, udid: string) => void = () => {},
) {
  const done = (exitCode = 0, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const name = (path: string) => path.slice(ROOT.length + 1).split('/')[0]!
  const entry = (udid: string) => {
    const text = dirs.get(udid)
    if (text) return { kind: 'claim', owner: JSON.parse(text) }
    return dirs.has(udid) ? { kind: 'orphan', mtime: mtime.get(udid) ?? NOW } : { kind: 'none' }
  }
  const claimctl = (command: string, udid: string, a: any) => {
    const e: any = entry(udid)
    const takeable = a.force ? e.kind !== 'none' : e.kind === 'orphan' ? a.now - e.mtime >= a.orphanMs : e.kind === 'claim' && a.now - e.owner.heartbeatAt > a.staleMs
    if (command === 'claim') {
      const mine = e.kind === 'claim' && e.owner.sessionId === a.me
      if (!mine && e.kind !== 'none' && !takeable) return { ok: false, holder: e.owner ?? null }
      dirs.set(udid, JSON.stringify({ ...a.owner, sessionId: a.me, heartbeatAt: a.now, claimedAt: mine ? e.owner.claimedAt : a.now }))
      return { ok: true }
    }
    if (command === 'release') {
      if (e.kind === 'none') return { ok: true }
      if ((e.kind === 'claim' && e.owner.sessionId === a.me) || a.force) return dirs.delete(udid), { ok: true }
      return { ok: false, holder: e.owner ?? null }
    }
    return { ok: false }
  }
  on('env.get', () => ({ value: '/home/me' }))
  on('session.id', () => ({ value: 'me' }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'sims' } }))
  on('tool.register', (_: unknown, e: any) => ({ value: { tool: `mcp__sim-board__${e.name}` } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv
    ran.push(argv)
    if (argv[1] === 'simctl' && argv[2] === 'list') return done(0, SIMCTL)
    if (argv[0] === 'python3' && argv[1]!.endsWith('/hooks/claimctl.py')) {
      expect(argv[3]).toBe(ROOT)
      beforeCtl(argv[2]!, argv[4]!)
      return done(0, JSON.stringify(claimctl(argv[2]!, argv[4]!, JSON.parse(argv[5]!))))
    }
    return done()
  })
  on('fs.list', () => ({ value: [...dirs.keys()].map(n => ({ name: n, kind: 'dir', size: 0 })) }))
  on('fs.read', (_: unknown, e: any) => {
    const text = dirs.get(name(e.path))
    if (text == null) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.stat', (_: unknown, e: any) => {
    const n = name(e.path)
    if (!dirs.has(n)) throw new Error('ENOENT')
    return { value: { mtimeMs: mtime.get(n) ?? NOW } }
  })
  on('tool.call', () => ({ result: { stdout: 'ran' } }))
}

const other = JSON.stringify({ sessionId: 'other', label: 'shop (feat/cart)', claimedAt: NOW - 600_000, heartbeatAt: NOW })

test('a test run on a simulator another session holds is refused', async ($, on) => {
  const dirs = new Map<string, string | null>([['BBBB-26', other]])
  engine(on, dirs, [])
  await $.session.start({ cwd: '/r/app', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: 'Bash', command: "xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 17'" })
  expect(ran.deny).toContain('in use by shop (feat/cart)')
  expect(ran.deny).toContain('CCCC-26')
  expect(dirs.has('CCCC-26')).toBe(false)
})

test('a test run on a free simulator claims it for this session', async ($, on) => {
  const dirs = new Map<string, string | null>()
  engine(on, dirs, [])
  await $.session.start({ cwd: '/r/app', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: 'Bash', command: "xcodebuild test -destination 'platform=iOS Simulator,id=CCCC-26'" })
  expect(ran.deny).toBeUndefined()
  expect(JSON.parse(dirs.get('CCCC-26')!).sessionId).toBe('me')
})

test('unrelated commands pass untouched', async ($, on) => {
  const dirs = new Map<string, string | null>([['BBBB-26', other]])
  const ran: string[][] = []
  engine(on, dirs, ran)
  await $.session.start({ cwd: '/r/app', surface: 'terminal', isInteractive: true })
  ran.length = 0

  const out = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(out.deny).toBeUndefined()
  expect(ran).toEqual([])
})

test('sims_claim takes a free one and sims_release lets it go', async ($, on) => {
  const dirs = new Map<string, string | null>([['BBBB-26', other]])
  engine(on, dirs, [])
  await $.session.start({ cwd: '/r/app', surface: 'terminal', isInteractive: true })

  const claimed = await $.tool.call({ tool: 'mcp__sim-board__sims_claim', boot: false })
  expect(String(claimed.result)).toContain("id=CCCC-26'")
  expect(dirs.has('CCCC-26')).toBe(true)

  const released = await $.tool.call({ tool: 'mcp__sim-board__sims_release' })
  expect(String(released.result)).toBe('Released CCCC-26.')
  expect(dirs.has('CCCC-26')).toBe(false)
  expect(dirs.has('BBBB-26')).toBe(true)
})

test('the pane shows who holds what, on every surface', async ($, on) => {
  const dirs = new Map<string, string | null>([['BBBB-26', other]])
  engine(on, dirs, [])
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ cwd: '/r/app', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'sim-board',
      surface,
      component: 'Pane',
      requestId: 'sim-board',
      props: { title: 'Simulators', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /shop \(feat\/cart\)/ }))?.text).toBe('shop (feat/cart) · 10m')
    expect(await ui.find({ type: 'Button', key: 'claim-CCCC-26' })).toBeTruthy()
    await ui.press({ key: 'claim-CCCC-26' })
    expect(JSON.parse(dirs.get('CCCC-26')!).sessionId).toBe('me')
    await ui.unmount()
    dirs.delete('CCCC-26')
  }
})

const stale = JSON.stringify({ sessionId: 'gone', label: 'old (main)', claimedAt: NOW - 3_600_000, heartbeatAt: NOW - 20 * 60_000 })

test('a stale claim is taken over', async ($, on) => {
  const dirs = new Map<string, string | null>([['CCCC-26', stale]])
  engine(on, dirs, [])
  await $.session.start({ cwd: '/r/app', surface: 'terminal', isInteractive: true })

  const claimed = await $.tool.call({ tool: 'mcp__sim-board__sims_claim', udid: 'CCCC-26', boot: false })
  expect(String(claimed.result)).toContain('Claimed iPhone 17 Pro')
  expect(JSON.parse(dirs.get('CCCC-26')!).sessionId).toBe('me')
})

test('a claim directory left without an owner is reclaimed once it is old', async ($, on) => {
  const dirs = new Map<string, string | null>([['CCCC-26', null]])
  engine(on, dirs, [], new Map([['CCCC-26', NOW - 5 * 60_000]]))
  await $.session.start({ cwd: '/r/app', surface: 'terminal', isInteractive: true })

  const claimed = await $.tool.call({ tool: 'mcp__sim-board__sims_claim', udid: 'CCCC-26', boot: false })
  expect(String(claimed.result)).toContain('Claimed iPhone 17 Pro')
  expect(JSON.parse(dirs.get('CCCC-26')!).sessionId).toBe('me')
})

test('a fresh claim directory without an owner yet is not reported as ours', async ($, on) => {
  const dirs = new Map<string, string | null>([['CCCC-26', null]])
  engine(on, dirs, [])
  await $.session.start({ cwd: '/r/app', surface: 'terminal', isInteractive: true })

  const claimed = await $.tool.call({ tool: 'mcp__sim-board__sims_claim', udid: 'CCCC-26', boot: false })
  expect(String(claimed.result)).toContain('held by another session')
  expect(dirs.get('CCCC-26')).toBe(null)
})

test('the display filter does not hide a held simulator from the guard', { options: { filter: 'Pro' } }, async ($, on) => {
  const dirs = new Map<string, string | null>([['BBBB-26', other]])
  engine(on, dirs, [])
  await $.session.start({ cwd: '/r/app', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: 'Bash', command: "xcodebuild test -destination 'platform=iOS Simulator,id=BBBB-26'" })
  expect(ran.deny).toContain('in use by shop (feat/cart)')
  const listed = await $.tool.call({ tool: 'mcp__sim-board__sims_list' })
  expect(String(listed.result)).not.toContain('BBBB-26')
})

test('a line continuation before the destination is still guarded', async ($, on) => {
  const dirs = new Map<string, string | null>([['BBBB-26', other]])
  engine(on, dirs, [])
  await $.session.start({ cwd: '/r/app', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: 'Bash', command: "xcodebuild test -scheme App \\\n  -destination 'platform=iOS Simulator,id=BBBB-26'" })
  expect(ran.deny).toContain('in use by shop (feat/cart)')
})

test('a refused multi-simulator command keeps none of the claims it made', async ($, on) => {
  const dirs = new Map<string, string | null>()
  // Another session claims the second target between the check and the claim.
  engine(on, dirs, [], new Map(), (command, udid) => {
    if (command === 'claim' && udid === 'BBBB-26') dirs.set('BBBB-26', other)
  })
  await $.session.start({ cwd: '/r/app', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({
    tool: 'Bash',
    command: "xcodebuild test -destination 'platform=iOS Simulator,id=CCCC-26' -destination 'platform=iOS Simulator,id=BBBB-26'",
  })
  expect(ran.deny).toContain('was just claimed by shop (feat/cart)')
  expect(dirs.has('CCCC-26')).toBe(false)
  expect(dirs.get('BBBB-26')).toBe(other)
})
