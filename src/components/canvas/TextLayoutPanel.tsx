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

import type { TextBaselineAnchor, TextBaselineFit, TextBaselineOrientation, TextLayout } from '../../types/project'
import type { TextLayoutKind } from '../../sketch/textPlacement'
import type { TextLayoutMeasure } from '../../text'
import { useI18n } from '../../i18n/i18nContext'
import { CanvasWorkflowAction, CanvasWorkflowCancel, CanvasWorkflowConfirm } from './CanvasWorkflowAction'
import { CanvasWorkflowPanel } from './CanvasWorkflowPanel'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

type LayoutMode = 'horizontal' | TextLayoutKind

interface TextLayoutPanelProps {
  layout: TextLayout | null
  /** Set once an arc's centre click has landed, so the panel can say what's next. */
  centerPicked: boolean
  guideName: string | null
  picking: boolean
  measure: TextLayoutMeasure | null
  /** Effective glyph height after a `fill` layout rescales the run. */
  effectiveSize: number
  panel: ReturnType<typeof useCanvasWorkflowPanel>
  onChangeMode: (mode: LayoutMode) => void
  onUpdate: (layout: TextLayout) => void
  onPickGuide: () => void
  onCancelPick: () => void
  onComplete: () => void
  onCancel: () => void
}

function inputNumber(event: React.ChangeEvent<HTMLInputElement>): number {
  const value = event.currentTarget.valueAsNumber
  return Number.isFinite(value) ? value : 0
}

export function TextLayoutPanel({
  layout,
  centerPicked,
  guideName,
  picking,
  measure,
  effectiveSize,
  panel,
  onChangeMode,
  onUpdate,
  onPickGuide,
  onCancelPick,
  onComplete,
  onCancel,
}: TextLayoutPanelProps) {
  const { t } = useI18n()
  const mode: LayoutMode = layout?.kind ?? 'horizontal'

  const step = picking
    ? t('canvas.textLayout.step.pickGuide')
    : mode === 'arc'
      ? centerPicked
        ? t('canvas.textLayout.step.setRadius')
        : t('canvas.textLayout.step.pickCenter')
      : mode === 'path'
        ? guideName
          ? t('canvas.textLayout.step.configure')
          : t('canvas.textLayout.step.needGuide')
        : t('canvas.textLayout.step.placeText')

  // Only a path layout commits from the panel; the others commit on the canvas
  // click that finishes their gesture.
  // Every mode applies from the panel: the run already exists, so there is no
  // placement click to commit on. An arc still needs its centre picked and a
  // path still needs its guide, so the button waits on whichever is missing.
  // Horizontal needs nothing — it is how a curved run is straightened again.
  const applyBlocked = picking
    || (mode === 'path' && !guideName)
    || (mode === 'arc' && !centerPicked)
  const warning = mode === 'path' && !guideName
    ? t('canvas.textLayout.error.guideRequired')
    : measure?.overflows
      ? t('canvas.textLayout.error.overflow')
      : null

  return (
    <CanvasWorkflowPanel
      title={t('canvas.textLayout.title')}
      step={step}
      position={panel.position}
      panelRef={panel.panelRef}
      handleProps={panel.handleProps}
      actionRowProps={panel.actionRowProps}
      className="canvas-workflow-panel--text-layout"
      pageLevel
      actions={(
        <>
          <CanvasWorkflowConfirm
            label={t('canvas.textLayout.create')}
            onClick={onComplete}
            disabled={applyBlocked}
          />
          <CanvasWorkflowCancel label={t('canvas.common.cancel')} onClick={onCancel} />
        </>
      )}
    >
      {picking ? (
        <div className="canvas-workflow-panel__picking-actions">
          <CanvasWorkflowAction label={t('canvas.textLayout.cancelPicking')} onClick={onCancelPick} variant="cancel" />
        </div>
      ) : (
        <>
          <div className="canvas-workflow-panel__grid">
            <label className="canvas-workflow-panel__field">
              <span>{t('canvas.textLayout.mode')}</span>
              <select value={mode} onChange={(event) => onChangeMode(event.currentTarget.value as LayoutMode)}>
                <option value="horizontal">{t('canvas.textLayout.mode.horizontal')}</option>
                <option value="arc">{t('canvas.textLayout.mode.arc')}</option>
                <option value="path">{t('canvas.textLayout.mode.path')}</option>
              </select>
            </label>
          </div>

          {layout?.kind === 'arc' && (
            <div className="canvas-workflow-panel__grid">
              <NumberField label={t('canvas.textLayout.radius')} value={layout.radius} onChange={(event) => onUpdate({ ...layout, radius: inputNumber(event) })} />
              <NumberField label={t('canvas.textLayout.angle')} value={layout.angleDegrees} onChange={(event) => onUpdate({ ...layout, angleDegrees: inputNumber(event) })} />
              <NumberField label={t('canvas.textLayout.sweep')} value={layout.sweepDegrees} onChange={(event) => onUpdate({ ...layout, sweepDegrees: inputNumber(event) })} />
              <label className="canvas-workflow-panel__field">
                <span>{t('canvas.textLayout.direction')}</span>
                <select value={layout.direction} onChange={(event) => onUpdate({ ...layout, direction: event.currentTarget.value as 'cw' | 'ccw' })}>
                  <option value="cw">{t('canvas.textLayout.direction.cw')}</option>
                  <option value="ccw">{t('canvas.textLayout.direction.ccw')}</option>
                </select>
              </label>
            </div>
          )}

          {layout?.kind === 'path' && (
            <div className="canvas-workflow-panel__grid">
              <div className="canvas-workflow-panel__field">
                <span>{t('canvas.textLayout.guide')}</span>
                <span className="canvas-workflow-panel__picker-selection">
                  {guideName && <strong>{guideName}</strong>}
                  <CanvasWorkflowAction
                    label={guideName ? t('canvas.textLayout.changeGuide') : t('canvas.textLayout.pickGuide')}
                    onClick={onPickGuide}
                  />
                </span>
              </div>
              <NumberField label={t('canvas.textLayout.startOffset')} value={layout.startOffset} onChange={(event) => onUpdate({ ...layout, startOffset: inputNumber(event) })} />
              <NumberField label={t('canvas.textLayout.endOffset')} value={layout.endOffset} onChange={(event) => onUpdate({ ...layout, endOffset: inputNumber(event) })} />
              <label className="canvas-workflow-panel__field">
                <span>{t('canvas.textLayout.reverse')}</span>
                <input
                  type="checkbox"
                  checked={layout.reversed}
                  onChange={(event) => onUpdate({ ...layout, reversed: event.currentTarget.checked })}
                />
              </label>
            </div>
          )}

          {layout && (
            <div className="canvas-workflow-panel__grid">
              <label className="canvas-workflow-panel__field">
                <span>{t('canvas.textLayout.anchor')}</span>
                <select value={layout.anchor} onChange={(event) => onUpdate({ ...layout, anchor: event.currentTarget.value as TextBaselineAnchor })}>
                  <option value="start">{t('canvas.textLayout.anchor.start')}</option>
                  <option value="center">{t('canvas.textLayout.anchor.center')}</option>
                  <option value="end">{t('canvas.textLayout.anchor.end')}</option>
                </select>
              </label>
              <label className="canvas-workflow-panel__field">
                <span>{t('canvas.textLayout.fit')}</span>
                <select value={layout.fit} onChange={(event) => onUpdate({ ...layout, fit: event.currentTarget.value as TextBaselineFit })}>
                  <option value="natural">{t('canvas.textLayout.fit.natural')}</option>
                  <option value="fill">{t('canvas.textLayout.fit.fill')}</option>
                </select>
              </label>
              <label className="canvas-workflow-panel__field canvas-workflow-panel__field--orientation">
                <span>{t('canvas.textLayout.orientation')}</span>
                <select value={layout.orientation} onChange={(event) => onUpdate({ ...layout, orientation: event.currentTarget.value as TextBaselineOrientation })}>
                  <option value="fixed">{t('canvas.textLayout.orientation.fixed')}</option>
                  <option value="follow">{t('canvas.textLayout.orientation.follow')}</option>
                </select>
              </label>
            </div>
          )}

          {/* A `fill` layout resizes the run, so the height it will actually cut
              is stated outright — nobody should engrave 4 mm expecting 10 mm. */}
          {layout?.fit === 'fill' && measure && (
            <p className="canvas-workflow-panel__hint">
              {t('canvas.textLayout.effectiveSize', { size: effectiveSize.toFixed(2) })}
            </p>
          )}
          {warning && <p className="canvas-workflow-panel__warning" role="alert">{warning}</p>}
        </>
      )}
    </CanvasWorkflowPanel>
  )
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <label className="canvas-workflow-panel__field">
      <span>{label}</span>
      <input
        className="canvas-workflow-panel__count-input"
        type="number"
        inputMode="decimal"
        step="any"
        value={value}
        onChange={onChange}
      />
    </label>
  )
}
