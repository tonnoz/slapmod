// The motion helper's life: started with the session at this load's
// threshold, read line by line, and gone with the module.

import type { EngineInterface } from 'claude-code'

import { levelToThreshold, lineSplitter, parseEvent } from './format'
import type { HelperEvent } from './format'
import { HELPER, PANE, live, pushLevel, raiseTotal, setSensor, settings } from './state'
import { TOTAL_KEY, checkSlapMac, findConfigKeys, flushSettings, prepareVoices, reconcileDial, slapped } from './actions'

const LEVEL_HZ = 10
const RESTART_DELAYS_MS = [1_000, 5_000, 30_000]
const STEADY_RUN_MS = 60_000
const SLAPMAC_CHECK_MS = 30_000
const THRESHOLD_DIGITS = 3

type Ended = 'exited' | 'unstartable' | 'unsupported'

function wait($: EngineInterface, ms: number): Promise<void> {
  return new Promise(resolve => {
    $.clock.after(ms, resolve)
  })
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
  void checkSlapMac($)
  $.clock.every(SLAPMAC_CHECK_MS, () => void checkSlapMac($))
  // Settings a reload cut short are finished now; this may reload again.
  const refusal = await flushSettings($)
  if (refusal !== undefined) $.ui.toast(`slapmod: ${refusal}`)
}
