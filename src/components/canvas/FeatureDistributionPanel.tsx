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
import type { FeatureDistributionPlan, FeatureDistributionSpec } from '../../sketch/featureDistribution'
import type { PendingFeatureDistribution } from '../../store/types'
import { useI18n } from '../../i18n/i18nContext'
import { CanvasWorkflowAction, CanvasWorkflowCancel, CanvasWorkflowConfirm } from './CanvasWorkflowAction'
import { CanvasWorkflowPanel } from './CanvasWorkflowPanel'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

interface FeatureDistributionPanelProps {
  pending: PendingFeatureDistribution
  plan: FeatureDistributionPlan
  sourcePivot: Point
  guideName: string | null
  panel: ReturnType<typeof useCanvasWorkflowPanel>
  onUpdate: (spec: FeatureDistributionSpec) => void
  onPickGuide: () => void
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
  panel,
  onUpdate,
  onPickGuide,
  onComplete,
  onCancel,
}: FeatureDistributionPanelProps) {
  const { t } = useI18n()
  const { spec } = pending
  const error = plan.ok ? null : {
    'invalid-grid': t('canvas.featureDistribution.error.invalidGrid'),
    'invalid-copy-count': t('canvas.featureDistribution.error.invalidCount'),
    'invalid-scale': t('canvas.featureDistribution.error.invalidScale'),
    'radial-center-overlaps-source': t('canvas.featureDistribution.error.centerOverlap'),
    'path-guide-required': t('canvas.featureDistribution.error.guideRequired'),
    'path-guide-empty': t('canvas.featureDistribution.error.guideEmpty'),
    'invalid-path-offsets': t('canvas.featureDistribution.error.invalidOffsets'),
  }[plan.code]

  function selectMode(mode: FeatureDistributionSpec['mode']) {
    const shared = { startScale: spec.startScale, endScale: spec.endScale }
    if (mode === 'grid') {
      onUpdate({ mode, rows: 1, columns: 2, spacingX: 20, spacingY: 20, ...shared })
    } else if (mode === 'radial') {
      onUpdate({
        mode,
        center: { x: sourcePivot.x - 20, y: sourcePivot.y },
        copyCount: 4,
        // Keep the initial preview clear of the source, which sits at the
        // 0° radius from this default center.
        startAngleDegrees: 90,
        sweepDegrees: 360,
        orientation: 'follow',
        ...shared,
      })
    } else {
      onUpdate({ mode, copyCount: 4, startOffset: 0, endOffset: 0, orientation: 'follow', ...shared })
    }
  }

  return (
    <CanvasWorkflowPanel
      title={t('canvas.featureDistribution.title')}
      step={pending.selectingGuide ? t('canvas.featureDistribution.step.pickGuide') : t('canvas.featureDistribution.step.configure')}
      position={panel.position}
      panelRef={panel.panelRef}
      handleProps={panel.handleProps}
      actionRowProps={panel.actionRowProps}
      className="canvas-workflow-panel--feature-distribution"
      actions={(
        <>
          {spec.mode === 'path' && (
            <CanvasWorkflowAction
              label={guideName ? t('canvas.featureDistribution.changeGuide') : t('canvas.featureDistribution.pickGuide')}
              onClick={onPickGuide}
            />
          )}
          <CanvasWorkflowConfirm label={t('canvas.featureDistribution.create')} onClick={onComplete} disabled={!plan.ok || pending.selectingGuide} />
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
          <NumberField label={t('canvas.featureDistribution.centerX')} value={spec.center.x} onChange={(event) => onUpdate({ ...spec, center: { ...spec.center, x: inputNumber(event) } })} />
          <NumberField label={t('canvas.featureDistribution.centerY')} value={spec.center.y} onChange={(event) => onUpdate({ ...spec, center: { ...spec.center, y: inputNumber(event) } })} />
          <NumberField label={t('canvas.field.copies')} value={spec.copyCount} integer onChange={(event) => onUpdate({ ...spec, copyCount: inputNumber(event) })} />
          <NumberField label={t('canvas.featureDistribution.startAngle')} value={spec.startAngleDegrees} onChange={(event) => onUpdate({ ...spec, startAngleDegrees: inputNumber(event) })} />
          <NumberField label={t('canvas.featureDistribution.sweep')} value={spec.sweepDegrees} onChange={(event) => onUpdate({ ...spec, sweepDegrees: inputNumber(event) })} />
          <OrientationField value={spec.orientation} onChange={(orientation) => onUpdate({ ...spec, orientation })} />
        </div>
      )}

      {spec.mode === 'path' && (
        <div className="canvas-workflow-panel__grid">
          <div className="canvas-workflow-panel__field">
            <span>{t('canvas.featureDistribution.guide')}</span>
            <strong>{guideName ?? '—'}</strong>
          </div>
          <NumberField label={t('canvas.field.copies')} value={spec.copyCount} integer onChange={(event) => onUpdate({ ...spec, copyCount: inputNumber(event) })} />
          <NumberField label={t('canvas.featureDistribution.startOffset')} value={spec.startOffset} onChange={(event) => onUpdate({ ...spec, startOffset: inputNumber(event) })} />
          <NumberField label={t('canvas.featureDistribution.endOffset')} value={spec.endOffset} onChange={(event) => onUpdate({ ...spec, endOffset: inputNumber(event) })} />
          <OrientationField value={spec.orientation} onChange={(orientation) => onUpdate({ ...spec, orientation })} />
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
