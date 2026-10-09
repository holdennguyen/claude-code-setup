import { describe, expect, test, tier } from 'claude-code/testing'

import { applySgr, parseLine, stripAnsi, withCursor, xterm } from '../hooks/ansi'
import { SWEEP_SCRIPT, isIdle, keyArgs, screenText, shellLine, socketNameFor, toolKeyArgs, watchdogCommand } from '../hooks/register'

tier('user')

const ESC = '\x1b'

describe('ansi', () => {
  test('SGR colours become styled runs and nothing else survives', () => {
    const line = `${ESC}[38;5;214m${ESC}[40mContext:${ESC}[0m ${ESC}[1m${ESC}[97mprod${ESC}[0m${ESC}[?25h${ESC}(B tail`
    const runs = parseLine(line)
    expect(runs.map(r => r.t).join('')).toBe('Context: prod tail')
    expect(runs[0]).toEqual({ t: 'Context:', fg: '#ffaf00', bg: 'black' })
    expect(runs[2]).toEqual({ t: 'prod', b: true, fg: 'whiteBright' })
    expect(stripAnsi(line)).toBe('Context: prod tail')
  })
  test('palette indexes map to names below 16 and hex above', () => {
    expect(xterm(1)).toBe('red')
    expect(xterm(9)).toBe('redBright')
    expect(xterm(214)).toBe('#ffaf00')
    expect(xterm(232)).toBe('#080808')
  })
  test('reset and partial resets', () => {
    const s = applySgr('1;4;31', {})
    expect(s).toEqual({ b: true, u: true, fg: 'red' })
    expect(applySgr('22;39', s)).toEqual({ u: true })
    expect(applySgr('', s)).toEqual({})
    expect(applySgr(';;', s)).toEqual({})
  })
  test('cursor inverts one cell, padding past the end of the row', () => {
    const runs = withCursor([{ t: 'abc' }], 1)
    expect(runs).toEqual([{ t: 'a' }, { t: 'b', inv: true }, { t: 'c' }])
    expect(withCursor([{ t: 'ab' }], 4)).toEqual([{ t: 'ab' }, { t: '  ' }, { t: ' ', inv: true }])
    expect(withCursor([{ t: 'ab' }], -1)).toEqual([{ t: 'ab' }])
  })
})

describe('keys', () => {
  test('pane keys map to tmux names or literal text', () => {
    expect(keyArgs({ key: 'return' })).toEqual(['Enter'])
    expect(keyArgs({ key: 'tab', shift: true })).toEqual(['BTab'])
    expect(keyArgs({ key: 'up', ctrl: true })).toEqual(['C-Up'])
    expect(keyArgs({ key: 'd', ctrl: true })).toEqual(['C-d'])
    expect(keyArgs({ key: ':' })).toEqual(['-l', ':'])
    expect(keyArgs({ key: 'x', meta: true })).toEqual(['M-x'])
  })
  test('model keys: names and chords as such, anything else literal', () => {
    expect(toolKeyArgs('Enter')).toEqual(['Enter'])
    expect(toolKeyArgs('escape')).toEqual(['Escape'])
    expect(toolKeyArgs('C-d')).toEqual(['C-d'])
    expect(toolKeyArgs(':pods')).toEqual(['-l', ':pods'])
    expect(toolKeyArgs('Enterprise')).toEqual(['-l', 'Enterprise'])
  })
})

describe('text', () => {
  test('the shell line quotes the command and keeps the arguments as typed', () => {
    expect(shellLine({ command: 'k9s', args: '', tmux: 'tmux', pollMs: 250, autoOpen: false, idleMinutes: 15 })).toBe('k9s')
    expect(shellLine({ command: '/opt/my k9s/k9s', args: '-n kube-system', tmux: 'tmux', pollMs: 250, autoOpen: false, idleMinutes: 15 })).toBe("'/opt/my k9s/k9s' -n kube-system")
  })
  test('the screen the model reads is plain text under a status line', () => {
    const text = screenText({
      lines: [`${ESC}[1mPods${ESC}[0m   `, 'nginx-1  Running'],
      cursor: { x: 2, y: 0 },
      columns: 80,
      rows: 2,
      status: 'running',
      note: '',
      isCursorShown: true,
    })
    expect(text).toBe('[k9s running · 80x2 · cursor 2,0]\nPods\nnginx-1  Running')
    expect(screenText({ lines: [], cursor: { x: 0, y: 0 }, columns: 0, rows: 0, status: 'stopped', note: 'tmux: not found', isCursorShown: true })).toMatch(/not running: tmux: not found/)
  })
})

describe('lifecycle', () => {
  test('the socket is named after the host pid', async () => {
    expect(socketNameFor('12345')).toBe('claude-k9s-12345')
    expect(socketNameFor('')).toBe('claude-k9s-shared')
  })
  test('the watchdog waits on the host pid and the socket, then ends the server', async () => {
    const cmd = watchdogCommand('4242')
    expect(cmd).toContain('kill -0 4242')
    expect(cmd).toContain('[ -S "#{socket_path}" ]')
    expect(cmd.endsWith('kill #{pid} 2>/dev/null')).toBe(true)
  })
  test('the sweep skips the live process and only touches claude-k9s-<pid> sockets', async () => {
    expect(SWEEP_SCRIPT).toContain('"$d"/claude-k9s-*')
    expect(SWEEP_SCRIPT).toContain('[ "$p" = "$SELF" ] && continue')
    expect(SWEEP_SCRIPT).toContain('case "$p" in ""|*[!0-9]*) continue;; esac')
    expect(SWEEP_SCRIPT).toContain('kill -0 "$p"')
  })
  test('idle means wanted, pane closed and quiet for the whole window', async () => {
    const base = { isWanted: true, isPaneOpen: false, lastActiveAt: 0, now: 15 * 60_000, idleMs: 15 * 60_000 }
    expect(isIdle(base)).toBe(true)
    expect(isIdle({ ...base, now: base.now - 1 })).toBe(false)
    expect(isIdle({ ...base, isPaneOpen: true })).toBe(false)
    expect(isIdle({ ...base, isWanted: false })).toBe(false)
    expect(isIdle({ ...base, idleMs: 0 })).toBe(false)
  })
})
