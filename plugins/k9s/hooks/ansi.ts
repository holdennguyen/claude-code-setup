/** One styled run of a terminal row, as the screen module draws it. */
export type Run = {
  t: string
  fg?: string
  bg?: string
  b?: true
  d?: true
  i?: true
  u?: true
  inv?: true
}

type Style = Omit<Run, 't'>

const BASIC = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
const BRIGHT = ['gray', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright']

const hex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('')

/** The colour of xterm palette index `n`: a name for the first 16 (so the person's palette applies), hex above. */
export function xterm(n: number): string {
  if (n < 8) return BASIC[n] ?? 'white'
  if (n < 16) return BRIGHT[n - 8] ?? 'white'
  if (n < 232) {
    const i = n - 16
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40)
    return hex(v(Math.floor(i / 36)), v(Math.floor((i % 36) / 6)), v(i % 6))
  }
  const v = 8 + (Math.min(255, n) - 232) * 10
  return hex(v, v, v)
}

/** Applies one SGR parameter list (`1;38;5;214`) to a style. */
export function applySgr(params: string, style: Style): Style {
  const next: Style = { ...style }
  const codes = params === '' ? [0] : params.split(';').map(p => (p === '' ? 0 : Number(p)))
  for (let k = 0; k < codes.length; k++) {
    const c = codes[k]
    if (c === undefined || Number.isNaN(c)) continue
    if (c === 0) {
      for (const key of Object.keys(next) as (keyof Style)[]) delete next[key]
    } else if (c === 1) next.b = true
    else if (c === 2) next.d = true
    else if (c === 3) next.i = true
    else if (c === 4) next.u = true
    else if (c === 7) next.inv = true
    else if (c === 22) {
      delete next.b
      delete next.d
    } else if (c === 23) delete next.i
    else if (c === 24) delete next.u
    else if (c === 27) delete next.inv
    else if (c >= 30 && c <= 37) next.fg = BASIC[c - 30]
    else if (c === 39) delete next.fg
    else if (c >= 40 && c <= 47) next.bg = BASIC[c - 40]
    else if (c === 49) delete next.bg
    else if (c >= 90 && c <= 97) next.fg = BRIGHT[c - 90]
    else if (c >= 100 && c <= 107) next.bg = BRIGHT[c - 100]
    else if (c === 38 || c === 48) {
      const mode = codes[k + 1]
      let color: string | undefined
      if (mode === 5 && codes[k + 2] !== undefined) {
        color = xterm(codes[k + 2] ?? 0)
        k += 2
      } else if (mode === 2 && codes[k + 4] !== undefined) {
        color = hex(codes[k + 2] ?? 0, codes[k + 3] ?? 0, codes[k + 4] ?? 0)
        k += 4
      }
      if (color !== undefined) {
        if (c === 38) next.fg = color
        else next.bg = color
      }
    }
  }
  return next
}

// SGR (kept), any other CSI / charset / lone escape, or a stray control character (dropped).
const TOKEN = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][ -~]|\x1b[^[(]?|[\x00-\x08\x0a-\x1f\x7f]/g

/** Splits one captured row into styled runs; every escape and control character is consumed. */
export function parseLine(line: string): Run[] {
  const runs: Run[] = []
  let style: Style = {}
  let buf = ''
  let at = 0
  const flush = () => {
    if (buf.length > 0) runs.push({ t: buf, ...style })
    buf = ''
  }
  for (const m of line.matchAll(TOKEN)) {
    const start = m.index ?? 0
    buf += line.slice(at, start).replace(/\t/g, ' ')
    at = start + m[0].length
    if (m[1] !== undefined) {
      const changed = applySgr(m[1], style)
      if (!sameStyle(changed, style)) {
        flush()
        style = changed
      }
    }
  }
  buf += line.slice(at).replace(/\t/g, ' ')
  flush()
  return runs
}

function sameStyle(a: Style, b: Style): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.b === b.b && a.d === b.d && a.i === b.i && a.u === b.u && a.inv === b.inv
}

/** The row as plain text: what the model reads. */
export function stripAnsi(line: string): string {
  return parseLine(line)
    .map(r => r.t)
    .join('')
}

/** The runs with the cell at column `x` drawn inverse (the cursor); `x < 0` leaves them. */
export function withCursor(runs: Run[], x: number): Run[] {
  if (x < 0) return runs
  const out: Run[] = []
  let col = 0
  let placed = false
  for (const r of runs) {
    const end = col + r.t.length
    if (!placed && x >= col && x < end) {
      const i = x - col
      if (i > 0) out.push({ ...r, t: r.t.slice(0, i) })
      out.push({ ...r, t: r.t[i] ?? ' ', inv: r.inv ? undefined : true })
      if (i + 1 < r.t.length) out.push({ ...r, t: r.t.slice(i + 1) })
      placed = true
    } else out.push(r)
    col = end
  }
  if (!placed) {
    if (x > col) out.push({ t: ' '.repeat(x - col) })
    out.push({ t: ' ', inv: true })
  }
  return out.map(r => (r.inv === undefined ? stripUndefined(r) : r))
}

function stripUndefined(r: Run): Run {
  const { inv: _inv, ...rest } = r
  return rest
}
