export type DayPhase = 'dawn' | 'day' | 'dusk' | 'night'

declare module 'claude-code' {
  interface PluginState {
    'context-weather': {
      percent: number | null
      phase: DayPhase | null
      override: number | null
    }
  }
}
