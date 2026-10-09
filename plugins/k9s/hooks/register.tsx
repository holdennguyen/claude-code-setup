import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { K9sScreen, K9sStatus } from '../types'
import { stripAnsi } from './ansi'

export const PANE = 'k9s'
export const SESSION = 'k9s'
export const SOCKET_PREFIX = 'claude-k9s-'
const SCREEN_TOOL = 'mcp__k9s__screen'
const KEYS_TOOL = 'mcp__k9s__keys'

const EMPTY: K9sScreen = { lines: [], cursor: { x: 0, y: 0 }, columns: 0, rows: 0, status: 'stopped', note: '', isCursorShown: true }
const screen = atom({ plugin: 'k9s', key: 'screen' } as const, EMPTY)

// --- the kubectl guard: while k9s runs, the model drives k9s instead of kubectl -----------

/**
 * kubectl in command position: at the start of a line, after `| ; & ( { \`` or `$(`, or after a wrapper
 * (sudo, exec, xargs, time, watch, command, nohup, env, then, do, else, if, while, until), with optional
 * `VAR=value` assignments and a path prefix. A mention inside a string, a file name such as
 * kubectl-cheatsheet.md, a grep pattern, `which kubectl` or `brew info kubectl` is not an invocation.
 */
const KUBECTL =
  /(^|[|;&(`{]|\$\(|\b(?:sudo|exec|xargs|time|watch|command|nohup|env|then|do|else|if|while|until)\s+)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?kubectl(?:\s|$|[;|&)])/m

/** Whether a shell command runs kubectl (see KUBECTL). */
export function invokesKubectl(command: string): boolean {
  return KUBECTL.test(command)
}

export const KUBECTL_DENY =
  'The k9s pane is open in this session, so kubectl is disabled: the person is watching k9s, which already runs on their kube context. ' +
  `Use the k9s mod instead: call ${SCREEN_TOOL} to read the live pane and ${KEYS_TOOL} to drive it, e.g. keys [":pods", "Enter"], [":ctx", "Enter"], ["/", "name", "Enter"], ["l"] for logs, ["d"] for describe, ["y"] for yaml. ` +
  'Only send destructive keys (C-d, C-k, e) when the person asked for that action. kubectl is available again after /k9s stop.'

export type Options = { command: string; args: string; tmux: string; pollMs: number; autoOpen: boolean; idleMinutes: number }

export function readOptions(o: PluginOptions): Options {
  const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : d)
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  return {
    command: str(o.command, 'k9s'),
    args: typeof o.args === 'string' ? o.args.trim() : '',
    tmux: str(o.tmux, 'tmux'),
    pollMs: Math.max(100, num(o.pollMs, 250) || 250),
    autoOpen: o.autoOpen === true,
    idleMinutes: num(o.idleMinutes, 15),
  }
}

type Size = { columns: number; rows: number }
type Exec = { exitCode: number; stdout: string; stderr: string }

// --- the private tmux server: one per Claude Code process ------------------

/** The Claude Code process id, learned at session start; the socket is named after it. */
let hostPid = ''

/** The socket name for a host pid: `claude-k9s-<pid>`, so a sweep can tell whose server it is. */
export function socketNameFor(pid: string): string {
  return SOCKET_PREFIX + (/^\d+$/.test(pid) ? pid : 'shared')
}

/** Runs one tmux command line (several joined by `;`) on this process's private server. */
const tmuxOf =
  ($: EngineInterface, opts: Options) =>
  (args: readonly string[], timeoutMs = 5000): Promise<Exec> =>
    $.process.run([opts.tmux, '-L', socketNameFor(hostPid), '-f', '/dev/null', ...args], { timeoutMs })

const shellWord = (w: string): string => (/^[A-Za-z0-9_./=-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)

/** What tmux runs in the window: the command and its arguments as one shell line. */
export function shellLine(opts: Options): string {
  return [shellWord(opts.command), opts.args].filter(s => s !== '').join(' ')
}

/**
 * The watchdog tmux runs in the background (`run-shell -b`): while the Claude Code
 * process lives and the socket exists it sleeps; then it ends the tmux server itself,
 * so a crash or a killed terminal never leaves k9s behind. tmux expands `#{...}`.
 */
export function watchdogCommand(pid: string): string {
  return `while kill -0 ${pid} 2>/dev/null && [ -S "#{socket_path}" ]; do sleep 3; done; kill #{pid} 2>/dev/null`
}

/**
 * The sweep run at session start: every `claude-k9s-<pid>` socket of this user whose
 * pid is no longer alive gets its server killed and its socket file removed.
 * `$SELF` is this process's pid, `$TMUX_BIN` the tmux to use.
 */
export const SWEEP_SCRIPT = [
  'd="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"',
  'for s in "$d"/' + SOCKET_PREFIX + '*; do',
  '  [ -e "$s" ] || continue',
  '  n=${s##*/}; p=${n#' + SOCKET_PREFIX + '}',
  '  case "$p" in ""|*[!0-9]*) continue;; esac',
  '  [ "$p" = "$SELF" ] && continue',
  '  if ! kill -0 "$p" 2>/dev/null; then "$TMUX_BIN" -L "$n" kill-server 2>/dev/null; rm -f "$s"; echo "$n"; fi',
  'done',
].join('\n')

/** Kills the servers of Claude Code processes that are gone; answers the socket names it swept. */
export async function sweepOrphans($: EngineInterface, opts: Options): Promise<string[]> {
  const r = await $.process.run(['sh', '-c', SWEEP_SCRIPT], { env: { SELF: hostPid, TMUX_BIN: opts.tmux }, timeoutMs: 10_000 }).catch(() => undefined)
  return r === undefined ? [] : r.stdout.split('\n').map(s => s.trim()).filter(s => s !== '')
}

// --- tmux key names -------------------------------------------------------

const NAMED: Record<string, string> = {
  return: 'Enter', enter: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', btab: 'BTab', space: 'Space',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End',
  pageup: 'PPage', pagedown: 'NPage', ppage: 'PPage', npage: 'NPage',
  backspace: 'BSpace', bspace: 'BSpace', delete: 'DC', dc: 'DC', insert: 'IC', ic: 'IC',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6', f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
}

export type KeyPress = { key: string; ctrl?: boolean; shift?: boolean; meta?: boolean }

/** The `send-keys` tail for one key the person pressed in the pane: a tmux name, or `-l` and the literal text. */
export function keyArgs(e: KeyPress): string[] {
  const lower = e.key.toLowerCase()
  if (lower === 'tab' && e.shift) return ['BTab']
  const named = NAMED[lower]
  if (named !== undefined) return [(e.ctrl ? 'C-' : '') + (e.meta ? 'M-' : '') + named]
  if (e.key.length === 1) {
    if (e.ctrl) return ['C-' + e.key.toLowerCase()]
    if (e.meta) return ['M-' + e.key]
  }
  return ['-l', e.key]
}

/** The `send-keys` tail for one entry of the model's `keys` list: a known name or chord is sent as such, anything else typed literally. */
export function toolKeyArgs(k: string): string[] {
  const named = NAMED[k.toLowerCase()]
  if (named !== undefined) return [named]
  if (/^(C|M)-(.|[A-Za-z]+)$/.test(k)) return [k]
  return ['-l', k]
}

// --- the hosted program ---------------------------------------------------

/** Whether the person or the model asked for k9s: while false the mod never touches tmux. */
let isWanted = false
let isPaneOpen = false
let lastActiveAt = 0
let lastCapture = ''
let isPolling = false
let tick = 0
let lastSize: Size = { columns: 120, rows: 30 }

const now = () => Date.now()
const touch = () => {
  lastActiveAt = now()
}

async function isRunning(tmux: ReturnType<typeof tmuxOf>): Promise<boolean> {
  return (await tmux(['has-session', '-t', SESSION])).exitCode === 0
}

/** Starts the program under tmux unless a session already runs; answers the error line when it did not start. */
async function start($: EngineInterface, opts: Options, size: Size): Promise<string | undefined> {
  const tmux = tmuxOf($, opts)
  isWanted = true
  touch()
  if (await isRunning(tmux)) return undefined
  const made = await tmux([
    'start-server', ';',
    'set', '-g', 'default-terminal', 'tmux-256color', ';',
    'set', '-g', 'remain-on-exit', 'on', ';',
    'set', '-g', 'window-size', 'manual', ';',
    'set', '-g', 'status', 'off', ';',
    'set', '-g', 'escape-time', '0', ';',
    'set', '-g', 'exit-empty', 'on', ';',
    'set', '-g', 'history-limit', '200', ';',
    'new-session', '-d', '-s', SESSION, '-x', String(size.columns), '-y', String(size.rows), shellLine(opts), ';',
    ...(hostPid !== '' ? ['run-shell', '-b', watchdogCommand(hostPid)] : ['display', '-p', '']),
  ])
  if (made.exitCode !== 0) {
    const why = (made.stderr || made.stdout).trim() || `tmux exited with ${made.exitCode}`
    isWanted = false
    await update($, screen, s => ({ ...s, status: 'stopped' as K9sStatus, note: why }))
    return why
  }
  lastCapture = ''
  await update($, screen, s => ({ ...s, status: 'running' as K9sStatus, note: '' }))
  return undefined
}

async function stop($: EngineInterface, opts: Options, note = 'stopped'): Promise<void> {
  isWanted = false
  await tmuxOf($, opts)(['kill-server']).catch(() => undefined)
  lastCapture = ''
  await update($, screen, () => ({ ...EMPTY, note }))
}

const FORMAT = '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height} #{pane_dead} #{pane_dead_status} #{cursor_flag}'

/** Reads the screen once and writes it to state when it changed. */
export async function poll($: EngineInterface, opts: Options): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    const out = await tmuxOf($, opts)(['display', '-p', '-t', SESSION, FORMAT, ';', 'capture-pane', '-p', '-e', '-N', '-t', SESSION], 3000)
    if (out.exitCode !== 0) {
      if (lastCapture !== '' || isWanted) {
        lastCapture = ''
        isWanted = false
        await update($, screen, s => (s.status === 'stopped' ? s : { ...EMPTY, note: 'k9s is not running' }))
      }
      return
    }
    if (out.stdout === lastCapture) return
    lastCapture = out.stdout
    const [head = '', ...body] = out.stdout.split('\n')
    const [cx, cy, w, h, dead, deadStatus, cursorFlag] = head.trim().split(' ')
    const rows = Number(h) || body.length
    const lines = body.slice(0, rows)
    while (lines.length < rows) lines.push('')
    const status: K9sStatus = dead === '1' ? 'exited' : 'running'
    await update($, screen, () => ({
      lines,
      cursor: { x: Number(cx) || 0, y: Number(cy) || 0 },
      columns: Number(w) || 0,
      rows,
      status,
      note: dead === '1' ? `${opts.command} exited with status ${deadStatus ?? '?'}` : '',
      isCursorShown: cursorFlag !== '0',
    }))
  } finally {
    isPolling = false
  }
}

/** Whether the program should be stopped for lying idle: wanted, pane closed, and nothing used it for `idleMs`. */
export function isIdle(args: { isWanted: boolean; isPaneOpen: boolean; lastActiveAt: number; now: number; idleMs: number }): boolean {
  return args.isWanted && !args.isPaneOpen && args.idleMs > 0 && args.now - args.lastActiveAt >= args.idleMs
}

/** One timer tick: nothing while k9s is not wanted; a slower read while the pane is closed; the idle stop. */
async function onTick($: EngineInterface, opts: Options): Promise<void> {
  if (!isWanted) return
  tick += 1
  if (isIdle({ isWanted, isPaneOpen, lastActiveAt, now: now(), idleMs: opts.idleMinutes * 60_000 })) {
    await stop($, opts, `stopped after ${opts.idleMinutes} min idle with the pane closed`)
    $.ui.toast(`k9s stopped after ${opts.idleMinutes} min idle. /k9s starts it again.`)
    return
  }
  if (!isPaneOpen && tick % 8 !== 0) return
  await poll($, opts)
}

async function resize($: EngineInterface, opts: Options, size: Size): Promise<void> {
  lastSize = size
  const tmux = tmuxOf($, opts)
  if (!(await isRunning(tmux))) return
  await tmux(['resize-window', '-t', SESSION, '-x', String(size.columns), '-y', String(size.rows)])
}

async function send($: EngineInterface, opts: Options, tails: string[][]): Promise<string | undefined> {
  const tmux = tmuxOf($, opts)
  if (!(await isRunning(tmux))) return 'k9s is not running'
  touch()
  for (const tail of tails) {
    const r = await tmux(['send-keys', '-t', SESSION, ...tail])
    if (r.exitCode !== 0) return r.stderr.trim() || 'send-keys failed'
  }
  return undefined
}

/** The screen as the model reads it: a status line, then the rows as plain text. */
export function screenText(s: K9sScreen): string {
  if (s.status === 'stopped') return `k9s is not running${s.note ? `: ${s.note}` : ''}. Call this tool again or run /k9s to start it.`
  const head = `[k9s ${s.status} · ${s.columns}x${s.rows} · cursor ${s.cursor.x},${s.cursor.y}${s.note ? ` · ${s.note}` : ''}]`
  return head + '\n' + s.lines.map(l => stripAnsi(l).replace(/\s+$/, '')).join('\n')
}

/** Starts the program when needed and reads its first screen; answers the error line when it did not start. */
async function ensure($: EngineInterface, opts: Options): Promise<string | undefined> {
  const err = await start($, opts, lastSize)
  if (err === undefined) {
    await $.clock.sleep(400)
    lastCapture = ''
    await poll($, opts)
  }
  return err
}

function open($: EngineInterface, focus: boolean): Promise<unknown> {
  isPaneOpen = true
  touch()
  return $.ui.open(focus ? { id: PANE, title: 'k9s', focus: true, rows: 30, columns: 140 } : { id: PANE, title: 'k9s', rows: 30, columns: 140 })
}

/** Learns this Claude Code process's pid: `sh` is spawned by it directly, so its parent is the host. */
async function learnHostPid($: EngineInterface): Promise<void> {
  const r = await $.process.run(['sh', '-c', 'echo $PPID'], { timeoutMs: 5000 }).catch(() => undefined)
  const pid = r?.stdout.trim() ?? ''
  if (/^\d+$/.test(pid)) hostPid = pid
}

// --- the mod ----------------------------------------------------------------

export const register: Register = (on, options) => {
  const opts = readOptions(options)
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'k9s',
      description: 'Open the k9s pane (start | stop | restart)',
      argumentHint: '[stop|restart]',
    })
    await $.tool.register({
      name: 'screen',
      description:
        'Read the k9s screen the person sees in the k9s pane: the visible terminal text plus the cursor position. Whenever the person works in k9s, or asks about cluster state while k9s is in use, prefer this tool and mcp__k9s__keys over kubectl: k9s already runs on their kube context and credentials, and they are watching this pane. Starts k9s (under tmux, with the kube context and credentials of the shell that launched Claude Code) if it is not running yet. Call it after mcp__k9s__keys to see the result, or any time you need to know what k9s is showing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'keys',
      description:
        'Send keystrokes to the running k9s and return its screen afterwards. Whenever the person works in k9s, or asks about cluster state while k9s is in use, prefer this tool and mcp__k9s__screen over kubectl. `keys` is a list sent in order; each entry is either literal text typed as-is (":pods", "/nginx", "0") or one key name: Enter, Escape, Tab, BTab, Space, Up, Down, Left, Right, Home, End, PPage, NPage, BSpace, DC, F1..F12, or a chord C-<key> (ctrl) / M-<key> (alt). Examples: [":pods", "Enter"], ["Escape"], ["/", "nginx", "Enter"], ["C-d"]. Destructive k9s keys (C-d delete, C-k kill, e edit) act on the cluster: only send them when the person asked for that action.',
      inputSchema: {
        type: 'object',
        properties: {
          keys: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Keys and text, in order.' },
          settleMs: { type: 'number', description: 'How long to wait before reading the screen back (default 500).' },
        },
        required: ['keys'],
        additionalProperties: false,
      },
      isDeferred: false,
    })

    await learnHostPid($)
    const swept = await sweepOrphans($, opts)
    if (swept.length > 0) $.ui.toast(`k9s: cleaned up ${swept.length} orphaned tmux server${swept.length === 1 ? '' : 's'} (${swept.join(', ')})`)

    timer?.cancel()
    timer = $.clock.every(opts.pollMs, () => void onTick($, opts))

    const panes = await $.ui.panes().catch(() => [])
    isPaneOpen = panes.some(p => p.id === PANE)

    if (opts.autoOpen) {
      const err = await ensure($, opts)
      if (err === undefined) void open($, false)
      else $.ui.toast(`k9s did not start: ${err}`)
    } else if (await isRunning(tmuxOf($, opts))) {
      isWanted = true
      touch()
      void poll($, opts)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
      timer?.cancel()
      await tmuxOf($, opts)(['kill-server']).catch(() => undefined)
    }
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const done = await next(e)
    isPaneOpen = false
    touch()
    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'k9s' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'stop') {
      await stop($, opts)
      return { text: 'k9s stopped.' }
    }
    if (arg === 'restart') await stop($, opts)
    const err = await ensure($, opts)
    if (err !== undefined) return { text: `k9s did not start: ${err}` }
    await open($, true)
    return { text: 'k9s pane opened. Click the screen to give it the keyboard; Esc hands the keys back to the prompt. The Esc and ^C buttons in the pane header reach k9s.' }
  })

  // While k9s runs, a Bash call that invokes kubectl is refused and the model is pointed at the k9s tools.
  // Not running (never started, /k9s stop, idle stop, exited): kubectl passes as usual.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!invokesKubectl(e.command)) return next(e)
    const s = await read($, screen)
    if (s.status !== 'running') return next(e)
    return { deny: KUBECTL_DENY }
  }).catch(($, e, next) => (next.called ? next(e) : invokesKubectl(e.command) ? { deny: KUBECTL_DENY } : next(e)))

  on('tool.call', { tool: SCREEN_TOOL }, async $ => {
    const err = await ensure($, opts)
    if (err !== undefined) return { result: `k9s did not start: ${err}` }
    return { result: screenText(await read($, screen)) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'the k9s screen could not be read' }))

  on('tool.call', { tool: KEYS_TOOL }, async ($, e) => {
    const input = e as unknown as { keys?: unknown; settleMs?: unknown }
    const keys = Array.isArray(input.keys) ? input.keys.filter((k): k is string => typeof k === 'string' && k !== '') : []
    if (keys.length === 0) return { deny: 'keys must be a non-empty list of strings' }
    const started = await ensure($, opts)
    if (started !== undefined) return { result: `k9s did not start: ${started}` }
    const err = await send($, opts, keys.map(toolKeyArgs))
    if (err !== undefined) return { result: `keys not sent: ${err}` }
    const settle = typeof input.settleMs === 'number' && input.settleMs > 0 ? Math.min(5000, input.settleMs) : 500
    await $.clock.sleep(settle)
    lastCapture = ''
    await poll($, opts)
    return { result: screenText(await read($, screen)) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'the keys could not be sent to k9s' }))

  // Keys and size reports from the screen module.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'screen' || typeof e.data !== 'object' || e.data === null) return next(e)
    const data = e.data as { key?: unknown; ctrl?: unknown; shift?: unknown; meta?: unknown; size?: unknown }
    if (typeof data.key === 'string') {
      await send($, opts, [keyArgs({ key: data.key, ctrl: data.ctrl === true, shift: data.shift === true, meta: data.meta === true })])
      $.clock.after(120, () => void poll($, opts))
      return {}
    }
    const size = data.size as { columns?: unknown; rows?: unknown } | undefined
    if (size && typeof size.columns === 'number' && typeof size.rows === 'number' && size.columns > 10 && size.rows > 3) {
      const s = await read($, screen)
      if (s.columns !== size.columns || s.rows !== size.rows) await resize($, opts, { columns: Math.floor(size.columns), rows: Math.floor(size.rows) })
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    isPaneOpen = true
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>The k9s pane draws in the terminal or the desktop app.</Text>
    }
    const { Box, Text, Button, Client } = $.ui.resolve(e)
    const s = await read($, screen)
    const bodyRows = Math.max(4, (e.viewport?.rows ?? 24) - 1)
    const press = (tail: string[]) => () => {
      void send($, opts, [tail]).then(() => $.clock.after(120, () => void poll($, opts)))
    }
    const state =
      s.status === 'running' ? `${s.columns}x${s.rows}` : s.status === 'exited' ? s.note || 'exited' : s.note || 'not running'
    const hint =
      s.status === 'stopped'
        ? 'k9s is not running. Press Start, or run /k9s.'
        : 'Waiting for the first screen…'
    return (
      <Box flexDirection="column" width="100%" height="100%">
        <Box flexDirection="row" gap={1} height={1} overflow="hidden">
          <Text bold>k9s</Text>
          <Text dimColor wrap="truncate">{state} · click the screen to type · Esc returns to the prompt</Text>
          {s.status === 'running' && (
            <Button key="esc" plain onPress={press(['Escape'])}>
              [Esc]
            </Button>
          )}
          {s.status === 'running' && (
            <Button key="ctrl-c" plain onPress={press(['C-c'])}>
              [^C]
            </Button>
          )}
          {s.status !== 'running' && (
            <Button
              key="start"
              plain
              onPress={() => {
                void (async () => {
                  if (s.status === 'exited') await stop($, opts)
                  const err = await ensure($, opts)
                  if (err !== undefined) $.ui.toast(`k9s did not start: ${err}`)
                })()
              }}
            >
              [Start]
            </Button>
          )}
          {s.status === 'running' && (
            <Button key="stop" plain onPress={() => void stop($, opts)}>
              [Stop]
            </Button>
          )}
        </Box>
        <Client
          key="screen"
          module="./screen.tsx"
          props={{ lines: s.lines, cursor: s.cursor, isCursorShown: s.isCursorShown && s.status === 'running', hint }}
          width="100%"
          height={bodyRows}
        />
      </Box>
    )
  })
}
