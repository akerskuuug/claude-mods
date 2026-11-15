import { describe, expect, test } from 'claude-code/testing'
import {
  commandOf,
  formatAge,
  holderOf,
  isStale,
  listText,
  parseDevices,
  parseOwner,
  pickFree,
  resolveDestination,
  runtimeName,
  shellScript,
  shellWords,
  summarize,
  targetsOf,
  filterSims,
} from './register'

const SIMCTL = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
      { udid: 'AAAA-18', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [
      { udid: 'BBBB-26', name: 'iPhone 17', state: 'Booted', isAvailable: true },
      { udid: 'CCCC-26', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'DDDD-26', name: 'iPad Air', state: 'Shutdown', isAvailable: false },
    ],
  },
})
const sims = parseDevices(SIMCTL)
const NOW = 1_000_000_000

describe('simctl', () => {
  test('names runtimes', async () => {
    expect(runtimeName('com.apple.CoreSimulator.SimRuntime.iOS-26-1')).toBe('iOS 26.1')
    expect(runtimeName('com.apple.CoreSimulator.SimRuntime.watchOS-11-0')).toBe('watchOS 11.0')
  })

  test('lists available devices, newest runtime first', async () => {
    expect(sims.map(s => s.udid)).toEqual(['BBBB-26', 'CCCC-26', 'AAAA-18'])
    expect(sims[0]).toEqual({ udid: 'BBBB-26', name: 'iPhone 17', runtime: 'iOS 26.1', state: 'Booted' })
  })

  test('filters by name or runtime', async () => {
    expect(filterSims(sims, 'pro').map(s => s.udid)).toEqual(['CCCC-26'])
    expect(filterSims(sims, 'iOS 18').map(s => s.udid)).toEqual(['AAAA-18'])
    expect(filterSims(sims, '(').length).toBe(3)
  })
})

describe('commands', () => {
  test('splits shell words', async () => {
    expect(shellWords(`cd app && xcodebuild test -destination 'platform=iOS Simulator,name=iPhone 17'`)).toEqual([
      ['cd', 'app'],
      ['xcodebuild', 'test', '-destination', 'platform=iOS Simulator,name=iPhone 17'],
    ])
    expect(shellWords("xcodebuild test \\\n  -destination 'id=X'")).toEqual([['xcodebuild', 'test', '-destination', 'id=X']])
    expect(shellWords('echo "a\\\nb" "c\\d"')).toEqual([['echo', 'ab', 'c\\d']])
    expect(shellWords('xcrun simctl boot "iPhone 17 Pro"; echo ok')).toEqual([
      ['xcrun', 'simctl', 'boot', 'iPhone 17 Pro'],
      ['echo', 'ok'],
    ])
  })

  test('resolves destinations like xcodebuild', async () => {
    expect(resolveDestination('platform=iOS Simulator,id=CCCC-26', sims)).toBe('CCCC-26')
    expect(resolveDestination('platform=iOS Simulator,name=iPhone 17', sims)).toBe('BBBB-26')
    expect(resolveDestination('platform=iOS Simulator,name=iPhone 17,OS=18.6', sims)).toBe('AAAA-18')
    expect(resolveDestination('platform=iOS Simulator,name=iPhone 17,OS=18', sims)).toBe('AAAA-18')
    expect(resolveDestination('platform=iOS Simulator,name=iPhone 99', sims)).toBe(null)
    expect(resolveDestination('generic/platform=iOS', sims)).toBe(null)
  })

  test('finds what xcodebuild test and simctl act on', async () => {
    expect(targetsOf(`xcodebuild -scheme App test -destination 'platform=iOS Simulator,id=CCCC-26'`, sims)).toEqual([
      { udids: ['CCCC-26'], isClaiming: true, what: 'xcodebuild test' },
    ])
    expect(targetsOf(`xcodebuild build -destination 'platform=iOS Simulator,id=CCCC-26'`, sims)).toEqual([])
    expect(targetsOf('xcrun simctl install booted App.app', sims)).toEqual([
      { udids: ['BBBB-26'], isClaiming: true, what: 'simctl install' },
    ])
    expect(targetsOf('xcrun simctl shutdown all', sims)).toEqual([
      { udids: ['BBBB-26', 'CCCC-26', 'AAAA-18'], isClaiming: false, what: 'simctl shutdown' },
    ])
    expect(targetsOf('xcrun simctl list devices', sims)).toEqual([])
    expect(targetsOf("env CI=1 xcrun --sdk iphonesimulator simctl boot CCCC-26", sims)).toEqual([
      { udids: ['CCCC-26'], isClaiming: true, what: 'simctl boot' },
    ])
    expect(targetsOf("(cd app && /usr/bin/xcodebuild test -destination 'id=CCCC-26')", sims).map(t => t.udids)).toEqual([['CCCC-26']])
    expect(targetsOf(`bash -c "xcodebuild test -destination 'id=CCCC-26'"`, sims).map(t => t.udids)).toEqual([['CCCC-26']])
  })

  test('skips wrappers and the values their options take', async () => {
    const boot = (cmd: string) => targetsOf(cmd, sims).map(t => t.udids)
    expect(boot('env -u CI xcrun simctl boot CCCC-26')).toEqual([['CCCC-26']])
    expect(boot('env --unset CI -C /tmp FOO=1 xcrun simctl boot CCCC-26')).toEqual([['CCCC-26']])
    expect(boot("env -S 'xcrun simctl boot CCCC-26'")).toEqual([['CCCC-26']])
    expect(boot("sudo -u ci -- xcodebuild test -destination 'id=CCCC-26'")).toEqual([['CCCC-26']])
    expect(boot('nice -n 5 time -o t.txt caffeinate -t 60 xcrun simctl boot CCCC-26')).toEqual([['CCCC-26']])
    expect(boot('command -v xcodebuild')).toEqual([])
    expect(commandOf(['env', '-u', 'CI'])).toBe(null)
  })

  test('finds the script a shell runs with -c, flags combined or not', async () => {
    const boot = (cmd: string) => targetsOf(cmd, sims).map(t => t.udids)
    expect(boot('bash -lc "xcrun simctl boot CCCC-26"')).toEqual([['CCCC-26']])
    expect(boot(`/bin/zsh -ec "xcodebuild test -destination 'id=CCCC-26'"`)).toEqual([['CCCC-26']])
    expect(boot('bash -c -e "xcrun simctl boot CCCC-26"')).toEqual([['CCCC-26']])
    expect(boot('bash -o pipefail -c "xcrun simctl boot CCCC-26"')).toEqual([['CCCC-26']])
    expect(boot('bash --norc -c "xcrun simctl boot CCCC-26"')).toEqual([['CCCC-26']])
    expect(boot('bash -l script.sh "xcrun simctl boot CCCC-26"')).toEqual([])
    expect(shellScript(['-lc', 'x'])).toBe('x')
    expect(shellScript(['-l', 'x'])).toBe(null)
  })

  test('ignores simulator commands that are only data', async () => {
    expect(targetsOf("echo xcodebuild test -destination 'id=CCCC-26'", sims)).toEqual([])
    expect(targetsOf("git commit -m 'xcrun simctl boot CCCC-26'", sims)).toEqual([])
    expect(targetsOf("ls # xcodebuild test -destination 'id=CCCC-26'", sims)).toEqual([])
    const heredoc = "cat > run.sh <<'EOF'\nxcodebuild test -destination 'id=CCCC-26'\nEOF\nchmod +x run.sh"
    expect(targetsOf(heredoc, sims)).toEqual([])
    expect(shellWords(heredoc)).toEqual([['cat', '>', 'run.sh'], ['chmod', '+x', 'run.sh']])
    const dashed = "cat <<-END > x\n\txcrun simctl boot CCCC-26\n\tEND\nxcrun simctl boot BBBB-26"
    expect(targetsOf(dashed, sims).map(t => t.udids)).toEqual([['BBBB-26']])
    expect(targetsOf('git status', sims)).toEqual([])
  })
})

describe('claims', () => {
  const owner = (sessionId: string, heartbeatAt = NOW) => ({ udid: 'BBBB-26', sessionId, label: 'app (main)', claimedAt: NOW - 120_000, heartbeatAt })

  test('reads an owner file', async () => {
    expect(parseOwner('X', JSON.stringify({ sessionId: 's1', label: 'l', claimedAt: 1, heartbeatAt: 2 }))).toEqual({
      udid: 'X',
      sessionId: 's1',
      label: 'l',
      claimedAt: 1,
      heartbeatAt: 2,
    })
    expect(parseOwner('X', 'nope')).toBe(null)
    expect(parseOwner('X', '{}')).toBe(null)
  })

  test('tells free, yours, held and stale apart', async () => {
    expect(holderOf('BBBB-26', [], 'me', NOW, 15).kind).toBe('free')
    expect(holderOf('BBBB-26', [owner('me')], 'me', NOW, 15).kind).toBe('yours')
    expect(holderOf('BBBB-26', [owner('other')], 'me', NOW, 15)).toEqual({ kind: 'held', claim: owner('other'), isStale: false })
    expect(isStale(owner('other', NOW - 16 * 60_000), NOW, 15)).toBe(true)
  })

  test('picks a free simulator, booted first', async () => {
    expect(pickFree(sims, [], 'me', NOW, 15)?.udid).toBe('BBBB-26')
    expect(pickFree(sims, [owner('other')], 'me', NOW, 15)?.udid).toBe('CCCC-26')
    expect(pickFree(sims, [owner('other')], 'me', NOW, 15, { runtime: '18' })?.udid).toBe('AAAA-18')
    expect(pickFree(sims, [], 'me', NOW, 15, { name: 'ipad' })).toBe(null)
  })

  test('summarizes and lists the board', async () => {
    const board = { sims, claims: [owner('other')], error: null, at: NOW }
    expect(summarize(board, 'me', NOW, 15)).toBe('2 free · 1 held · 0 yours · 1 booted')
    expect(listText(board, 'me', NOW, 15)).toContain('iPhone 17 [BBBB-26] Booted, app (main) · 2m')
  })

  test('formats ages', async () => {
    expect(formatAge(10_000)).toBe('just now')
    expect(formatAge(5 * 60_000)).toBe('5m')
    expect(formatAge(125 * 60_000)).toBe('2h5m')
  })
})
