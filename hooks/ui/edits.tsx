// The band above the prompt: what the last turn edited, by git.
// `Edited 9 files +682 −1`, expandable to one row per file. No `$` here: the
// hook in register.tsx reads the state and passes the surface's elements in.

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { CockpitEdits } from '../../types'
import { count } from '../lib/rounds'
import { describeLines, shortPath } from '../lib/timeline'

/** The most files the expanded band lists; the rest are counted. */
export const MAX_LISTED_FILES = 12

export type EditsModel = {
  edits: CockpitEdits
  isExpanded: boolean
  columns: number
  onToggle: () => unknown
  onDismiss: () => unknown
}

/** cockpit's rows under whatever the mods beneath drew in the band (`theirs`). */
export function editsBandTree(ui: Elements[RenderSurface], model: EditsModel, theirs: RenderElement): RenderElement {
  const { Box, Button, Text } = ui
  const { edits, isExpanded } = model
  const columns = Math.max(20, count(model.columns))
  const files = edits.files.length

  const rows: RenderElement[] = [
    <Box key="edits-header" flexDirection="row" gap={1}>
      <Text>{`Edited ${files} ${files === 1 ? 'file' : 'files'}`}</Text>
      <Text color="success">{'+' + count(edits.added)}</Text>
      <Text color="error">{'−' + count(edits.removed)}</Text>
      <Button key="edits-toggle" label={isExpanded ? 'Hide files' : 'Show files'} onPress={model.onToggle} />
      <Button key="edits-dismiss" label="Dismiss" role="dismiss" onPress={model.onDismiss} />
    </Box>,
  ]

  if (isExpanded) {
    const listed = edits.files.slice(0, MAX_LISTED_FILES)
    for (const file of listed) {
      const lines = describeLines(file)
      rows.push(
        <Box key={'edit-' + file.path} flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-start">{'  ' + shortPath(file.path, columns - lines.length - 4)}</Text>
          {file.added === null && file.removed === null ? (
            <Text dimColor>{lines}</Text>
          ) : (
            <Box flexDirection="row" gap={1}>
              <Text color="success">{'+' + count(file.added)}</Text>
              <Text color="error">{'−' + count(file.removed)}</Text>
            </Box>
          )}
        </Box>,
      )
    }
    const more = files - listed.length
    if (more > 0) {
      rows.push(
        <Text key="edits-more" dimColor>
          {`  … and ${more} more`}
        </Text>,
      )
    }
  }

  return (
    <Box flexDirection="column">
      {theirs}
      <Box key="cockpit-edits" flexDirection="column">
        {rows}
      </Box>
    </Box>
  )
}
