// The pane: the live meter, and the settings page that tunes it.

import type { EngineInterface, RenderInput } from 'claude-code'

import {
  ACTIONS,
  GESTURE_FIELDS,
  MAX_LEVEL,
  SOUNDS,
  actionText,
  dial as dialCells,
  levelToThreshold,
  meter,
  plural,
  sparkline,
  strengthOf,
} from './format'
import type { Gesture } from './format'
import {
  PANE_PADDING,
  readDial,
  readJolt,
  readLast,
  readLevels,
  readSensor,
  readSlapMacRunning,
  readSlaps,
  readTotal,
  readView,
  setView,
  settings,
} from './state'
import { nudgeDial, playTest, saveSetting, saveText } from './actions'

const METER_LABEL_WIDTH = 8
const MIN_WIDTH = 8
const GESTURE_LABELS: Record<Gesture, string> = { single: 'Slap', double: 'Double slap' }
const TEXT_HINTS: Record<'command' | 'prompt', string> = {
  command: '/compact',
  prompt: 'Step back and try a different approach.',
}

export async function renderPane($: EngineInterface, e: RenderInput<'Pane'>) {
  return (await readView($)) === 'settings' ? renderSettings($, e) : renderMeter($, e)
}

async function renderMeter($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const state = await readSensor($)
  const history = await readLevels($)
  const count = await readSlaps($)
  const all = await readTotal($)
  const latest = await readLast($)
  const isSlapMacOn = await readSlapMacRunning($)
  const offset = await readJolt($)
  const width = Math.max(MIN_WIDTH, e.props.bodyColumns - offset - PANE_PADDING)
  const level = history.at(-1) ?? 0
  const threshold = levelToThreshold(settings.level)

  return (
    <Box flexDirection="column" paddingLeft={offset}>
      {state.status === 'starting' && <Text dimColor>Waking the motion sensor...</Text>}
      {state.status === 'stopped' && <Text color="warning">{state.reason}</Text>}
      {state.status === 'ready' && (
        <Text color="claude">{history.length > 0 ? sparkline(history, width) : 'Listening...'}</Text>
      )}
      {state.status === 'ready' && (
        <Text>
          {meter(level, width - METER_LABEL_WIDTH, threshold)} {level.toFixed(2)} g
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
      <Text dimColor>A slap {actionText(settings.onSlap, settings.slapText)}</Text>
      <Text dimColor>A double slap {actionText(settings.onDoubleSlap, settings.doubleSlapText)}</Text>
      {isSlapMacOn && <Text dimColor>SlapMac is running, so it plays the sounds.</Text>}
      <Box marginTop={1} gap={1}>
        <Button key="settings" label="Settings" onPress={() => void setView($, 'settings')} />
        <Button key="test" label="Test sound" onPress={() => void playTest($)} />
      </Box>
    </Box>
  )
}

async function renderSettings($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Button, Text } = $.ui.resolve(e)
  // The mobile app draws no text field yet.
  const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input
  const draft = await readDial($)
  const history = await readLevels($)
  const level = draft ?? settings.level
  const threshold = levelToThreshold(level)
  const g = history.at(-1) ?? 0
  const width = Math.max(MIN_WIDTH, e.props.bodyColumns - PANE_PADDING)

  function gestureRows(which: Gesture) {
    const fields = GESTURE_FIELDS[which]
    const action = settings[fields.action]
    const text = settings[fields.text]
    const takesText = action === 'command' || action === 'prompt'

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>
          {GESTURE_LABELS[which]}: {actionText(action, text)}
        </Text>
        <Box flexWrap="wrap" columnGap={1}>
          {ACTIONS.map(one => (
            <Button
              key={`${which}-${one}`}
              label={one}
              variant={one === action ? 'primary' : 'secondary'}
              onPress={() => void saveSetting($, fields.action, one)}
            />
          ))}
        </Box>
        {takesText && Input !== undefined && (
          <Input
            key={fields.text}
            label={action === 'command' ? 'Command' : 'Prompt'}
            placeholder={text === '' ? TEXT_HINTS[action] : text}
            submitLabel="Save"
            onSubmit={value => void saveText($, which, value)}
          />
        )}
        {takesText && Input === undefined && <Text dimColor>Change the text in /config.</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingLeft={PANE_PADDING}>
      <Text bold>Sensitivity</Text>
      <Box gap={1}>
        <Button key="sensitivity-down" label="−" dimColor={level <= 1} onPress={() => void nudgeDial($, -1)} />
        <Text>
          {dialCells(level)} {level}
        </Text>
        <Button key="sensitivity-up" label="+" dimColor={level >= MAX_LEVEL} onPress={() => void nudgeDial($, 1)} />
        <Text dimColor>{threshold.toFixed(3)} g</Text>
      </Box>
      <Text color="claude">
        {meter(g, width - METER_LABEL_WIDTH, threshold)} {g.toFixed(2)} g
      </Text>
      <Text dimColor>Tap the desk: a shake past the ┃ counts as a slap.</Text>
      {gestureRows('single')}
      {gestureRows('double')}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Sound: {settings.sound}</Text>
        <Box columnGap={1}>
          {SOUNDS.map(one => (
            <Button
              key={`sound-${one}`}
              label={one}
              variant={one === settings.sound ? 'primary' : 'secondary'}
              onPress={() => void saveSetting($, 'sound', one)}
            />
          ))}
        </Box>
      </Box>
      <Box marginTop={1} gap={1}>
        <Button key="test" label="Test sound" onPress={() => void playTest($)} />
        <Button key="back" label="Back" onPress={() => void setView($, 'meter')} />
      </Box>
    </Box>
  )
}
