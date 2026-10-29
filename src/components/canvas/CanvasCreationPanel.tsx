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

/**
 * The creation side panel (extracted from SketchCanvas for the max-lines cap).
 *
 * A pure move: the panel's markup, phase text and actions are unchanged. The
 * canvas shell owns the workflow hooks and passes their results in; this module
 * only renders the shape-specific fields.
 */

import type { RefObject } from 'react'
import type { Project } from '../../types/project'
import type { GearCreationParams } from '../../sketch/gearProfile'
import type { CreationTarget, PendingAddTool } from '../../store/types'
import { useProjectStore } from '../../store/projectStore'
import { useI18n } from '../../i18n/i18nContext'
import { CanvasWorkflowAction, CanvasWorkflowCancel, CanvasWorkflowConfirm } from './CanvasWorkflowAction'
import { CanvasWorkflowPanel } from './CanvasWorkflowPanel'
import { CANVAS_SHORTCUT, withShortcut } from './canvasShortcuts'
import { NgonParameterPanel, RectCornerParameterPanel } from './CreationParameterReferences'
import { GearParameterPanel } from './GearParameterPanel'
import { RotaryPatternPanel } from './RotaryPatternPanel'
import { RotarySolidPanel } from './RotarySolidPanel'
import type { CreationWorkflow } from './useCreationWorkflow'
import type { DimensionEditWorkflow } from './useDimensionEditWorkflow'

/* eslint-disable react-hooks/refs -- This leaf component forwards refs produced
   by the canvas workflow hooks (dimEdit) into JSX, like EditSketchPanel. */

export interface CanvasCreationPanelProps {
  creation: CreationWorkflow
  pendingAdd: PendingAddTool | null
  project: Project
  creationTarget: CreationTarget
  dimEdit: DimensionEditWorkflow
  pendingDraftHasSelfIntersection: boolean
  pendingDraftExceedsStock: boolean
  setPendingGearParams: (patch: Partial<GearCreationParams>) => void
  setPendingNgonSides: (sides: number) => void
  setPendingRectCorner: (corner: number) => void
  /** The canvas container, for the panels that position themselves against it. */
  containerRef: RefObject<HTMLElement | null>
  canvasRef: RefObject<HTMLElement | null>
  clearTransientCanvasState: () => void
}

export function CanvasCreationPanel({
  creation,
  pendingAdd,
  project,
  creationTarget,
  dimEdit,
  pendingDraftHasSelfIntersection,
  pendingDraftExceedsStock,
  setPendingGearParams,
  setPendingNgonSides,
  setPendingRectCorner,
  containerRef,
  canvasRef,
  clearTransientCanvasState,
}: CanvasCreationPanelProps) {
  const { t } = useI18n()
  const cancelPendingAdd = useProjectStore((state) => state.cancelPendingAdd)

  // The rotary kinds are created in the same page-level canvas panel the other
  // canned shapes use, so their fields and their Create/Cancel live in their
  // own components rather than in the shape switch below (issue #1112 rt2-b).
  if (pendingAdd?.shape === 'rotary-solid') {
    return (
      <RotarySolidPanel
        kind={pendingAdd.kind}
        onClose={cancelPendingAdd}
        containerRef={containerRef}
        canvasRef={canvasRef}
        clearTransientCanvasState={clearTransientCanvasState}
      />
    )
  }
  if (pendingAdd?.shape === 'rotary-pattern') {
    return (
      <RotaryPatternPanel
        kind={pendingAdd.kind}
        onClose={cancelPendingAdd}
        containerRef={containerRef}
        canvasRef={canvasRef}
        clearTransientCanvasState={clearTransientCanvasState}
      />
    )
  }

  return (
    <>
      {creation.creationPanelShape && pendingAdd && (
        <CanvasWorkflowPanel
          title={
            creation.creationPanelShape === 'rect' ? t('canvas.shape.rectangle')
            : creation.creationPanelShape === 'circle' ? t('canvas.shape.circle')
            : creation.creationPanelShape === 'ellipse' ? t('canvas.shape.ellipse')
            : creation.creationPanelShape === 'tab' ? t('canvas.shape.tab')
            : creation.creationPanelShape === 'clamp' ? t('canvas.shape.clamp')
            : creation.creationPanelShape === 'polygon' ? t('canvas.shape.polygon')
            : creation.creationPanelShape === 'spline' ? t('canvas.shape.spline')
            : creation.creationPanelShape === 'slot' ? t('canvas.shape.slot')
            : creation.creationPanelShape === 'ngon' ? t('canvas.shape.regularPolygon')
            : creation.creationPanelShape === 'gear' ? t('canvas.shape.gear')
            : creation.creationPanelShape === 'roundrect' ? t('canvas.shape.roundedRectangle')
            : creation.creationPanelShape === 'chamferrect' ? t('canvas.shape.chamferedRectangle')
            : t('canvas.shape.composite')
          }
          step={
            creation.creationDimEditActive ? t('canvas.creation.step.enterDimensions')
            : creation.creationPanelShape === 'composite'
              ? (pendingAdd.shape === 'composite' && pendingAdd.start
                ? (pendingAdd.currentMode === 'arc' && pendingAdd.pendingArcEnd
                  ? t('canvas.creation.step.clickArcCurvature')
                  : t('canvas.creation.step.addPoints', { mode: pendingAdd.currentMode }))
                : t('canvas.creation.step.clickFirstPoint'))
            : (creation.creationPanelShape === 'polygon' || creation.creationPanelShape === 'spline')
              ? (creation.creationPanelHasPoints
                ? ('points' in pendingAdd && pendingAdd.points.length < 2
                  ? t('canvas.creation.step.addOneMore')
                  : t('canvas.creation.step.addPointsOrClose'))
                : t('canvas.creation.step.clickFirstPoint'))
            : creation.creationPanelShape === 'slot'
              ? (pendingAdd.shape === 'slot' && pendingAdd.points.length >= 2
                ? t('canvas.creation.step.slotSetWidth')
                : pendingAdd.shape === 'slot' && pendingAdd.points.length === 1
                  ? t('canvas.creation.step.slotSecondEnd')
                  : t('canvas.creation.step.slotFirstEnd'))
            : creation.creationPanelShape === 'gear'
              ? (pendingAdd.shape === 'gear' && pendingAdd.outsideRadius !== null ? t('canvas.creation.step.gearParams') : pendingAdd.shape === 'gear' && pendingAdd.anchor ? t('canvas.creation.step.gearSetRadius') : t('canvas.creation.step.clickCenterPoint'))
            : creation.creationPanelHasAnchor
              ? (creation.creationPanelShape === 'circle'
                ? t('canvas.creation.step.setRadiusOrDimensions')
                : creation.creationPanelShape === 'ellipse'
                  ? t('canvas.creation.step.setRadiiOrDimensions')
                  : creation.creationPanelShape === 'ngon'
                    ? t('canvas.creation.step.setRadius')
                    : t('canvas.creation.step.setCornerOrDimensions'))
              : (creation.creationPanelShape === 'circle' || creation.creationPanelShape === 'ellipse' || creation.creationPanelShape === 'ngon')
                ? t('canvas.creation.step.clickCenterPoint')
                : t('canvas.creation.step.clickFirstCorner')
          }
          position={creation.creationWorkflowPanel.position}
          panelRef={creation.creationWorkflowPanel.panelRef}
          handleProps={creation.creationWorkflowPanel.handleProps}
          pageLevel
          actionRowProps={creation.creationWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--creation"
          moveLabel={t('canvas.creation.moveLabel')}
          actions={(
            <>
              {creation.creationDimEditActive && (
                <CanvasWorkflowConfirm label={t('canvas.common.confirm')} onClick={creation.commitCreationDimensionEdit} />
              )}
              {(pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline') && 'points' in pendingAdd && pendingAdd.points.length >= 2 && creationTarget !== 'region' && !creation.creationDimEditActive && (
                <CanvasWorkflowConfirm label={t('canvas.common.finish')} onClick={creation.finishOpenPathFromPanel} />
              )}
              {pendingAdd.shape === 'composite' && pendingAdd.segments.length >= 1 && !pendingAdd.pendingArcEnd && creationTarget !== 'region' && !creation.creationDimEditActive && (
                <CanvasWorkflowConfirm label={t('canvas.common.finish')} onClick={creation.finishOpenCompositeFromPanel} />
              )}
              {pendingAdd.shape === 'gear' && pendingAdd.outsideRadius !== null && !creation.creationDimEditActive && (
                <CanvasWorkflowAction variant="confirm" icon="check" label={t('canvas.creation.confirmGear')} onClick={creation.completeGearFromPanel} />
              )}
              {creation.creationCanDimEdit && !creation.creationDimEditActive && (
                <CanvasWorkflowAction
                  shortcut={CANVAS_SHORTCUT.dimensions}
                  label={pendingAdd.shape === 'slot' && 'points' in pendingAdd && pendingAdd.points.length >= 2 ? t('canvas.creation.widthButton') : (pendingAdd.shape === 'ngon' || pendingAdd.shape === 'gear') ? t('canvas.creation.radiusButton') : t('canvas.creation.dimensionsButton')}
                  onClick={creation.triggerDimensionFromCreationPanel}
                />
              )}
              {((creation.creationPanelHasPoints && pendingAdd.shape !== 'slot') || (pendingAdd.shape === 'composite' && pendingAdd.start)) && !creation.creationDimEditActive && (
                <CanvasWorkflowAction
                  icon="undo"
                  // Backspace only undoes a point for the multi-point shapes; other
                  // shapes have the button but no key, so they get no hint.
                  shortcut={pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline' || pendingAdd.shape === 'composite' ? CANVAS_SHORTCUT.undo : undefined}
                  label={t('canvas.common.undo')}
                  onClick={creation.undoFromCreationPanel}
                />
              )}
              <CanvasWorkflowCancel label={t('canvas.common.cancel')} onClick={creation.cancelCreationFromPanel} />
            </>
          )}
        >
          {pendingAdd.shape === 'composite' && pendingAdd.start && !pendingAdd.closed && !creation.creationDimEditActive && (
            <div className="canvas-workflow-panel__meta canvas-workflow-panel__mode-row">
              <button
                type="button"
                className={`tablet-cmd-btn ${pendingAdd.currentMode === 'line' ? 'tablet-cmd-btn--active' : ''}`}
                onClick={() => creation.setCompositeModeFromPanel('line')}
              >{withShortcut(t('canvas.composite.mode.line'), CANVAS_SHORTCUT.compositeLine)}</button>
              <button
                type="button"
                className={`tablet-cmd-btn ${pendingAdd.currentMode === 'arc' ? 'tablet-cmd-btn--active' : ''}`}
                onClick={() => creation.setCompositeModeFromPanel('arc')}
              >{withShortcut(t('canvas.composite.mode.arc'), CANVAS_SHORTCUT.compositeArc)}</button>
              <button
                type="button"
                className={`tablet-cmd-btn ${pendingAdd.currentMode === 'spline' ? 'tablet-cmd-btn--active' : ''}`}
                onClick={() => creation.setCompositeModeFromPanel('spline')}
              >{withShortcut(t('canvas.composite.mode.spline'), CANVAS_SHORTCUT.compositeSpline)}</button>
            </div>
          )}
          {creation.creationDimEditActive && dimEdit.dimensionEdit && (
            <div className="canvas-workflow-panel__meta">
              {dimEdit.dimensionEdit.shape === 'circle' ? (
                <label className="canvas-workflow-panel__field">
                  <span>{t('canvas.field.radius')}</span>
                  <input
                    ref={dimEdit.radiusInputRef}
                    className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                    type="text"
                    inputMode="decimal"
                    value={dimEdit.dimensionEdit.radius}
                    onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, radius: e.target.value } : null)}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        creation.commitCreationDimensionEdit()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        creation.cancelCreationDimensionEdit()
                      }
                    }}
                    autoFocus
                  />
                </label>
              ) : (dimEdit.dimensionEdit.shape === 'composite' && dimEdit.dimensionEdit.arcStart && dimEdit.dimensionEdit.arcEnd) ? (
                <label className="canvas-workflow-panel__field">
                  <span>{t('canvas.field.radius')}</span>
                  <input
                    ref={dimEdit.radiusInputRef}
                    className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                    type="text"
                    inputMode="decimal"
                    value={dimEdit.dimensionEdit.radius}
                    onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, radius: e.target.value } : null)}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        creation.commitCreationDimensionEdit()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        creation.cancelCreationDimensionEdit()
                      }
                    }}
                    autoFocus
                  />
                </label>
              ) : (dimEdit.dimensionEdit.shape === 'polygon' || dimEdit.dimensionEdit.shape === 'spline' || dimEdit.dimensionEdit.shape === 'composite') ? (
                <>
                  <label className="canvas-workflow-panel__field">
                    <span>{t('canvas.field.length')}</span>
                    <input
                      ref={dimEdit.widthInputRef}
                      className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                      type="text"
                      inputMode="decimal"
                      value={dimEdit.dimensionEdit.length}
                      onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, length: e.target.value } : null)}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          creation.commitCreationDimensionEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          creation.cancelCreationDimensionEdit()
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
                      onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, angle: e.target.value } : null)}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          creation.commitCreationDimensionEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          creation.cancelCreationDimensionEdit()
                        } else if (e.key === 'Tab') {
                          e.preventDefault()
                          if (pendingAdd?.shape === 'composite' && pendingAdd.currentMode === 'arc' && !pendingAdd.pendingArcEnd) {
                            dimEdit.radiusInputRef.current?.focus({ preventScroll: true })
                          } else {
                            dimEdit.widthInputRef.current?.focus({ preventScroll: true })
                          }
                        }
                      }}
                    />
                  </label>
                  {pendingAdd?.shape === 'composite' && pendingAdd.currentMode === 'arc' && !pendingAdd.pendingArcEnd && (
                    <label className="canvas-workflow-panel__field">
                      <span>{t('canvas.field.radius')}</span>
                      <input
                        ref={dimEdit.radiusInputRef}
                        className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                        type="text"
                        inputMode="decimal"
                        value={dimEdit.dimensionEdit.radius}
                        onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, radius: e.target.value } : null)}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            creation.commitCreationDimensionEdit()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            creation.cancelCreationDimensionEdit()
                          } else if (e.key === 'Tab') {
                            e.preventDefault()
                            dimEdit.widthInputRef.current?.focus({ preventScroll: true })
                          }
                        }}
                      />
                    </label>
                  )}
                </>
              ) : dimEdit.dimensionEdit.shape === 'slot' ? (
                dimEdit.dimensionEdit.arcEnd ? (
                  <label className="canvas-workflow-panel__field">
                    <span>{t('canvas.field.width')}</span>
                    <input
                      ref={dimEdit.widthInputRef}
                      className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                      type="text"
                      inputMode="decimal"
                      value={dimEdit.dimensionEdit.width}
                      onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, width: e.target.value } : null)}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') { e.preventDefault(); creation.commitCreationDimensionEdit() }
                        else if (e.key === 'Escape') { e.preventDefault(); creation.cancelCreationDimensionEdit() }
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
                        onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, length: e.target.value } : null)}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') { e.preventDefault(); creation.commitCreationDimensionEdit() }
                          else if (e.key === 'Escape') { e.preventDefault(); creation.cancelCreationDimensionEdit() }
                          else if (e.key === 'Tab') { e.preventDefault(); dimEdit.heightInputRef.current?.focus({ preventScroll: true }) }
                        }}
                        autoFocus
                      />
                    </label>
                    <label className="canvas-workflow-panel__field">
                      <span>{t('canvas.field.angleDeg')}</span>
                      <input
                        ref={dimEdit.heightInputRef}
                        className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                        type="text"
                        inputMode="decimal"
                        value={dimEdit.dimensionEdit.angle}
                        onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, angle: e.target.value } : null)}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') { e.preventDefault(); creation.commitCreationDimensionEdit() }
                          else if (e.key === 'Escape') { e.preventDefault(); creation.cancelCreationDimensionEdit() }
                          else if (e.key === 'Tab') { e.preventDefault(); dimEdit.radiusInputRef.current?.focus({ preventScroll: true }) }
                        }}
                      />
                    </label>
                    <label className="canvas-workflow-panel__field">
                      <span>{t('canvas.field.width')}</span>
                      <input
                        ref={dimEdit.radiusInputRef}
                        className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                        type="text"
                        inputMode="decimal"
                        value={dimEdit.dimensionEdit.radius}
                        onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, radius: e.target.value } : null)}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') { e.preventDefault(); creation.commitCreationDimensionEdit() }
                          else if (e.key === 'Escape') { e.preventDefault(); creation.cancelCreationDimensionEdit() }
                          else if (e.key === 'Tab') { e.preventDefault(); creation.cancelCreationDimensionEdit() }
                        }}
                      />
                    </label>
                  </>
                )
              ) : (dimEdit.dimensionEdit.shape === 'ngon' || dimEdit.dimensionEdit.shape === 'gear') ? (
                <label className="canvas-workflow-panel__field">
                  <span>{t('canvas.field.radius')}</span>
                  <input
                    ref={dimEdit.radiusInputRef}
                    className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                    type="text"
                    inputMode="decimal"
                    value={dimEdit.dimensionEdit.radius}
                    onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, radius: e.target.value } : null)}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') { e.preventDefault(); creation.commitCreationDimensionEdit() }
                      else if (e.key === 'Escape') { e.preventDefault(); creation.cancelCreationDimensionEdit() }
                    }}
                    autoFocus
                  />
                </label>
              ) : (
                <>
                  <label className="canvas-workflow-panel__field">
                    <span>{t('canvas.field.width')}</span>
                    <input
                      ref={dimEdit.widthInputRef}
                      className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                      type="text"
                      inputMode="decimal"
                      value={dimEdit.dimensionEdit.width}
                      onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, width: e.target.value } : null)}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          creation.commitCreationDimensionEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          creation.cancelCreationDimensionEdit()
                        } else if (e.key === 'Tab') {
                          e.preventDefault()
                          dimEdit.heightInputRef.current?.focus({ preventScroll: true })
                        }
                      }}
                      autoFocus
                    />
                  </label>
                  <label className="canvas-workflow-panel__field">
                    <span>{t('canvas.field.height')}</span>
                    <input
                      ref={dimEdit.heightInputRef}
                      className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                      type="text"
                      inputMode="decimal"
                      value={dimEdit.dimensionEdit.height}
                      onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, height: e.target.value } : null)}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          creation.commitCreationDimensionEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          creation.cancelCreationDimensionEdit()
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
          {pendingAdd.shape === 'gear' && !creation.creationDimEditActive && (<GearParameterPanel pendingAdd={pendingAdd} units={project.meta.units} setPendingGearParams={setPendingGearParams} />)}
          {pendingAdd.shape === 'ngon' && !creation.creationDimEditActive && (
            <NgonParameterPanel pendingAdd={pendingAdd} setPendingNgonSides={setPendingNgonSides} />
          )}
          {(pendingAdd.shape === 'roundrect' || pendingAdd.shape === 'chamferrect') && !creation.creationDimEditActive && (
            <RectCornerParameterPanel pendingAdd={pendingAdd} setPendingRectCorner={setPendingRectCorner} />
          )}
          {pendingDraftHasSelfIntersection ? (
            <div className="sketch-banner-warning">{t('canvas.warning.selfIntersect')}</div>
          ) : null}
          {pendingDraftExceedsStock ? (
            <div className="sketch-banner-warning">{t('canvas.warning.exceedsStock')}</div>
          ) : null}
        </CanvasWorkflowPanel>
      )}
    </>
  )
}
