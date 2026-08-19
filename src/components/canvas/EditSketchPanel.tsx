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

import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import { useProjectStore } from '../../store/projectStore'
import type { SketchEditTool } from '../../store/types'
import { useSketchCommands } from '../../commands/sketchCommands'
import { Icon } from '../Icon'
import { parseLengthInput } from '../../utils/units'
import { CanvasWorkflowAction, CanvasWorkflowCancel, CanvasWorkflowConfirm } from './CanvasWorkflowAction'
import { CanvasWorkflowPanel } from './CanvasWorkflowPanel'
import { CANVAS_SHORTCUT } from './canvasShortcuts'
import type { DimensionEditWorkflow } from './useDimensionEditWorkflow'
import type { FilletWorkflow } from './useFilletWorkflow'
import type { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

/* eslint-disable react-hooks/refs -- This leaf component forwards refs produced by
   the canvas workflow hooks (dimEdit, fillet, panel) into JSX, like ConstraintEditPanel. */

/** Per-tool "Done" exit label — worded as finishing the mode, never as cancelling. */
const DONE_LABEL_KEYS: Record<SketchEditTool, MessageKey> = {
  add_point: 'canvas.edit.done.addPoint',
  delete_point: 'canvas.edit.done.deletePoint',
  delete_segment: 'canvas.edit.done.deleteSegment',
  disconnect: 'canvas.edit.done.disconnect',
  fillet: 'canvas.edit.done.fillet',
  chamfer: 'canvas.edit.done.chamfer',
  trim: 'canvas.edit.done.trim',
  extend: 'canvas.edit.done.extend',
}

const TOOL_ICONS: Record<SketchEditTool, string> = {
  add_point: 'point-add',
  delete_point: 'point-delete',
  delete_segment: 'segment-delete',
  disconnect: 'disconnect',
  fillet: 'fillet',
  chamfer: 'chamfer',
  trim: 'trim',
  extend: 'extend',
}

const TOOL_LABEL_KEYS: Record<SketchEditTool, MessageKey> = {
  add_point: 'sketch.edit.addPoint',
  delete_point: 'sketch.edit.deletePoint',
  delete_segment: 'sketch.edit.deleteSegment',
  disconnect: 'sketch.edit.disconnect',
  fillet: 'sketch.edit.fillet',
  chamfer: 'sketch.edit.chamfer',
  trim: 'sketch.edit.trim',
  extend: 'sketch.edit.extend',
}

const TOOL_ORDER: SketchEditTool[] = [
  'add_point',
  'delete_point',
  'delete_segment',
  'disconnect',
  'fillet',
  'chamfer',
  'trim',
  'extend',
]

interface ToolButtonProps {
  icon: string
  label: string
  active: boolean
  disabled: boolean
  onClick: () => void
}

/** One tool-mode button in the panel's tool row. Icon + visible text so the
 *  mode is discoverable without hover (tablet-safe). */
function ToolButton({ icon, label, active, disabled, onClick }: ToolButtonProps) {
  return (
    <button
      type="button"
      className={`canvas-workflow-panel__tool${active ? ' canvas-workflow-panel__tool--active' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon id={icon} size={16} />
      <span>{label}</span>
    </button>
  )
}

export interface EditSketchPanelProps {
  panel: ReturnType<typeof useCanvasWorkflowPanel>
  dimEdit: DimensionEditWorkflow
  fillet: FilletWorkflow
  hasSelfIntersection: boolean
  exceedsStock: boolean
  /** Finish the whole edit session. Inspector state is closed first. */
  onFinishSession: () => void
  /** Cancel the whole edit session. Inspector state is closed first. */
  onCancelSession: () => void
  /** Opens dimension entry (the "Dimension" affordance armed by Tab). */
  onTriggerDimensionEdit: () => void
  /** Redraw the canvas (live radius preview while typing). */
  scheduleDraw: () => void
}

/**
 * The Edit Sketch session panel (issue #556). The eight sketch-edit tool modes
 * live here — not in the global rail — and the header's Finish/Cancel pair keeps
 * its session-wide meaning in every sub-state. The segment and fillet inspectors
 * are live edits inside the session; they never reuse the session confirm control.
 */
export function EditSketchPanel({
  panel,
  dimEdit,
  fillet,
  hasSelfIntersection,
  exceedsStock,
  onFinishSession,
  onCancelSession,
  onTriggerDimensionEdit,
  scheduleDraw,
}: EditSketchPanelProps) {
  const { t } = useI18n()
  const commands = useSketchCommands()
  const selection = useProjectStore((state) => state.selection)
  const pendingSketchEdit = useProjectStore((state) => state.pendingSketchEdit)
  const units = useProjectStore((state) => state.project.meta.units)
  const setSketchEditTool = useProjectStore((state) => state.setSketchEditTool)

  const tool = selection.sketchEditTool
  const filletEditorActive = fillet.filletDimensionEditActive
  const dimEditorActive = dimEdit.dimensionEdit !== null

  function activateTool(nextTool: SketchEditTool) {
    commands.sketchEdit[nextTool].onActivate()
    panel.focusCanvasAfterAction()
  }

  /** Exit the active tool, keeping every edit made in it. */
  function exitTool() {
    setSketchEditTool(null)
    panel.focusCanvasAfterAction()
  }

  function finishSession() {
    if (dimEditorActive) {
      dimEdit.commitEditDimension()
    }
    if (filletEditorActive) {
      fillet.commitFilletDimension()
    }
    onFinishSession()
  }

  function cancelSession() {
    if (dimEditorActive) {
      dimEdit.cancelEditDimension()
    }
    if (filletEditorActive) {
      fillet.cancelFilletDimension()
    }
    onCancelSession()
  }

  /** Blur on the radius field: apply a valid typed radius, otherwise close the
   *  editor and keep the picked corner (the pointer preview returns). */
  function closeFilletRadiusFromBlur() {
    const current = fillet.filletDimensionEditRef.current
    const typed = current ? parseLengthInput(current.radius, units) : null
    if (typed !== null && typed > 0) {
      fillet.commitFilletDimension()
    } else {
      fillet.dismissFilletDimension()
      panel.focusCanvasAfterAction()
    }
  }

  function closeDimensionEditor() {
    // Live semantics: closing keeps the values — Escape and Enter are equivalent.
    dimEdit.commitEditDimension()
  }

  function commitFilletRadiusFromField() {
    fillet.commitFilletDimension()
    panel.focusCanvasAfterAction()
  }

  function dismissFilletRadiusFromField() {
    fillet.dismissFilletDimension()
    panel.focusCanvasAfterAction()
  }

  const stepText = filletEditorActive
    ? (tool === 'chamfer' ? t('canvas.edit.step.enterDistance') : t('canvas.edit.step.enterRadius'))
    : dimEditorActive ? t('canvas.edit.step.enterDimensions')
    : tool === 'add_point' ? t('canvas.edit.step.clickToAddPoints')
    : tool === 'delete_point' ? t('canvas.edit.step.clickToDeletePoints')
    : tool === 'delete_segment' ? t('canvas.edit.step.clickToDeleteSegments')
    : tool === 'disconnect' ? t('canvas.edit.step.clickAnchorToSplit')
    : tool === 'fillet' ? (fillet.filletCornerPicked ? t('canvas.edit.step.filletSecond') : t('canvas.edit.step.filletCorner'))
    : tool === 'chamfer' ? (fillet.filletCornerPicked ? t('canvas.edit.step.chamferSecond') : t('canvas.edit.step.chamferCorner'))
    : tool === 'trim' ? (pendingSketchEdit?.phase === 'pick-reference' ? t('canvas.edit.step.trimReference') : t('canvas.edit.step.trimSubject'))
    : tool === 'extend' ? (pendingSketchEdit?.phase === 'pick-reference' ? t('canvas.edit.step.extendReference') : t('canvas.edit.step.extendSubject'))
    : t('canvas.edit.step.default')

  return (
    <CanvasWorkflowPanel
      className="canvas-workflow-panel--edit"
      title={t('canvas.edit.title')}
      step={stepText}
      position={panel.position}
      panelRef={panel.panelRef}
      handleProps={panel.handleProps}
      actions={(
        <>
          <CanvasWorkflowConfirm label={t('canvas.edit.finish')} onClick={finishSession} />
          <CanvasWorkflowCancel label={t('canvas.edit.cancelSession')} onClick={cancelSession} />
        </>
      )}
    >
      <div className="canvas-workflow-panel__tool-row">
        <ToolButton
          icon="move"
          label={t('canvas.edit.move')}
          active={tool === null}
          disabled={false}
          onClick={exitTool}
        />
        {TOOL_ORDER.map((key) => (
          <ToolButton
            key={key}
            icon={TOOL_ICONS[key]}
            label={t(TOOL_LABEL_KEYS[key])}
            active={tool === key}
            disabled={!commands.sketchEdit[key].enabled}
            onClick={() => activateTool(key)}
          />
        ))}
      </div>
      {tool && (
        <div className="canvas-workflow-panel__mode-strip">
          <button type="button" className="tablet-cmd-btn" onClick={exitTool}>
            {t(DONE_LABEL_KEYS[tool])}
          </button>
        </div>
      )}
      {dimEdit.armedForDimension && !dimEditorActive && (
        <div className="canvas-workflow-panel__mode-strip">
          <CanvasWorkflowAction
            shortcut={CANVAS_SHORTCUT.dimensions}
            label={t('canvas.edit.dimensionButton')}
            onClick={() => { onTriggerDimensionEdit(); dimEdit.setArmedForDimension(false) }}
          />
        </div>
      )}
      {fillet.filletCornerPicked && !filletEditorActive && (
        <div className="canvas-workflow-panel__mode-strip">
          <CanvasWorkflowAction
            label={tool === 'chamfer' ? t('canvas.edit.distanceButton') : t('canvas.edit.radiusButton')}
            onClick={fillet.enterFilletRadiusEdit}
          />
        </div>
      )}
      {dimEditorActive && dimEdit.dimensionEdit && (
        <div className="canvas-workflow-panel__inspector">
          <div className="canvas-workflow-panel__section-label">{t('canvas.edit.inspector.segment')}</div>
          {dimEdit.dimensionEdit.activeField === 'radius' ? (
            <label className="canvas-workflow-panel__field">
              <span>{t('canvas.field.radius')}</span>
              <input
                ref={dimEdit.radiusInputRef}
                className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                type="text"
                inputMode="decimal"
                value={dimEdit.dimensionEdit.radius}
                onChange={(e) => dimEdit.handleEditDimLiveChange('radius', e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter' || e.key === 'Escape') {
                    e.preventDefault()
                    closeDimensionEditor()
                  }
                }}
                autoFocus
              />
            </label>
          ) : (
            <>
              <label className="canvas-workflow-panel__field">
                <span>{t('canvas.field.length')}</span>
                <input
                  ref={dimEdit.widthInputRef}
                  className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                  type="text"
                  inputMode="decimal"
                  value={dimEdit.dimensionEdit.length}
                  onChange={(e) => dimEdit.handleEditDimLiveChange('length', e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      e.preventDefault()
                      closeDimensionEditor()
                    } else if (e.key === 'Tab') {
                      e.preventDefault()
                      dimEdit.heightInputRef.current?.focus({ preventScroll: true })
                    }
                  }}
                  autoFocus
                />
              </label>
              <label className="canvas-workflow-panel__field">
                <span>{t('canvas.field.angle')}</span>
                <input
                  ref={dimEdit.heightInputRef}
                  className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                  type="text"
                  inputMode="decimal"
                  value={dimEdit.dimensionEdit.angle}
                  onChange={(e) => dimEdit.handleEditDimLiveChange('angle', e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      e.preventDefault()
                      closeDimensionEditor()
                    } else if (e.key === 'Tab') {
                      e.preventDefault()
                      dimEdit.widthInputRef.current?.focus({ preventScroll: true })
                    }
                  }}
                />
              </label>
            </>
          )}
        </div>
      )}
      {filletEditorActive && (
        <div className="canvas-workflow-panel__inspector">
          <label className="canvas-workflow-panel__field">
            <span>{tool === 'chamfer' ? t('canvas.field.distance') : t('canvas.field.radius')}</span>
            <input
              ref={fillet.filletRadiusInputRef}
              className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
              type="text"
              inputMode="decimal"
              value={fillet.filletDimensionEdit?.radius ?? ''}
              onChange={(e) => {
                fillet.setFilletDimensionEdit((prev) => (prev ? { ...prev, radius: e.target.value } : null))
                scheduleDraw()
              }}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={closeFilletRadiusFromBlur}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitFilletRadiusFromField()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  dismissFilletRadiusFromField()
                }
              }}
            />
          </label>
        </div>
      )}
      {hasSelfIntersection && (
        <div className="canvas-workflow-panel__summary" style={{ color: 'var(--warning)' }}>{t('canvas.edit.warning.selfIntersecting')}</div>
      )}
      {exceedsStock && (
        <div className="canvas-workflow-panel__summary" style={{ color: 'var(--warning)' }}>{t('canvas.edit.warning.exceedsStock')}</div>
      )}
    </CanvasWorkflowPanel>
  )
}
