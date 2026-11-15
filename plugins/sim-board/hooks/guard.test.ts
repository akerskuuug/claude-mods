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

// A tiny claim store standing in for the disk, and simctl standing in for Xcode.
function engine(on: any, dirs: Map<string, string | null>, ran: string[][]) {
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
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[1] === 'simctl' && argv[2] === 'list') return ok(SIMCTL)
    if (argv[0] === 'mkdir' && argv[1] !== '-p') {
      const udid = argv[1]!.split('/').pop()!
      if (dirs.has(udid)) return { value: { exitCode: 1, stdout: '', stderr: 'exists', isStdoutTruncated: false, isStderrTruncated: false } }
      dirs.set(udid, null)
    }
    if (argv[0] === 'rm') dirs.delete(argv[2]!.split('/').pop()!)
    return ok()
  })
  on('fs.list', () => ({ value: [...dirs.keys()].map(name => ({ name, kind: 'dir', size: 0 })) }))
  on('fs.read', (_: unknown, e: any) => {
    const udid = e.path.slice(ROOT.length + 1).split('/')[0]
    const text = dirs.get(udid)
    if (text == null) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_: unknown, e: any) => {
    dirs.set(e.path.slice(ROOT.length + 1).split('/')[0], e.text)
    return { value: undefined }
  })
  on('fs.stat', () => ({ value: { mtimeMs: NOW } }))
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
