import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { lineSplitter, meter, slapNote, sparkline, strengthOf } from '../hooks/format'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const PANE = {
  plugin: 'slapmod',
  component: 'Pane',
  requestId: 'slapmod',
  props: {
    title: 'slapmod',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const READY = { type: 'ready', version: '0.1.0', model: 'Mac16,8' }
const LEADER = { type: 'leader' }
const HARD_SLAP = { type: 'slap', g: 1.2, strength: 0.9 }
const NO_SENSOR = { type: 'error', code: 'no-sensor', message: 'This Mac has no motion sensor.' }
const SLAP_DELAY_MS = 100
const COMPOSER = { kind: 'composer' } as const

function says(...events: object[]): string {
  return events.map(event => `${JSON.stringify(event)}\n`).join('')
}

// The engine beneath the mod: the helper says `first` at once and `later`
// once the clock has moved SLAP_DELAY_MS, then exits; pgrep finds SlapMac
// only when `isSlapMacRunning`.
function world(on: On, first: string, later = '', isSlapMacRunning = false) {
  const clock = mock.clock(on, { now: 10_000 })
  mock.store(on)
  const played: string[] = []
  const aborted: string[] = []
  on('command.register', () => ({ value: { command: 'slap' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({
    value: {
      exitCode: isSlapMacRunning ? 0 : 1,
      stdout: '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: first }
    if (later !== '') {
      await clock.sleep(SLAP_DELAY_MS)
      yield { stream: 'stdout' as const, text: later }
    }
    return { value: { code: 0, signal: null } }
  })
  on('audio.play', (_, e) => {
    played.push(e.clip.asset ?? '')
    return { value: undefined }
  })
  on('turn.abort', (_, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  return { clock, played, aborted }
}

test('a slap is counted, bonks once and shows in the pane on every surface', async ($, on) => {
  const { clock, played } = world(on, says(READY, LEADER, HARD_SLAP))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect(played).toEqual(['sounds/bonk-hard.wav'])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /this session/ }))?.text).toBe('1 slap this session')
    expect((await ui.find({ type: 'Text', text: /Last one/ }))?.text).toBe('Last one: hard, 1.20 g')
    expect(await ui.find({ type: 'Text', text: /SlapMac/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('while SlapMac runs it plays the sounds, and the mod stays quiet and says so', async ($, on) => {
  const { clock, played } = world(on, says(READY, LEADER), says(HARD_SLAP), true)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(SLAP_DELAY_MS)

  expect(played).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /this session/ }))?.text).toBe('1 slap this session')
  expect(await ui.find({ type: 'Text', text: /SlapMac is running/ })).toBeDefined()
  await ui.unmount()
})

test('a slap during a turn stops it, and Claude hears why with the next prompt only', async ($, on) => {
  const { clock, aborted } = world(on, says(READY, LEADER), says(HARD_SLAP))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'rewrite everything', turnId: 'turn-1' })
  await clock.advance(SLAP_DELAY_MS)

  expect(aborted).toEqual(['turn-1'])
  const next = await $.prompt.submit({ text: 'fine, why?', origin: COMPOSER, wait: false })
  expect(next.context?.join('\n')).toMatch(/stopped your last turn by slapping/)
  const after = await $.prompt.submit({ text: 'and now?', origin: COMPOSER, wait: false })
  expect(after.context).toBeUndefined()
})

test('tell mode lets the turn run and still tells Claude', { options: { onSlap: 'tell' } }, async ($, on) => {
  const { clock, aborted } = world(on, says(READY, LEADER), says(HARD_SLAP))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'rewrite everything', turnId: 'turn-1' })
  await clock.advance(SLAP_DELAY_MS)

  expect(aborted).toEqual([])
  const next = await $.prompt.submit({ text: 'hello', origin: COMPOSER, wait: false })
  expect(next.context?.join('\n')).toMatch(/slapped their MacBook 1 time since/)
})

test('a slap felt while the bonk plays is its echo, not a second slap', async ($, on) => {
  const { clock, played } = world(on, says(READY, LEADER, HARD_SLAP, HARD_SLAP))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect(played.length).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /this session/ }))?.text).toBe('1 slap this session')
  await ui.unmount()
})

test('only the session holding the sound lock plays', async ($, on) => {
  const { clock, played } = world(on, says(READY, HARD_SLAP))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect(played).toEqual([])
})

test('a Mac without the sensor says so in the pane', async ($, on) => {
  const { clock } = world(on, says(NO_SENSOR))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /no motion sensor/ })).toBeDefined()
    await ui.unmount()
  }
})

describe('format', () => {
  test('lines are split whole across pieces', async () => {
    const lines = lineSplitter()
    expect(lines('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(lines(':2}\n')).toEqual(['{"b":2}'])
  })

  test('the meter and sparkline fit their width', async () => {
    expect(meter(0.5, 10).length).toBe(10)
    expect(meter(0, 10)).toBe('░'.repeat(10))
    expect(sparkline([0.001, 0.1, 2], 2)).toBe('▅█')
  })

  test('strength reads as light, solid or hard', async () => {
    expect([0.1, 0.5, 0.9].map(strengthOf)).toEqual(['light', 'solid', 'hard'])
    expect(slapNote({ count: 2, hardest: 0.5, didStop: false })).toMatch(/2 times since your last message, the hardest a solid one/)
  })
})
