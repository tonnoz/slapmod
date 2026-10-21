import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Sensor } from '../types'
import {
  HISTORY_LENGTH,
  NOTHING_PENDING,
  lineSplitter,
  meter,
  parseEvent,
  plural,
  slapNote,
  sparkline,
  strengthOf,
} from './format'
import type { HelperEvent, Pending, Strength } from './format'

const PANE = 'slapmod'
const COMMAND = 'slap'
const HELPER = 'native/slapsense'
const LEVEL_HZ = 10
const RESTART_DELAYS_MS = [1_000, 5_000, 30_000]
const STEADY_RUN_MS = 60_000
const BONK_GUARD_MS = 600
const VOICE_GUARD_MS = 1_200
const BASE_GAIN = 0.6
const STRENGTH_GAIN = 0.6
const TOAST_MS = 1_500
const STOP_TOAST_MS = 3_000
const TEST_STRENGTH = 0.5
const PANE_PADDING = 1
const JOLT_FRAMES = [3, 0, 2, PANE_PADDING]
const JOLT_FRAME_MS = 50
const METER_LABEL_WIDTH = 8
const MIN_WIDTH = 8
const TOTAL_KEY = 'totalSlaps'
const SLAPMAC_PROCESS = 'slapmac'
const SLAPMAC_CHECK_MS = 30_000

const ON_SLAP = ['stop', 'tell', 'off'] as const
const SOUNDS = ['bonk', 'voice', 'off'] as const
const SENSITIVITIES = ['low', 'medium', 'high'] as const
type OnSlap = (typeof ON_SLAP)[number]
type Sound = (typeof SOUNDS)[number]
type Sensitivity = (typeof SENSITIVITIES)[number]

const CLIPS: Record<Strength, string> = {
  light: 'sounds/bonk-light.wav',
  solid: 'sounds/bonk.wav',
  hard: 'sounds/bonk-hard.wav',
}
const VOICE_LINES: Record<Strength, string> = { light: 'Hey.', solid: 'Ow!', hard: 'Ouch! Rude.' }
const ON_SLAP_TEXT: Record<OnSlap, string> = {
  stop: 'Claude stops and hears about it',
  tell: 'Claude hears about it',
  off: 'nothing reaches Claude',
}

const sensor = atom({ plugin: 'slapmod', key: 'sensor' } as const, { status: 'starting' })
const levels = atom({ plugin: 'slapmod', key: 'levels' } as const, [])
const slaps = atom({ plugin: 'slapmod', key: 'slaps' } as const, 0)
const total = atom({ plugin: 'slapmod', key: 'total' } as const, 0)
const last = atom({ plugin: 'slapmod', key: 'last' } as const, null)
const slapMacRunning = atom({ plugin: 'slapmod', key: 'slapMacRunning' } as const, false)
const jolt = atom({ plugin: 'slapmod', key: 'jolt' } as const, PANE_PADDING)

type Ended = 'exited' | 'unstartable' | 'unsupported'

// What the module tracks between events; a reload starts it over.
const settings: { onSlap: OnSlap; sound: Sound; sensitivity: Sensitivity } = {
  onSlap: 'stop',
  sound: 'bonk',
  sensitivity: 'medium',
}
const live: {
  runningTurn: string | undefined
  pending: Pending
  isPaneOpen: boolean
  isSoundLeader: boolean
  isSlapMacRunning: boolean
  quietUntil: number
} = {
  runningTurn: undefined,
  pending: NOTHING_PENDING,
  isPaneOpen: false,
  isSoundLeader: false,
  isSlapMacRunning: false,
  quietUntil: 0,
}

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find(one => one === value) ?? fallback
}

function wait($: EngineInterface, ms: number): Promise<void> {
  return new Promise(resolve => {
    $.clock.after(ms, resolve)
  })
}

async function play($: EngineInterface, strength: number): Promise<void> {
  const kind = strengthOf(strength)
  const now = await $.clock.now()
  if (settings.sound === 'bonk') {
    live.quietUntil = now + BONK_GUARD_MS
    await $.audio.play({ asset: CLIPS[kind] }, { gain: BASE_GAIN + STRENGTH_GAIN * strength })
  }
  if (settings.sound === 'voice') {
    live.quietUntil = now + VOICE_GUARD_MS
    await $.audio.speak(VOICE_LINES[kind])
  }
}

function setSensor($: EngineInterface, next: Sensor): Promise<Sensor> {
  return update($, sensor, () => next)
}

function joltPane($: EngineInterface): void {
  JOLT_FRAMES.forEach((offset, frame) => {
    $.clock.after(frame * JOLT_FRAME_MS, () => void update($, jolt, () => offset))
  })
}

async function stopTurn($: EngineInterface): Promise<boolean> {
  const turnId = live.runningTurn
  if (turnId === undefined) return false
  live.runningTurn = undefined

  return $.turn.abort({ turnId }).then(
    () => true,
    () => false,
  )
}

async function slapped($: EngineInterface, g: number, strength: number): Promise<void> {
  // Our own bonk shakes the case too: a slap felt while it plays is the echo.
  if ((await $.clock.now()) < live.quietUntil) return

  const count = await update($, slaps, n => (n ?? 0) + 1)
  const all = await update($, total, n => (n ?? 0) + 1)
  await update($, last, () => ({ g, strength }))
  void $.store.set(TOTAL_KEY, all)
  $.ui.status(`👋 ${plural(count, 'slap', 'slaps')}`)
  if (live.isPaneOpen) joltPane($)
  // One session plays per slap, and none while SlapMac does the voices.
  if (live.isSoundLeader && !live.isSlapMacRunning) void play($, strength).catch(() => undefined)

  if (settings.onSlap !== 'off') {
    const { pending } = live
    live.pending = { ...pending, count: pending.count + 1, hardest: Math.max(pending.hardest, strength) }
  }
  if (settings.onSlap === 'stop' && (await stopTurn($))) {
    live.pending = { ...live.pending, didStop: true }
    $.ui.toast('Slap! Claude stopped.', { timeoutMs: STOP_TOAST_MS })
    return
  }
  if (!live.isPaneOpen) $.ui.toast(`👋 A ${strengthOf(strength)} slap`, { timeoutMs: TOAST_MS })
}

async function handle($: EngineInterface, event: HelperEvent): Promise<void> {
  switch (event.type) {
    case 'ready':
      await setSensor($, { status: 'ready', model: event.model })
      return
    case 'leader':
      live.isSoundLeader = true
      return
    case 'level':
      if (live.isPaneOpen) await update($, levels, list => [...(list ?? []), event.g].slice(-HISTORY_LENGTH))
      return
    case 'slap':
      await slapped($, event.g, event.strength)
      return
    case 'error':
      await setSensor($, { status: 'stopped', reason: event.message })
      if (event.code === 'no-sensor') $.ui.toast(`slapmod: ${event.message}`)
      return
  }
}

async function runHelper($: EngineInterface): Promise<Ended> {
  const child = $.process.spawn({
    argv: [`${$.plugin.root}/${HELPER}`, '--sensitivity', settings.sensitivity, '--level-hz', String(LEVEL_HZ)],
  })
  const lines = lineSplitter()
  let hasStarted = false
  let ended: Ended = 'exited'
  try {
    for await (const { stream, text } of child) {
      hasStarted = true
      if (stream !== 'stdout') continue
      for (const line of lines(text)) {
        const event = parseEvent(line)
        if (event === undefined) continue
        if (event.type === 'error' && event.code === 'no-sensor') ended = 'unsupported'
        await handle($, event)
      }
    }
  } catch {
    if (!hasStarted) return 'unstartable'
  }
  live.isSoundLeader = false

  return ended
}

// Keeps the helper running for the session; it dies with the module.
async function watch($: EngineInterface): Promise<void> {
  let failures = 0
  let hasFixedMode = false
  for (;;) {
    const startedAt = await $.clock.now()
    const ended = await runHelper($)
    if (ended === 'unsupported') return
    if (ended === 'unstartable') {
      // An install can drop the executable bit; put it back once.
      if (!hasFixedMode) {
        hasFixedMode = true
        await $.process.run(['/bin/chmod', '+x', `${$.plugin.root}/${HELPER}`]).catch(() => undefined)
        continue
      }
      await setSensor($, {
        status: 'stopped',
        reason: "Couldn't start the motion helper. slapmod needs an Apple Silicon MacBook.",
      })
      return
    }
    if ((await $.clock.now()) - startedAt > STEADY_RUN_MS) failures = 0
    const delay = RESTART_DELAYS_MS[failures]
    failures += 1
    if (delay === undefined) {
      await setSensor($, { status: 'stopped', reason: 'The motion helper keeps stopping.' })
      return
    }
    await wait($, delay)
    await setSensor($, { status: 'starting' })
  }
}

// SlapMac plays its own sounds on a slap, so while it runs this mod stays quiet.
async function checkSlapMac($: EngineInterface): Promise<void> {
  const isRunning = await $.process.run(['/usr/bin/pgrep', '-x', SLAPMAC_PROCESS]).then(
    result => result.exitCode === 0,
    () => false,
  )
  if (isRunning === live.isSlapMacRunning) return
  live.isSlapMacRunning = isRunning
  await update($, slapMacRunning, () => isRunning)
}

export const register: Register = (on, options) => {
  settings.onSlap = choice(options.onSlap, ON_SLAP, 'stop')
  settings.sound = choice(options.sound, SOUNDS, 'bonk')
  settings.sensitivity = choice(options.sensitivity, SENSITIVITIES, 'medium')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the slapmod meter, or /slap test for a sound',
      argumentHint: '[test]',
      immediate: true,
    })
    const started = await next(e)

    live.isPaneOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    const stored = Number((await $.store.get(TOTAL_KEY)) ?? 0)
    await update($, total, n => Math.max(n ?? 0, stored))
    void watch($)
    void checkSlapMac($)
    $.clock.every(SLAPMAC_CHECK_MS, () => void checkSlapMac($))

    return started
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) live.runningTurn = e.turnId

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined && e.turnId === live.runningTurn) live.runningTurn = undefined

    return next(e)
  })

  // Claude hears about the slaps it missed with the next prompt, once.
  on('prompt.submit', ($, e, next) => {
    const { pending } = live
    if (settings.onSlap === 'off' || pending.count === 0 || e.command !== undefined || e.isMeta) return next(e)
    live.pending = NOTHING_PENDING

    return next({ ...e, context: [...(e.context ?? []), slapNote(pending)] })
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim() === 'test') {
      if (settings.sound === 'off') return { text: 'Sounds are off. Turn them on in /config.' }
      await play($, TEST_STRENGTH)

      return { text: 'Bonk.' }
    }
    if (live.isPaneOpen) {
      await $.ui.close({ id: PANE })

      return {}
    }
    const opened = await $.ui.open({ id: PANE, title: 'slapmod' })
    live.isPaneOpen = true

    return opened.isPlaced ? {} : { text: `The slapmod pane is waiting for room (${opened.reason}).` }
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    live.isPaneOpen = false

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const state = await read($, sensor)
    const history = await read($, levels)
    const count = await read($, slaps)
    const all = await read($, total)
    const latest = await read($, last)
    const isSlapMacOn = await read($, slapMacRunning)
    const offset = await read($, jolt)
    const width = Math.max(MIN_WIDTH, e.props.bodyColumns - offset - PANE_PADDING)
    const level = history.at(-1) ?? 0

    return (
      <Box flexDirection="column" paddingLeft={offset}>
        {state.status === 'starting' && <Text dimColor>Waking the motion sensor...</Text>}
        {state.status === 'stopped' && <Text color="warning">{state.reason}</Text>}
        {state.status === 'ready' && (
          <Text color="claude">{history.length > 0 ? sparkline(history, width) : 'Listening...'}</Text>
        )}
        {state.status === 'ready' && (
          <Text>
            {meter(level, width - METER_LABEL_WIDTH)} {level.toFixed(2)} g
          </Text>
        )}
        <Box gap={1}>
          <Text bold>{plural(count, 'slap', 'slaps')} this session</Text>
          <Text dimColor>({all} all time)</Text>
        </Box>
        {latest !== null && (
          <Text dimColor>
            Last one: {strengthOf(latest.strength)}, {latest.g.toFixed(2)} g
          </Text>
        )}
        <Text dimColor>On slap: {ON_SLAP_TEXT[settings.onSlap]}. Change it in /config.</Text>
        {isSlapMacOn && <Text dimColor>SlapMac is running, so it plays the sounds.</Text>}
        <Box marginTop={1}>
          <Button key="test" label="Test sound" onPress={() => void play($, TEST_STRENGTH)} />
        </Box>
      </Box>
    )
  })
}
