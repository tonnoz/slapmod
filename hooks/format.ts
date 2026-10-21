// Pure helpers: the helper's line protocol, the meter's drawing and the note
// Claude reads. No `$` here, so tests can call them directly.

export const HISTORY_LENGTH = 120

const BLOCKS = '▁▂▃▄▅▆▇█'
const LEVEL_FLOOR_G = 0.003
const LEVEL_CEILING_G = 1.5
const LIGHT_BELOW = 0.35
const SOLID_BELOW = 0.7

export type HelperEvent =
  | { type: 'ready'; version: string; model: string }
  | { type: 'leader' }
  | { type: 'level'; g: number }
  | { type: 'slap'; g: number; strength: number }
  | { type: 'error'; code: string; message: string }

export type Strength = 'light' | 'solid' | 'hard'

/** Slaps Claude has not heard about yet. */
export type Pending = { count: number; hardest: number; didStop: boolean }

export const NOTHING_PENDING: Pending = { count: 0, hardest: 0, didStop: false }

/** Splits a child's output into whole lines; a piece may end mid-line. */
export function lineSplitter(): (text: string) => string[] {
  let rest = ''

  return text => {
    const parts = (rest + text).split('\n')
    rest = parts.pop() ?? ''

    return parts.filter(line => line.trim() !== '')
  }
}

export function parseEvent(line: string): HelperEvent | undefined {
  try {
    const event: unknown = JSON.parse(line)
    if (typeof event !== 'object' || event === null || !('type' in event)) return undefined

    return event as HelperEvent
  } catch {
    return undefined
  }
}

export function strengthOf(strength: number): Strength {
  if (strength < LIGHT_BELOW) return 'light'
  if (strength < SOLID_BELOW) return 'solid'

  return 'hard'
}

/** A shake in g as 0 to 1, on a log scale so a tap still shows. */
export function scale(g: number): number {
  if (g <= LEVEL_FLOOR_G) return 0

  return Math.min(1, Math.log(g / LEVEL_FLOOR_G) / Math.log(LEVEL_CEILING_G / LEVEL_FLOOR_G))
}

export function sparkline(levels: readonly number[], width: number): string {
  return levels
    .slice(-Math.max(0, width))
    .map(g => BLOCKS[Math.round(scale(g) * (BLOCKS.length - 1))])
    .join('')
}

export function meter(g: number, width: number): string {
  const room = Math.max(0, width)
  const filled = Math.round(scale(g) * room)

  return '█'.repeat(filled) + '░'.repeat(room - filled)
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** What Claude reads with the next prompt about the slaps it missed. */
export function slapNote(pending: Pending): string {
  const hardest = strengthOf(pending.hardest)
  if (pending.didStop) {
    return `slapmod: the user stopped your last turn by slapping their MacBook (a ${hardest} slap). Take it as a sign that turn was going the wrong way.`
  }

  return `slapmod: the user slapped their MacBook ${plural(pending.count, 'time', 'times')} since your last message, the hardest a ${hardest} one.`
}
