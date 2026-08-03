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
 * Post-import 3D orientation controls for an imported STL/OBJ model
 * (issue #241) — the answer to "my model came in lying on its side".
 *
 * Numeric entry plus 90° quick-rotate rather than a drag gizmo: the real need
 * is quarter-turns, the app is precision-oriented, and the 3D viewport is a
 * preview with no manipulator infrastructure. Numeric entry is also tablet-safe
 * (no hover, no fine drag).
 */

import { useState } from 'react'
import { DisclosureSection } from '../common/DisclosureSection'
import {
  liftImportedModel,
  reorientImportedModel,
} from '../project/importedModelArtifacts'
import { IDENTITY_MODEL_ORIENTATION, isIdentityModelOrientation } from '../../engine/importedModelTransform'
import { formatLength, parseLengthInput } from '../../utils/units'
import { useI18n } from '../../i18n/i18nContext'
import type { ModelOrientation } from '../../types/project'

type OrientationAxis = 'rx' | 'ry' | 'rz'

const AXES: ReadonlyArray<{ axis: OrientationAxis, labelKey: 'featureTree.properties.model.rotateX' | 'featureTree.properties.model.rotateY' | 'featureTree.properties.model.rotateZ' }> = [
  { axis: 'rx', labelKey: 'featureTree.properties.model.rotateX' },
  { axis: 'ry', labelKey: 'featureTree.properties.model.rotateY' },
  { axis: 'rz', labelKey: 'featureTree.properties.model.rotateZ' },
]

interface AngleInputProps {
  value: number
  disabled: boolean
  onCommit: (value: number) => void
}

/**
 * Degrees, committed on blur/Enter and reverted on Escape — same draft-edit
 * contract as the length inputs in the properties panel, without the unit
 * parsing (angles are unitless degrees in every project).
 */
function AngleInput({ value, disabled, onCommit }: AngleInputProps) {
  const display = String(Math.round(value * 1000) / 1000)

  function reset(element: HTMLInputElement) {
    element.value = display
  }

  function commit(element: HTMLInputElement) {
    const parsed = Number(element.value.trim())
    if (!Number.isFinite(parsed)) {
      reset(element)
      return
    }
    if (parsed === value) {
      reset(element)
      return
    }
    onCommit(parsed)
  }

  return (
    <input
      key={display}
      type="text"
      inputMode="decimal"
      defaultValue={display}
      disabled={disabled}
      spellCheck={false}
      data-numeric-entry="true"
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
          return
        }
        if (event.key === 'Escape') {
          reset(event.currentTarget)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

interface ModelOrientationSectionProps {
  featureId: string
  orientation: ModelOrientation | undefined
  zTop: number
  zBottom: number
  units: 'mm' | 'inch'
  /** How many instances share this definition; > 1 re-orients them together. */
  linkedInstanceCount: number
}

export function ModelOrientationSection({
  featureId,
  orientation,
  zTop,
  zBottom,
  units,
  linkedInstanceCount,
}: ModelOrientationSectionProps) {
  const { t, tPlural } = useI18n()
  // Re-deriving the silhouette, profile, and top view is a Z-slice projection
  // over the whole mesh, so it is async and can take a moment on a heavy model.
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState(false)
  const busy = progress !== null

  const current = orientation ?? IDENTITY_MODEL_ORIENTATION
  const isDefaultOrientation = isIdentityModelOrientation(orientation)
  const height = Math.abs(zTop - zBottom)

  async function applyOrientation(next: ModelOrientation | null) {
    if (busy) return
    setError(false)
    setProgress(0)
    try {
      const result = await reorientImportedModel(featureId, next, (percent) => {
        setProgress(Math.max(0, Math.min(100, Math.round(percent))))
      })
      if (!result) setError(true)
    } catch {
      setError(true)
    } finally {
      setProgress(null)
    }
  }

  function rotateBy(axis: OrientationAxis, delta: number) {
    void applyOrientation({ ...current, [axis]: current[axis] + delta })
  }

  return (
    <DisclosureSection
      title={t('featureTree.properties.model.orientation')}
      storageKey="feature-model-orientation"
    >
      {AXES.map(({ axis, labelKey }) => (
        <label className="properties-field properties-field--axis" key={axis}>
          <span>{t(labelKey)}</span>
          <div className="properties-axis-row">
            <AngleInput
              value={current[axis]}
              disabled={busy}
              onCommit={(next) => void applyOrientation({ ...current, [axis]: next })}
            />
            <button
              className="feat-btn properties-axis-btn"
              type="button"
              disabled={busy}
              title={t('featureTree.properties.model.rotateMinus90')}
              onClick={() => rotateBy(axis, -90)}
            >
              −90°
            </button>
            <button
              className="feat-btn properties-axis-btn"
              type="button"
              disabled={busy}
              title={t('featureTree.properties.model.rotatePlus90')}
              onClick={() => rotateBy(axis, 90)}
            >
              +90°
            </button>
          </div>
        </label>
      ))}
      <label className="properties-field">
        <span>{t('featureTree.properties.model.lift')}</span>
        <input
          key={`model-lift-${featureId}-${zBottom}`}
          type="text"
          inputMode="decimal"
          defaultValue={formatLength(zBottom, units)}
          disabled={busy}
          spellCheck={false}
          data-numeric-entry="true"
          title={t('featureTree.properties.model.liftTooltip')}
          onBlur={(event) => {
            const parsed = parseLengthInput(event.currentTarget.value, units)
            if (parsed === null || parsed < 0 || parsed === zBottom) {
              event.currentTarget.value = formatLength(zBottom, units)
              return
            }
            liftImportedModel(featureId, parsed)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
              return
            }
            if (event.key === 'Escape') {
              event.currentTarget.value = formatLength(zBottom, units)
              event.currentTarget.blur()
            }
          }}
        />
      </label>
      <div className="properties-model-hint">
        {t('featureTree.properties.model.heightHint', {
          height: `${formatLength(height, units)} ${units === 'inch' ? 'in' : 'mm'}`,
        })}
      </div>
      {linkedInstanceCount > 1 ? (
        <div className="properties-model-hint">
          {tPlural(
            linkedInstanceCount,
            'featureTree.properties.model.linkedHint.one',
            'featureTree.properties.model.linkedHint.other',
            { count: linkedInstanceCount },
          )}
        </div>
      ) : null}
      {busy ? (
        <div className="properties-model-hint">
          {t('featureTree.properties.model.working', { percent: progress ?? 0 })}
        </div>
      ) : null}
      {error ? (
        <div className="properties-warning">
          {t('featureTree.properties.model.rotateFailed')}
        </div>
      ) : null}
      <div className="properties-actions" style={{ marginTop: '8px' }}>
        <button
          className="feat-btn"
          type="button"
          disabled={busy || isDefaultOrientation}
          onClick={() => void applyOrientation(null)}
        >
          {t('featureTree.properties.model.resetOrientation')}
        </button>
      </div>
    </DisclosureSection>
  )
}
