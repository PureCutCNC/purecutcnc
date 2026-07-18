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
import type { ConstraintWorkflow } from './useConstraintWorkflow'

/* eslint-disable react-hooks/refs -- This leaf component forwards refs produced by canvas workflow hooks into JSX. */

interface ConstraintEditPanelProps {
  constraint: ConstraintWorkflow
}

export function ConstraintEditPanel({ constraint }: ConstraintEditPanelProps) {
  const { t } = useI18n()
  const edit = constraint.constraintEdit
  if (!edit) return null

  return (
    <CanvasWorkflowPanel
      title={t('canvas.constraint.editTitle')}
      step={t('canvas.constraint.step.setDistance')}
      position={constraint.constraintEditWorkflowPanel.position}
      panelRef={constraint.constraintEditWorkflowPanel.panelRef}
      handleProps={constraint.constraintEditWorkflowPanel.handleProps}
      actionRowProps={constraint.constraintEditWorkflowPanel.actionRowProps}
      className="canvas-workflow-panel--constraint-edit"
      moveLabel={t('canvas.constraint.moveLabel')}
      actions={(
        <>
          <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={constraint.commitConstraintEditFromPanel}>{t('canvas.constraint.apply')}</button>
          <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={constraint.cancelConstraintEditFromPanel}>{t('canvas.constraint.cancel')}</button>
        </>
      )}
    >
      <label className="canvas-workflow-panel__field">
        <span>{t('canvas.field.distance')}</span>
        <input
          key={`constraint-edit-${edit.constraintId}`}
          ref={constraint.constraintEditInputRef}
          className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
          type="text"
          inputMode="decimal"
          value={edit.value}
          onChange={(e) => constraint.setConstraintEdit((prev) => prev ? { ...prev, value: e.target.value } : null)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              constraint.commitConstraintEditFromPanel()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              constraint.cancelConstraintEditFromPanel()
            }
          }}
          autoFocus
        />
      </label>
    </CanvasWorkflowPanel>
  )
}
