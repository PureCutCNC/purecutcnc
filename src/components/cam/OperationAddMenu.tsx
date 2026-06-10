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

import { useEffect, useRef, useState } from 'react'
import type { OperationKind } from '../../types/project'
import { operationDescriptions } from '../../types/operationDescriptions'
import { Icon } from '../Icon'

interface OperationButton {
  kind: OperationKind
  label: string
  hint?: string
}

interface OperationAddMenuProps {
  operationButtons: OperationButton[]
  selectedNewOperationKind: OperationKind | null
  selectedNewOperationHint: string | null
  operationSupportsPass: (kind: OperationKind) => boolean
  onChooseOperation: (kind: OperationKind) => void
  onAddOperation: (kind: OperationKind, mode: 'rough' | 'finish' | 'pair') => void
  /** A1.3: arm a kind (on hover or tap-expand) so the canvas highlights its compatible features. */
  onHighlightOperation?: (kind: OperationKind | null) => void
}

export function OperationAddMenu({
  operationButtons,
  selectedNewOperationKind,
  selectedNewOperationHint,
  operationSupportsPass,
  onChooseOperation,
  onAddOperation,
  onHighlightOperation,
}: OperationAddMenuProps) {
  // expandedOperationKind: which description card is open (one at a time).
  // selectedNewOperationKind (prop): which operation the user last attempted to add via the
  // + button for non-pass operations — separate from expansion state so the user can browse
  // descriptions without clearing the attempted-operation highlight.
  const [expandedOperationKind, setExpandedOperationKind] = useState<OperationKind | null>(null)
  const [imageErrors, setImageErrors] = useState<Set<OperationKind>>(new Set())
  const expandedRef = useRef<HTMLDivElement>(null)

  // Auto-scroll expanded card into view
  useEffect(() => {
    expandedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [expandedOperationKind])

  // A1.3: clear the canvas highlight when the menu closes/unmounts.
  useEffect(() => () => onHighlightOperation?.(null), [onHighlightOperation])

  function handleOperationClick(kind: OperationKind) {
    onChooseOperation(kind)
  }

  return (
    <div className="cam-add-menu cam-add-menu--vertical">
      <div className="cam-add-menu__section">
        <span className="cam-add-menu__label">Operation</span>

        <div className="cam-operations-list">
          {operationButtons.map((button) => {
            const isExpanded = expandedOperationKind === button.kind
            const description = operationDescriptions[button.kind]

            return (
              <div
                key={button.kind}
                className={`cam-operation-item ${isExpanded ? 'cam-operation-item--expanded' : ''}`}
                onMouseEnter={() => onHighlightOperation?.(button.kind)}
                onMouseLeave={() => onHighlightOperation?.(null)}
              >
                {/* Operation row */}
                <div className="cam-operation-row">
                  <button
                    className={`cam-operation-label-btn ${isExpanded ? 'cam-operation-label-btn--expanded' : ''}`}
                    type="button"
                    title={button.hint ?? (isExpanded ? `Collapse ${button.label} info` : `Expand ${button.label} info`)}
                    onClick={() => {
                      // A1.5: arm the highlight on tap too, so touch users (no
                      // hover) get the same compatible-feature highlight. Kept
                      // armed on collapse — it matches hover (the pointer is
                      // still on the row) and clears when the menu closes.
                      setExpandedOperationKind(isExpanded ? null : button.kind)
                      onHighlightOperation?.(button.kind)
                    }}
                  >
                    <span className="cam-operation-label">{button.label}</span>
                    <Icon id="chevron-down" size={12} />
                  </button>

                  {operationSupportsPass(button.kind) ? (
                    <div className="cam-operation-pass-buttons">
                      <button
                        className="cam-subtab cam-subtab--compact"
                        type="button"
                        title={button.hint ? `Rough pass (${button.hint})` : 'Rough pass'}
                        disabled={!!button.hint}
                        onClick={() => onAddOperation(button.kind, 'rough')}
                      >
                        Rough
                      </button>
                      <button
                        className="cam-subtab cam-subtab--compact"
                        type="button"
                        title={button.hint ? `Finish pass (${button.hint})` : 'Finish pass'}
                        disabled={!!button.hint}
                        onClick={() => onAddOperation(button.kind, 'finish')}
                      >
                        Finish
                      </button>
                      <button
                        className="cam-subtab cam-subtab--compact"
                        type="button"
                        title={button.hint ? `Both passes (${button.hint})` : 'Both rough and finish passes'}
                        disabled={!!button.hint}
                        onClick={() => onAddOperation(button.kind, 'pair')}
                      >
                        Both
                      </button>
                    </div>
                  ) : (
                    <button
                      className={`feat-btn ${selectedNewOperationKind === button.kind ? 'feat-btn--active' : ''}`}
                      type="button"
                      title={button.hint ? `Add ${button.label} (${button.hint})` : `Add ${button.label}`}
                      disabled={!!button.hint}
                      onClick={() => handleOperationClick(button.kind)}
                    >
                      Add
                    </button>
                  )}
                </div>

                {/* A1.3: always-visible inline reason why this operation is
                    unavailable, promoted from the button tooltip. */}
                {button.hint ? (
                  <div className="cam-operation-hint" role="note">
                    {button.hint}
                  </div>
                ) : null}

                {/* Expanded card */}
                {isExpanded && description && (
                  <div className="cam-operation-details" ref={expandedRef}>
                    <div className="cam-operation-details__image-container">
                      {imageErrors.has(button.kind) ? (
                        <div className="cam-operation-details__image-fallback">
                          Missing image:<br />
                          <code>public/operation-examples/{description.exampleImageName}</code>
                        </div>
                      ) : (
                        <img
                          src={`${import.meta.env.BASE_URL}operation-examples/${description.exampleImageName}`}
                          alt={`${description.title} example`}
                          className="cam-operation-details__image"
                          onError={() => setImageErrors((prev) => new Set(prev).add(button.kind))}
                        />
                      )}
                    </div>

                    <p className="cam-operation-details__description">
                      {description.fullDescription}
                    </p>

                    {description.keyPoints.length > 0 && (
                      <div className="cam-operation-details__keypoints">
                        <span className="cam-operation-details__keypoints-label">Key points:</span>
                        <ul className="cam-operation-details__keypoints-list">
                          {description.keyPoints.map((point, index) => (
                            <li key={index} className="cam-operation-details__keypoint">
                              {point}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {selectedNewOperationHint ? (
        <div className="cam-field-message" role="status">
          {selectedNewOperationHint}
        </div>
      ) : null}
    </div>
  )
}
