export type RateWindow = { kind: string; percentUsed: number; resetsAt?: string }
export type Usage = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: RateWindow[]
}
export type CostView = 'session' | 'today' | '7d' | '30d'
export type KnownBilling = 'subscription' | 'metered'
export type GitState = { branch: string; isDirty: boolean; worktree: string | null; root: string | null }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      usage: Usage | null
      now: number | null
      git: GitState | null
      model: string | null
      effort: string | null
      costView: CostView
      costOpen: boolean
      costInfo: boolean
      ledger: Record<string, number>
      sessionCost: number
      knownBilling: KnownBilling | null
      dir: string | null
      worktreeOpen: boolean
    }
  }
}
