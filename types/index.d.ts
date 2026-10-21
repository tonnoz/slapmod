/** Where the motion helper stands. */
export type Sensor =
  | { status: 'starting' }
  | { status: 'ready'; model: string }
  | { status: 'stopped'; reason: string }

/** The latest slap: its peak in g and its strength from 0 to 1. */
export type LastSlap = { g: number; strength: number }

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
    }
  }
}
