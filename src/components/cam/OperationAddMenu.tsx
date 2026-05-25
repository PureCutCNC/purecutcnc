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
  selectedNewOperationSupportsPass: boolean
  selectedNewOperationTarget: boolean
  selectedNewOperationHint: string | null
  onChooseOperation: (kind: OperationKind) => void
  onAddOperation: (kind: OperationKind, mode: 'rough' | 'finish' | 'pair') => void
}

export function OperationAddMenu({
  operationButtons,
  selectedNewOperationKind,
  selectedNewOperationSupportsPass,
  selectedNewOperationTarget,
  selectedNewOperationHint,
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

  function handleAddClick(kind: OperationKind, mode: 'rough' | 'finish' | 'pair', event: React.MouseEvent) {
    event.stopPropagation()
    onAddOperation(kind, mode)
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

                  <button
                    className={`feat-btn ${selectedNewOperationKind === button.kind ? 'feat-btn--active' : ''}`}
                    type="button"
                    title={button.hint ? `Add ${button.label} (${button.hint})` : `Add ${button.label}`}
                    disabled={!!button.hint}
                    onClick={() => handleOperationClick(button.kind)}
                  >
                    <Icon id="plus" size={14} />
                  </button>
                </div>

                {/* Expanded card */}
                {isExpanded && description && (
                  <div className="cam-operation-details" ref={expandedRef}>
                    {description.exampleImageUrl && (
                      <div className="cam-operation-details__image-container">
                        <img
                          src={description.exampleImageUrl}
                          alt={`${description.title} example`}
                          className="cam-operation-details__image"
                        />
                      </div>
                    )}

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

      {/* Pass selection (shown when operation is selected and supports it) */}
      {selectedNewOperationKind && selectedNewOperationSupportsPass && selectedNewOperationTarget ? (
        <div className="cam-add-menu__section">
          <span className="cam-add-menu__label">Pass</span>
          <div className="cam-pass-toggle">
            <button
              className="cam-subtab"
              type="button"
              onClick={(e) => handleAddClick(selectedNewOperationKind, 'rough', e)}
            >
              Rough
            </button>
            <button
              className="cam-subtab"
              type="button"
              onClick={(e) => handleAddClick(selectedNewOperationKind, 'finish', e)}
            >
              Finish
            </button>
            <button
              className="cam-subtab"
              type="button"
              onClick={(e) => handleAddClick(selectedNewOperationKind, 'pair', e)}
            >
              Rough + finish
            </button>
          </div>
        </div>
      ) : null}

      {selectedNewOperationHint ? (
        <div className="cam-field-message" role="status">
          {selectedNewOperationHint}
        </div>
      ) : null}
    </div>
  )
}
