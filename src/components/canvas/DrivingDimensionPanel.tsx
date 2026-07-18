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
import { useI18n } from '../../i18n/i18nContext'
import type { DrivingDimensionWorkflow } from './useDrivingDimensionWorkflow'
import type { HeldSideId } from '../../sketch/drivingDimensionResolver'

/* eslint-disable react-hooks/refs -- This leaf component forwards refs produced by canvas workflow hooks into JSX. */

import type { MessageKey } from '../../i18n/locales/en'

// Localized "Hold …" labels for the resolver's stable held-side ids.
const HOLD_LABEL_KEYS: Record<HeldSideId, MessageKey> = {
  left: 'canvas.driving.holdLabel.left',
  right: 'canvas.driving.holdLabel.right',
  top: 'canvas.driving.holdLabel.top',
  bottom: 'canvas.driving.holdLabel.bottom',
  start: 'canvas.driving.holdLabel.start',
  end: 'canvas.driving.holdLabel.end',
  firstRay: 'canvas.driving.holdLabel.firstRay',
  secondRay: 'canvas.driving.holdLabel.secondRay',
}

const HELD_SIDE_LABEL_KEYS: Record<string, MessageKey> = {
  left: 'canvas.driving.heldSide.left',
  right: 'canvas.driving.heldSide.right',
  top: 'canvas.driving.heldSide.top',
  bottom: 'canvas.driving.heldSide.bottom',
}

interface DrivingDimensionPanelProps {
  driving: DrivingDimensionWorkflow
}

export function DrivingDimensionPanel({ driving }: DrivingDimensionPanelProps) {
  const { t } = useI18n()
  const state = driving.drivingEdit
  if (!state) return null

  const edit = state.edit
  const title = edit.kind === 'stock_dimension' ? t('canvas.driving.title.resizeStock') : t('canvas.driving.title.editDimension')
  const fieldLabel =
    edit.kind === 'stock_dimension'
      ? t(edit.axis === 'width' ? 'canvas.field.width' : 'canvas.field.height')
      : edit.kind === 'linear' ? t('canvas.field.distance')
        : edit.kind === 'diameter' ? t('canvas.field.diameter')
          : edit.kind === 'angle' ? t('canvas.field.angle') : t('canvas.field.radius')
  const inputKey = 'annotationId' in edit ? `drive-${edit.annotationId}` : 'drive-stock'
  const heldSummary =
    edit.kind === 'stock_dimension'
      ? t('canvas.driving.holdingSide', { side: t((HELD_SIDE_LABEL_KEYS[edit.heldSide] ?? 'canvas.driving.heldSide.left') as MessageKey) })
      : edit.kind === 'linear' || edit.kind === 'angle' ? t(HOLD_LABEL_KEYS[edit.heldSideId]) : null

  return (
    <CanvasWorkflowPanel
      title={title}
      step={t('canvas.driving.step.setValue')}
      position={driving.drivingDimensionWorkflowPanel.position}
      panelRef={driving.drivingDimensionWorkflowPanel.panelRef}
      handleProps={driving.drivingDimensionWorkflowPanel.handleProps}
      actionRowProps={driving.drivingDimensionWorkflowPanel.actionRowProps}
      className="canvas-workflow-panel--driving-edit"
      moveLabel={t('canvas.driving.moveLabel')}
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
              {t('canvas.driving.flipHeldPoint')}
            </button>
          )}
          <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={driving.commitDrivingFromPanel}>{t('canvas.driving.apply')}</button>
          <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={driving.cancelDrivingFromPanel}>{t('canvas.driving.cancel')}</button>
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
