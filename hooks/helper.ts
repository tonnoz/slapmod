// The motion helper's life: started with the session at this load's
// threshold, read line by line, and gone with the module. While SlapMac
// listens, its bridge runs in the helper's place and SlapMac does the
// detecting and the sounds; when it stops, the helper takes over again.

import type { EngineInterface } from 'claude-code'

import { BRIDGE_PROTOCOL, NO_SLAPMAC, levelToThreshold, lineSplitter, parseEvent } from './format'
import type { HelperEvent } from './format'
import { HELPER, PANE, live, pushLevel, raiseTotal, setSensor, settings } from './state'
import {
  TOTAL_KEY,
  checkSlapMac,
  findConfigKeys,
  flushSettings,
  isBridged,
  prepareVoices,
  reconcileDial,
  setLink,
  slapped,
} from './actions'

const LEVEL_HZ = 10
const RESTART_DELAYS_MS = [1_000, 5_000, 30_000]
const STEADY_RUN_MS = 60_000
const SLAPMAC_CHECK_MS = 15_000
const THRESHOLD_DIGITS = 3
/** A bridge that ends this many times in a row before it's ready is left alone for this load. */
const MAX_BRIDGE_FAILURES = 3

type Ended = 'exited' | 'unstartable' | 'unsupported' | 'switched'
/** How a bridge stream ended: SlapMac's reason when it gave one. */
type BridgeEnd = { isReady: boolean; isBroken: boolean; reason: string | undefined }

function wait($: EngineInterface, ms: number): Promise<void> {
  return new Promise(resolve => {
    $.clock.after(ms, resolve)
  })
}

async function handle($: EngineInterface, event: HelperEvent): Promise<void> {
  switch (event.type) {
    case 'ready':
      await setSensor($, { status: 'ready', model: event.model })
      if (event.voices !== undefined && event.threshold !== undefined) {
        await setLink($, { mode: 'linked', voices: event.voices, threshold: event.threshold })
      }
      return
    case 'settings':
      await setLink($, { mode: 'linked', voices: event.voices, threshold: event.threshold })
      return
    case 'leader':
      live.isSoundLeader = true
      return
    case 'level':
      if (live.isPaneOpen) await pushLevel($, event.g)
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
  await setSensor($, { status: 'starting' })
  const child = $.process.spawn({
    argv: [
      `${$.plugin.root}/${HELPER}`,
      '--threshold',
      levelToThreshold(settings.level).toFixed(THRESHOLD_DIGITS),
      '--level-hz',
      String(LEVEL_HZ),
    ],
  })
  const lines = lineSplitter()
  let hasStarted = false
  let ended: Ended = 'exited'
  try {
    for await (const { stream, text } of child) {
      hasStarted = true
      // SlapMac started listening: leaving the loop ends the helper, and its bridge takes over.
      if (isBridged()) {
        ended = 'switched'
        break
      }
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

/** Streams SlapMac's slaps through its bridge until SlapMac stops listening or quits. */
async function runBridge($: EngineInterface, bridge: string): Promise<BridgeEnd> {
  await setSensor($, { status: 'starting' })
  const child = $.process.spawn({ argv: [bridge, 'stream', '--level-hz', String(LEVEL_HZ)] })
  const lines = lineSplitter()
  const end: BridgeEnd = { isReady: false, isBroken: false, reason: undefined }
  try {
    stream: for await (const { stream, text } of child) {
      if (stream !== 'stdout') continue
      for (const line of lines(text)) {
        const event = parseEvent(line)
        if (event === undefined) continue
        if ((event as { protocol?: unknown }).protocol !== BRIDGE_PROTOCOL) {
          // A SlapMac newer than this mod: its lines can't be trusted to mean the same.
          end.isBroken = true
          break stream
        }
        if (event.type === 'error') {
          end.reason = event.message
          continue
        }
        if (event.type === 'ready') end.isReady = true
        await handle($, event)
      }
    }
  } catch {
    // It couldn't start: moved or deleted since it was found, so look for it again.
    if (!end.isReady) live.bridge = undefined
  }
  live.isSoundLeader = false

  return end
}

// Keeps the helper, or SlapMac's bridge, running for the session; it dies with the module.
async function watch($: EngineInterface): Promise<void> {
  let failures = 0
  let bridgeFailures = 0
  let hasFixedMode = false
  await checkSlapMac($)
  for (;;) {
    if (isBridged() && live.bridge !== undefined) {
      const end = await runBridge($, live.bridge)
      bridgeFailures = end.isReady ? 0 : bridgeFailures + 1
      if (end.isBroken || bridgeFailures >= MAX_BRIDGE_FAILURES) live.isBridgeBroken = true
      // Back to the mod's own helper and sounds until SlapMac listens again.
      await setLink($, end.reason === undefined || live.isBridgeBroken ? NO_SLAPMAC : { mode: 'idle', reason: end.reason })
      if (live.isBridgeBroken) void checkSlapMac($)
      continue
    }
    const startedAt = await $.clock.now()
    const ended = await runHelper($)
    if (ended === 'switched') continue
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
  }
}

/** Everything a load does once the session is up, a reload's included. */
export async function startSession($: EngineInterface): Promise<void> {
  live.isPaneOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  live.sessionId = await $.session.id().catch(() => '')
  const stored = Number((await $.store.get(TOTAL_KEY)) ?? 0)
  await raiseTotal($, stored)
  await findConfigKeys($)
  await reconcileDial($)
  void watch($)
  void prepareVoices($)
  $.clock.every(SLAPMAC_CHECK_MS, () => void checkSlapMac($))
  // Settings a reload cut short are finished now; this may reload again.
  const refusal = await flushSettings($)
  if (refusal !== undefined) $.ui.toast(`slapmod: ${refusal}`)
}
