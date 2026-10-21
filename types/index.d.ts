/** Where the motion helper stands. */
export type Sensor =
  | { status: 'starting' }
  | { status: 'ready'; model: string }
  | { status: 'stopped'; reason: string }

/** The latest slap: its peak in g and its strength from 0 to 1. */
export type LastSlap = { g: number; strength: number }

/**
 * Where SlapMac stands. none: not installed or not running. legacy: an older
 * SlapMac without the bridge runs, plays its own sounds, and the mod stays
 * quiet. idle: SlapMac runs but won't take slaps (paused, Slap Mode off, not
 * activated), so the mod plays. linked: SlapMac detects the slaps and plays
 * `voices`, its selected pack, and `threshold` is its smallest slap in g.
 */
export type SlapMacLink =
  | { mode: 'none' }
  | { mode: 'legacy' }
  | { mode: 'idle'; reason: string }
  | { mode: 'linked'; voices: string; threshold: number }

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
      /** Whether SlapMac detects and voices the slaps, or this mod does. */
      slapMac: SlapMacLink
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
