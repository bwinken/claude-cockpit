// The diff pane: one edited file's change, as git prints it, opened by
// pressing the file in the edited files band or in a turn's row. No `$` here:
// the hook in register.tsx reads the state and passes the surface's elements in.

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { CockpitDiffView } from '../../types'

export type DiffModel = {
  view: CockpitDiffView | null
  onClose: () => unknown
}

/** How a diff line is drawn: added, removed, a hunk header, or context. */
export function lineKind(line: string): 'added' | 'removed' | 'hunk' | 'context' {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'added'
  if (line.startsWith('-')) return 'removed'
  return 'context'
}

/** The diff's body: git's header (`diff --git`, `index`, `---`, `+++`) dropped, the pane names the file. */
export function diffBody(text: string): string[] {
  const lines = text.split('\n')
  const first = lines.findIndex(line => line.startsWith('@@') || line.startsWith('Binary files'))
  return first === -1 ? [] : lines.slice(first)
}

export function diffTree(ui: Elements[RenderSurface], model: DiffModel): RenderElement {
  const { Box, Button, Text } = ui
  const view = model.view
  const header = (
    <Box key="diff-header" flexDirection="row" gap={1}>
      <Text bold wrap="truncate-start">
        {view === null ? 'No file chosen' : view.path}
      </Text>
      <Button key="diff-close" label="Close" role="dismiss" onPress={model.onClose} />
    </Box>
  )
  if (view === null) return <Box flexDirection="column">{header}</Box>

  const body = view.text === null ? null : diffBody(view.text)
  let rows: RenderElement[]
  if (body === null) {
    rows = [
      <Text key="diff-none" dimColor>
        git can no longer show this change.
      </Text>,
    ]
  } else if (body.length === 0) {
    rows = [
      <Text key="diff-none" dimColor>
        No change git can show line by line.
      </Text>,
    ]
  } else {
    const COLORS = { added: 'success', removed: 'error', hunk: 'claude', context: undefined } as const
    rows = body.map((line, i) => {
      const kind = lineKind(line)
      return (
        <Text key={'diff-' + i} color={COLORS[kind]} dimColor={kind === 'hunk'} wrap="truncate-end">
          {line.replace(/\t/g, '    ') || ' '}
        </Text>
      )
    })
  }
  return (
    <Box flexDirection="column">
      <Box key="diff-top" flexDirection="column" marginBottom={1}>
        {header}
      </Box>
      <Box key="diff-body" flexDirection="column">
        {rows}
      </Box>
    </Box>
  )
}
