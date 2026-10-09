/** Whether the hosted program is up: never started, alive, or exited (tmux keeps its last screen). */
export type K9sStatus = 'stopped' | 'running' | 'exited'

/** The k9s screen as last read from tmux: one raw line per row (ANSI SGR kept), the cursor, the size and the state. */
export type K9sScreen = {
  lines: string[]
  cursor: { x: number; y: number }
  columns: number
  rows: number
  status: K9sStatus
  /** One line for the person: why it is not running, or the exit status. */
  note: string
  isCursorShown: boolean
}

declare module 'claude-code' {
  interface PluginState {
    k9s: { screen: K9sScreen }
  }
}
