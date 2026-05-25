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
}

export function OperationAddMenu({
  operationButtons,
  selectedNewOperationKind,
  selectedNewOperationHint,
  operationSupportsPass,
  onChooseOperation,
  onAddOperation,
}: OperationAddMenuProps) {
  const [expandedOperationKind, setExpandedOperationKind] = useState<OperationKind | null>(null)
  const expandedRef = useRef<HTMLDivElement>(null)

  // Auto-scroll expanded card into view on tablet/mobile
  useEffect(() => {
    if (expandedRef.current && expandedOperationKind) {
      const scrollParent = expandedRef.current.closest('.cam-add-menu')
      if (scrollParent && scrollParent.scrollHeight > scrollParent.clientHeight) {
        // Only scroll if menu is scrollable
        expandedRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }
  }, [expandedOperationKind])

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
              >
                {/* Operation row */}
                <div className="cam-operation-row">
                  <button
                    className={`cam-operation-label-btn ${isExpanded ? 'cam-operation-label-btn--expanded' : ''}`}
                    type="button"
                    title={button.hint}
                    onClick={() => setExpandedOperationKind(isExpanded ? null : button.kind)}
                  >
                    <span className="cam-operation-label">{button.label}</span>
                  </button>

                  {operationSupportsPass(button.kind) ? (
                    <div className="cam-operation-pass-buttons">
                      <button
                        className="cam-operation-pass-btn"
                        type="button"
                        title={button.hint ? `Rough pass (${button.hint})` : 'Rough pass'}
                        disabled={!!button.hint}
                        onClick={() => onAddOperation(button.kind, 'rough')}
                      >
                        Rough
                      </button>
                      <button
                        className="cam-operation-pass-btn"
                        type="button"
                        title={button.hint ? `Finish pass (${button.hint})` : 'Finish pass'}
                        disabled={!!button.hint}
                        onClick={() => onAddOperation(button.kind, 'finish')}
                      >
                        Finish
                      </button>
                      <button
                        className="cam-operation-pass-btn"
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
                      <Icon id="plus" size={14} />
                    </button>
                  )}
                </div>

                {/* Expanded card */}
                {isExpanded && description && (
                  <div className="cam-operation-details" ref={expandedRef}>
                    <div className="cam-operation-details__image-container">
                      <img
                        src={`/operation-examples/${description.exampleImageName}`}
                        alt={`${description.title} example`}
                        className="cam-operation-details__image"
                        onError={(e) => {
                          const el = e.currentTarget
                          el.style.display = 'none'
                          const placeholder = el.nextElementSibling
                          if (placeholder) {
                            ;(placeholder as HTMLElement).style.display = 'flex'
                          }
                        }}
                      />
                      <div
                        className="cam-operation-details__image-fallback"
                        style={{ display: 'none' }}
                      >
                        Missing image:<br />
                        <code>public/operation-examples/{description.exampleImageName}</code>
                      </div>
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
