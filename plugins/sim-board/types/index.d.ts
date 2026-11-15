export type Sim = {
  udid: string
  name: string
  // e.g. "iOS 26.1"
  runtime: string
  // simctl's state: Booted, Shutdown, Booting, Shutting Down, ...
  state: string
}

export type Claim = {
  udid: string
  sessionId: string
  // Who holds it, for people: the session's directory and branch.
  label: string
  claimedAt: number
  heartbeatAt: number
  purpose?: string
}

export type Board = {
  sims: Sim[]
  claims: Claim[]
  // Why the simulators could not be listed (no Xcode, simctl failed).
  error: string | null
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'sim-board': {
      board: Board | null
    }
  }
}
