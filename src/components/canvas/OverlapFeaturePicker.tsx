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

import type { FeatureKind } from '../../types/project'
import { CanvasWorkflowPanel } from './CanvasWorkflowPanel'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import type { OverlapFeaturePickerController } from './useOverlapFeaturePicker'

interface OverlapFeaturePickerProps {
  picker: OverlapFeaturePickerController
}

const FEATURE_KIND_LABEL_KEYS: Record<FeatureKind, MessageKey> = {
  rect: 'canvas.overlap.kind.rect',
  circle: 'canvas.overlap.kind.circle',
  ellipse: 'canvas.overlap.kind.ellipse',
  polygon: 'canvas.overlap.kind.polygon',
  spline: 'canvas.overlap.kind.spline',
  composite: 'canvas.overlap.kind.composite',
  text: 'canvas.overlap.kind.text',
  stl: 'canvas.overlap.kind.stl',
}

export function OverlapFeaturePicker({ picker }: OverlapFeaturePickerProps) {
  const { t, tPlural } = useI18n()

  if (!picker.isOpen) return null

  const candidateCount = picker.candidates.length

  return (
    <div className="overlap-feature-picker" role="dialog" aria-label={t('canvas.overlap.dialogAria')} aria-modal="false">
      <CanvasWorkflowPanel
        title={t('canvas.overlap.title')}
        step={tPlural(candidateCount, 'canvas.overlap.step.one', 'canvas.overlap.step.other')}
        position={picker.workflowPanel.position}
        panelRef={picker.workflowPanel.panelRef}
        handleProps={picker.workflowPanel.handleProps}
        actionRowProps={picker.workflowPanel.actionRowProps}
        className="overlap-feature-picker__panel"
        moveLabel={t('canvas.overlap.moveLabel')}
        actions={(
          <button
            type="button"
            className="tablet-cmd-btn tablet-cmd-btn--cancel"
            onClick={picker.cancel}
          >{t('canvas.overlap.cancel')}</button>
        )}
      >
        <div className="overlap-feature-picker__list" aria-label={t('canvas.overlap.listAria')}>
          {picker.candidates.map((candidate) => {
            const kindLabel = t(FEATURE_KIND_LABEL_KEYS[candidate.kind])
            return (
              <button
                key={candidate.id}
                type="button"
                className="overlap-feature-picker__candidate"
                aria-label={t('canvas.overlap.selectAria', { name: candidate.name, kind: kindLabel })}
                onClick={() => picker.selectCandidate(candidate.id)}
                onPointerEnter={() => picker.previewCandidate(candidate.id)}
                onPointerLeave={(event) => {
                  if (document.activeElement !== event.currentTarget) {
                    picker.previewCandidate(null)
                  }
                }}
                onFocus={() => picker.previewCandidate(candidate.id)}
                onBlur={(event) => {
                  if (!event.currentTarget.matches(':hover')) {
                    picker.previewCandidate(null)
                  }
                }}
              >
                <span className="overlap-feature-picker__candidate-name">{candidate.name}</span>
                <span className="overlap-feature-picker__candidate-kind">{kindLabel}</span>
              </button>
            )
          })}
        </div>
      </CanvasWorkflowPanel>
    </div>
  )
}
