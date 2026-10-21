// Pure helpers: the helper's line protocol, the settings, the gestures, the
// meter's drawing and the note Claude reads. No `$` here, so tests can call
// them directly.

export const HISTORY_LENGTH = 120
export const MAX_LEVEL = 10
export const DOUBLE_WINDOW_MS = 800
export const SEND_MIN_STRENGTH = 0.35
export const SEND_COOLDOWN_MS = 5_000
export const MAX_TEXT_LENGTH = 2_000

const BLOCKS = '▁▂▃▄▅▆▇█'
const THRESHOLD_MARK = '┃'
const LEVEL_FLOOR_G = 0.003
const LEVEL_CEILING_G = 1.5
const LOOSEST_THRESHOLD_G = 0.25
const THRESHOLD_SPAN = 0.1
const LIGHT_BELOW = 0.35
const SOLID_BELOW = 0.7
const ECHO_RATIO = 0.7

export const LEVELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] as const
export const ACTIONS = ['stop', 'tell', 'command', 'prompt', 'off'] as const
export const SOUNDS = ['bonk', 'voice', 'off'] as const
export type Action = (typeof ACTIONS)[number]
export type Sound = (typeof SOUNDS)[number]
export type Gesture = 'single' | 'double'
export type Strength = 'light' | 'solid' | 'hard'

/** What the Mac says to a slap: one at random, never the same twice running. */
export const VOICE_LINES = ['Ow!', 'Hey!', 'Ouch! Rude.', 'Okay, okay!', 'What did I do?'] as const

export type Settings = {
  level: number
  onSlap: Action
  slapText: string
  onDoubleSlap: Action
  doubleSlapText: string
  sound: Sound
}

/** The /config row of each setting, by its userConfig field. */
export type SettingField = 'sensitivity' | 'onSlap' | 'slapText' | 'onDoubleSlap' | 'doubleSlapText' | 'sound'
export const SETTING_FIELDS: readonly SettingField[] = [
  'sensitivity',
  'onSlap',
  'slapText',
  'onDoubleSlap',
  'doubleSlapText',
  'sound',
]
export type SettingWrite = { field: SettingField; value: string }

export const DEFAULT_SETTINGS: Settings = {
  level: 5,
  onSlap: 'stop',
  slapText: '',
  onDoubleSlap: 'prompt',
  doubleSlapText: "That's not it. Step back and try a different approach.",
  sound: 'bonk',
}

export const GESTURE_FIELDS: Record<Gesture, { action: 'onSlap' | 'onDoubleSlap'; text: 'slapText' | 'doubleSlapText' }> = {
  single: { action: 'onSlap', text: 'slapText' },
  double: { action: 'onDoubleSlap', text: 'doubleSlapText' },
}

export type HelperEvent =
  | { type: 'ready'; version: string; model: string }
  | { type: 'leader' }
  | { type: 'level'; g: number }
  | { type: 'slap'; g: number; strength: number }
  | { type: 'error'; code: string; message: string }

/** Slaps Claude has not heard about yet. */
export type Pending = { count: number; hardest: number; didStop: boolean }

export const NOTHING_PENDING: Pending = { count: 0, hardest: 0, didStop: false }

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find(one => one === value) ?? fallback
}

export function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT_LENGTH) : ''
}

export function readSettings(options: Readonly<Record<string, unknown>>): Settings {
  return {
    level: Number(choice(options.sensitivity, LEVELS, String(DEFAULT_SETTINGS.level) as (typeof LEVELS)[number])),
    onSlap: choice(options.onSlap, ACTIONS, DEFAULT_SETTINGS.onSlap),
    slapText: cleanText(options.slapText),
    onDoubleSlap: choice(options.onDoubleSlap, ACTIONS, DEFAULT_SETTINGS.onDoubleSlap),
    doubleSlapText: typeof options.doubleSlapText === 'string' ? cleanText(options.doubleSlapText) : DEFAULT_SETTINGS.doubleSlapText,
    sound: choice(options.sound, SOUNDS, DEFAULT_SETTINGS.sound),
  }
}

/** What a setting holds now, as its /config row spells it. */
export function settingValue(settings: Settings, field: SettingField): string {
  return field === 'sensitivity' ? String(settings.level) : settings[field]
}

/** A sensitivity level from 1 to 10 as the smallest shake, in g, that counts. */
export function levelToThreshold(level: number): number {
  const clamped = Math.min(MAX_LEVEL, Math.max(1, Math.round(level)))

  return LOOSEST_THRESHOLD_G * THRESHOLD_SPAN ** ((clamped - 1) / (MAX_LEVEL - 1))
}

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

/** A bar of the shake, with a mark where a slap starts counting. */
export function meter(g: number, width: number, threshold?: number): string {
  const room = Math.max(0, width)
  const filled = Math.round(scale(g) * room)
  const cells = Array.from({ length: room }, (_, index): string => (index < filled ? '█' : '░'))
  if (threshold !== undefined && room > 0) {
    cells[Math.min(room - 1, Math.round(scale(threshold) * room))] = THRESHOLD_MARK
  }

  return cells.join('')
}

export function dial(level: number): string {
  return '▮'.repeat(level) + '▯'.repeat(MAX_LEVEL - level)
}

/** A voice line other than the last one, from `random` in [0, 1). */
export function pickVoiceLine(previous: number, random: number): number {
  if (previous < 0 || previous >= VOICE_LINES.length) return Math.floor(random * VOICE_LINES.length)
  const others = VOICE_LINES.length - 1

  return (previous + 1 + Math.floor(random * others)) % VOICE_LINES.length
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** A command's text as `$.command.run` takes it: the name without its slash. */
export function parseCommandText(text: string): { command: string; args: string } | undefined {
  const match = /^\/?([\w:-]+)\s*([\s\S]*)$/.exec(text.trim())
  if (match === null) return undefined

  return { command: match[1] ?? '', args: (match[2] ?? '').trim() }
}

/** Why a slap may not run this text, or undefined when it may. */
export function textRefusal(action: Action, text: string): string | undefined {
  if (action !== 'command' || text === '') return undefined
  const parsed = parseCommandText(text)
  if (parsed === undefined) return 'That needs to be a slash command, like /compact.'
  if (parsed.command === 'slap') return "A slap can't run /slap itself."

  return undefined
}

export function actionText(action: Action, text: string): string {
  switch (action) {
    case 'stop':
      return 'stops Claude'
    case 'tell':
      return 'tells Claude'
    case 'command':
      return text === '' ? 'runs a command (none set yet)' : `runs ${text.startsWith('/') ? text : `/${text}`}`
    case 'prompt':
      return text === '' ? 'sends a prompt (none written yet)' : `sends "${text}"`
    case 'off':
      return 'does nothing'
  }
}

export function describeSettings(settings: Settings): string {
  return [
    `Sensitivity ${settings.level} of ${MAX_LEVEL} (${levelToThreshold(settings.level).toFixed(3)} g)`,
    `A slap ${actionText(settings.onSlap, settings.slapText)}`,
    `A double slap ${actionText(settings.onDoubleSlap, settings.doubleSlapText)}`,
    `Sound: ${settings.sound}`,
  ].join('\n')
}

export type SlapCommand =
  | { kind: 'toggle' }
  | { kind: 'settings' }
  | { kind: 'status' }
  | { kind: 'test' }
  | { kind: 'set'; writes: SettingWrite[] }
  | { kind: 'error'; message: string }

const USAGE =
  'Try /slap, /slap settings, /slap status, /slap test, /slap sensitivity 1-10, /slap on|double stop|tell|command|prompt|off [text], or /slap sound bonk|voice|off.'

/** Reads what follows /slap. Writes put a text before its action, so the action finds it. */
export function parseSlapArgs(args: string): SlapCommand {
  const [word = '', ...rest] = args.trim().split(/\s+/)
  const tail = args.trim().slice(word.length).trim()
  switch (word) {
    case '':
      return { kind: 'toggle' }
    case 'settings':
    case 'status':
    case 'test':
      return { kind: word }
    case 'sensitivity': {
      const level = Number(rest[0])
      if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
        return { kind: 'error', message: `Sensitivity goes from 1 to ${MAX_LEVEL}.` }
      }

      return { kind: 'set', writes: [{ field: 'sensitivity', value: String(level) }] }
    }
    case 'sound': {
      const sound = SOUNDS.find(one => one === rest[0])
      if (sound === undefined) return { kind: 'error', message: 'The sound is bonk, voice or off.' }

      return { kind: 'set', writes: [{ field: 'sound', value: sound }] }
    }
    case 'on':
    case 'double': {
      const fields = GESTURE_FIELDS[word === 'on' ? 'single' : 'double']
      const action = ACTIONS.find(one => one === rest[0])
      if (action === undefined) return { kind: 'error', message: 'The action is stop, tell, command, prompt or off.' }
      const text = cleanText(tail.slice(action.length))
      const refusal = textRefusal(action, text)
      if (refusal !== undefined) return { kind: 'error', message: refusal }
      const writes: SettingWrite[] = []
      if (text !== '' && (action === 'command' || action === 'prompt')) writes.push({ field: fields.text, value: text })
      writes.push({ field: fields.action, value: action })

      return { kind: 'set', writes }
    }
    default:
      return { kind: 'error', message: USAGE }
  }
}

export type GestureState = { id: number; firstAt: number; isWaiting: boolean; quietUntil: number }
export const GESTURE_START: GestureState = { id: 0, firstAt: -Infinity, isWaiting: false, quietUntil: -Infinity }
export type GestureEvent = { type: 'slap'; at: number } | { type: 'due'; id: number }
export type GestureEffect =
  | { type: 'fire'; gesture: Gesture; action: Action }
  | { type: 'schedule'; id: number; inMs: number }

/**
 * Turns slaps into actions. The first slap fires its action at once, unless a
 * double slap is set and the action sends something: then it waits out the
 * window, and a second slap inside it fires the double action instead. Slaps
 * for one window after a double count but trigger nothing.
 */
export function gesture(
  state: GestureState,
  event: GestureEvent,
  settings: Pick<Settings, 'onSlap' | 'onDoubleSlap'>,
): { state: GestureState; effects: GestureEffect[] } {
  if (event.type === 'due') {
    if (event.id !== state.id || !state.isWaiting) return { state, effects: [] }

    return { state: { ...state, isWaiting: false }, effects: [{ type: 'fire', gesture: 'single', action: settings.onSlap }] }
  }
  const { at } = event
  if (at < state.quietUntil) return { state, effects: [] }
  if (state.isWaiting && at - state.firstAt <= DOUBLE_WINDOW_MS) {
    const effects: GestureEffect[] =
      settings.onDoubleSlap === 'off' ? [] : [{ type: 'fire', gesture: 'double', action: settings.onDoubleSlap }]

    return { state: { id: state.id + 1, firstAt: -Infinity, isWaiting: false, quietUntil: at + DOUBLE_WINDOW_MS }, effects }
  }
  const id = state.id + 1
  const hasDouble = settings.onDoubleSlap !== 'off'
  const sends = settings.onSlap === 'command' || settings.onSlap === 'prompt'
  const isDeferred = hasDouble && sends
  // A late timer must not swallow the first slap's action.
  const overdue: GestureEffect[] =
    state.isWaiting && isDeferred ? [{ type: 'fire', gesture: 'single', action: settings.onSlap }] : []
  const effects: GestureEffect[] =
    settings.onSlap === 'off'
      ? []
      : isDeferred
        ? [{ type: 'schedule', id, inMs: DOUBLE_WINDOW_MS }]
        : [{ type: 'fire', gesture: 'single', action: settings.onSlap }]

  return { state: { id, firstAt: at, isWaiting: hasDouble, quietUntil: state.quietUntil }, effects: [...overdue, ...effects] }
}

export type EchoGuard = { until: number; strength: number }

/** A slap felt while our own sound plays, and much weaker than the slap that played it, is its echo. */
export function isEcho(now: number, guard: EchoGuard | undefined, strength: number): boolean {
  return guard !== undefined && now < guard.until && strength < guard.strength * ECHO_RATIO
}

export function canSend(now: number, lastSentAt: number): boolean {
  return now - lastSentAt >= SEND_COOLDOWN_MS
}

/** What Claude reads with the next prompt about the slaps it missed. */
export function slapNote(pending: Pending): string {
  const hardest = strengthOf(pending.hardest)
  if (pending.didStop) {
    return `slapmod: the user stopped your last turn by slapping their MacBook (a ${hardest} slap). Take it as a sign that turn was going the wrong way.`
  }

  return `slapmod: the user slapped their MacBook ${plural(pending.count, 'time', 'times')} since your last message, the hardest a ${hardest} one.`
}
