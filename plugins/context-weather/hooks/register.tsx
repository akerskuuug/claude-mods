import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DayPhase } from '../types'

const PANE = 'context-weather'
const FRAME_MS = 125 // 8 fps: lo-fi on purpose
const UPPER_HALF = 0x2580 // '▀': foreground paints the top pixel, background the bottom
// Where heavy rain turns into a thunderstorm: the forecast and the lightning share it.
const STORM = 0.88
// Where overcast turns into light rain: the forecast and the raindrops share it.
const RAIN = 0.6
// The terminal width from which the pane opens by itself.
const WIDE = 144

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
  if (pct < RAIN * 100) return 'overcast'
  if (pct < 75) return 'light rain'
  if (pct < STORM * 100) return 'heavy rain'
  return 'thunderstorm'
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** How hard it rains, 0 to 1: none until light rain, full by 90%. */
export function rainfall(s: number): number {
  return clamp01((s - RAIN) / 0.3)
}

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

// ---------------------------------------------------------------- visitors

// Now and then someone passes through, if the weather suits them (see visitorFor).
// Each kind in KINDS says what it is called, how long it stays and how it is drawn.
export const VISITORS = [
  'birds',
  'cat',
  'star',
  'owl',
  'kite',
  'plane',
  'umbrella',
  'duck',
  'cow',
  'bike',
  'door',
  'lost-umbrella',
] as const
export type VisitorKind = (typeof VISITORS)[number]
export type Visitor = { kind: VisitorKind; start: number; seed: number }

// What the storm blows past; the cow is one in four.
const STORM_VISITORS: readonly VisitorKind[] = ['cow', 'bike', 'door', 'lost-umbrella']

// Between visits: 3 to 8 minutes.
const GAP_MIN = (3 * 60_000) / FRAME_MS
const GAP_MAX = (8 * 60_000) / FRAME_MS
// Where light rain turns heavy: the umbrella gives up from here.
const HEAVY = 0.75

// Pixels per frame.
const BIRD_SPEED = 0.35
const CAT_SPEED = 0.12
const PLANE_SPEED = 0.5
const WALK_SPEED = 0.25
const RUN_SPEED = 0.6
const DUCK_SPEED = 0.2
const STAR_FALL = 8 // frames the shooting star moves
const STAR_FADE = 5 // frames it fades after
const KITE_FRAMES = 320 // 40 seconds of kite flying
const KITE_REEL = 40 // frames to let the kite out, and to reel it in
const CAT_SIT = 160 // frames the cat sits on the roof's peak
const CAT_UP = Math.ceil(3 / CAT_SPEED) // from the left eave to the peak
const CAT_DOWN = Math.ceil(5 / CAT_SPEED) // from the peak off the right eave
const OWL_FRAMES = 480 // a minute on the roof
const OWL_LEAVE = 24 // frames flying off at the end of it

/** Frames until the next visit, from a roll of 0..1. */
export function nextGap(roll: number): number {
  return Math.round(GAP_MIN + clamp01(roll) * (GAP_MAX - GAP_MIN))
}

const pick = <T,>(list: readonly T[], roll: number): T => list[Math.min(list.length - 1, Math.floor(roll * list.length))]!

/** Who visits this sky; `roll` (0..1) picks where several might. */
export function visitorFor(s: number, hour: number, roll = 0): VisitorKind {
  if (s >= STORM) return pick(STORM_VISITORS, roll)
  if (s >= RAIN) return roll < 0.5 ? 'umbrella' : 'duck'
  const phase = dayPhase(hour)
  if (s < 0.25 && (phase === 'dawn' || phase === 'dusk')) return 'cat'
  const light = daylight(hour)
  if (light < 0.3) return roll < 0.5 ? (s < 0.3 ? 'star' : 'plane') : 'owl'
  if (s >= 0.25) return light > 0.6 && roll < 0.5 ? 'kite' : 'plane'
  return 'birds'
}

/** How many frames a visit lasts in a scene `w` pixels wide: until it is out of sight. */
export function visitLength(kind: VisitorKind, w: number): number {
  return KINDS[kind].length(w)
}

/** The visitor `/weather visit <name>` means, or null. */
export function visitorNamed(name: string): VisitorKind | null {
  const key = name.trim().toLowerCase()
  return VISITORS.find(k => k === key || KINDS[k].names.includes(key)) ?? null
}

/** What a visitor draws with: the scene's measures and pens, for one frame. */
type Scene = {
  w: number
  groundY: number
  s: number
  light: number
  frame: number
  hx: number // the house's left wall
  door: number // the house's middle: walkers come out from behind it
  dot(x: number, y: number, color: number, alpha?: number): void
  /** Rows of letters keyed into `colors`, '.' for clear, shaded for the dark. */
  sprite(rows: readonly string[], colors: Record<string, number>, x: number, y: number): void
  shade(color: number): number
  /** Someone 3 pixels tall standing on the ground at `x`, legs apart mid-stride. */
  person(x: number, isStriding: boolean): void
  /** The roof's top edge at `x`. */
  roofTop(x: number): number
}

// Where a visitor is drawn: behind the clouds, in front of the rain, or on the house.
export type Layer = 'sky' | 'air' | 'roof'

type Kind = {
  arrival: string // what /weather visit answers
  names: string[] // other names /weather visit takes
  layer: Layer
  length(w: number): number
  /** Draws the visitor `t` frames into its visit. */
  draw(scene: Scene, t: number, seed: number): void
}

/** Which way a visitor heads: 1 left to right, -1 right to left. */
const heading = (seed: number) => (hash(seed + 2) < 0.5 ? -1 : 1)
/** Where something crossing at `speed` is, `t` frames after it came in from the side `dir` says. */
const across = (w: number, t: number, speed: number, dir: number) => (dir > 0 ? -2 + t * speed : w + 1 - t * speed)

/** `rows` turned a quarter clockwise `quarters` times. */
function turn(rows: readonly string[], quarters: number): string[] {
  let out = [...rows]
  for (let q = 0; q < quarters % 4; q++) out = Array.from(out[0]!, (_, c) => out.map(row => row[c]!).reverse().join(''))
  return out
}

/** Something the gale picked up, tumbling across: `spin` frames per turn of `quarters`. */
function blown(kind: {
  arrival: string
  names: string[]
  rows: readonly string[]
  colors: Record<string, number>
  speed: number
  spin: number
  quarters: number
}): Kind {
  const turns = [0, 1, 2, 3].map(q => turn(kind.rows, q))
  return {
    arrival: kind.arrival,
    names: kind.names,
    layer: 'air',
    length: w => Math.ceil((w + 16) / kind.speed),
    draw({ groundY, sprite }, t, seed) {
      const shape = turns[(Math.floor(t / kind.spin) * kind.quarters) % 4]!
      const cx = Math.round(-8 + t * kind.speed)
      const cy = Math.floor(groundY * (0.3 + hash(seed + 1) * 0.35)) + Math.round(Math.sin(t / 6) * 2)
      sprite(shape, kind.colors, cx - (shape[0]!.length >> 1), cy - (shape.length >> 1))
    },
  }
}

const SKIN = 0xe8b796
const COAT = 0xe0b030
const BOOTS = 0x3a3f4a
const SHOOTING = 0xffffff
// A bird, wings up and level.
const BIRD_UP = ['B.B', '.B.']
const BIRD_LEVEL = ['BBB']
const BIRD_COLORS: Record<string, number> = { B: 0x2b2f3a }
const FLOCK_DY = [0, -2, 2]
// A far-off plane and the beacon that blinks on it.
const PLANE = 0xd8dce4
const BEACON = 0xff3b30
// An umbrella over a Handle: open, and blown inside out.
const UMBRELLA_OPEN = ['.RRR.', 'RRRRR', '..H..']
const UMBRELLA_BLOWN = ['R...R', '.RRR.', '..H..']
const UMBRELLA_COLORS: Record<string, number> = { R: 0xc8423a, H: BOOTS }
// A diamond Kite with a yellow Heart, on a String.
const KITE = ['.K.', 'KHK', '.K.']
const KITE_COLORS: Record<string, number> = { K: 0xd8443a, H: 0xf2c94c }
const STRING = 0xd8d2c0
// A duck facing left, 5 by 4: Green head, Orange bill, White body with an upturned tail,
// webbed Feet that step as it waddles. Only the feet change, so the tail holds still.
const DUCK = [
  ['.G..W', 'OGWWW', '..WWW', '..F.F'],
  ['.G..W', 'OGWWW', '..WWW', '...F.'],
]
const DUCK_COLORS: Record<string, number> = { G: 0x2f6b3a, O: 0xe8a23a, W: 0xf0ece0, F: 0xd8862a }
// A cat, dark against the twilight: walking right, in two steps, and sitting facing
// out; its tail and its eyes, which catch the light, are drawn apart.
const CAT_WALK = [
  ['K..K', '.KKK', '.K.K'],
  ['K..K', '.KKK', '..K.'],
]
const CAT_SIT_ROWS = ['K.K', 'KKK', 'KKK']
const CAT_COLORS: Record<string, number> = { K: 0x2c2830 }
const CAT_EYES = 0x9be36a
// An owl, 3 by 3, its yellow eyes drawn apart so they can blink and look about.
const OWL = ['B.B', 'BBB', 'BBB']
const OWL_COLORS: Record<string, number> = { B: 0x6b5440 }
const OWL_EYES = 0xffd23a
const OWL_LOOKS = [[0, 2], [0, 1], [1, 2]] // eyes ahead, left, right

const KINDS: Record<VisitorKind, Kind> = {
  // A few birds flap across a fair sky, one way or the other.
  birds: {
    arrival: 'Here come some birds.',
    names: ['bird'],
    layer: 'air',
    length: w => Math.ceil((w + 16) / BIRD_SPEED),
    draw({ w, groundY, sprite }, t, seed) {
      const dir = heading(seed)
      const lead = across(w, t, BIRD_SPEED, dir)
      const y0 = 2 + Math.floor(hash(seed + 1) * groundY * 0.35) + Math.round(Math.sin(t / 10))
      const flock = hash(seed + 3) < 0.5 ? 2 : 3
      for (let i = 0; i < flock; i++) {
        const [bx, by] = [Math.round(lead - dir * i * 4), y0 + FLOCK_DY[i]!]
        if (((t >> 2) + i) % 2 === 0) sprite(BIRD_UP, BIRD_COLORS, bx - 1, by - 1)
        else sprite(BIRD_LEVEL, BIRD_COLORS, bx - 1, by)
      }
    },
  },

  // A cat climbs to the roof's peak, sits a while with its tail curling, and goes on.
  cat: {
    arrival: 'A cat is out on the roof.',
    names: ['cats'],
    layer: 'roof',
    length: () => CAT_UP + CAT_SIT + CAT_DOWN,
    draw({ hx, dot, sprite, shade, roofTop }, t) {
      if (t >= CAT_UP && t < CAT_UP + CAT_SIT) {
        const [x, peak] = [hx + 1, roofTop(hx + 2)]
        sprite(CAT_SIT_ROWS, CAT_COLORS, x, peak - 3)
        if (t % 64 >= 2) for (const dx of [0, 2]) dot(x + dx, peak - 2, CAT_EYES)
        dot(x + 3, peak - (Math.floor(t / 8) % 2 === 0 ? 1 : 2), shade(CAT_COLORS.K!))
        return
      }
      const cx = Math.round(hx - 1 + (t < CAT_UP ? t : t - CAT_SIT) * CAT_SPEED)
      if (cx <= hx + 6) sprite(CAT_WALK[Math.floor(t / 3) % 2]!, CAT_COLORS, cx - 2, roofTop(cx) - 3)
    },
  },

  // A shooting star streaks down and fades, behind the clouds.
  star: {
    arrival: 'Here comes a shooting star.',
    names: ['stars', 'shooting-star', 'shootingstar'],
    layer: 'sky',
    length: () => STAR_FALL + STAR_FADE,
    draw({ w, groundY, dot }, t, seed) {
      const dir = heading(seed)
      const step = Math.min(t, STAR_FALL)
      const headX = Math.floor(w * (0.2 + 0.6 * hash(seed))) + step * 2 * dir
      const headY = Math.floor(hash(seed + 1) * groundY * 0.3) + step
      const fade = t <= STAR_FALL ? 1 : 1 - (t - STAR_FALL) / STAR_FADE
      for (let j = Math.min(6, step * 2); j >= 1; j--) dot(headX - dir * j, headY - Math.round(j / 2), SHOOTING, (1 - j / 7) * fade * 0.8)
      dot(headX, headY, SHOOTING, fade)
    },
  },

  // An owl keeps watch from the roof's peak, blinking and looking about, then flies off.
  owl: {
    arrival: 'An owl lands on the roof.',
    names: ['owls'],
    layer: 'roof',
    length: () => OWL_FRAMES,
    draw({ hx, dot, sprite, roofTop }, t) {
      const away = Math.max(0, Math.floor((t - (OWL_FRAMES - OWL_LEAVE)) / 2))
      const [x, y] = [hx + 1 + away, roofTop(hx + 2) - 3 - away]
      sprite(OWL, OWL_COLORS, x, y)
      const isBlinking = t % 48 < 2 || (t % 240 >= 6 && t % 240 < 8)
      if (isBlinking || away > 0) return
      for (const dx of OWL_LOOKS[Math.floor(t / 96) % 3]!) dot(x + dx, y + 1, OWL_EYES)
    },
  },

  // Someone by the house flies a kite; the wind leans it over, harder the fuller the context.
  kite: {
    arrival: 'Someone is out flying a kite.',
    names: ['kites'],
    layer: 'air',
    length: () => KITE_FRAMES,
    draw({ w, groundY, s, door, dot, sprite, shade, person }, t) {
      const x = door + 5
      person(x, false)
      const reach = Math.min(w * 0.5, groundY * 0.7) * clamp01(Math.min(t, KITE_FRAMES - t) / KITE_REEL)
      const lean = 0.35 + s * 0.8
      const [handX, handY] = [x + 1, groundY - 2]
      const kx = Math.round(handX + Math.sin(lean) * reach + Math.sin(t / 7) * 1.5)
      const ky = Math.round(handY - Math.cos(lean) * reach + Math.sin(t / 5))
      const n = Math.max(Math.abs(kx - handX), Math.abs(ky - handY))
      for (let i = 1; i < n; i += 2) {
        dot(Math.round(handX + ((kx - handX) * i) / n), Math.round(handY + ((ky - handY) * i) / n), STRING, 0.6)
      }
      for (let j = 1; j <= 3; j++) dot(kx + Math.round(j * 0.5 + Math.sin(t / 3 + j) * 0.6), ky + 1 + j, shade(KITE_COLORS.H!))
      sprite(KITE, KITE_COLORS, kx - 1, ky - 1)
    },
  },

  // A plane far off, its beacon blinking and its contrail fading behind it.
  plane: {
    arrival: 'Here comes a plane.',
    names: ['planes', 'airplane', 'aeroplane'],
    layer: 'sky',
    length: w => Math.ceil((w + 40) / PLANE_SPEED),
    draw({ w, groundY, light, frame, dot, shade }, t, seed) {
      const dir = heading(seed)
      const x = Math.round(across(w, t, PLANE_SPEED, dir))
      const y = 1 + Math.floor(hash(seed + 1) * groundY * 0.2)
      for (let j = 2; j < 30; j++) dot(x - dir * j, y, 0xffffff, (0.15 + 0.35 * light) * (1 - j / 30))
      dot(x, y, shade(PLANE))
      dot(x - dir, y, frame % 8 < 4 ? BEACON : shade(PLANE))
    },
  },

  // Someone walks out under an umbrella; in heavy rain it blows inside out halfway and they run.
  umbrella: {
    arrival: 'Someone is heading out under an umbrella.',
    names: ['umbrellas', 'person'],
    layer: 'air',
    length: w => Math.ceil((w + 8) / WALK_SPEED),
    draw({ w, groundY, s, door, sprite, person }, t) {
      const mid = Math.max(door, Math.round(w * 0.55))
      const flipAt = (mid - door) / WALK_SPEED
      const isBlown = s >= HEAVY && t >= flipAt
      const x = Math.round(isBlown ? mid + (t - flipAt) * RUN_SPEED : door + t * WALK_SPEED)
      person(x, Math.floor(t / (isBlown ? 1 : 2)) % 2 === 1)
      sprite(isBlown ? UMBRELLA_BLOWN : UMBRELLA_OPEN, UMBRELLA_COLORS, x - 2, groundY - 6)
    },
  },

  // A duck waddles through the rain, glad of it.
  duck: {
    arrival: 'Here comes a duck.',
    names: ['ducks'],
    layer: 'air',
    length: w => Math.ceil((w + 12) / DUCK_SPEED),
    draw({ w, groundY, sprite }, t) {
      sprite(DUCK[Math.floor(t / 4) % 2]!, DUCK_COLORS, Math.round(across(w, t, DUCK_SPEED, -1)), groundY - 4)
    },
  },

  // Whatever the gale picked up tumbles past.
  cow: blown({
    arrival: 'Here comes a cow.',
    names: ['cows'],
    // Facing right, 8 by 4: White, Black patches, Pink snout, Legs.
    rows: ['......WW', 'WBWWBWWP', 'WWBWWW..', 'L.L..L.L'],
    colors: { W: 0xf4f1e8, B: 0x26221f, P: 0xf0a3a8, L: 0x5a4a40 },
    speed: 0.9,
    spin: 6,
    quarters: 2,
  }),
  bike: blown({
    arrival: 'Is that a bike?',
    names: ['bikes', 'bicycle'],
    // 7 by 5: blacK saddle and handlebar, a red Frame, twO wheels.
    rows: ['.K...K.', '..FFFF.', 'OOOFOOO', 'O.O.O.O', 'OOO.OOO'],
    colors: { K: 0x2a2a2a, F: 0xd04a3a, O: 0x3a3a3a },
    speed: 0.8,
    spin: 4,
    quarters: 1,
  }),
  door: blown({
    arrival: 'There goes a shed door.',
    names: ['doors', 'shed-door'],
    // 3 by 6, with a brass Knob.
    rows: ['DDD', 'DDD', 'DDD', 'DDK', 'DDD', 'DDD'],
    colors: { D: 0x9b6a3f, K: 0xe8c860 },
    speed: 0.7,
    spin: 5,
    quarters: 1,
  }),
  'lost-umbrella': blown({
    arrival: 'An umbrella blows past. Someone will miss that.',
    names: ['brolly'],
    // The umbrella from the rain, 5 by 5, with nobody under it.
    rows: ['.RRR.', 'RRRRR', '..H..', '..H..', '.HH..'],
    colors: UMBRELLA_COLORS,
    speed: 1,
    spin: 3,
    quarters: 1,
  }),
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

/** The row the ground starts on, in a scene `h` pixels tall. */
export function groundLine(h: number): number {
  return h - Math.max(2, Math.round(h * 0.12))
}

/**
 * One frame of the scene as `w * h` pixels (0xRRGGBB), `s` the storminess 0..1
 * `hour` the local time of day, 0..24, and `visitor` whoever is passing through.
 * Pure: the same arguments draw the same frame.
 */
export function paint(w: number, h: number, s: number, frame: number, hour = 12, visitor: Visitor | null = null): Uint32Array {
  const px = new Uint32Array(w * h)
  const pal = palette(s, hour)
  const light = daylight(hour)
  const wind = 0.08 + s * 0.7
  const groundY = groundLine(h)

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

  // Whoever is visiting, drawn in turn at its layer.
  const hasHouse = w >= 16 && groundY >= 8
  const hx = Math.round(w * 0.18)
  const roofTop = (x: number) => groundY - 7 + Math.max(0, hx + 1 - x, x - (hx + 4)) // a three-step gable
  const t = visitor ? frame - visitor.start : -1
  const guest = visitor && t >= 0 && t < visitLength(visitor.kind, w) ? KINDS[visitor.kind] : null
  const scene: Scene = {
    w,
    groundY,
    s,
    light,
    frame,
    hx,
    door: hx + 3,
    roofTop,
    dot(x, y, color, alpha = 1) {
      if (x < 0 || y < 0 || x >= w || y >= groundY) return
      px[y * w + x] = mix(px[y * w + x]!, color, alpha)
    },
    shade: color => mix(color, 0x000000, (1 - light) * 0.35),
    sprite(rows, colors, x, y) {
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r]!.length; c++) {
          const ch = rows[r]![c]!
          if (ch !== '.') scene.dot(x + c, y + r, scene.shade(colors[ch]!))
        }
      }
    },
    person(x, isStriding) {
      scene.dot(x, groundY - 3, scene.shade(SKIN))
      scene.dot(x, groundY - 2, scene.shade(COAT))
      for (const dx of isStriding ? [-1, 1] : [0]) scene.dot(x + dx, groundY - 1, scene.shade(BOOTS))
    },
  }
  const drawVisitor = (layer: Layer) => {
    if (guest?.layer === layer && (layer !== 'roof' || hasHouse)) guest.draw(scene, t, visitor!.seed)
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

  drawVisitor('sky')

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
  const rain = rainfall(s)
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

  drawVisitor('air')

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
  if (hasHouse) {
    const wall = mix(mix(0x8a5a44, 0x2a1d18, s), 0x140e0c, (1 - light) * 0.6)
    const roof = mix(mix(0xb2483b, 0x3a1c1a, s), 0x1a0c0b, (1 - light) * 0.6)
    for (let y = groundY - 4; y < groundY; y++) for (let x = hx; x < hx + 6; x++) px[y * w + x] = wall
    for (let x = hx - 1; x <= hx + 6; x++) for (let y = roofTop(x); y <= groundY - 5; y++) px[y * w + x] = roof
    const lit = (s > 0.3 || light < 0.7) && !(s >= STORM && frame % 40 === 0)
    px[(groundY - 3) * w + hx + 2] = lit ? 0xffcf6b : mix(wall, 0x000000, 0.3)
    px[(groundY - 3) * w + hx + 3] = lit ? 0xffcf6b : mix(wall, 0x000000, 0.3)
  }

  drawVisitor('roof')

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
let visitor: Visitor | null = null // whoever is passing through now
let visitAt = 0 // the frame the next visit is due

/** Lets someone in now; they stay until out of sight, whatever the weather does meanwhile. */
function visit(kind: VisitorKind) {
  visitor = { kind, start: frame, seed: Math.floor(Math.random() * 0x7fffffff) }
}

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

/** Reads the context afresh and shows its weather at once, with no easing. */
async function resetWeather($: EngineInterface) {
  const { context } = await $.session.usage()
  await setPercent($, contextPercent(context))
  shown = target
}

/** Opens the pane at the person's word; the reply says if it waits undrawn. */
async function openPane($: EngineInterface, done: string): Promise<{ text: string }> {
  const opened = await $.ui.open({ id: PANE, title: 'Weather', columns: 32 })
  return { text: opened.isPlaced ? done : `${done} The window is not shown yet: ${opened.reason}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'weather',
      description:
        'Toggle the context weather window; "at 22:30" shows that time, "at now" follows the clock, "visit <name>" sends a visitor by',
      argumentHint: '[at HH:MM|now|visit <visitor>]',
    })
    await resetWeather($)
    pinned = await read($, override)
    await syncClock($)
    visitAt = frame + nextGap(Math.random())
    $.clock.every(60_000, () => syncClock($))
    $.clock.every(FRAME_MS, () => {
      frame += 1
      shown += (target - shown) * 0.04
      if (visitor && frame - visitor.start >= visitLength(visitor.kind, size?.columns ?? 0)) visitor = null
      if (!visitor && frame >= visitAt) {
        visit(visitorFor(shown, hour, Math.random()))
        visitAt = frame + nextGap(Math.random())
      }
      if (!size) return
      const { columns, rows } = size
      $.ui
        .blit({ requestId: PANE, key: 'sky', cells: encode(paint(columns, rows * 2, shown, frame, hour, visitor), columns, rows) })
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

  // A /clear or a resume swaps the conversation without a session.start, and
  // the next measure waits for a turn: show the new conversation's sky and hour now.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear' || e.source === 'resume') {
      await resetWeather($)
      // The new conversation has its own /weather at, and its own phase atom.
      pinned = await read($, override)
      await syncClock($)
    }
    return result
  })

  on('command.run', { command: 'weather' }, async ($, e) => {
    const at = /^at\s+(.+)$/.exec(e.args.trim())
    if (at) {
      const wanted = at[1]!.trim() === 'now' ? null : parseClock(at[1]!)
      if (wanted === null && at[1]!.trim() !== 'now') return { text: `Not a time: ${at[1]}. Try /weather at 22:30.` }
      pinned = wanted
      await update($, override, () => wanted)
      await syncClock($)
      return openPane($, wanted === null ? 'The weather follows the clock again.' : `The weather shows ${at[1]!.trim()}.`)
    }
    const guest = /^visit\s+(\S+)$/.exec(e.args.trim())
    if (guest) {
      const kind = visitorNamed(guest[1]!)
      if (!kind) return { text: `Nobody called ${guest[1]} visits. Try ${VISITORS.join(', ')}.` }
      visit(kind)
      return openPane($, KINDS[kind].arrival)
    }
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'Weather window closed.' }
    }
    return openPane($, 'Weather window opened.')
  })

  // Open unasked only where the pane docks as a sidebar: the terminal's
  // fullscreen layout, at least WIDE columns across. Only a drawing knows
  // that, so the prompt's own sites look, pass through, and open the pane once.
  for (const component of ['AbovePrompt', 'PromptHint'] as const) {
    on('ui.render', { component }, ($, e, next) => {
      if (!isAutoOpened && e.surface === 'terminal' && e.viewport?.isFullscreen === true && e.viewport.columns >= WIDE) {
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
        <Raster key="sky" columns={columns} rows={rows} cells={encode(paint(columns, rows * 2, shown, frame, hour, visitor), columns, rows)} />
        <Text dimColor wrap="truncate">
          {caption}
        </Text>
      </Box>
    )
  })
}
