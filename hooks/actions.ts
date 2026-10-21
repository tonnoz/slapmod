// What a slap does, and how settings are written. Every function here takes
// `$` from a hook, so each is declared at the top level, as the loader asks.

import type { CommandRunResult, EngineInterface } from 'claude-code'

import {
  GESTURE_FIELDS,
  MAX_LEVEL,
  NOTHING_PENDING,
  SEND_MIN_STRENGTH,
  SETTING_FIELDS,
  VOICE_LINES,
  bridgeCandidates,
  canSend,
  cleanText,
  describeSettings,
  gesture,
  isEcho,
  isSameLink,
  linkFromStatus,
  parseCommandText,
  parseSlapArgs,
  pickOther,
  playRefusal,
  playsOwnSounds,
  plural,
  settingValue,
  slapNote,
  strengthOf,
  textRefusal,
} from './format'
import { NO_SLAPMAC } from './format'
import type { Action, Gesture, GestureEffect, SettingField, SettingWrite, Strength } from './format'
import type { SlapMacLink } from '../types'
import {
  PANE,
  PANE_PADDING,
  addToTotal,
  countSlap,
  endRunningTurn,
  live,
  readDial,
  readPending,
  readRunningTurn,
  readSlapMac,
  setDial,
  setJolt,
  setLast,
  setPending,
  setRunningTurn,
  setSlapMac,
  setView,
  settings,
} from './state'

export const TOTAL_KEY = 'totalSlaps'
const ACTIVE_KEY = 'activeSession'
const PENDING_WRITES_KEY = 'pendingWrites'
const MAX_WRITE_TRIES = 3
const DIAL_COMMIT_MS = 600
const ECHO_TAIL_MS = 150
const VOICE_GUARD_MS = 1_200
const VOICE_MIME = 'audio/wav'
const VOICE_FORMAT = ['--file-format=WAVE', '--data-format=LEI16@22050']
const VOICE_BYTES_PER_SECOND = 22_050 * 2
const WAV_HEADER_BYTES = 44
const BASE64_BYTES_PER_CHAR = 3 / 4
const FALLBACK_TMPDIR = '/tmp/'
const BASE_GAIN = 0.6
const STRENGTH_GAIN = 0.6
const TOAST_MS = 1_500
const STOP_TOAST_MS = 3_000
const TEST_STRENGTH = 0.5
const JOLT_FRAMES = [3, 0, 2, PANE_PADDING]
const JOLT_FRAME_MS = 50
const SETTINGS_ROWS = 20
const SLAPMAC_PROCESS = 'slapmac'
const SLAPMAC_QUERY = "kMDItemCFBundleIdentifier == 'com.tonnoz.slapmac'"
/** How often to look for SlapMac's bridge again while it can't be found. */
const BRIDGE_SEARCH_MS = 300_000
/** What a setting SlapMac takes over while it listens is called, for the note after saving it. */
const SLAPMAC_FIELDS: Partial<Record<SettingField, string>> = { sensitivity: 'the sensitivity', sound: 'the sound' }
/** Where a prompt the person typed comes from: the terminal, a remote client, the desktop app. */
const PERSON_ORIGINS = ['composer', 'bridge', 'sdk']

type Clip = { asset: string; ms: number }

/** The bonks, by how hard the slap was, with how long each plays. */
const BONKS: Record<Strength, Clip> = {
  light: { asset: 'sounds/bonk-light.wav', ms: 180 },
  solid: { asset: 'sounds/bonk.wav', ms: 280 },
  hard: { asset: 'sounds/bonk-hard.wav', ms: 450 },
}
/** Five whip cracks, played in turn at random; the slap's strength sets the volume. */
const WHIPS: readonly Clip[] = [
  { asset: 'sounds/whip-1.mp3', ms: 1_000 },
  { asset: 'sounds/whip-2.mp3', ms: 446 },
  { asset: 'sounds/whip-3.mp3', ms: 586 },
  { asset: 'sounds/whip-4.mp3', ms: 1_000 },
  { asset: 'sounds/whip-5.mp3', ms: 892 },
]
const GESTURE_NAMES: Record<Gesture, string> = { single: 'slap', double: 'double slap' }

type Queued = { writes: SettingWrite[]; tries: number }
type ActiveSession = { id: string; at: number }

function isQueued(value: unknown): value is Queued {
  return typeof value === 'object' && value !== null && 'writes' in value && Array.isArray(value.writes)
}

function isActiveSession(value: unknown): value is ActiveSession {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
}

export async function play($: EngineInterface, strength: number): Promise<void> {
  const kind = strengthOf(strength)
  const now = await $.clock.now()
  if (settings.sound === 'bonk' || settings.sound === 'whip') {
    const clip = settings.sound === 'bonk' ? BONKS[kind] : pickWhip()
    live.guard = { until: now + clip.ms + ECHO_TAIL_MS, strength }
    await $.audio.play({ asset: clip.asset }, { gain: BASE_GAIN + STRENGTH_GAIN * strength })
  }
  if (settings.sound === 'voice') {
    const line = pickOther(live.lastVoice, VOICE_LINES.length, Math.random())
    live.lastVoice = line
    const clip = live.voices[line]
    if (clip !== undefined) {
      live.guard = { until: now + clip.ms + ECHO_TAIL_MS, strength }
      await $.audio.play({ base64: clip.base64, mime: VOICE_MIME }, { gain: BASE_GAIN + STRENGTH_GAIN * strength })
      return
    }
    // Not made yet: speak it, which waits on the voice to load.
    live.guard = { until: now + VOICE_GUARD_MS, strength }
    await $.audio.speak(VOICE_LINES[line] ?? VOICE_LINES[0])
  }
}

/**
 * Makes the voice lines once, with the Mac's own voice, so a slap plays a file
 * as quickly as a bonk instead of waiting on `say` to load the voice.
 */
export async function prepareVoices($: EngineInterface): Promise<void> {
  if (settings.sound !== 'voice') return
  const tmp = (await $.env.get('TMPDIR').catch(() => undefined)) ?? FALLBACK_TMPDIR
  const dir = tmp.endsWith('/') ? tmp : `${tmp}/`
  for (const [line, text] of VOICE_LINES.entries()) {
    const path = `${dir}slapmod-voice-${live.sessionId === '' ? 'session' : live.sessionId}-${line}.wav`
    const isMade = await $.process.run(['/usr/bin/say', ...VOICE_FORMAT, '-o', path, text]).then(
      result => result.exitCode === 0,
      () => false,
    )
    if (!isMade) continue
    const clip = await $.fs.read(path, { as: 'bytes' }).catch(() => undefined)
    await $.process.run(['/bin/rm', '-f', path]).catch(() => undefined)
    if (clip !== undefined) live.voices[line] = { base64: clip.base64, ms: clipMs(clip.base64) }
  }
}

function clipMs(base64: string): number {
  const bytes = base64.length * BASE64_BYTES_PER_CHAR - WAV_HEADER_BYTES

  return Math.round((Math.max(0, bytes) / VOICE_BYTES_PER_SECOND) * 1_000)
}

function pickWhip(): Clip {
  live.lastWhip = pickOther(live.lastWhip, WHIPS.length, Math.random())

  return WHIPS[live.lastWhip] ?? BONKS.solid
}

/** Plays what a slap would: SlapMac's pack while it listens. Says how that went. */
export async function playTest($: EngineInterface): Promise<{ text: string; isPlayed: boolean }> {
  if (live.link.mode === 'linked' && live.bridge !== undefined) {
    const { voices } = live.link
    const result = await $.process.run([live.bridge, 'play', '--strength', String(TEST_STRENGTH)]).catch(() => undefined)
    const refusal = result === undefined ? "SlapMac didn't answer." : playRefusal(result.stdout)

    return refusal === undefined
      ? { text: `SlapMac played its ${voices} pack.`, isPlayed: true }
      : { text: `SlapMac: ${refusal}`, isPlayed: false }
  }
  if (settings.sound === 'off') return { text: 'Sounds are off. Turn them on in /slap settings.', isPlayed: false }
  await play($, TEST_STRENGTH).catch(() => undefined)

  return { text: 'Bonk.', isPlayed: true }
}

/** The pane's Test sound: quiet when it plays, a toast when it can't. */
export async function testSound($: EngineInterface): Promise<void> {
  const tested = await playTest($)
  if (!tested.isPlayed) $.ui.toast(tested.text)
}

function joltPane($: EngineInterface): void {
  JOLT_FRAMES.forEach((offset, frame) => {
    $.clock.after(frame * JOLT_FRAME_MS, () => void setJolt($, offset))
  })
}

export async function stopTurn($: EngineInterface): Promise<boolean> {
  const turnId = await readRunningTurn($)
  if (turnId === null) return false
  await setRunningTurn($, null)

  return $.turn.abort({ turnId }).then(
    () => true,
    () => false,
  )
}

export async function slapped($: EngineInterface, g: number, strength: number): Promise<void> {
  // Our own sound shakes the case too: a much weaker slap felt while it plays is the echo.
  const now = await $.clock.now()
  if (isEcho(now, live.guard, strength)) return

  const count = await countSlap($)
  const all = await addToTotal($)
  await setLast($, { g, strength })
  void $.store.set(TOTAL_KEY, all)
  $.ui.status(`👋 ${plural(count, 'slap', 'slaps')}`)
  if (live.isPaneOpen) {
    joltPane($)
  } else {
    $.ui.toast(`👋 A ${strengthOf(strength)} slap`, { timeoutMs: TOAST_MS })
  }
  // One session plays per slap, and none while SlapMac plays its own.
  if (live.isSoundLeader && playsOwnSounds(live.link)) void play($, strength).catch(() => undefined)

  if (settings.onSlap !== 'off' || settings.onDoubleSlap !== 'off') {
    await setPending($, was => ({ ...was, count: was.count + 1, hardest: Math.max(was.hardest, strength) }))
  }
  const next = gesture(live.gesture, { type: 'slap', at: now }, settings)
  live.gesture = next.state
  await applyEffects($, next.effects, strength)
}

async function applyEffects($: EngineInterface, effects: readonly GestureEffect[], strength: number): Promise<void> {
  for (const effect of effects) {
    if (effect.type === 'schedule') {
      live.firstStrength = strength
      $.clock.after(effect.inMs, () => void onDue($, effect.id))
      continue
    }
    await fire($, effect.gesture, effect.action, strength)
  }
}

async function onDue($: EngineInterface, id: number): Promise<void> {
  const next = gesture(live.gesture, { type: 'due', id }, settings)
  live.gesture = next.state
  await applyEffects($, next.effects, live.firstStrength)
}

async function fire($: EngineInterface, which: Gesture, action: Action, strength: number): Promise<void> {
  if (action === 'stop') {
    if (await stopTurn($)) {
      await setPending($, was => ({ ...was, didStop: true }))
      $.ui.toast('Slap! Claude stopped.', { timeoutMs: STOP_TOAST_MS })
    }
    return
  }
  if (action !== 'command' && action !== 'prompt') return

  const text = settings[GESTURE_FIELDS[which].text]
  if (text === '') {
    $.ui.toast(`Set what a ${GESTURE_NAMES[which]} ${action === 'command' ? 'runs' : 'sends'} in /slap settings.`)
    return
  }
  if (strength < SEND_MIN_STRENGTH) {
    $.ui.toast(`Slap harder to ${action === 'command' ? 'run it' : 'send it'}.`)
    return
  }
  const now = await $.clock.now()
  if (!canSend(now, live.lastSentAt)) {
    $.ui.toast('Easy. One every few seconds.')
    return
  }
  // Every open session feels the slap; only the one you typed in last acts.
  if (!(await isActiveHere($))) return
  live.lastSentAt = now
  if (action === 'command') {
    await runCommand($, text)
  } else {
    await sendPrompt($, text)
  }
}

async function isActiveHere($: EngineInterface): Promise<boolean> {
  const active = await $.store.get(ACTIVE_KEY).catch(() => undefined)

  return isActiveSession(active) ? active.id === live.sessionId : live.isSoundLeader
}

/** Remembers that the person typed in this session, the one a slap's command or prompt goes to. */
export async function markActive($: EngineInterface, originKind: string): Promise<void> {
  if (!PERSON_ORIGINS.includes(originKind) || live.sessionId === '') return
  const record: ActiveSession = { id: live.sessionId, at: await $.clock.now() }
  await $.store.set(ACTIVE_KEY, record).catch(() => undefined)
}

async function runCommand($: EngineInterface, text: string): Promise<void> {
  const parsed = parseCommandText(text)
  const refusal = textRefusal('command', text)
  if (parsed === undefined || refusal !== undefined) {
    $.ui.toast(`slapmod: ${refusal ?? 'that is not a command.'}`)
    return
  }
  const isKnown = await $.command.list().then(
    list => list.some(command => command.name === parsed.command),
    () => true,
  )
  if (!isKnown) {
    $.ui.toast(`slapmod: there's no /${parsed.command} command.`)
    return
  }
  $.ui.toast(`👋 Running /${parsed.command}`)
  // Runs once the session is idle, so never wait on it here.
  void $.command.run({ command: parsed.command, args: parsed.args }).catch(() => {
    $.ui.toast(`slapmod: /${parsed.command} didn't run.`)
  })
}

async function sendPrompt($: EngineInterface, text: string): Promise<void> {
  // This mod's own prompt hook never sees its own prompt, so the note rides in the text.
  const note = await takePending($)
  $.ui.toast('👋 Sending your slap prompt')
  // Starts a turn once the session is idle, so never wait on it here.
  void $.prompt.submit({ text: note === undefined ? text : `${text}\n\n[${note}]`, asUser: true }).catch(() => {
    $.ui.toast("slapmod: the prompt didn't go through.")
  })
}

/** The note about the slaps Claude missed, once, for the next prompt. */
export async function takePending($: EngineInterface): Promise<string | undefined> {
  if (settings.onSlap === 'off' && settings.onDoubleSlap === 'off') return undefined
  const was = await readPending($)
  if (was.count === 0) return undefined
  await setPending($, () => NOTHING_PENDING)

  return slapNote(was)
}

export async function clearTurn($: EngineInterface, turnId: string): Promise<void> {
  await endRunningTurn($, turnId)
}

export async function findConfigKeys($: EngineInterface): Promise<void> {
  const rows = await $.config.list().catch(() => [])
  for (const field of SETTING_FIELDS) {
    const pattern = new RegExp(`^slapmod(@[^.]+)?\\.${field}$`)
    const row = rows.find(one => pattern.test(one.key))
    if (row !== undefined) live.configKeys[field] = row.key
  }
}

/**
 * Writes settings through /config. Each write reloads the module, which may
 * cut the rest short, so the writes wait in the store and the next load
 * finishes them; a write already in force is skipped.
 */
export async function writeSettings($: EngineInterface, writes: readonly SettingWrite[]): Promise<string | undefined> {
  const due = writes.filter(write => settingValue(settings, write.field) !== write.value)
  if (due.length === 0) return undefined
  const queued: Queued = { writes: due, tries: 0 }
  await $.store.set(PENDING_WRITES_KEY, queued)

  return flushSettings($)
}

export async function flushSettings($: EngineInterface): Promise<string | undefined> {
  const queued = await $.store.get(PENDING_WRITES_KEY).catch(() => undefined)
  if (!isQueued(queued)) return undefined
  const remaining = queued.writes.filter(write => settingValue(settings, write.field) !== write.value)
  if (remaining.length === 0 || queued.tries >= MAX_WRITE_TRIES) {
    await $.store.delete(PENDING_WRITES_KEY)
    return remaining.length === 0 ? undefined : "Couldn't save that setting."
  }
  const next: Queued = { writes: remaining, tries: queued.tries + 1 }
  await $.store.set(PENDING_WRITES_KEY, next)
  for (const write of remaining) {
    const key = live.configKeys[write.field] ?? `slapmod.${write.field}`
    const result = await $.config.set({ key, value: write.value }).catch((error: unknown) => ({
      deny: error instanceof Error ? error.message : "Couldn't save that setting.",
    }))
    if (result.deny !== undefined) {
      await $.store.delete(PENDING_WRITES_KEY)
      return result.deny
    }
  }
  await $.store.delete(PENDING_WRITES_KEY)

  return undefined
}

export async function saveSetting($: EngineInterface, field: SettingField, value: string): Promise<void> {
  const refusal = await writeSettings($, [{ field, value }])
  if (refusal !== undefined) $.ui.toast(`slapmod: ${refusal}`)
}

export async function saveText($: EngineInterface, which: Gesture, value: string): Promise<void> {
  const fields = GESTURE_FIELDS[which]
  const text = cleanText(value)
  const refusal = textRefusal(settings[fields.action], text)
  if (refusal !== undefined) {
    $.ui.toast(refusal)
    return
  }
  await saveSetting($, fields.text, text)
}

export async function nudgeDial($: EngineInterface, delta: number): Promise<void> {
  await setDial($, draft => Math.min(MAX_LEVEL, Math.max(1, (draft ?? settings.level) + delta)))
  // Saving reloads the module: wait for the presses to stop, then save once.
  live.dialTimer?.cancel()
  live.dialTimer = $.clock.after(DIAL_COMMIT_MS, () => void commitDial($))
}

async function commitDial($: EngineInterface): Promise<void> {
  live.dialTimer = undefined
  const level = await readDial($)
  if (level === null) return
  if (level === settings.level) {
    await setDial($, () => null)
    return
  }
  const refusal = await writeSettings($, [{ field: 'sensitivity', value: String(level) }])
  if (refusal !== undefined) {
    $.ui.toast(`slapmod: ${refusal}`)
    await setDial($, () => null)
  }
}

/** After a reload, the dial either shows the saved level or still has a change to save. */
export async function reconcileDial($: EngineInterface): Promise<void> {
  const level = await readDial($)
  if (level === null) return
  if (level === settings.level) {
    await setDial($, () => null)
    return
  }
  live.dialTimer = $.clock.after(DIAL_COMMIT_MS, () => void commitDial($))
}

/**
 * Asks SlapMac whether it detects and voices the slaps. A SlapMac with the
 * bridge answers for itself; an older one is only seen running, and plays its
 * own sounds either way. Skipped while the bridge streams: the stream says
 * when that ends.
 */
export async function checkSlapMac($: EngineInterface): Promise<void> {
  if (live.isCheckingSlapMac || live.link.mode === 'linked') return
  live.isCheckingSlapMac = true
  try {
    await setLink($, await askSlapMac($))
  } finally {
    live.isCheckingSlapMac = false
  }
}

/** Sets where SlapMac stands. The atom outlives a reload and this load's copy doesn't, so the atom is what's compared. */
export async function setLink($: EngineInterface, link: SlapMacLink): Promise<void> {
  live.link = link
  if (isSameLink(link, await readSlapMac($))) return
  await setSlapMac($, link)
}

/** Whether SlapMac's bridge runs in the helper's place. */
export function isBridged(): boolean {
  return live.link.mode === 'linked' && live.bridge !== undefined
}

async function askSlapMac($: EngineInterface): Promise<SlapMacLink> {
  const bridge = await findBridge($)
  if (bridge !== undefined) {
    const result = await $.process.run([bridge, 'status']).catch(() => undefined)
    // Gone since it was found: look again next time.
    if (result === undefined) live.bridge = undefined
    const link = result === undefined ? undefined : linkFromStatus(result.stdout)
    if (link !== undefined) return link
  }
  const isRunning = await $.process.run(['/usr/bin/pgrep', '-x', SLAPMAC_PROCESS]).then(
    result => result.exitCode === 0,
    () => false,
  )

  return isRunning ? { mode: 'legacy' } : NO_SLAPMAC
}

/** Finds SlapMac's bridge: the app folders first, then Spotlight, every few minutes until it turns up. */
async function findBridge($: EngineInterface): Promise<string | undefined> {
  if (live.isBridgeBroken) return undefined
  if (live.bridge !== undefined) return live.bridge
  const now = await $.clock.now()
  if (now - live.bridgeSearchedAt < BRIDGE_SEARCH_MS) return undefined
  live.bridgeSearchedAt = now
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  for (const spotlight of [false, true]) {
    const found = spotlight
      ? await $.process.run(['/usr/bin/mdfind', SLAPMAC_QUERY]).then(
          result => result.stdout,
          () => '',
        )
      : ''
    for (const path of bridgeCandidates(home, found)) {
      if (await $.fs.exists(path).catch(() => false)) {
        live.bridge = path
        return path
      }
    }
  }

  return undefined
}

export async function openPane($: EngineInterface, page: 'meter' | 'settings'): Promise<CommandRunResult> {
  await setView($, page)
  // The settings page takes the keyboard, so Tab walks its buttons and Esc goes back to the prompt.
  const opened = await $.ui.open({
    id: PANE,
    title: 'slapmod',
    ...(page === 'settings' ? { rows: SETTINGS_ROWS, focus: true } : {}),
  })
  live.isPaneOpen = true

  return opened.isPlaced ? {} : { text: `The slapmod pane is waiting for room (${opened.reason}).` }
}

export async function runSlapCommand($: EngineInterface, args: string): Promise<CommandRunResult> {
  const parsed = parseSlapArgs(args)
  switch (parsed.kind) {
    case 'toggle':
      if (live.isPaneOpen) {
        await $.ui.close({ id: PANE })
        return {}
      }
      return openPane($, 'meter')
    case 'settings':
      return openPane($, 'settings')
    case 'status':
      return { text: describeSettings(settings, live.link) }
    case 'test':
      return { text: (await playTest($)).text }
    case 'error':
      return { text: parsed.message }
    case 'set': {
      const refusal = await writeSettings($, parsed.writes)
      if (refusal !== undefined) return { text: refusal }
      const takenOver = parsed.writes.map(write => SLAPMAC_FIELDS[write.field]).find(name => name !== undefined)
      if (live.link.mode === 'linked' && takenOver !== undefined) {
        return { text: `Saved. SlapMac sets ${takenOver} while it's listening, so this applies without it.` }
      }
      return { text: 'Saved.' }
    }
  }
}
