/** Where the motion helper stands. */
export type Sensor =
  | { status: 'starting' }
  | { status: 'ready'; model: string }
  | { status: 'stopped'; reason: string }

/** The latest slap: its peak in g and its strength from 0 to 1. */
export type LastSlap = { g: number; strength: number }

/** Slaps Claude has not heard about yet. */
export type PendingSlaps = { count: number; hardest: number; didStop: boolean }

declare module 'claude-code' {
  interface PluginState {
    slapmod: {
      sensor: Sensor
      levels: number[]
      slaps: number
      total: number
      last: LastSlap | null
      /** SlapMac plays its own sounds while it runs, and this mod stays quiet. */
      slapMacRunning: boolean
      jolt: number
      /** Which page the pane shows. */
      view: 'meter' | 'settings'
      /** The sensitivity the dial shows before it is saved; null once it is. */
      dial: number | null
      /** The main loop's running turn, which a slap can stop. */
      runningTurn: string | null
      pending: PendingSlaps
    }
  }
}
