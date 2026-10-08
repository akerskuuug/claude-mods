export type RateWindow = { kind: string; percentUsed: number; resetsAt?: string }
export type Usage = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: RateWindow[]
}
export type GitState = { branch: string; isDirty: boolean; worktree: string | null }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      usage: Usage | null
      now: number | null
      git: GitState | null
      model: string | null
      effort: string | null
    }
  }
}
