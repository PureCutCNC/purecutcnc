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
import type { OverlapFeaturePickerController } from './useOverlapFeaturePicker'

interface OverlapFeaturePickerProps {
  picker: OverlapFeaturePickerController
}

const FEATURE_KIND_LABELS: Record<FeatureKind, string> = {
  rect: 'Rectangle',
  circle: 'Circle',
  ellipse: 'Ellipse',
  polygon: 'Polygon',
  spline: 'Spline',
  composite: 'Composite path',
  text: 'Text',
  stl: 'STL model',
}

export function OverlapFeaturePicker({ picker }: OverlapFeaturePickerProps) {
  if (!picker.isOpen) return null

  const candidateCount = picker.candidates.length

  return (
    <div className="overlap-feature-picker" role="dialog" aria-label="Select feature" aria-modal="false">
      <CanvasWorkflowPanel
        title="Select feature"
        step={`${candidateCount} features overlap here. Choose one to select.`}
        position={picker.workflowPanel.position}
        panelRef={picker.workflowPanel.panelRef}
        handleProps={picker.workflowPanel.handleProps}
        actionRowProps={picker.workflowPanel.actionRowProps}
        className="overlap-feature-picker__panel"
        moveLabel="Move feature selection controls"
        actions={(
          <button
            type="button"
            className="tablet-cmd-btn tablet-cmd-btn--cancel"
            onClick={picker.cancel}
          >Cancel</button>
        )}
      >
        <div className="overlap-feature-picker__list" aria-label="Overlapping features">
          {picker.candidates.map((candidate) => {
            const kindLabel = FEATURE_KIND_LABELS[candidate.kind]
            return (
              <button
                key={candidate.id}
                type="button"
                className="overlap-feature-picker__candidate"
                aria-label={`Select ${candidate.name}, ${kindLabel}`}
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
