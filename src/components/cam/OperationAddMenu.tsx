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
import type { camEn } from '../../i18n/locales/en/cam'
import { camT } from './camI18n'
import { Icon } from '../Icon'

/** camelCase segment used in cam.opDesc.<segment>.* catalog keys. */
const OP_DESC_SEG: Record<OperationKind, string> = {
  pocket: 'pocket',
  v_carve: 'vCarve',
  v_carve_medial: 'vCarveMedial',
  edge_route_inside: 'edgeRouteInside',
  edge_route_outside: 'edgeRouteOutside',
  surface_clean: 'surfaceClean',
  rough_surface: 'roughSurface',
  finish_surface: 'finishSurface',
  finish_surface_cleanup: 'finishSurfaceCleanup',
  follow_line: 'followLine',
  drilling: 'drilling',
}

interface OperationButton {
  kind: OperationKind
  label: string
  hint?: string
  /** Features "Select all" would select; empty when the affordance is unavailable. */
  selectAllFeatureIds?: string[]
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
  /** Replace the current selection (drives the hint row's "Select all" button). */
  onSelectFeatures?: (featureIds: string[]) => void
}

export function OperationAddMenu({
  operationButtons,
  selectedNewOperationKind,
  selectedNewOperationHint,
  operationSupportsPass,
  onChooseOperation,
  onAddOperation,
  onHighlightOperation,
  onSelectFeatures,
}: OperationAddMenuProps) {
  // expandedOperationKind: which description card is open (one at a time).
  // selectedNewOperationKind (prop): which operation the user last attempted to add via the
  // + button for non-pass operations — separate from expansion state so the user can browse
  // descriptions without clearing the attempted-operation highlight.
  const [expandedOperationKind, setExpandedOperationKind] = useState<OperationKind | null>(null)
  // Which row the pointer is on (or was tap-armed on, for touch) — gates the
  // hint row's "Select all" button to the hovered operation only.
  const [hoveredOperationKind, setHoveredOperationKind] = useState<OperationKind | null>(null)
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

  function opDescKey(kind: OperationKind, slot: string): keyof typeof camEn {
    return `cam.opDesc.${OP_DESC_SEG[kind]}.${slot}` as keyof typeof camEn
  }

  return (
    <div className="cam-add-menu cam-add-menu--vertical">
      <div className="cam-add-menu__section">
        <span className="cam-add-menu__label">{camT('cam.addMenu.operation')}</span>

        <div className="cam-operations-list">
          {operationButtons.map((button) => {
            const isExpanded = expandedOperationKind === button.kind
            const description = operationDescriptions[button.kind]

            return (
              <div
                key={button.kind}
                className={`cam-operation-item ${isExpanded ? 'cam-operation-item--expanded' : ''}`}
                onMouseEnter={() => {
                  setHoveredOperationKind(button.kind)
                  onHighlightOperation?.(button.kind)
                }}
                onMouseLeave={() => {
                  setHoveredOperationKind(null)
                  onHighlightOperation?.(null)
                }}
              >
                {/* Operation row */}
                <div className="cam-operation-row">
                  <button
                    className={`cam-operation-label-btn ${isExpanded ? 'cam-operation-label-btn--expanded' : ''}`}
                    type="button"
                    title={button.hint ?? (isExpanded
                      ? camT('cam.addMenu.collapseInfo', { label: button.label })
                      : camT('cam.addMenu.expandInfo', { label: button.label }))}
                    onClick={() => {
                      // A1.5: arm the highlight on tap too, so touch users (no
                      // hover) get the same compatible-feature highlight. Kept
                      // armed on collapse — it matches hover (the pointer is
                      // still on the row) and clears when the menu closes.
                      setExpandedOperationKind(isExpanded ? null : button.kind)
                      setHoveredOperationKind(button.kind)
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
                        title={button.hint
                          ? camT('cam.addMenu.roughPassHint', { hint: button.hint })
                          : camT('cam.addMenu.roughPassTitle')}
                        disabled={!!button.hint}
                        onClick={() => onAddOperation(button.kind, 'rough')}
                      >
                        {camT('cam.addMenu.roughPass')}
                      </button>
                      <button
                        className="cam-subtab cam-subtab--compact"
                        type="button"
                        title={button.hint
                          ? camT('cam.addMenu.finishPassHint', { hint: button.hint })
                          : camT('cam.addMenu.finishPassTitle')}
                        disabled={!!button.hint}
                        onClick={() => onAddOperation(button.kind, 'finish')}
                      >
                        {camT('cam.addMenu.finishPass')}
                      </button>
                      <button
                        className="cam-subtab cam-subtab--compact"
                        type="button"
                        title={button.hint
                          ? camT('cam.addMenu.bothPassesHint', { hint: button.hint })
                          : camT('cam.addMenu.bothPassesTitle')}
                        disabled={!!button.hint}
                        onClick={() => onAddOperation(button.kind, 'pair')}
                      >
                        {camT('cam.addMenu.bothPasses')}
                      </button>
                    </div>
                  ) : (
                    <button
                      className={`feat-btn ${selectedNewOperationKind === button.kind ? 'feat-btn--active' : ''}`}
                      type="button"
                      title={button.hint
                        ? camT('cam.addMenu.addHint', { label: button.label, hint: button.hint })
                        : camT('cam.addMenu.addLabel', { label: button.label })}
                      disabled={!!button.hint}
                      onClick={() => handleOperationClick(button.kind)}
                    >
                      {camT('cam.addMenu.add')}
                    </button>
                  )}
                </div>

                {/* A1.3: always-visible inline reason why this operation is
                    unavailable, promoted from the button tooltip. */}
                {button.hint ? (
                  <div className="cam-operation-hint" role="note">
                    <span className="cam-operation-hint__text">{button.hint}</span>
                    {hoveredOperationKind === button.kind
                      && onSelectFeatures
                      && (button.selectAllFeatureIds?.length ?? 0) > 0 ? (
                      <button
                        className="cam-subtab cam-subtab--compact cam-operation-hint__select-all"
                        type="button"
                        title={camT('cam.addMenu.selectAllHint', { label: button.label })}
                        onClick={() => onSelectFeatures(button.selectAllFeatureIds ?? [])}
                      >
                        {camT('cam.addMenu.selectAll')}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {/* Expanded card */}
                {isExpanded && description && (
                  <div className="cam-operation-details" ref={expandedRef}>
                    <div className="cam-operation-details__image-container">
                      {imageErrors.has(button.kind) ? (
                        <div className="cam-operation-details__image-fallback">
                          {camT('cam.addMenu.missingImage')}<br />
                          <code>public/operation-examples/{description.exampleImageName}</code>
                        </div>
                      ) : (
                        <img
                          src={`${import.meta.env.BASE_URL}operation-examples/${description.exampleImageName}`}
                          alt={camT('cam.addMenu.exampleImage', { title: camT(opDescKey(button.kind, 'title')) })}
                          className="cam-operation-details__image"
                          onError={() => setImageErrors((prev) => new Set(prev).add(button.kind))}
                        />
                      )}
                    </div>

                    <p className="cam-operation-details__description">
                      {camT(opDescKey(button.kind, 'fullDescription'))}
                    </p>

                    {description.keyPoints.length > 0 && (
                      <div className="cam-operation-details__keypoints">
                        <span className="cam-operation-details__keypoints-label">
                          {camT('cam.addMenu.keyPoints')}
                        </span>
                        <ul className="cam-operation-details__keypoints-list">
                          {description.keyPoints.map((_point, index) => (
                            <li key={index} className="cam-operation-details__keypoint">
                              {camT(opDescKey(button.kind, `keyPoint.${index}`))}
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
