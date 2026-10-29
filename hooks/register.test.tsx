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

const start = async ($: any, on: any, entries?: Record<string, unknown>) => {
  // An in-memory store the test can read back, standing for the engine's.
  const stored: Record<string, unknown> = { ...entries }
  const clock = mock.clock(on)
  const prompts: string[] = []
  on('prompt.submit', (_: any, e: any) => {
    prompts.push(e.text)

    return { text: e.text }
  })
  on('store.get', (_: any, e: any) => ({ value: stored[e.key] }))
  on('store.set', (_: any, e: any) => {
    stored[e.key] = e.value

    return { value: undefined }
  })
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__pins__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  return { stored, prompts, clock }
}

test('/pin with words hands them to the model', async ($, on) => {
  const { prompts, clock } = await start($, on)

  const ran = await run($, 'pin', 'the table')
  expect(ran.text).toBe('Asking Claude to pin: the table')
  expect(prompts).toEqual([])

  await clock.advance(1)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toMatch(/"\/pin the table"/)
})

test('the tool replaces a pin in place', async ($, on) => {
  await start($, on)

  await $.tool.call({ tool: 'mcp__pins__pin', text: 'first' })
  await $.tool.call({ tool: 'mcp__pins__pin', text: 'second' })
  const ran = await $.tool.call({ tool: 'mcp__pins__pin', text: 'FIRST', replace: 1 })
  expect(ran.result).toBe('Pin 1 updated.')
  expect((await run($, 'pin', '')).text).toBe('1. FIRST\n2. second')

  const missed = await $.tool.call({ tool: 'mcp__pins__pin', text: 'x', replace: 5 })
  expect(missed.deny).toMatch(/no pin 5/)
})

test('the tool pins a line and the pane draws it', async ($, on) => {
  const { stored } = await start($, on)

  await $.tool.call({ tool: 'mcp__pins__pin', text: 'buy milk' })
  expect((await run($, 'pin', '')).text).toBe('1. buy milk')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('buy milk')
  await ui.unmount()

  expect(stored.pins).toEqual([
    { id: expect.any(String), text: 'buy milk' },
  ])
})

test('the tool pins and /unpin removes by number', async ($, on) => {
  await start($, on)

  await $.tool.call({ tool: 'mcp__pins__pin', text: '- a\n- b' })
  await $.tool.call({ tool: 'mcp__pins__pin', text: 'second' })
  expect((await run($, 'pin', '')).text).toBe(
    '1. - a\n2. second',
  )

  expect((await run($, 'unpin', '1')).text).toBe(
    'Unpinned - a.',
  )
  expect((await run($, 'pin', '')).text).toBe('1. second')
  expect((await run($, 'unpin', '9')).text).toBe('No pin 9.')
})

test('pins stored by an earlier session come back', async ($, on) => {
  await start($, on, { pins: [{ id: 'k', text: 'kept' }] })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('kept')
  await ui.unmount()
})

test('an empty pane says so', async ($, on) => {
  await start($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/Nothing pinned/)
  await ui.unmount()
})
