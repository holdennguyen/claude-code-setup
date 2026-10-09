import type { On } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const ESC = '\x1b'

const PANE = {
  component: 'Pane',
  requestId: 'k9s',
  props: { title: 'k9s', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 22 }, view: {} },
  viewport: { columns: 100, rows: 24 },
} as const

/** A tmux beneath the plugin: every call succeeds, has-session says yes, capture answers the given rows. */
function fakeTmux(on: On, calls: string[][], rows: string[]) {
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    const line = e.argv.join(' ')
    const stdout = line.includes('capture-pane') ? `3 1 100 ${rows.length} 0  0\n${rows.join('\n')}\n` : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

describe('pane', () => {
  test('draws the captured rows and forwards a key to tmux', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-09T12:00:00Z') })
    const calls: string[][] = []
    fakeTmux(on, calls, [`${ESC}[1m${ESC}[38;5;214m Pods(all)[12] ${ESC}[0m`, 'nginx-1   1/1   Running'])
    const pending = $.tool.call({ tool: 'mcp__k9s__screen' })
    await clock.advance(1000)
    const seen = await pending
    expect(String((seen as { text?: unknown }).text ?? JSON.stringify(seen))).toMatch(/nginx-1/)

    const ui = await $.ui.mount({ plugin: 'k9s', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /Pods\(all\)\[12\]/, in: 'screen' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /nginx-1/, in: 'screen' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'esc' })).toBeDefined()

    await ui.key({ key: 'j', in: 'screen' })
    const sent = calls.filter(c => c.includes('send-keys'))
    expect(sent.length).toBe(1)
    expect(sent[0]?.slice(-2)).toEqual(['-l', 'j'])

    await ui.key({ key: 'return', in: 'screen' })
    expect(calls.filter(c => c.includes('send-keys')).at(-1)?.at(-1)).toBe('Enter')

    await ui.press({ key: 'esc' })
    expect(calls.filter(c => c.includes('send-keys')).at(-1)?.at(-1)).toBe('Escape')
    await ui.unmount()
  })

  test('says so while nothing runs', async ($, on) => {
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no server running', isStdoutTruncated: false, isStderrTruncated: false } }))
    const ui = await $.ui.mount({ plugin: 'k9s', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /not running/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'start' })).toBeDefined()
    await ui.unmount()
  })
})
