import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DayPhase } from '../types'

const PANE = 'context-weather'
const FRAME_MS = 125 // 8 fps: lo-fi on purpose
const UPPER_HALF = 0x2580 // '▀': foreground paints the top pixel, background the bottom
// Where heavy rain turns into a thunderstorm: the forecast and the lightning share it.
const STORM = 0.88

const percent = atom({ plugin: 'context-weather', key: 'percent' } as const, null)
const phaseNow = atom({ plugin: 'context-weather', key: 'phase' } as const, null)
const override = atom({ plugin: 'context-weather', key: 'override' } as const, null)

// ---------------------------------------------------------------- weather model

export function contextPercent(context: { tokens?: number; window: number; percent?: number }): number {
  const used = context.percent ?? (context.window > 0 ? ((context.tokens ?? 0) / context.window) * 100 : 0)
  return Math.max(0, Math.min(100, used))
}

export function forecast(pct: number): string {
  if (pct < 10) return 'clear skies'
  if (pct < 25) return 'fair'
  if (pct < 45) return 'partly cloudy'
  if (pct < 60) return 'overcast'
  if (pct < 75) return 'light rain'
  if (pct < STORM * 100) return 'heavy rain'
  return 'thunderstorm'
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

// ---------------------------------------------------------------- the day

// A simple day: sunrise at 6, sunset at 20, twilight half an hour either side.
const SUNRISE = 6
const SUNSET = 20
const TWILIGHT = 0.75

/** Hours since local midnight, 0..24, from epoch ms and the UTC offset in minutes. */
export function localHour(ms: number, offsetMinutes: number): number {
  const minutes = Math.floor(ms / 60_000) + offsetMinutes
  return (((minutes % 1440) + 1440) % 1440) / 60
}

/** 0 at night, 1 by day, easing through dawn and dusk. */
export function daylight(hour: number): number {
  const rise = clamp01((hour - (SUNRISE - TWILIGHT)) / (2 * TWILIGHT))
  const set = clamp01((SUNSET + TWILIGHT - hour) / (2 * TWILIGHT))
  return Math.min(rise, set)
}

/** 1 right at sunrise or sunset, fading to 0 an hour and a quarter away. */
function glow(hour: number): number {
  return clamp01(1 - Math.min(Math.abs(hour - SUNRISE), Math.abs(hour - SUNSET)) / 1.25)
}

export function dayPhase(hour: number): DayPhase {
  if (Math.abs(hour - SUNRISE) <= TWILIGHT) return 'dawn'
  if (Math.abs(hour - SUNSET) <= TWILIGHT) return 'dusk'
  return hour > SUNRISE && hour < SUNSET ? 'day' : 'night'
}

/** Parses `date +%z` (`+0200`, `-0530`) into minutes east of UTC. */
export function parseOffset(text: string): number | null {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(text.trim())
  if (!m) return null
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

/** `22`, `22:30`, `7:05` as hours since midnight; null for anything else. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,2})(?::(\d\d))?$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2] ?? 0)
  return h < 24 && min < 60 ? h + min / 60 : null
}

function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  return ((x ^ (x >>> 16)) >>> 0) / 0x100000000
}

function mix(a: number, b: number, t: number): number {
  const k = clamp01(t)
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff
    const y = (b >> shift) & 0xff
    return Math.round(x + (y - x) * k) << shift
  }
  return ch(16) | ch(8) | ch(0)
}

// Three anchor palettes; storminess 0..0.5 blends clear→overcast, 0.5..1 overcast→storm.
type Pal = { top: number; bottom: number; cloud: number; shade: number; ground: number }

const SKY: Pal[] = [
  { top: 0x4f8fd9, bottom: 0xa8d8f0, cloud: 0xf4f6f8, shade: 0xc9d3de, ground: 0x5d8a4a },
  { top: 0x6f7f90, bottom: 0xa9b3bd, cloud: 0xb7bec7, shade: 0x8b939e, ground: 0x4a6b40 },
  { top: 0x161a24, bottom: 0x353c4b, cloud: 0x4a505c, shade: 0x2e333d, ground: 0x26331f },
]

// The same three, after dark.
const NIGHT: Pal[] = [
  { top: 0x0a1030, bottom: 0x22305a, cloud: 0x3a4466, shade: 0x262d48, ground: 0x1a2a1c },
  { top: 0x14171f, bottom: 0x2a2f3c, cloud: 0x3a3f4c, shade: 0x262a33, ground: 0x161f15 },
  { top: 0x08090d, bottom: 0x161920, cloud: 0x2a2e37, shade: 0x1a1d24, ground: 0x0e140d },
]

function blend(anchors: Pal[], s: number): Pal {
  const [clear, gray, storm] = anchors as [Pal, Pal, Pal]
  const [a, b, t] = s < 0.5 ? [clear, gray, s * 2] : [gray, storm, (s - 0.5) * 2]
  return {
    top: mix(a.top, b.top, t),
    bottom: mix(a.bottom, b.bottom, t),
    cloud: mix(a.cloud, b.cloud, t),
    shade: mix(a.shade, b.shade, t),
    ground: mix(a.ground, b.ground, t),
  }
}

function palette(s: number, hour: number): Pal {
  const day = blend(SKY, s)
  const night = blend(NIGHT, s)
  const light = daylight(hour)
  const warm = glow(hour) * (1 - s) // dawn and dusk colors, hidden by overcast
  const pal: Pal = {
    top: mix(night.top, day.top, light),
    bottom: mix(night.bottom, day.bottom, light),
    cloud: mix(night.cloud, day.cloud, light),
    shade: mix(night.shade, day.shade, light),
    ground: mix(night.ground, day.ground, light),
  }
  pal.top = mix(pal.top, 0x5b4a8a, warm * 0.45)
  pal.bottom = mix(pal.bottom, 0xf28c5a, warm * 0.75)
  pal.cloud = mix(pal.cloud, 0xf5b08a, warm * 0.5)
  return pal
}

const BAYER = [0, 2, 3, 1]

/**
 * One frame of the scene as `w * h` pixels (0xRRGGBB), `s` the storminess 0..1
 * and `hour` the local time of day, 0..24. Pure: the same arguments draw the same frame.
 */
export function paint(w: number, h: number, s: number, frame: number, hour = 12): Uint32Array {
  const px = new Uint32Array(w * h)
  const pal = palette(s, hour)
  const light = daylight(hour)
  const wind = 0.08 + s * 0.7
  const groundY = h - Math.max(2, Math.round(h * 0.12))

  // Lightning: in some 24-frame windows, a double flicker.
  const win = Math.floor(frame / 24)
  const strikeChance = s < STORM ? 0 : 0.25 + ((s - STORM) / (1 - STORM)) * 0.6
  const strikeAt = Math.floor(hash(win * 7 + 1) * 18)
  const inWindow = frame % 24
  const isStrike = hash(win * 7) < strikeChance && (inWindow === strikeAt || inWindow === strikeAt + 2)
  const flash = isStrike ? 0.45 : 0

  // Sky: banded gradient, 2x2 ordered dither between bands.
  const bands = 6
  for (let y = 0; y < groundY; y++) {
    for (let x = 0; x < w; x++) {
      const t = (y / Math.max(1, groundY - 1)) * bands + BAYER[(y & 1) * 2 + (x & 1)]! / 4 - 0.375
      const band = Math.max(0, Math.min(bands, Math.round(t)))
      px[y * w + x] = mix(mix(pal.top, pal.bottom, band / bands), 0xd8dcf0, flash)
    }
  }

  // Stars, twinkling, wherever the sky is dark and clear.
  const starAlpha = (1 - light) * clamp01(1 - s * 2.2)
  if (starAlpha > 0) {
    const stars = Math.round(w * groundY * 0.03)
    for (let i = 0; i < stars; i++) {
      const x = Math.floor(hash(i * 5 + 101) * w)
      const y = Math.floor(hash(i * 5 + 102) * groundY * 0.75)
      const dim = hash(i * 5 + 103 + Math.floor(frame / 6) * 977) < 0.15
      const p = y * w + x
      px[p] = mix(px[p]!, 0xfff6d8, starAlpha * (dim ? 0.35 : 0.9))
    }
  }

  // Sun and moon ride an arc from the left horizon to the right one.
  const r = Math.max(2, Math.round(Math.min(w, groundY) * 0.09))
  const arc = (t: number) => ({
    cx: Math.round(w * (0.1 + 0.8 * t)),
    cy: Math.round(groundY - 1 - Math.sin(Math.PI * t) * groundY * 0.72),
  })
  const disc = (cx: number, cy: number, color: number, alpha: number, cut?: { dx: number; dy: number }) => {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= w || y >= groundY || Math.hypot(x - cx, y - cy) > r) continue
        if (cut && Math.hypot(x - cx - cut.dx, y - cy - cut.dy) <= r) continue
        px[y * w + x] = mix(px[y * w + x]!, color, alpha)
      }
    }
  }

  const sunAlpha = clamp01(1 - s * 2.6)
  const sunT = (hour - (SUNRISE - 0.5)) / (SUNSET - SUNRISE + 1)
  if (sunAlpha > 0 && sunT >= 0 && sunT <= 1) {
    const { cx, cy } = arc(sunT)
    const color = mix(0xffd34d, 0xff7a3d, glow(hour))
    disc(cx, cy, color, sunAlpha)
    const glint = frame % 16 < 8 ? 1 : 0
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      for (let k = r + 1; k <= r + 1 + glint; k++) {
        const x = cx + dx * k
        const y = cy + dy * k
        if (x >= 0 && y >= 0 && x < w && y < groundY) px[y * w + x] = mix(px[y * w + x]!, 0xffe9a0, sunAlpha * 0.8)
      }
    }
  }

  const moonAlpha = clamp01(1 - s * 2.2) * (1 - light)
  const moonT = (((hour - SUNSET + 24) % 24) + 0.5) / (24 - (SUNSET - SUNRISE) + 1)
  if (moonAlpha > 0 && moonT <= 1) {
    const { cx, cy } = arc(moonT)
    disc(cx, cy, 0xe9e4c8, moonAlpha, { dx: Math.ceil(r * 0.7), dy: -Math.ceil(r * 0.4) })
  }

  // Overcast ceiling with a wavy lower edge.
  const ceiling = clamp01((s - 0.45) * 2.2) * groundY * 0.3
  if (ceiling > 0) {
    for (let x = 0; x < w; x++) {
      const edge = ceiling + Math.sin((x + frame * wind) / 3) * 1.2 + Math.sin((x + frame * wind * 0.6) / 7) * 1.5
      for (let y = 0; y < Math.min(groundY, edge); y++) px[y * w + x] = y > edge - 2 ? pal.shade : pal.cloud
    }
  }

  // Drifting clouds: more, bigger and faster the fuller the context.
  const count = s < 0.06 ? 0 : Math.min(12, Math.ceil(s * 12))
  for (let k = 0; k < count; k++) {
    const cw = Math.round(6 + hash(k * 3 + 11) * 8 + s * 8)
    const ch = Math.max(3, Math.round(cw * 0.35))
    const span = w + cw * 2
    const speed = wind * (0.5 + hash(k * 3 + 12) * 0.7)
    const cx0 = (((hash(k * 3 + 13) * span + frame * speed) % span) + span) % span - cw
    const cy0 = 1 + Math.round(hash(k * 5 + 17) * groundY * (0.35 + s * 0.15))
    for (let y = cy0 - ch; y <= cy0 + 1; y++) {
      for (let dx = -cw; dx <= cw; dx++) {
        const x = Math.round(cx0 + dx)
        if (x < 0 || y < 0 || x >= w || y >= groundY) continue
        // Three bumps on a flat base.
        const bump = Math.max(
          ch - Math.abs(dx) * 0.35,
          ch * 1.25 - Math.abs(dx + cw * 0.3) * 0.6,
          ch * 0.9 - Math.abs(dx - cw * 0.35) * 0.55,
        )
        if (cy0 - y > bump || Math.abs(dx) > cw - (y === cy0 + 1 ? 2 : 0)) continue
        px[y * w + x] = y >= cy0 ? pal.shade : mix(pal.cloud, 0xffffff, flash)
      }
    }
  }

  // Rain, slanting with the wind.
  const rain = clamp01((s - 0.55) / 0.35)
  if (rain > 0) {
    const drops = Math.round(w * groundY * 0.05 * rain)
    const color = mix(0x55657f, mix(0x8fa8c8, 0xc8d6ea, s), Math.max(light, flash))
    for (let i = 0; i < drops; i++) {
      const v = 1.6 + hash(i * 4 + 1) * 1.2 + s
      const y = Math.floor((hash(i * 4 + 2) * groundY + frame * v) % groundY)
      const x = Math.floor(((hash(i * 4 + 3) * w + y * wind * 0.5) % w + w) % w)
      // A streak, longer and more slanted the heavier it falls.
      const length = rain > 0.6 ? 3 : 2
      for (let k = 0; k < length && y - k >= 0; k++) {
        const i = (y - k) * w + Math.max(0, x - Math.round(k * wind * 0.5))
        px[i] = k === 0 ? color : mix(color, px[i]!, 0.45)
      }
    }
  }

  // The bolt itself.
  if (isStrike) {
    let x = Math.floor(hash(win * 7 + 2) * w * 0.8 + w * 0.1)
    for (let y = Math.floor(ceiling); y < groundY; y++) {
      px[y * w + Math.max(0, Math.min(w - 1, x))] = 0xfff7c2
      x += Math.floor(hash(win * 131 + y) * 3) - 1
    }
  }

  // Ground, and a little house whose window lights up when it gets gloomy or dark.
  for (let y = groundY; y < h; y++) {
    for (let x = 0; x < w; x++) px[y * w + x] = y === groundY ? mix(pal.ground, 0xffffff, 0.04 + 0.08 * light) : pal.ground
  }
  if (w >= 16 && groundY >= 8) {
    const hx = Math.round(w * 0.18)
    const wall = mix(mix(0x8a5a44, 0x2a1d18, s), 0x140e0c, (1 - light) * 0.6)
    const roof = mix(mix(0xb2483b, 0x3a1c1a, s), 0x1a0c0b, (1 - light) * 0.6)
    for (let y = groundY - 4; y < groundY; y++) for (let x = hx; x < hx + 6; x++) px[y * w + x] = wall
    for (let r = 0; r < 3; r++) for (let x = hx - 1 + r; x < hx + 7 - r; x++) px[(groundY - 5 - r) * w + x] = roof
    const lit = (s > 0.3 || light < 0.7) && !(s >= STORM && frame % 40 === 0)
    px[(groundY - 3) * w + hx + 2] = lit ? 0xffcf6b : mix(wall, 0x000000, 0.3)
    px[(groundY - 3) * w + hx + 3] = lit ? 0xffcf6b : mix(wall, 0x000000, 0.3)
  }

  return px
}

/** Packs a `columns * rows*2` pixel frame into Raster cells, two pixels per '▀'. */
export function encode(px: Uint32Array, columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const o = (r * columns + c) * 3
      words[o] = UPPER_HALF
      words[o + 1] = px[r * 2 * columns + c]!
      words[o + 2] = px[(r * 2 + 1) * columns + c]!
    }
  }
  return base64(new Uint8Array(words.buffer))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64, by hand: not every runtime has Uint8Array#toBase64. */
export function base64(bytes: Uint8Array): string {
  const out: string[] = []
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out.push(B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!)
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out.push(B64[n >> 18]! + B64[(n >> 12) & 63]! + '==')
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out.push(B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '=')
  }
  return out.join('')
}

// ---------------------------------------------------------------- hooks

// Module-local animation state; a reload starts it over, which is fine.
let frame = 0
let target = 0 // storminess the context asks for
let shown = 0 // storminess on screen, easing toward the target
let size: { columns: number; rows: number } | null = null
let hour = 12 // local time of day the scene shows
let clockHour = 12 // the real one
let pinned: number | null = null // a time /weather at set, or null to follow the clock
let isAutoOpened = false // opened unasked once this load, where it would be a sidebar

async function syncClock($: EngineInterface) {
  let offset: number | null = null
  try {
    const run = await $.process.run(['date', '+%z'], { timeoutMs: 5_000 })
    if (run.exitCode === 0) offset = parseOffset(run.stdout)
  } catch {}
  clockHour = localHour(await $.clock.now(), offset ?? -new Date().getTimezoneOffset())
  hour = pinned ?? clockHour
  const next = dayPhase(hour)
  await update($, phaseNow, () => next)
}

async function setPercent($: EngineInterface, pct: number) {
  target = pct / 100
  await update($, percent, () => Math.round(pct))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'weather',
      description: 'Toggle the context weather window; "at 22:30" shows that time, "at now" follows the clock',
      argumentHint: '[at HH:MM|now]',
    })
    const { context } = await $.session.usage()
    await setPercent($, contextPercent(context))
    shown = target
    pinned = await read($, override)
    await syncClock($)
    $.clock.every(60_000, () => syncClock($))
    $.clock.every(FRAME_MS, () => {
      frame += 1
      shown += (target - shown) * 0.04
      if (!size) return
      const { columns, rows } = size
      $.ui
        .blit({ requestId: PANE, key: 'sky', cells: encode(paint(columns, rows * 2, shown, frame, hour), columns, rows) })
        .then(r => {
          if ('deny' in r && r.deny) size = null
        })
        .catch(() => {
          size = null
        })
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    await setPercent($, contextPercent(e.context))
    return next(e)
  })

  on('command.run', { command: 'weather' }, async ($, e) => {
    const at = /^at\s+(.+)$/.exec(e.args.trim())
    if (at) {
      const wanted = at[1]!.trim() === 'now' ? null : parseClock(at[1]!)
      if (wanted === null && at[1]!.trim() !== 'now') return { text: `Not a time: ${at[1]}. Try /weather at 22:30.` }
      pinned = wanted
      await update($, override, () => wanted)
      await syncClock($)
      await $.ui.open({ id: PANE, title: 'Weather', columns: 32 })
      return { text: wanted === null ? 'The weather follows the clock again.' : `The weather shows ${at[1]!.trim()}.` }
    }
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'Weather window closed.' }
    }
    await $.ui.open({ id: PANE, title: 'Weather', columns: 32 })
    return { text: 'Weather window opened.' }
  })

  // Open unasked only where the pane docks as a sidebar: the terminal's
  // fullscreen layout. Only a drawing knows that, so the prompt's own sites
  // look, pass through, and open the pane once.
  for (const component of ['AbovePrompt', 'PromptHint'] as const) {
    on('ui.render', { component }, ($, e, next) => {
      if (!isAutoOpened && e.surface === 'terminal' && e.viewport?.isFullscreen === true) {
        isAutoOpened = true
        void $.ui.open({ id: PANE, title: 'Weather', columns: 32 })
      }
      return next(e)
    })
  }

  on('ui.close', { id: PANE }, ($, e, next) => {
    size = null
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const pct = (await read($, percent)) ?? 0
    const phase = (await read($, phaseNow)) ?? 'day'
    const columns = Math.max(1, Math.min(512, e.props.bodyColumns))
    const room = e.props.scroll.bodyRows - 1
    const rows = Math.max(2, Math.min(256, e.props.placement === 'dock' ? room : Math.min(room, 8)))
    const caption = `${phase === 'day' ? '' : `${phase} · `}${forecast(pct)} · ${pct}% context`

    if (e.surface !== 'terminal') {
      // Raster is terminal-only for now; elsewhere the forecast alone. The
      // terminal's mounted Raster, if any, keeps animating.
      const { Text } = $.ui.resolve(e)
      return <Text>{caption}</Text>
    }
    const { Box, Raster, Text } = $.ui.resolve(e)
    size = { columns, rows }

    return (
      <Box flexDirection="column">
        <Raster key="sky" columns={columns} rows={rows} cells={encode(paint(columns, rows * 2, shown, frame, hour), columns, rows)} />
        <Text dimColor wrap="truncate">
          {caption}
        </Text>
      </Box>
    )
  })
}
