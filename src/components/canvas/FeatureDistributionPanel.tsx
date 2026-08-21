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

import type { Point } from '../../types/project'
import { createDefaultFeatureDistributionSpec, type FeatureDistributionPlan, type FeatureDistributionSpec } from '../../sketch/featureDistribution'
import type { PendingFeatureDistribution } from '../../store/types'
import type { Units } from '../../utils/units'
import { useI18n } from '../../i18n/i18nContext'
import { CanvasWorkflowAction, CanvasWorkflowCancel, CanvasWorkflowConfirm } from './CanvasWorkflowAction'
import { CanvasWorkflowPanel } from './CanvasWorkflowPanel'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

interface FeatureDistributionPanelProps {
  pending: PendingFeatureDistribution
  plan: FeatureDistributionPlan
  sourcePivot: Point
  guideName: string | null
  units: Units
  panel: ReturnType<typeof useCanvasWorkflowPanel>
  onUpdate: (spec: FeatureDistributionSpec) => void
  onPickGuide: () => void
  onPickCenter: () => void
  onCancelPick: () => void
  onComplete: () => void
  onCancel: () => void
}

function inputNumber(event: React.ChangeEvent<HTMLInputElement>): number {
  const value = event.currentTarget.valueAsNumber
  return Number.isFinite(value) ? value : 0
}

export function FeatureDistributionPanel({
  pending,
  plan,
  sourcePivot,
  guideName,
  units,
  panel,
  onUpdate,
  onPickGuide,
  onPickCenter,
  onCancelPick,
  onComplete,
  onCancel,
}: FeatureDistributionPanelProps) {
  const { t } = useI18n()
  const { spec } = pending
  const planError = plan.ok ? null : {
    'invalid-grid': t('canvas.featureDistribution.error.invalidGrid'),
    'invalid-copy-count': t('canvas.featureDistribution.error.invalidCount'),
    'invalid-scale': t('canvas.featureDistribution.error.invalidScale'),
    'radial-center-overlaps-source': t('canvas.featureDistribution.error.centerOverlap'),
    'path-guide-required': t('canvas.featureDistribution.error.guideRequired'),
    'path-guide-empty': t('canvas.featureDistribution.error.guideEmpty'),
    'invalid-path-offsets': t('canvas.featureDistribution.error.invalidOffsets'),
  }[plan.code]
  const radialCenterRequired = spec.mode === 'radial' && !pending.radialCenterPicked
  const error = radialCenterRequired
    ? t('canvas.featureDistribution.error.centerRequired')
    : planError

  function selectMode(mode: FeatureDistributionSpec['mode']) {
    if (mode === spec.mode) return
    const shared = { startScale: spec.startScale, endScale: spec.endScale }
    if (mode === 'grid') {
      const defaults = createDefaultFeatureDistributionSpec(units)
      if (defaults.mode === 'grid') onUpdate({ ...defaults, ...shared })
    } else if (mode === 'radial') {
      onUpdate({
        mode,
        // This fallback is never exposed as a coordinate. Radial copies remain
        // unavailable until the user picks an actual point on the sketch.
        center: sourcePivot,
        copyCount: 4,
        sweepDegrees: 360,
        orientation: 'follow',
        ...shared,
      })
    } else {
      onUpdate({ mode, copyCount: 4, startOffset: 0, endOffset: 0, orientation: 'follow', ...shared })
    }
  }

  const step = pending.pickTarget === 'guide'
    ? t('canvas.featureDistribution.step.pickGuide')
    : pending.pickTarget === 'radial-center'
      ? t('canvas.featureDistribution.step.pickCenter')
      : t('canvas.featureDistribution.step.configure')
  const orientationHelp = spec.mode !== 'grid' && spec.orientation === 'fixed'
    ? t('canvas.featureDistribution.fixedOrientationHint')
    : t('canvas.featureDistribution.followOrientationHint')

  return (
    <CanvasWorkflowPanel
      title={t('canvas.featureDistribution.title')}
      step={step}
      position={panel.position}
      panelRef={panel.panelRef}
      handleProps={panel.handleProps}
      actionRowProps={panel.actionRowProps}
      className="canvas-workflow-panel--feature-distribution"
      actions={(
        <>
          <CanvasWorkflowConfirm label={t('canvas.featureDistribution.create')} onClick={onComplete} disabled={!plan.ok || radialCenterRequired || pending.pickTarget !== null} />
          <CanvasWorkflowCancel label={t('canvas.common.cancel')} onClick={onCancel} />
        </>
      )}
    >
      <div className="canvas-workflow-panel__field">
        <span>{t('canvas.featureDistribution.title')}</span>
        <div className="canvas-workflow-panel__segmented-control" role="group" aria-label={t('canvas.featureDistribution.title')}>
          <button type="button" aria-pressed={spec.mode === 'grid'} onClick={() => selectMode('grid')}>{t('canvas.featureDistribution.grid')}</button>
          <button type="button" aria-pressed={spec.mode === 'radial'} onClick={() => selectMode('radial')}>{t('canvas.featureDistribution.radial')}</button>
          <button type="button" aria-pressed={spec.mode === 'path'} onClick={() => selectMode('path')}>{t('canvas.featureDistribution.path')}</button>
        </div>
      </div>

      {spec.mode === 'grid' && (
        <div className="canvas-workflow-panel__grid">
          <NumberField label={t('canvas.featureDistribution.rows')} value={spec.rows} onChange={(event) => onUpdate({ ...spec, rows: inputNumber(event) })} />
          <NumberField label={t('canvas.featureDistribution.columns')} value={spec.columns} onChange={(event) => onUpdate({ ...spec, columns: inputNumber(event) })} />
          <NumberField label={t('canvas.featureDistribution.spacingX')} value={spec.spacingX} onChange={(event) => onUpdate({ ...spec, spacingX: inputNumber(event) })} />
          <NumberField label={t('canvas.featureDistribution.spacingY')} value={spec.spacingY} onChange={(event) => onUpdate({ ...spec, spacingY: inputNumber(event) })} />
        </div>
      )}

      {spec.mode === 'radial' && (
        <div className="canvas-workflow-panel__grid">
          <div className="canvas-workflow-panel__field">
            <span>{t('canvas.featureDistribution.center')}</span>
            {pending.pickTarget === 'radial-center' ? (
              <PickerInstruction hint={t('canvas.featureDistribution.pickCenterHint')} onCancel={onCancelPick} />
            ) : (
              <PickerSelection label={pending.radialCenterPicked ? t('canvas.featureDistribution.centerPicked') : null}>
                <CanvasWorkflowAction
                  label={pending.radialCenterPicked ? t('canvas.featureDistribution.changeCenter') : t('canvas.featureDistribution.pickCenter')}
                  onClick={onPickCenter}
                />
              </PickerSelection>
            )}
          </div>
          <NumberField label={t('canvas.featureDistribution.instanceCount')} value={spec.copyCount} integer onChange={(event) => onUpdate({ ...spec, copyCount: inputNumber(event) })} />
          <NumberField label={t('canvas.featureDistribution.sweep')} value={spec.sweepDegrees} onChange={(event) => onUpdate({ ...spec, sweepDegrees: inputNumber(event) })} />
          <OrientationField value={spec.orientation} onChange={(orientation) => onUpdate({ ...spec, orientation })} />
          <p className="canvas-workflow-panel__help">{orientationHelp}</p>
        </div>
      )}

      {spec.mode === 'path' && (
        <div className="canvas-workflow-panel__grid">
          <div className="canvas-workflow-panel__field">
            <span>{t('canvas.featureDistribution.guide')}</span>
            {pending.pickTarget === 'guide' ? (
              <PickerInstruction hint={t('canvas.featureDistribution.pickGuideHint')} onCancel={onCancelPick} />
            ) : (
              <PickerSelection label={guideName}>
                <CanvasWorkflowAction
                  label={guideName ? t('canvas.featureDistribution.changeGuide') : t('canvas.featureDistribution.pickGuide')}
                  onClick={onPickGuide}
                />
              </PickerSelection>
            )}
          </div>
          <NumberField label={t('canvas.featureDistribution.instanceCount')} value={spec.copyCount} integer onChange={(event) => onUpdate({ ...spec, copyCount: inputNumber(event) })} />
          <NumberField label={t('canvas.featureDistribution.startOffset')} value={spec.startOffset} onChange={(event) => onUpdate({ ...spec, startOffset: inputNumber(event) })} />
          <NumberField label={t('canvas.featureDistribution.endOffset')} value={spec.endOffset} onChange={(event) => onUpdate({ ...spec, endOffset: inputNumber(event) })} />
          <OrientationField value={spec.orientation} onChange={(orientation) => onUpdate({ ...spec, orientation })} />
          <p className="canvas-workflow-panel__help">{orientationHelp}</p>
        </div>
      )}

      <div className="canvas-workflow-panel__grid">
        <NumberField label={t('canvas.featureDistribution.startScale')} value={spec.startScale} onChange={(event) => onUpdate({ ...spec, startScale: inputNumber(event) })} />
        <NumberField label={t('canvas.featureDistribution.endScale')} value={spec.endScale} onChange={(event) => onUpdate({ ...spec, endScale: inputNumber(event) })} />
      </div>
      {error && <p className="canvas-workflow-panel__warning" role="alert">{error}</p>}
    </CanvasWorkflowPanel>
  )
}

function PickerInstruction({ hint, onCancel }: { hint: string; onCancel: () => void }) {
  const { t } = useI18n()
  return (
    <span className="canvas-workflow-panel__picker-instruction">
      <span>{hint}</span>
      <CanvasWorkflowAction label={t('canvas.featureDistribution.cancelPicking')} onClick={onCancel} variant="cancel" />
    </span>
  )
}

function PickerSelection({ label, children }: { label: string | null; children: React.ReactNode }) {
  return (
    <span className="canvas-workflow-panel__picker-selection">
      {label && <strong>{label}</strong>}
      {children}
    </span>
  )
}

function NumberField({
  label,
  value,
  integer = false,
  onChange,
}: {
  label: string
  value: number
  integer?: boolean
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <label className="canvas-workflow-panel__field">
      <span>{label}</span>
      <input
        className="canvas-workflow-panel__count-input"
        type="number"
        inputMode="decimal"
        step={integer ? 1 : 'any'}
        value={value}
        onChange={onChange}
      />
    </label>
  )
}

function OrientationField({
  value,
  onChange,
}: {
  value: 'fixed' | 'follow'
  onChange: (value: 'fixed' | 'follow') => void
}) {
  const { t } = useI18n()
  return (
    <label className="canvas-workflow-panel__field">
      <span>{t('canvas.featureDistribution.orientation')}</span>
      <select value={value} onChange={(event) => onChange(event.currentTarget.value as 'fixed' | 'follow')}>
        <option value="fixed">{t('canvas.featureDistribution.fixedOrientation')}</option>
        <option value="follow">{t('canvas.featureDistribution.followOrientation')}</option>
      </select>
    </label>
  )
}
