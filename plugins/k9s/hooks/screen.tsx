import type { ClientModule } from 'claude-code'

import { parseLine, withCursor } from './ansi'

/** What the hooks module hands the screen: the raw rows and where the cursor is. */
export type ScreenProps = {
  lines: string[]
  cursor: { x: number; y: number }
  isCursorShown: boolean
  /** Shown instead of rows while nothing has been captured yet. */
  hint: string
}

type Local = { columns: number; rows: number }

/** Draws the captured k9s rows, forwards keys, and tells the hooks module its size so tmux matches it. */
const Screen: ClientModule<ScreenProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  const size: Local = { columns: surface.columns, rows: surface.rows }

  if (surface.state === undefined) {
    surface.onKey(e => surface.post({ key: e.key, ctrl: e.ctrl === true, shift: e.shift === true, meta: e.meta === true }))
    surface.setState(size)
    if (size.columns > 0 && size.rows > 0) surface.post({ size })
  } else if (surface.state.columns !== size.columns || surface.state.rows !== size.rows) {
    surface.setState(size)
    if (size.columns > 0 && size.rows > 0) surface.post({ size })
  }

  if (props.lines.length === 0) {
    return (
      <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
        <Text dimColor>{props.hint}</Text>
      </Box>
    )
  }

  const shown = surface.rows > 0 ? props.lines.slice(0, surface.rows) : props.lines

  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      {shown.map((line, y) => {
        const runs = withCursor(parseLine(line), props.isCursorShown && y === props.cursor.y ? props.cursor.x : -1)
        return (
          <Box flexDirection="row" height={1} overflow="hidden">
            {runs.length === 0 && <Text> </Text>}
            {runs.map(r => (
              <Text
                color={r.fg}
                backgroundColor={r.bg}
                bold={r.b}
                dimColor={r.d}
                italic={r.i}
                underline={r.u}
                inverse={r.inv}
                wrap="truncate"
              >
                {r.t}
              </Text>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

export default Screen
