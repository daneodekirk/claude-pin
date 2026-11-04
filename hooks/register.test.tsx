import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'pins',
  component: 'Pane',
  requestId: 'pins',
  props: {
    title: 'Pins',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const run = ($: any, command: string, args: string) =>
  $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

// The conversation the test stands in, as the kit's session.id answers it.
const SESSION = 'conv-1'
const KEY = `pins:${SESSION}`

const start = async ($: any, on: any, entries?: Record<string, unknown>) => {
  // An in-memory store the test can read back, standing for the engine's.
  const stored: Record<string, unknown> = { ...entries }
  const clock = mock.clock(on)
  const prompts: string[] = []
  on('prompt.submit', (_: any, e: any) => {
    prompts.push(e.text)

    return { text: e.text }
  })
  on('session.id', () => ({ value: SESSION }))
  on('store.get', (_: any, e: any) => ({ value: stored[e.key] }))
  on('store.set', (_: any, e: any) => {
    stored[e.key] = e.value

    return { value: undefined }
  })
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__pins__${e.name}` } }))
  const panes: string[] = []
  on('ui.open', (_: any, e: any) => {
    if (!panes.includes(e.id)) panes.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: any, e: any) => {
    panes.splice(panes.indexOf(e.id), 1)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: panes.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  return { stored, prompts, clock, panes }
}

test('/pin with words hands them to the model', async ($, on) => {
  const { prompts, clock } = await start($, on)

  const ran = await run($, 'pin', 'the table')
  expect(ran.text).toBe('Asking Claude to pin: the table')
  expect(prompts).toEqual([])

  await clock.advance(1)
  expect(prompts).toEqual(['Pin: the table'])
})

test('the tool replaces a pin in place', async ($, on) => {
  const { stored } = await start($, on)

  await $.tool.call({ tool: 'mcp__pins__pin', text: 'first' })
  await $.tool.call({ tool: 'mcp__pins__pin', text: 'second' })
  const ran = await $.tool.call({ tool: 'mcp__pins__pin', text: 'FIRST', replace: 1 })
  expect(ran.result).toBe('Pin 1 updated.')
  expect((stored[KEY] as { text: string }[]).map(pin => pin.text)).toEqual(['FIRST', 'second'])

  const missed = await $.tool.call({ tool: 'mcp__pins__pin', text: 'x', replace: 5 })
  expect(missed.deny).toMatch(/no pin 5/)
})

test('a table wider than the pane is refused once the pane has been drawn', async ($, on) => {
  await start($, on)

  const row = `| ${'x'.repeat(60)} |`
  const table = `| a |\n|---|\n${row}`
  const unsized = await $.tool.call({ tool: 'mcp__pins__pin', text: 'first' })
  expect(unsized.result).toBe('Pinned as 1.')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.unmount()

  const wide = await $.tool.call({ tool: 'mcp__pins__pin', text: table })
  expect(wide.deny).toMatch(/40 columns wide and a table or code row here is 64/)
  const code = await $.tool.call({ tool: 'mcp__pins__pin', text: '```\n' + 'y'.repeat(50) + '\n```' })
  expect(code.deny).toMatch(/row here is 50/)

  const prose = await $.tool.call({ tool: 'mcp__pins__pin', text: '- ' + 'z'.repeat(80) })
  expect(prose.result).toBe('Pinned as 2. The pane is 40 columns wide.')
  const fits = await $.tool.call({ tool: 'mcp__pins__pin', text: '| a | b |\n|---|---|\n| 1 | 2 |', replace: 1 })
  expect(fits.result).toBe('Pin 1 updated. The pane is 40 columns wide.')
})

test('the tool pins a line and the pane draws it', async ($, on) => {
  const { stored } = await start($, on)

  await $.tool.call({ tool: 'mcp__pins__pin', text: 'buy milk' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('buy milk')
  await ui.unmount()

  expect(stored[KEY]).toEqual([
    { id: expect.any(String), text: 'buy milk' },
  ])
  expect(stored.pins).toBeUndefined()
})

test('the tool pins and /unpin removes by number', async ($, on) => {
  const { stored } = await start($, on)

  await $.tool.call({ tool: 'mcp__pins__pin', text: '- a\n- b' })
  await $.tool.call({ tool: 'mcp__pins__pin', text: 'second' })
  const texts = () => (stored[KEY] as { text: string }[]).map(pin => pin.text)
  expect(texts()).toEqual(['- a\n- b', 'second'])

  expect((await run($, 'unpin', '1')).text).toBe('Unpinned - a.')
  expect(texts()).toEqual(['second'])
  expect((await run($, 'unpin', '9')).text).toBe('No pin 9.')
})

test('pins of this conversation come back, another conversation\'s do not', async ($, on) => {
  await start($, on, {
    [KEY]: [{ id: 'k', text: 'kept' }],
    'pins:other': [{ id: 'o', text: 'elsewhere' }],
    pins: [{ id: 's', text: 'shared' }],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('kept')
  await ui.unmount()
})

test('with scope "everywhere" every conversation shares one list', { options: { scope: 'everywhere' } }, async ($, on) => {
  const { stored } = await start($, on, { pins: [{ id: 's', text: 'shared' }] })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('shared')
  await ui.unmount()

  await $.tool.call({ tool: 'mcp__pins__pin', text: 'more' })
  expect((stored.pins as { text: string }[]).map(pin => pin.text)).toEqual(['shared', 'more'])
  expect(stored[KEY]).toBeUndefined()
})

test('/pin alone shows the pane, then hides it', async ($, on) => {
  const { panes } = await start($, on)

  expect((await run($, 'pin', '')).text).toBe('Pins pane shown')
  expect(panes).toEqual(['pins'])
  expect((await run($, 'pin', '')).text).toBe('Pins pane hidden')
  expect(panes).toEqual([])
})

const ROW = {
  plugin: 'pins',
  component: 'ToolUse',
  requestId: 'call-1',
  props: {
    tool_use_id: 'call-1',
    tool: 'mcp__pins__pin',
    input: { text: '**Groceries**\n\n- milk\n- eggs', replace: 2 },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  },
} as const

test('the pin tool\'s transcript row is one line, unless expanded', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  await start($, on)

  const row = await $.ui.mount({ ...ROW, surface: 'terminal' })
  expect((await row.find({ type: 'Text', text: /Pin 2/ }))?.text).toBe('Pin 2 **Groceries**')
  expect(await row.find({ type: 'Text', text: /milk/ })).toBeUndefined()
  await row.unmount()

  const expanded = await $.ui.mount({
    ...ROW,
    props: { ...ROW.props, isExpanded: true },
    surface: 'terminal',
  })
  expect((await expanded.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await expanded.unmount()

  const other = await $.ui.mount({
    ...ROW,
    props: { ...ROW.props, tool: 'Bash', input: { command: 'ls' } },
    surface: 'terminal',
  })
  expect((await other.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await other.unmount()
})

test('an empty pane says so', async ($, on) => {
  await start($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/Nothing pinned/)
  await ui.unmount()
})
