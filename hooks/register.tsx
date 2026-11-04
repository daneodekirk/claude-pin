import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pin } from '../types'

const PANE = 'pins'
const TITLE = 'Pins'
// Where pins are kept: one key per conversation, or one for all of them.
let storeKey = 'pins'

const pins = atom({ plugin: 'pins', key: 'pins' } as const, [], {
  shape: 'pins-1',
})

const isPinList = (value: unknown): value is Pin[] =>
  Array.isArray(value) &&
  value.every(
    one =>
      typeof one === 'object' &&
      one !== null &&
      typeof (one as Pin).id === 'string' &&
      typeof (one as Pin).text === 'string',
  )

// Changes the list in session state and keeps the result across sessions.
const change = async ($: EngineInterface, fn: (list: Pin[]) => Pin[]) => {
  const list = await update($, pins, fn)
  await $.store.set(storeKey, list)

  return list
}

const add = ($: EngineInterface, text: string) =>
  change($, list => [...list, { id: crypto.randomUUID(), text: text.trim() }])

// Replaces the text of pin `n` (1-based), keeping its place; false if no such pin.
const replace = async ($: EngineInterface, n: number, text: string) => {
  const list = await read($, pins)
  if (!Number.isInteger(n) || n < 1 || n > list.length) {
    return false
  }
  await change($, now =>
    now.map((one, i) => (i === n - 1 ? { ...one, text: text.trim() } : one)),
  )

  return true
}

// `which` is a 1-based number or "all"; returns what was removed.
const remove = async ($: EngineInterface, which: string) => {
  const before = await read($, pins)
  const n = Number(which)

  if (which === 'all') {
    await change($, () => [])

    return before
  }

  if (!Number.isInteger(n) || n < 1 || n > before.length) {
    return []
  }

  await change($, list => list.filter((_, i) => i !== n - 1))

  return [before[n - 1] as Pin]
}

const open = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE })

// The pane body's width in cells, as last drawn; 0 until the pane has been
// drawn. A module variable, not state: nothing drawn reads it, and a render
// hook may not write state.
let columns = 0

// The widest line that cannot wrap: a table row or a line of fenced code.
const widest = (text: string) => {
  let isCode = false
  let most = 0
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      isCode = !isCode
      continue
    }
    if (isCode || line.trimStart().startsWith('|')) {
      most = Math.max(most, Array.from(line).length)
    }
  }

  return most
}

const sized = () => (columns > 0 ? ` The pane is ${columns} columns wide.` : '')

// The first line of a pin, as a row of the transcript names it.
const headline = (text: unknown) =>
  typeof text === 'string' ? (text.trim().split('\n')[0] ?? '').trim() : ''

export const register: Register = (on, options) => {
  const isShared = options.scope === 'everywhere'

  on('session.start', async ($, e, next) => {
    storeKey = isShared ? 'pins' : `pins:${await $.session.id()}`
    const stored = await $.store.get(storeKey)
    if (isPinList(stored) && stored.length > 0) {
      await update($, pins, () => stored)
      void open($)
    }

    await $.command.register({
      name: 'pin',
      description: 'Pin something to the Pins pane (text, or "the table"); no text shows or hides the pane',
      argumentHint: '[text]',
    })
    await $.command.register({
      name: 'unpin',
      description: 'Remove a pin by number, or all of them',
      argumentHint: '<number|all>',
    })
    await $.tool.register({
      name: 'pin',
      description:
        'Pins text to the Pins pane beside the chat, where the user keeps lists and notes for this conversation. Call it once when the user asks to pin something, including a prompt of the form "Pin: <words>" (what /pin submits): if the words point at content in the conversation (a table, a list, an answer you gave), pin that content itself, verbatim, as markdown; otherwise pin the words as written, then reply in one short line. Markdown is rendered in a narrow pane, about a third of the terminal: write a pin as a list, not a table, and keep any table row or code line within the width the result reports, since a wider one is refused. To change a pin in place (edit a list, drop a row), pass `replace` with its number instead of unpinning and pinning again.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to pin' },
          replace: {
            type: 'integer',
            description: 'The 1-based number of an existing pin to overwrite in place',
          },
        },
        required: ['text'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'unpin',
      description:
        'Removes a pin from the Pins pane: by its 1-based number, or "all".',
      inputSchema: {
        type: 'object',
        properties: {
          which: { type: 'string', description: 'A 1-based number or "all"' },
        },
        required: ['which'],
      },
      isDeferred: false,
    })

    return next(e)
  })

  // `/pin <words>` goes to the model: "the table" means the table it just
  // wrote, "buy milk" means those words. `/pin` alone toggles the pane.
  on('command.run', { command: 'pin' }, async ($, e) => {
    const words = e.args.trim()
    if (words === '') {
      const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
      if (isUp) {
        await $.ui.close({ id: PANE })

        return { text: 'Pins pane hidden' }
      }
      await open($)

      return { text: 'Pins pane shown' }
    }
    // Opened here, on the person's own command, the pane seats at any width.
    await open($)

    // A prompt cannot be submitted from inside the command's own hook (the
    // engine refuses it); a timer fires once the command has returned.
    $.clock.after(0, () => {
      // Shown in the transcript as a prompt, so it is one short line in the
      // person's own voice; the pinning rules live in the tool's description.
      void $.prompt.submit({ text: `Pin: ${words}`, asUser: true })
    })

    return { text: `Asking Claude to pin: ${words}` }
  })

  on('command.run', { command: 'unpin' }, async ($, e) => {
    const which = e.args.trim()
    if (which === '') {
      return { text: 'Say which: /unpin <number> or /unpin all. Numbers follow pane order.' }
    }
    const gone = await remove($, which)

    return {
      text:
        gone.length === 0
          ? `No pin ${which}.`
          : `Unpinned ${gone.length === 1 ? gone[0]?.text.split('\n')[0] : `${gone.length} pins`}.`,
    }
  })

  on('tool.call', { tool: 'mcp__pins__pin' }, async ($, e) => {
    const text = typeof e.text === 'string' ? e.text.trim() : ''
    if (text === '') {
      return { deny: 'pins: text is required.' }
    }
    const wide = widest(text)
    if (columns > 0 && wide > columns) {
      return {
        deny: `pins: the pane is ${columns} columns wide and a table or code row here is ${wide}. Rewrite it to fit, as a list rather than a table, and pin again.`,
      }
    }
    if (typeof e.replace === 'number') {
      const isDone = await replace($, e.replace, text)
      await open($)

      return isDone
        ? { result: `Pin ${e.replace} updated.${sized()}` }
        : { deny: `pins: no pin ${e.replace}.` }
    }
    const list = await add($, text)
    await open($)

    return { result: `Pinned as ${list.length}.${sized()}` }
  })

  on('tool.call', { tool: 'mcp__pins__unpin' }, async ($, e) => {
    const which = typeof e.which === 'string' ? e.which.trim() : ''
    const gone = await remove($, which)

    return {
      result:
        gone.length === 0 ? `No pin ${which}.` : `Unpinned ${gone.length}.`,
    }
  })

  // The transcript draws a tool call with its whole input, which for a pin is
  // the pin itself, already in the pane: one line names it instead. Expanded
  // (ctrl+o, --verbose) the engine's own row shows all.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, input, isExpanded } = e.props
    const isOurs = tool === 'mcp__pins__pin' || tool === 'mcp__pins__unpin'
    if (!isOurs || isExpanded === true) {
      return next(e)
    }
    const { Text } = $.ui.resolve(e)
    const args = (typeof input === 'object' && input !== null ? input : {}) as {
      text?: unknown
      replace?: unknown
      which?: unknown
    }
    const label =
      tool === 'mcp__pins__unpin'
        ? `Unpin ${typeof args.which === 'string' ? args.which : ''}`
        : typeof args.replace === 'number'
          ? `Pin ${args.replace}`
          : 'Pin'

    return (
      <Text>
        <Text bold>{label}</Text>
        <Text dimColor> {headline(args.text)}</Text>
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    columns = e.props.bodyColumns
    const list = await read($, pins)

    if (list.length === 0) {
      return <Text dimColor>Nothing pinned. /pin {'<text>'} adds one.</Text>
    }

    return (
      <Box flexDirection="column" gap={1}>
        {list.map(pin => (
          <Box key={pin.id} flexDirection="column">
            <Box justifyContent="flex-end">
              <Button
                key={`x:${pin.id}`}
                plain
                dimColor
                label="x"
                onPress={() =>
                  change($, now => now.filter(one => one.id !== pin.id))
                }
              />
            </Box>
            <Markdown text={pin.text} />
          </Box>
        ))}
      </Box>
    )
  })
}
