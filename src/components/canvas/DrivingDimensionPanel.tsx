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

import { CanvasWorkflowPanel } from './CanvasWorkflowPanel'
import type { DrivingDimensionWorkflow } from './useDrivingDimensionWorkflow'

/* eslint-disable react-hooks/refs -- This leaf component forwards refs produced by canvas workflow hooks into JSX. */

interface DrivingDimensionPanelProps {
  driving: DrivingDimensionWorkflow
}

export function DrivingDimensionPanel({ driving }: DrivingDimensionPanelProps) {
  const state = driving.drivingEdit
  if (!state) return null

  const edit = state.edit
  const title = edit.kind === 'stock_dimension' ? 'Resize Stock' : 'Edit Dimension'
  const fieldLabel =
    edit.kind === 'stock_dimension'
      ? edit.axis === 'width' ? 'Width' : 'Height'
      : edit.kind === 'linear' ? 'Distance'
        : edit.kind === 'diameter' ? 'Diameter'
          : edit.kind === 'angle' ? 'Angle' : 'Radius'
  const inputKey = 'annotationId' in edit ? `drive-${edit.annotationId}` : 'drive-stock'
  const heldSummary =
    edit.kind === 'stock_dimension'
      ? `Holding ${edit.heldSide} side`
      : edit.kind === 'linear' || edit.kind === 'angle' ? edit.heldSideLabel : null

  return (
    <CanvasWorkflowPanel
      title={title}
      step="Set value"
      position={driving.drivingDimensionWorkflowPanel.position}
      panelRef={driving.drivingDimensionWorkflowPanel.panelRef}
      handleProps={driving.drivingDimensionWorkflowPanel.handleProps}
      actionRowProps={driving.drivingDimensionWorkflowPanel.actionRowProps}
      className="canvas-workflow-panel--driving-edit"
      moveLabel="Move driving edit controls"
      actions={(
        <>
          {(edit.kind === 'linear' || edit.kind === 'stock_dimension' || edit.kind === 'angle') && (
            <button
              type="button"
              className="tablet-cmd-btn"
              onClick={() => {
                driving.flipDrivingHeldSide()
              }}
            >
              Flip held point
            </button>
          )}
          <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={driving.commitDrivingFromPanel}>Apply</button>
          <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={driving.cancelDrivingFromPanel}>Cancel</button>
        </>
      )}
    >
      {heldSummary && <p className="canvas-workflow-panel__summary">{heldSummary}</p>}
      <label className="canvas-workflow-panel__field">
        <span>{fieldLabel}</span>
        <input
          key={inputKey}
          ref={driving.drivingEditInputRef}
          className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
          type="text"
          inputMode="decimal"
          value={state.value}
          onChange={(e) => driving.handleDrivingValueChange(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              driving.commitDrivingFromPanel()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              driving.cancelDrivingFromPanel()
            }
          }}
          autoFocus
        />
      </label>
    </CanvasWorkflowPanel>
  )
}
