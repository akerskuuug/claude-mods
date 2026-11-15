import { describe, expect, test } from 'claude-code/testing'
import {
  formatAge,
  holderOf,
  isStale,
  listText,
  parseDevices,
  parseOwner,
  pickFree,
  resolveDestination,
  runtimeName,
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
