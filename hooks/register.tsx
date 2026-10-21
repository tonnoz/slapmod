import type { Register } from 'claude-code'

import { cleanText, readSettings } from './format'
import { live, setRunningTurn, settings } from './state'
import { clearTurn, markActive, runSlapCommand, takePending } from './actions'
import { startSession } from './helper'
import { renderPane } from './pane'

// Literals in this file, so the loader can read what each hook matches.
const PANE = 'slapmod'
const COMMAND = 'slap'
/** A slap's command or prompt, as the person types it in /config. */
const TEXT_KEY = /^slapmod(@[^.]+)?\.(slapText|doubleSlapText)$/
const RUNS_ITSELF = /^\/?slap(\s|$)/

export const register: Register = (on, options) => {
  Object.assign(settings, readSettings(options))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the slapmod meter, or /slap settings to tune it',
      argumentHint: '[settings|status|test|sensitivity 1-10|on|double <action> [text]|sound <sound>]',
      immediate: true,
    })
    const started = await next(e)
    await startSession($)

    return started
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await setRunningTurn($, e.turnId)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await clearTurn($, e.turnId)

    return next(e)
  })

  // Claude hears about the slaps it missed with the next prompt, once.
  on('prompt.submit', async ($, e, next) => {
    void markActive($, e.origin.kind)
    if (e.command !== undefined || e.isMeta) return next(e)
    const note = await takePending($)

    return note === undefined ? next(e) : next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('command.run', { command: COMMAND }, ($, e) => runSlapCommand($, e.args))

  // The text a slap runs or sends, typed in /config: tidied, and never /slap itself.
  on('config.set', ($, e, next) => {
    if (!TEXT_KEY.test(e.key) || typeof e.value !== 'string') return next(e)
    const text = cleanText(e.value)
    if (RUNS_ITSELF.test(text)) return { deny: "A slap can't run /slap itself." }

    return next({ ...e, value: text })
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    live.isPaneOpen = false

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => renderPane($, e))
}
