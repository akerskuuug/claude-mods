import { describe, expect, mock, test } from 'claude-code/testing'
import { base64, contextPercent, dayPhase, daylight, encode, forecast, localHour, paint, parseClock, parseOffset } from './register'

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

  test('opens by itself only in the fullscreen terminal', async ($, on) => {
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
    const band = (isFullscreen: boolean) =>
      $.ui.mount({
        plugin: 'context-weather',
        surface: 'terminal',
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 150 } as never,
        viewport: { columns: 160, rows: 50, isFullscreen },
      } as never)
    const main = await band(false)
    await main.unmount()
    expect(opened).toEqual([])
    const full = await band(true)
    await full.unmount()
    expect(opened).toEqual(['context-weather'])
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
