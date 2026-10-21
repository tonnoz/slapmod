// The mod's state, and the one file that reads and writes it: the loader
// accepts `$.state` sources declared in the file that uses them.
//
// Atoms hold what a drawing reads or what must survive a hot reload, which
// every settings change causes; `settings` and `live` are the module's own and
// start over with it.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Timer } from 'claude-code'

import { DEFAULT_SETTINGS, GESTURE_START, HISTORY_LENGTH, NOTHING_PENDING } from './format'
import type { EchoGuard, GestureState, Pending, SettingField, Settings } from './format'
import type { LastSlap, Sensor } from '../types'

export const PANE = 'slapmod'
export const HELPER = 'native/slapsense'
export const PANE_PADDING = 1

export type View = 'meter' | 'settings'
/** A voice line made ahead of time: a WAV's bytes, and how long it plays. */
export type VoiceClip = { base64: string; ms: number }

const sensor = atom({ plugin: 'slapmod', key: 'sensor' } as const, { status: 'starting' })
const levels = atom({ plugin: 'slapmod', key: 'levels' } as const, [])
const slaps = atom({ plugin: 'slapmod', key: 'slaps' } as const, 0)
const total = atom({ plugin: 'slapmod', key: 'total' } as const, 0)
const last = atom({ plugin: 'slapmod', key: 'last' } as const, null)
const slapMacRunning = atom({ plugin: 'slapmod', key: 'slapMacRunning' } as const, false)
const jolt = atom({ plugin: 'slapmod', key: 'jolt' } as const, PANE_PADDING)
const view = atom({ plugin: 'slapmod', key: 'view' } as const, 'meter')
const dial = atom({ plugin: 'slapmod', key: 'dial' } as const, null)
const runningTurn = atom({ plugin: 'slapmod', key: 'runningTurn' } as const, null)
const pending = atom({ plugin: 'slapmod', key: 'pending' } as const, NOTHING_PENDING)

/** The settings this load was given; a change to them reloads the module. */
export const settings: Settings = { ...DEFAULT_SETTINGS }

export const live: {
  isPaneOpen: boolean
  isSoundLeader: boolean
  isSlapMacRunning: boolean
  sessionId: string
  configKeys: Partial<Record<SettingField, string>>
  guard: EchoGuard | undefined
  gesture: GestureState
  firstStrength: number
  lastSentAt: number
  dialTimer: Timer | undefined
  /** The voice lines made ahead of time, by their place in VOICE_LINES. */
  voices: (VoiceClip | undefined)[]
  lastVoice: number
  lastWhip: number
} = {
  isPaneOpen: false,
  isSoundLeader: false,
  isSlapMacRunning: false,
  sessionId: '',
  configKeys: {},
  guard: undefined,
  gesture: GESTURE_START,
  firstStrength: 0,
  lastSentAt: -Infinity,
  dialTimer: undefined,
  voices: [],
  lastVoice: -1,
  lastWhip: -1,
}

export function readSensor($: EngineInterface): Promise<Sensor> {
  return read($, sensor)
}

export function setSensor($: EngineInterface, next: Sensor): Promise<Sensor> {
  return update($, sensor, () => next)
}

export function readLevels($: EngineInterface): Promise<number[]> {
  return read($, levels)
}

export function pushLevel($: EngineInterface, g: number): Promise<number[]> {
  return update($, levels, list => [...(list ?? []), g].slice(-HISTORY_LENGTH))
}

export function readSlaps($: EngineInterface): Promise<number> {
  return read($, slaps)
}

export function countSlap($: EngineInterface): Promise<number> {
  return update($, slaps, n => (n ?? 0) + 1)
}

export function readTotal($: EngineInterface): Promise<number> {
  return read($, total)
}

export function addToTotal($: EngineInterface): Promise<number> {
  return update($, total, n => (n ?? 0) + 1)
}

/** Brings the all-time count up to what the store kept from earlier sessions. */
export function raiseTotal($: EngineInterface, stored: number): Promise<number> {
  return update($, total, n => Math.max(n ?? 0, stored))
}

export function readLast($: EngineInterface): Promise<LastSlap | null> {
  return read($, last)
}

export function setLast($: EngineInterface, slap: LastSlap): Promise<LastSlap | null> {
  return update($, last, () => slap)
}

export function readSlapMacRunning($: EngineInterface): Promise<boolean> {
  return read($, slapMacRunning)
}

export function setSlapMacRunning($: EngineInterface, isRunning: boolean): Promise<boolean> {
  return update($, slapMacRunning, () => isRunning)
}

export function readJolt($: EngineInterface): Promise<number> {
  return read($, jolt)
}

export function setJolt($: EngineInterface, offset: number): Promise<number> {
  return update($, jolt, () => offset)
}

export function readView($: EngineInterface): Promise<View> {
  return read($, view)
}

export function setView($: EngineInterface, page: View): Promise<View> {
  return update($, view, () => page)
}

export function readDial($: EngineInterface): Promise<number | null> {
  return read($, dial)
}

export function setDial($: EngineInterface, change: (draft: number | null) => number | null): Promise<number | null> {
  return update($, dial, draft => change(draft ?? null))
}

export function readRunningTurn($: EngineInterface): Promise<string | null> {
  return read($, runningTurn)
}

export function setRunningTurn($: EngineInterface, turnId: string | null): Promise<string | null> {
  return update($, runningTurn, () => turnId)
}

/** Forgets the running turn once it ends, unless another has started since. */
export function endRunningTurn($: EngineInterface, turnId: string): Promise<string | null> {
  return update($, runningTurn, current => (current === turnId ? null : (current ?? null)))
}

export function readPending($: EngineInterface): Promise<Pending> {
  return read($, pending)
}

export function setPending($: EngineInterface, change: (was: Pending) => Pending): Promise<Pending> {
  return update($, pending, was => change(was ?? NOTHING_PENDING))
}
