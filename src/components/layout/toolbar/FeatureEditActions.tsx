/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ToolbarActionButton } from './primitives'

function FeatureEditActions({
  enabled,
  hasLockedSelection,
  hasClosedSelection,
  pendingMoveMode,
  pendingTransformMode,
  pendingOffset,
  tooltipSide,
  onCopy,
  onMove,
  onDelete,
  onResize,
  onRotate,
  onMirror,
  onOffset,
  onConstraint,
  constraintActive,
}: {
  enabled: boolean
  hasLockedSelection: boolean
  hasClosedSelection: boolean
  pendingMoveMode: 'move' | 'copy' | null
  pendingTransformMode: 'resize' | 'rotate' | 'mirror' | null
  pendingOffset: boolean
  tooltipSide?: 'bottom' | 'right'
  onCopy: () => void
  onMove: () => void
  onDelete: () => void
  onResize: () => void
  onRotate: () => void
  onMirror: () => void
  onOffset: () => void
  onConstraint: () => void
  constraintActive: boolean
}) {
  if (!enabled) return null

  return (
    <>
      <div className="toolbar-group">
        <ToolbarActionButton
          icon="copy"
          label={pendingMoveMode === 'copy' ? 'Cancel copy' : 'Copy selected features'}
          active={pendingMoveMode === 'copy'}
          tooltipSide={tooltipSide}
          onClick={onCopy}
        />
        <ToolbarActionButton
          icon="move"
          label={pendingMoveMode === 'move' ? 'Cancel move' : 'Move selected features'}
          active={pendingMoveMode === 'move'}
          disabled={hasLockedSelection}
          tooltipSide={tooltipSide}
          onClick={onMove}
        />
        <ToolbarActionButton
          icon="trash"
          label="Delete selected features"
          tooltipSide={tooltipSide}
          onClick={onDelete}
        />
        <ToolbarActionButton
          icon="resize"
          label={pendingTransformMode === 'resize' ? 'Cancel resize' : 'Resize selected features'}
          active={pendingTransformMode === 'resize'}
          disabled={hasLockedSelection}
          tooltipSide={tooltipSide}
          onClick={onResize}
        />
        <ToolbarActionButton
          icon="rotate"
          label={pendingTransformMode === 'rotate' ? 'Cancel rotate' : 'Rotate selected features'}
          active={pendingTransformMode === 'rotate'}
          disabled={hasLockedSelection}
          tooltipSide={tooltipSide}
          onClick={onRotate}
        />
        <ToolbarActionButton
          icon="mirror"
          label={pendingTransformMode === 'mirror' ? 'Cancel mirror' : 'Mirror selected features'}
          active={pendingTransformMode === 'mirror'}
          disabled={hasLockedSelection}
          tooltipSide={tooltipSide}
          onClick={onMirror}
        />
        <ToolbarActionButton
          icon="offset"
          label={pendingOffset ? 'Cancel offset' : 'Create offset feature'}
          active={pendingOffset}
          disabled={hasLockedSelection || !hasClosedSelection}
          tooltipSide={tooltipSide}
          onClick={onOffset}
        />
        <ToolbarActionButton
          icon="constraint"
          label={constraintActive ? 'Cancel constraint' : 'Add constraint'}
          active={constraintActive}
          disabled={hasLockedSelection}
          tooltipSide={tooltipSide}
          onClick={onConstraint}
        />
      </div>
    </>
  )
}

export { FeatureEditActions }
