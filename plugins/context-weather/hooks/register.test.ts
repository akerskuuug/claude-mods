import { describe, expect, mock, test } from 'claude-code/testing'
import {
  base64,
  contextPercent,
  dayPhase,
  daylight,
  encode,
  forecast,
  localHour,
  nextGap,
  paint,
  parseClock,
  parseOffset,
  rainfall,
  visitLength,
  visitorFor,
  visitorNamed,
} from './register'
import type { VisitorKind } from './register'

const decode = (cells: string) => {
  const bin = atob(cells)
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
  return new Uint32Array(bytes.buffer)
}

describe('forecast', () => {
  test('runs from clear skies to a thunderstorm', async () => {
    expect(forecast(0)).toBe('clear skies')
    expect(forecast(30)).toBe('partly cloudy')
    expect(forecast(65)).toBe('light rain')
    expect(forecast(80)).toBe('heavy rain')
    expect(forecast(95)).toBe('thunderstorm')
  })

  test('reads percent, or tokens over the window', async () => {
    expect(contextPercent({ window: 200_000, percent: 42 })).toBe(42)
    expect(contextPercent({ window: 200_000, tokens: 50_000 })).toBe(25)
    expect(contextPercent({ window: 0 })).toBe(0)
    expect(contextPercent({ window: 100, tokens: 500 })).toBe(100)
  })
})

describe('painting', () => {
  test('base64 matches the standard encoding', async () => {
    for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
      expect(base64(new TextEncoder().encode(s))).toBe(btoa(s))
    }
  })

  test('packs two pixel rows per half-block cell', async () => {
    const px = Uint32Array.of(0x111111, 0x222222, 0x333333, 0x444444)
    expect(Array.from(decode(encode(px, 2, 1)))).toEqual([0x2580, 0x111111, 0x333333, 0x2580, 0x222222, 0x444444])
  })

  test('a storm is darker than a clear sky, and rain moves', async () => {
    const lum = (px: Uint32Array) => px.reduce((sum, c) => sum + ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255), 0)
    expect(lum(paint(30, 40, 0.95, 5))).toBeLessThan(lum(paint(30, 40, 0, 5)))
    expect(Array.from(paint(30, 40, 0.8, 1))).not.toEqual(Array.from(paint(30, 40, 0.8, 2)))
    expect(Array.from(paint(30, 40, 0.3, 7))).toEqual(Array.from(paint(30, 40, 0.3, 7)))
  })
})

describe('time of day', () => {
  test('reads the local hour from the clock and the UTC offset', async () => {
    const noonUtc = Date.parse('2026-10-09T12:00:00Z')
    expect(localHour(noonUtc, 0)).toBe(12)
    expect(localHour(noonUtc, 120)).toBe(14)
    expect(localHour(noonUtc, -13 * 60)).toBe(23)
    expect(parseOffset('+0200\n')).toBe(120)
    expect(parseOffset('-0530')).toBe(-330)
    expect(parseOffset('UTC')).toBe(null)
  })

  test('parses the times /weather at takes', async () => {
    expect(parseClock('22')).toBe(22)
    expect(parseClock('7:30')).toBe(7.5)
    expect(parseClock('24:00')).toBe(null)
    expect(parseClock('soon')).toBe(null)
  })

  test('names the phases and dims the light', async () => {
    expect([3, 6, 12, 20, 23].map(dayPhase)).toEqual(['night', 'dawn', 'day', 'dusk', 'night'])
    expect(daylight(12)).toBe(1)
    expect(daylight(2)).toBe(0)
    expect(daylight(20)).toBeGreaterThan(0)
    expect(daylight(20)).toBeLessThan(1)
  })

  test('night is darker than noon, and a clear night has stars', async () => {
    const lum = (px: Uint32Array) => px.reduce((sum, c) => sum + ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255), 0)
    expect(lum(paint(30, 40, 0, 5, 2))).toBeLessThan(lum(paint(30, 40, 0, 5, 12)) / 2)
    const bright = (px: Uint32Array) => Array.from(px.slice(0, 30 * 20)).filter(c => ((c >> 16) & 255) > 200).length
    expect(bright(paint(30, 40, 0, 5, 2))).toBeGreaterThan(3)
    expect(bright(paint(30, 40, 0.9, 5, 2))).toBeLessThan(bright(paint(30, 40, 0, 5, 2)))
  })
})

describe('the house', () => {
  test('its window is lit at night even under a clear sky, and dark on a clear day', async () => {
    const lit = (px: Uint32Array) => px.includes(0xffcf6b)
    expect(lit(paint(30, 40, 0, 5, 23))).toBe(true)
    expect(lit(paint(30, 40, 0, 5, 3))).toBe(true)
    expect(lit(paint(30, 40, 0, 5, 12))).toBe(false)
    expect(lit(paint(30, 40, 0.5, 5, 12))).toBe(true)
  })
})

describe('review fixes', () => {
  test('no lightning below the thunderstorm threshold', async () => {
    const bolt = (s: number) => Array.from({ length: 480 }, (_, f) => paint(16, 20, s, f).includes(0xfff7c2)).some(Boolean)
    expect(forecast(87)).toBe('heavy rain')
    expect(bolt(0.87)).toBe(false)
    expect(bolt(0.95)).toBe(true)
  })

  test('no rain until the forecast says light rain', async () => {
    expect(forecast(59)).toBe('overcast')
    expect(rainfall(0.59)).toBe(0)
    expect(forecast(61)).toBe('light rain')
    expect(rainfall(0.61)).toBeGreaterThan(0)
  })

  test('/weather says when the window waits undrawn', async ($, on) => {
    mock.clock(on)
    on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
    on('command.register', async () => ({ value: {} }) as never)
    on('session.usage', async () => ({ value: { context: { tokens: 0, window: 200_000 }, rateLimits: [] } }) as never)
    on('ui.panes', async () => ({ value: [] }) as never)
    let isPlaced = true
    on('ui.open', async () => ({ value: isPlaced ? { isPlaced } : { isPlaced, reason: 'needs 110 columns, 80 now' } }) as never)
    await $.session.start({ cwd: '/', surface: 'terminal' } as never)
    expect((await $.command.run({ command: 'weather', args: '' })).text).toBe('Weather window opened.')
    isPlaced = false
    expect((await $.command.run({ command: 'weather', args: '' })).text).toBe(
      'Weather window opened. The window is not shown yet: needs 110 columns, 80 now',
    )
    expect((await $.command.run({ command: 'weather', args: 'at 22' })).text).toContain('not shown yet')
  })

  test('opens by itself only in a fullscreen terminal 144 columns wide', async ($, on) => {
    mock.clock(on)
    const opened: string[] = []
    on('ui.render', { component: 'AbovePrompt' }, async ($$, e) => {
      const { Text } = $$.ui.resolve(e)
      return h(Text, {}, 'band')
    })
    on('ui.open', async (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } } as never
    })
    const band = (isFullscreen: boolean, columns = 160) =>
      $.ui.mount({
        plugin: 'context-weather',
        surface: 'terminal',
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 150 } as never,
        viewport: { columns, rows: 50, isFullscreen },
      } as never)
    const main = await band(false)
    await main.unmount()
    expect(opened).toEqual([])
    const narrow = await band(true, 120)
    await narrow.unmount()
    expect(opened).toEqual([])
    const full = await band(true)
    await full.unmount()
    expect(opened).toEqual(['context-weather'])
  })
})

describe('a fresh conversation', () => {
  test('/clear and a resume show the new context at once', async ($, on) => {
    mock.clock(on)
    let tokens = 190_000
    on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
    on('command.register', async () => ({ value: {} }) as never)
    on('session.usage', async () => ({ value: { context: { tokens, window: 200_000 }, rateLimits: [] } }) as never)
    on('classic.SessionStart', async () => ({}) as never)
    await $.session.start({ cwd: '/', surface: 'terminal' } as never)
    const shows = async (text: RegExp) => {
      const ui = await $.ui.mount({
        plugin: 'context-weather',
        surface: 'terminal',
        component: 'Pane',
        requestId: 'context-weather',
        props: { title: 'Weather', isFocused: false, bodyColumns: 30, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } } as never,
      } as never)
      const found = await ui.find({ type: 'Text', text })
      await ui.unmount()
      return found
    }
    expect(await shows(/thunderstorm · 95% context$/)).toBeDefined()
    tokens = 0
    await $.classic.SessionStart({ source: 'clear' } as never)
    expect(await shows(/clear skies · 0% context$/)).toBeDefined()
    tokens = 130_000
    await $.classic.SessionStart({ source: 'resume' } as never)
    expect(await shows(/light rain · 65% context$/)).toBeDefined()
  })

  test('/clear reads the clock again at once', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-09T12:00:00Z') })
    let offset = '+0000'
    on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
    on('command.register', async () => ({ value: {} }) as never)
    on('session.usage', async () => ({ value: { context: { tokens: 0, window: 200_000 }, rateLimits: [] } }) as never)
    on('process.run', async () => ({ value: { exitCode: 0, stdout: `${offset}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
    on('classic.SessionStart', async () => ({}) as never)
    await $.session.start({ cwd: '/', surface: 'terminal' } as never)
    const caption = async () => {
      const ui = await $.ui.mount({
        plugin: 'context-weather',
        surface: 'desktop',
        component: 'Pane',
        requestId: 'context-weather',
        props: { title: 'Weather', isFocused: false, bodyColumns: 30, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } } as never,
      } as never)
      const day = await ui.find({ type: 'Text', text: /^clear skies/ })
      const night = await ui.find({ type: 'Text', text: /^night · clear skies/ })
      await ui.unmount()
      return day ? 'day' : night ? 'night' : 'none'
    }
    expect(await caption()).toBe('day')
    offset = '+1100'
    await $.classic.SessionStart({ source: 'clear' } as never)
    expect(await caption()).toBe('night')
  })
})

describe('several surfaces', () => {
  test('a desktop drawing of the pane does not stop the terminal animating', async ($, on) => {
    const clock = mock.clock(on)
    on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
    on('command.register', async () => ({ value: {} }) as never)
    on('session.usage', async () => ({ value: { context: { tokens: 0, window: 200_000 }, rateLimits: [] } }) as never)
    let blits = 0
    on('ui.blit', async () => {
      blits += 1
      return { value: {} } as never
    })
    await $.session.start({ cwd: '/', surface: 'terminal' } as never)
    const pane = (surface: 'terminal' | 'desktop') =>
      $.ui.mount({
        plugin: 'context-weather',
        surface,
        component: 'Pane',
        requestId: 'context-weather',
        props: { title: 'Weather', isFocused: false, bodyColumns: 20, placement: 'dock', scroll: { offset: 0, bodyRows: 10 } } as never,
      } as never)
    const terminal = await pane('terminal')
    const desktop = await pane('desktop')
    await clock.advance(1_000)
    expect(blits).toBeGreaterThan(0)
    await desktop.unmount()
    await terminal.unmount()
  })
})

describe('pane', () => {
  test('draws the sky and the forecast for the context', async ($, on) => {
    mock.clock(on)
    on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
    on('command.register', async () => ({ value: {} }) as never)
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('session.usage', async () => ({ value: { context: { tokens: 160_000, window: 200_000 }, rateLimits: [] } }) as never)
    await $.session.start({ cwd: '/', surface: 'terminal' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'context-weather',
        surface,
        component: 'Pane',
        requestId: 'context-weather',
        props: { title: 'Weather', isFocused: false, bodyColumns: 30, placement: 'dock', scroll: { offset: 0, bodyRows: 20 } } as never,
      } as never)
      expect(await ui.find({ type: 'Text', text: /heavy rain · 80% context$/ })).toBeDefined()
      if (surface === 'terminal') expect(await ui.find({ key: 'sky' })).toBeDefined()
      await ui.unmount()
    }
  })
})

describe('visitors', () => {
  const visit = (kind: VisitorKind, start = 100) => ({ kind, start, seed: 42 })

  test('come only in their weather', async () => {
    expect(visitorFor(0.95, 12)).toBe('cow')
    expect(visitorFor(0.95, 2)).toBe('cow')
    expect(visitorFor(0, 2)).toBe('star')
    expect(visitorFor(0.1, 12)).toBe('birds')
    expect(visitorFor(0.4, 12, 0.2)).toBe('kite')
    expect(visitorFor(0.4, 12, 0.8)).toBe('plane')
    expect(visitorFor(0.4, 2, 0.2)).toBe('plane')
    expect(visitorFor(0.7, 2, 0.2)).toBe('umbrella')
    expect(visitorFor(0.7, 12, 0.8)).toBe('duck')
    expect(visitorFor(0.1, 6)).toBe(null)
  })

  test('answer to other names', async () => {
    expect(visitorNamed('stars')).toBe('star')
    expect(visitorNamed('Bird')).toBe('birds')
    expect(visitorNamed('shooting-star')).toBe('star')
    expect(visitorNamed('airplane')).toBe('plane')
    expect(visitorNamed('duck')).toBe('duck')
    expect(visitorNamed('dragon')).toBe(null)
  })

  test('come every 3 to 8 minutes, at 8 frames a second', async () => {
    expect(nextGap(0)).toBe(3 * 60 * 8)
    expect(nextGap(1)).toBe(8 * 60 * 8)
  })

  test('a cow tumbles across the storm and leaves', async () => {
    const pink = (px: Uint32Array) => px.includes(0xf0a3a8)
    expect(pink(paint(32, 40, 0.95, 120, 12))).toBe(false)
    expect(pink(paint(32, 40, 0.95, 120, 12, visit('cow')))).toBe(true)
    const gone = 100 + visitLength('cow', 32)
    expect(pink(paint(32, 40, 0.95, gone, 12, visit('cow')))).toBe(false)
  })

  test('birds cross a fair sky', async () => {
    const birds = (px: Uint32Array) => px.filter(c => c === 0x2b2f3a).length
    expect(birds(paint(32, 40, 0, 160, 12))).toBe(0)
    expect(birds(paint(32, 40, 0, 160, 12, visit('birds')))).toBeGreaterThanOrEqual(6)
  })

  test('a shooting star streaks by and fades', async () => {
    const head = (f: number) => paint(32, 40, 0, f, 2, visit('star')).includes(0xffffff)
    expect(paint(32, 40, 0, 103, 2).includes(0xffffff)).toBe(false)
    expect(head(103)).toBe(true)
    expect(head(100 + visitLength('star', 32))).toBe(false)
  })

  test('a plane blinks across behind the clouds', async () => {
    const beacon = (f: number) => paint(32, 40, 0.4, f, 12, visit('plane')).includes(0xff3b30)
    expect(paint(32, 40, 0.4, 130, 12).includes(0xff3b30)).toBe(false)
    expect(Array.from({ length: 8 }, (_, i) => beacon(130 + i)).some(Boolean)).toBe(true)
  })

  test('a kite goes up, and comes down again', async () => {
    const heart = (f: number) => paint(32, 40, 0.4, f, 12, visit('kite')).includes(0xf2c94c)
    expect(heart(250)).toBe(true)
    expect(heart(100 + visitLength('kite', 32))).toBe(false)
  })

  test('in heavy rain the umbrella blows inside out and they run', async () => {
    const at = (s: number, f: number) => {
      const px = paint(40, 40, s, f, 12, visit('umbrella'))
      const xs = [...px.keys()].filter(i => px[i] === 0xc8423a).map(i => i % 40)
      return { left: Math.min(...xs), right: Math.max(...xs) }
    }
    const light = at(0.65, 160)
    const heavy = at(0.8, 160)
    expect(light.right - light.left).toBe(4)
    expect(heavy.left).toBeGreaterThan(light.left)
    expect(paint(40, 40, 0.65, 100, 12, visit('umbrella')).includes(0xc8423a)).toBe(false)
  })

  test('a duck waddles through the rain', async () => {
    expect(paint(32, 40, 0.7, 150, 12).includes(0xe8a23a)).toBe(false)
    expect(paint(32, 40, 0.7, 150, 12, visit('duck')).includes(0xe8a23a)).toBe(true)
  })

  test('/weather visit sends one by, and names who can come', async ($, on) => {
    mock.clock(on)
    on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
    on('command.register', async () => ({ value: {} }) as never)
    on('session.usage', async () => ({ value: { context: { tokens: 0, window: 200_000 }, rateLimits: [] } }) as never)
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    await $.session.start({ cwd: '/', surface: 'terminal' } as never)
    expect((await $.command.run({ command: 'weather', args: 'visit cow' })).text).toBe('Here comes a cow.')
    expect((await $.command.run({ command: 'weather', args: 'visit stars' })).text).toBe('Here comes a shooting star.')
    expect((await $.command.run({ command: 'weather', args: 'visit dragon' })).text).toBe(
      'Nobody called dragon visits. Try birds, star, kite, plane, umbrella, duck, cow.',
    )
  })
})
