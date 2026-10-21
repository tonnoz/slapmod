import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ConfigRow, On } from 'claude-code'

import {
  DEFAULT_SETTINGS,
  GESTURE_START,
  SETTING_FIELDS,
  gesture,
  levelToThreshold,
  lineSplitter,
  meter,
  parseCommandText,
  parseSlapArgs,
  pickOther,
  slapNote,
  sparkline,
  strengthOf,
  VOICE_LINES,
} from '../hooks/format'
import type { GestureEffect, GestureState } from '../hooks/format'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const PANE = {
  plugin: 'slapmod',
  component: 'Pane',
  requestId: 'slapmod',
  props: {
    title: 'slapmod',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const READY = { type: 'ready', version: '0.2.0', model: 'Mac16,8' }
const LEADER = { type: 'leader' }
const HARD_SLAP = { type: 'slap', g: 1.2, strength: 0.9 }
const WEAK_SLAP = { type: 'slap', g: 0.06, strength: 0.2 }
const NO_SENSOR = { type: 'error', code: 'no-sensor', message: 'This Mac has no motion sensor.' }
const START = 10_000
/** A stand-in for the WAV `say` writes: its bytes as base64. */
const VOICE_WAV = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA='
const COMPOSER = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: false, columns: 120 }
const THIS_SESSION = 'session-here'
/** The helper runs for the session: it stays this long after its last line. */
const HELPER_LIFE_MS = 3_600_000

/** What the helper says: some events, after the clock moves `afterMs` from the step before. */
type Step = { afterMs?: number; events: object[] }

function says(...events: object[]): string {
  return events.map(event => `${JSON.stringify(event)}\n`).join('')
}

const CONFIG_ROWS = SETTING_FIELDS.map(
  (field): ConfigRow => ({
    key: `slapmod.${field}`,
    label: field,
    kind: 'text',
    value: '',
    provider: { plugin: 'slapmod', tier: 'user' },
    isLocked: false,
  }),
)

// The engine beneath the mod, recording what the mod asks of it.
function world(
  on: On,
  steps: Step[],
  {
    isSlapMacRunning = false,
    canSay = true,
    store = {},
  }: { isSlapMacRunning?: boolean; canSay?: boolean; store?: Record<string, unknown> } = {},
) {
  const clock = mock.clock(on, { now: START })
  mock.store(on, store)
  const seen = {
    played: [] as string[],
    aborted: [] as string[],
    prompts: [] as { text: string; context: readonly string[] | undefined; origin: string }[],
    commands: [] as { command: string; args: string }[],
    writes: [] as { key: string; value: unknown }[],
    spawned: [] as (readonly string[])[],
    toasts: [] as string[],
    spoken: [] as string[],
    runs: [] as (readonly string[])[],
  }
  on('command.register', () => ({ value: { command: 'slap' } }))
  on('command.list', () => ({ value: [{ name: 'compact', description: 'Compact', source: 'builtin' }] }))
  on('command.run', (_, e) => {
    seen.commands.push({ command: e.command, args: e.args })
    return { text: '' }
  })
  on('config.list', () => ({ value: CONFIG_ROWS }))
  on('config.set', (_, e) => {
    seen.writes.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('session.id', () => ({ value: THIS_SESSION }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    seen.runs.push(e.argv)
    const isPgrep = e.argv[0] === '/usr/bin/pgrep'
    const isSay = e.argv[0] === '/usr/bin/say'
    return {
      value: {
        exitCode: isPgrep ? (isSlapMacRunning ? 0 : 1) : isSay && !canSay ? 1 : 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('process.spawn', async function* (_, e) {
    seen.spawned.push(e.argv)
    for (const step of steps) {
      if (step.afterMs !== undefined) await clock.sleep(step.afterMs)
      yield { stream: 'stdout' as const, text: says(...step.events) }
    }
    await clock.sleep(HELPER_LIFE_MS)
    return { value: { code: 0, signal: null } }
  })
  on('fs.read', () => ({ value: { base64: VOICE_WAV } }))
  on('audio.speak', (_, e) => {
    seen.spoken.push(e.text)
    return { value: { via: 'system' as const } }
  })
  on('audio.play', (_, e) => {
    seen.played.push(e.clip.asset ?? e.clip.mime ?? '')
    return { value: undefined }
  })
  on('turn.abort', (_, e) => {
    seen.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => {
    seen.prompts.push({ text: e.text, context: e.context, origin: e.origin.kind })
    return { text: e.text, context: e.context }
  })

  return { clock, seen }
}

const ON_START = [{ events: [READY, LEADER] }]

describe('slaps', () => {
  test('a slap is counted, bonks once and shows in the pane on every surface', async ($, on) => {
    const { clock, seen } = world(on, [{ events: [READY, LEADER, HARD_SLAP] }])
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await clock.settle()

    expect(seen.played).toEqual(['sounds/bonk-hard.wav'])
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /this session/ }))?.text).toBe('1 slap this session')
      expect((await ui.find({ type: 'Text', text: /Last one/ }))?.text).toBe('Last one: hard, 1.20 g')
      expect(await ui.find({ type: 'Text', text: /SlapMac/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the helper starts at the threshold of the sensitivity', async ($, on) => {
    const { clock, seen } = world(on, ON_START)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.settle()

    expect(seen.spawned[0]).toContain('--threshold')
    expect(seen.spawned[0]).toContain('0.090')
  })

  test('a higher sensitivity starts it at a lower threshold', { options: { sensitivity: '8' } }, async ($, on) => {
    const { clock, seen } = world(on, ON_START)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.settle()

    expect(seen.spawned[0]).toContain('0.042')
  })

  test('a much weaker slap while the bonk plays is its echo, a strong one counts', async ($, on) => {
    const { clock } = world(on, [{ events: [READY, LEADER, HARD_SLAP, WEAK_SLAP, HARD_SLAP] }])
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await clock.settle()

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /this session/ }))?.text).toBe('2 slaps this session')
    await ui.unmount()
  })

  test('only the session holding the sound lock plays', async ($, on) => {
    const { clock, seen } = world(on, [{ events: [READY, HARD_SLAP] }])
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await clock.settle()

    expect(seen.played).toEqual([])
  })

  test('while SlapMac runs it plays the sounds, and the mod stays quiet and says so', async ($, on) => {
    const { clock, seen } = world(on, [...ON_START, { afterMs: 100, events: [HARD_SLAP] }], {
      isSlapMacRunning: true,
    })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await clock.advance(100)

    expect(seen.played).toEqual([])
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /SlapMac is running/ })).toBeDefined()
    await ui.unmount()
  })

  test('a Mac without the sensor says so in the pane', async ($, on) => {
    const { clock } = world(on, [{ events: [NO_SENSOR] }])
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /no motion sensor/ })).toBeDefined()
      await ui.unmount()
    }
  })
})

describe('voice', () => {
  const VOICE = { options: { sound: 'voice' } }

  test('the voice lines are made once, and a slap plays one as quickly as a bonk', VOICE, async ($, on) => {
    const { clock, seen } = world(on, [...ON_START, { afterMs: 100, events: [HARD_SLAP] }])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(100)

    expect(seen.runs.filter(argv => argv[0] === '/usr/bin/say').length).toBe(VOICE_LINES.length)
    expect(seen.runs.filter(argv => argv[0] === '/bin/rm').length).toBe(VOICE_LINES.length)
    expect(seen.played).toEqual(['audio/wav'])
    expect(seen.spoken).toEqual([])
  })

  test('if the lines could not be made, a slap still speaks', VOICE, async ($, on) => {
    const { clock, seen } = world(on, [...ON_START, { afterMs: 100, events: [HARD_SLAP] }], { canSay: false })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(100)

    expect(seen.played).toEqual([])
    expect(seen.spoken.length).toBe(1)
    expect(VOICE_LINES).toContain(seen.spoken[0])
  })

  test('the whip plays one of its five cracks, never the same twice running', { options: { sound: 'whip' } }, async ($, on) => {
    const { clock, seen } = world(on, [{ events: [READY, LEADER, HARD_SLAP, HARD_SLAP, HARD_SLAP] }])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.settle()

    expect(seen.played.length).toBe(3)
    for (const asset of seen.played) expect(asset).toMatch(/^sounds\/whip-[1-5]\.mp3$/)
    expect(seen.played[1]).not.toBe(seen.played[0])
    expect(seen.played[2]).not.toBe(seen.played[1])
  })

  test('with the bonk, no voice lines are made', async ($, on) => {
    const { clock, seen } = world(on, ON_START)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.settle()

    expect(seen.runs.filter(argv => argv[0] === '/usr/bin/say')).toEqual([])
  })
})

describe('actions', () => {
  test('a slap during a turn stops it, and Claude hears why with the next prompt only', async ($, on) => {
    const { clock, seen } = world(on, [...ON_START, { afterMs: 100, events: [HARD_SLAP] }])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'rewrite everything', turnId: 'turn-1' })
    await clock.advance(1_000)

    expect(seen.aborted).toEqual(['turn-1'])
    const next = await $.prompt.submit({ text: 'fine, why?', origin: COMPOSER, wait: false })
    expect(next.context?.join('\n')).toMatch(/stopped your last turn by slapping/)
    const after = await $.prompt.submit({ text: 'and now?', origin: COMPOSER, wait: false })
    expect(after.context).toBeUndefined()
  })

  test('a double slap mid-turn stops Claude, then sends the double slap prompt with the note', async ($, on) => {
    const { clock, seen } = world(on, [
      ...ON_START,
      { afterMs: 100, events: [HARD_SLAP] },
      { afterMs: 250, events: [HARD_SLAP] },
    ])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'rewrite everything', turnId: 'turn-1' })
    await clock.advance(400)

    expect(seen.aborted).toEqual(['turn-1'])
    expect(seen.prompts[0]?.origin).toBe('plugin')
    expect(seen.prompts.map(prompt => prompt.text)).toEqual([
      `${DEFAULT_SETTINGS.doubleSlapText}\n\n[${slapNote({ count: 2, hardest: 0.9, didStop: true })}]`,
    ])
  })

  test('tell mode lets the turn run and still tells Claude', { options: { onSlap: 'tell' } }, async ($, on) => {
    const { clock, seen } = world(on, [...ON_START, { afterMs: 100, events: [HARD_SLAP] }])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'rewrite everything', turnId: 'turn-1' })
    await clock.advance(1_000)

    expect(seen.aborted).toEqual([])
    const next = await $.prompt.submit({ text: 'hello', origin: COMPOSER, wait: false })
    expect(next.context?.join('\n')).toMatch(/slapped their MacBook 1 time since/)
  })

  const PROMPT_AND_COMMAND = {
    options: { onSlap: 'prompt', slapText: 'keep going', onDoubleSlap: 'command', doubleSlapText: '/compact' },
  }

  test('a prompt slap waits out the double window, then sends', PROMPT_AND_COMMAND, async ($, on) => {
    const { clock, seen } = world(on, [...ON_START, { afterMs: 100, events: [HARD_SLAP] }])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(100)

    expect(seen.prompts).toEqual([])
    await clock.advance(800)
    expect(seen.prompts.map(prompt => prompt.text.split('\n')[0])).toEqual(['keep going'])
  })

  test('a second slap inside the window runs the double slap command instead', PROMPT_AND_COMMAND, async ($, on) => {
    const { clock, seen } = world(on, [
      ...ON_START,
      { afterMs: 100, events: [HARD_SLAP] },
      { afterMs: 250, events: [HARD_SLAP] },
    ])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(2_000)

    expect(seen.commands).toEqual([{ command: 'compact', args: '' }])
    expect(seen.prompts).toEqual([])
  })

  test('sending cools down between double slaps', async ($, on) => {
    const { clock, seen } = world(on, [
      ...ON_START,
      { afterMs: 100, events: [HARD_SLAP] },
      { afterMs: 250, events: [HARD_SLAP] },
      { afterMs: 1_000, events: [HARD_SLAP] },
      { afterMs: 250, events: [HARD_SLAP] },
    ])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(2_000)

    expect(seen.prompts.length).toBe(1)
    expect(seen.toasts).toContain('Easy. One every few seconds.')
  })

  test('a light double slap does not send', async ($, on) => {
    const { clock, seen } = world(on, [
      ...ON_START,
      { afterMs: 100, events: [WEAK_SLAP] },
      { afterMs: 250, events: [WEAK_SLAP] },
    ])
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(1_000)

    expect(seen.prompts).toEqual([])
    expect(seen.toasts).toContain('Slap harder to send it.')
  })

  test('only the session you typed in last sends', async ($, on) => {
    const { clock, seen } = world(
      on,
      [...ON_START, { afterMs: 100, events: [HARD_SLAP] }, { afterMs: 250, events: [HARD_SLAP] }],
      { store: { activeSession: { id: 'another-session', at: 1 } } },
    )
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(1_000)

    expect(seen.prompts).toEqual([])
  })

  test('typing here makes this the session a slap sends to', async ($, on) => {
    const { clock, seen } = world(
      on,
      [...ON_START, { afterMs: 100, events: [HARD_SLAP] }, { afterMs: 250, events: [HARD_SLAP] }],
      { store: { activeSession: { id: 'another-session', at: 1 } } },
    )
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit({ text: 'hi', origin: COMPOSER, wait: false })
    await clock.advance(1_000)

    expect(seen.prompts.map(prompt => prompt.text.split('\n')[0])).toEqual(['hi', DEFAULT_SETTINGS.doubleSlapText])
  })
})

describe('/slap', () => {
  async function slap($: Engine, args: string) {
    return $.command.run({ command: 'slap', args, origin: COMPOSER, presentation: PRESENTATION })
  }

  test('sets the sensitivity, and refuses one out of range', async ($, on) => {
    const { clock, seen } = world(on, ON_START)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.settle()

    expect((await slap($, 'sensitivity 11')).text).toBe('Sensitivity goes from 1 to 10.')
    expect(seen.writes).toEqual([])
    expect((await slap($, 'sensitivity 7')).text).toBe('Saved.')
    expect(seen.writes).toEqual([{ key: 'slapmod.sensitivity', value: '7' }])
  })

  test('sets a double slap command, the text before the action', async ($, on) => {
    const { clock, seen } = world(on, ON_START)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.settle()

    await slap($, 'double command /compact focus on tests')
    expect(seen.writes).toEqual([
      { key: 'slapmod.doubleSlapText', value: '/compact focus on tests' },
      { key: 'slapmod.onDoubleSlap', value: 'command' },
    ])
    expect((await slap($, 'on command /slap')).text).toBe("A slap can't run /slap itself.")
  })

  test('says how it is set up', async ($, on) => {
    const { clock } = world(on, ON_START)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.settle()

    const { text } = await slap($, 'status')
    expect(text).toMatch(/Sensitivity 5 of 10 \(0\.090 g\)/)
    expect(text).toMatch(/A slap stops Claude/)
  })
})

describe('settings page', () => {
  test('the dial moves at once and saves once the presses stop', async ($, on) => {
    const { clock, seen } = world(on, ON_START)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await clock.settle()
    await $.command.run({ command: 'slap', args: 'settings', origin: COMPOSER, presentation: PRESENTATION })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'sensitivity-up' })
    await ui.press({ key: 'sensitivity-up' })
    expect((await ui.find({ type: 'Text', text: /▮/ }))?.text).toBe('▮▮▮▮▮▮▮▯▯▯ 7')
    expect(seen.writes).toEqual([])
    await clock.advance(600)
    expect(seen.writes).toEqual([{ key: 'slapmod.sensitivity', value: '7' }])
    await ui.unmount()
  })

  test('the page saves a typed command on desktop, and points to /config on mobile', { options: { onSlap: 'command' } }, async ($, on) => {
    const { clock, seen } = world(on, ON_START)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await clock.settle()
    await $.command.run({ command: 'slap', args: 'settings', origin: COMPOSER, presentation: PRESENTATION })

    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await desktop.input({ key: 'slapText', text: '/compact' })
    expect(seen.writes).toEqual([{ key: 'slapmod.slapText', value: '/compact' }])
    await desktop.unmount()

    const mobile = await $.ui.mount({ ...PANE, surface: 'mobile' })
    expect(await mobile.find({ type: 'Text', text: /Change the text in \/config/ })).toBeDefined()
    await mobile.unmount()
  })

  test('the page draws on every surface', async ($, on) => {
    const { clock } = world(on, ON_START)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await clock.settle()
    await $.command.run({ command: 'slap', args: 'settings', origin: COMPOSER, presentation: PRESENTATION })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /Sensitivity/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Double slap: sends/ })).toBeDefined()
      await ui.unmount()
    }
  })
})

describe('format', () => {
  const BOTH = { onSlap: 'prompt', onDoubleSlap: 'command' } as const

  function run(state: GestureState, events: Parameters<typeof gesture>[1][], settings: Parameters<typeof gesture>[2]) {
    const effects: GestureEffect[] = []
    let now = state
    for (const event of events) {
      const next = gesture(now, event, settings)
      now = next.state
      effects.push(...next.effects)
    }
    return effects
  }

  test('a stop slap fires at once even with a double slap set', async () => {
    expect(run(GESTURE_START, [{ type: 'slap', at: 0 }], { onSlap: 'stop', onDoubleSlap: 'prompt' })).toEqual([
      { type: 'fire', gesture: 'single', action: 'stop' },
    ])
  })

  test('a sending slap waits, then fires when its time is due', async () => {
    expect(run(GESTURE_START, [{ type: 'slap', at: 0 }, { type: 'due', id: 1 }], BOTH)).toEqual([
      { type: 'schedule', id: 1, inMs: 800 },
      { type: 'fire', gesture: 'single', action: 'prompt' },
    ])
  })

  test('a second slap in the window fires the double, and the first one is never due', async () => {
    expect(
      run(GESTURE_START, [{ type: 'slap', at: 0 }, { type: 'slap', at: 300 }, { type: 'due', id: 1 }, { type: 'slap', at: 600 }], BOTH),
    ).toEqual([
      { type: 'schedule', id: 1, inMs: 800 },
      { type: 'fire', gesture: 'double', action: 'command' },
    ])
  })

  test('with no double slap, every slap fires straight away', async () => {
    expect(run(GESTURE_START, [{ type: 'slap', at: 0 }, { type: 'slap', at: 300 }], { onSlap: 'prompt', onDoubleSlap: 'off' })).toEqual([
      { type: 'fire', gesture: 'single', action: 'prompt' },
      { type: 'fire', gesture: 'single', action: 'prompt' },
    ])
  })

  test('/slap arguments read as settings to write', async () => {
    expect(parseSlapArgs('')).toEqual({ kind: 'toggle' })
    expect(parseSlapArgs('on prompt  try again  ')).toEqual({
      kind: 'set',
      writes: [
        { field: 'slapText', value: 'try again' },
        { field: 'onSlap', value: 'prompt' },
      ],
    })
    expect(parseSlapArgs('double off')).toEqual({ kind: 'set', writes: [{ field: 'onDoubleSlap', value: 'off' }] })
    expect(parseSlapArgs('sound whip')).toEqual({ kind: 'set', writes: [{ field: 'sound', value: 'whip' }] })
    expect(parseSlapArgs('sound loud').kind).toBe('error')
    expect(parseSlapArgs('bogus').kind).toBe('error')
  })

  test('commands read with or without their slash', async () => {
    expect(parseCommandText('/compact focus on tests')).toEqual({ command: 'compact', args: 'focus on tests' })
    expect(parseCommandText('review')).toEqual({ command: 'review', args: '' })
    expect(parseCommandText('  ')).toBeUndefined()
  })

  test('the sensitivity spans 0.25 g to 0.025 g', async () => {
    expect(levelToThreshold(1).toFixed(3)).toBe('0.250')
    expect(levelToThreshold(10).toFixed(3)).toBe('0.025')
    expect(levelToThreshold(5).toFixed(3)).toBe('0.090')
  })

  test('lines are split whole across pieces', async () => {
    const lines = lineSplitter()
    expect(lines('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(lines(':2}\n')).toEqual(['{"b":2}'])
  })

  test('the meter fits its width and marks the threshold', async () => {
    expect(meter(0.5, 10).length).toBe(10)
    expect(meter(0, 10)).toBe('░'.repeat(10))
    expect(meter(0, 10, 0.09)).toContain('┃')
    expect(sparkline([0.001, 0.1, 2], 2)).toBe('▅█')
  })

  test('a voice line is never the same twice running, and every one comes up', async () => {
    const randoms = [0, 0.2, 0.4, 0.6, 0.8, 0.99]
    for (let previous = 0; previous < VOICE_LINES.length; previous++) {
      const picks = randoms.map(random => pickOther(previous, VOICE_LINES.length, random))
      expect(picks).not.toContain(previous)
      expect(new Set(picks).size).toBe(VOICE_LINES.length - 1)
    }
    expect(new Set(randoms.map(random => pickOther(-1, VOICE_LINES.length, random))).size).toBe(VOICE_LINES.length)
  })

  test('strength reads as light, solid or hard', async () => {
    expect([0.1, 0.5, 0.9].map(strengthOf)).toEqual(['light', 'solid', 'hard'])
    expect(slapNote({ count: 2, hardest: 0.5, didStop: false })).toMatch(/2 times since your last message, the hardest a solid one/)
  })
})
