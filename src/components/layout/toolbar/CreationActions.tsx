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
import { createPortal } from 'react-dom'
import { Icon } from '../../Icon'
import { useProjectStore } from '../../../store/projectStore'
import { activeFace, aroundSheetTargetRefused } from '../../../store/helpers/activeFace'
import { useI18n } from '../../../i18n/i18nContext'
import type { MessageKey } from '../../../i18n/locales/en'
import { useOutsideDismiss } from '../../../hooks/useOutsideDismiss'
import { usePortalPosition } from '../../../hooks/usePortalPosition'
import type { CreationTarget } from '../../../store/types'
import {
  CREATION_SHAPE_OPTIONS,
  TOOLBAR_POPOVER_HOVER_CLOSE_DELAY_MS,
  TOOLBAR_POPOVER_HOVER_OPEN_DELAY_MS,
} from './shared'
import type { CreationShape, PopoverOpenMode } from './shared'
import { RotaryPatternActions } from './RotaryPatternActions'
import { RotarySolidActions } from './RotarySolidActions'
import { ToolbarAction, ToolbarActionButton } from './primitives'

const CREATION_TARGET_LABEL_KEYS: Record<CreationTarget, MessageKey> = {
  feature: 'sketch.target.createFeatures',
  line: 'sketch.target.createLines',
  region: 'sketch.target.createRegions',
  construction: 'sketch.target.createConstruction',
}

const CREATION_TARGET_NOUN_KEYS: Record<CreationTarget, MessageKey> = {
  feature: 'sketch.target.feature',
  line: 'sketch.target.line',
  region: 'sketch.target.region',
  construction: 'sketch.target.construction',
}

/**
 * The shape entries that are features: text and gear. They exist on the
 * feature target only, and off it they stay in the drawer disabled with the
 * reason instead of disappearing (issue #1112 rt3-d item 31).
 */
const FEATURE_ONLY_SHAPES: ReadonlySet<CreationShape> = new Set<CreationShape>(['text', 'gear'])

/**
 * The drawer's rotary group: Thread/Flutes and Turn/Polygon in one row.
 *
 * The group follows the bar workflow, not the Around face alone (issue #1112
 * rt2-b item 20): Turn and Polygon belong to the bar, so they are offered from
 * Top and Bottom as well, while Thread and Flutes need the Around face. It is
 * always listed — a block project has no bar to turn, and every entry then
 * stays in place disabled with its reason instead of disappearing (issue #1112
 * rt3-d item 31).
 */
function RotaryCreationGroup({ tooltipSide }: { tooltipSide: 'bottom' | 'right' }) {
  return (
    <>
      <div aria-hidden style={{ height: '1px', background: 'currentColor', opacity: 0.15, margin: '2px 0' }} />
      <div className="toolbar-creation-picker__rotary" style={{ display: 'flex' }}>
        <RotaryPatternActions variant="drawer" tooltipSide={tooltipSide} />
        <RotarySolidActions variant="drawer" tooltipSide={tooltipSide} />
      </div>
    </>
  )
}

function CreationActions({
  pendingShape,
  creationTarget,
  tooltipSide,
  onCreationTargetChange,
  onRect,
  onCircle,
  onEllipse,
  onPolygon,
  onSpline,
  onComposite,
  onText,
  onSlot,
  onNgon,
  onGear,
  onRoundRect,
  onChamferRect,
}: {
  pendingShape: string | null
  creationTarget: CreationTarget
  tooltipSide?: 'bottom' | 'right'
  onCreationTargetChange: (target: CreationTarget) => void
  onRect: () => void
  onCircle: () => void
  onEllipse: () => void
  onPolygon: () => void
  onSpline: () => void
  onComposite: () => void
  onText: () => void
  onSlot: () => void
  onNgon: () => void
  onGear: () => void
  onRoundRect: () => void
  onChamferRect: () => void
}) {
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  // A square blank's Around sheet takes a region and a construction line, and
  // refuses everything that would be cut on it (issue #1112 decision 17). The
  // refused entries stay in the drawer, disabled with the reason, rather than
  // vanishing (#1016 hid them).
  const face = activeFace(project)
  const sheetRefusal = t('sketch.creation.squareBarUnavailable')
  const sheetShapeRefusal = aroundSheetTargetRefused(project, face, creationTarget) ? sheetRefusal : undefined
  // Text and Gear are features: a line, region or construction target cannot
  // create them, and the row says so rather than being filtered out (issue
  // #1112 rt3-d item 31).
  const featureTargetRefusal = creationTarget === 'feature' ? undefined : t('sketch.creation.featureTargetOnly')
  const [lastShape, setLastShape] = useState<CreationShape>('rect')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const openModeRef = useRef<PopoverOpenMode | null>(null)
  const side = tooltipSide ?? 'bottom'
  /** Why this shape entry cannot be used here, or `undefined` when it can. */
  function shapeRefusal(shape: CreationShape): string | undefined {
    return sheetShapeRefusal ?? (FEATURE_ONLY_SHAPES.has(shape) ? featureTargetRefusal : undefined)
  }
  // The last-shape button runs the tool immediately, so it only ever reads a
  // shape this target can create: the refused rows stay in the drawer, but they
  // are never what the drawer button offers as the default. The sheet refusal
  // is not part of this choice — on a square blank's sheet the offered shape is
  // the one that would be used elsewhere, disabled with the reason, rather than
  // some other shape taking its place.
  const targetShapeOptions = CREATION_SHAPE_OPTIONS.filter((option) => (
    !FEATURE_ONLY_SHAPES.has(option.value) || creationTarget === 'feature'
  ))
  const lastShapeOption = targetShapeOptions.find((option) => option.value === lastShape) ?? targetShapeOptions[0]
  const primaryOptions = CREATION_SHAPE_OPTIONS.filter((o) => o.tier === 'primary')
  const secondaryOptions = CREATION_SHAPE_OPTIONS.filter((o) => o.tier === 'secondary')
  const targetNoun = t(CREATION_TARGET_NOUN_KEYS[creationTarget])

  function clearDrawerTimers() {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  function runShapeTool(shape: CreationShape) {
    if (shape === 'rect') {
      onRect()
    } else if (shape === 'circle') {
      onCircle()
    } else if (shape === 'ellipse') {
      onEllipse()
    } else if (shape === 'polygon') {
      onPolygon()
    } else if (shape === 'spline') {
      onSpline()
    } else if (shape === 'composite') {
      onComposite()
    } else if (shape === 'slot') {
      onSlot()
    } else if (shape === 'ngon') {
      onNgon()
    } else if (shape === 'gear') {
      onGear()
    } else if (shape === 'roundrect') {
      onRoundRect()
    } else if (shape === 'chamferrect') {
      onChamferRect()
    } else {
      onText()
    }
  }

  function selectShape(shape: CreationShape) {
    setLastShape(shape)
    openModeRef.current = null
    setDrawerOpen(false)
    runShapeTool(shape)
  }

  function scheduleDrawerOpen() {
    if (openModeRef.current === 'click') {
      return
    }
    clearDrawerTimers()
    openTimerRef.current = window.setTimeout(() => {
      openModeRef.current = 'hover'
      setDrawerOpen(true)
      openTimerRef.current = null
    }, TOOLBAR_POPOVER_HOVER_OPEN_DELAY_MS)
  }

  function scheduleDrawerClose() {
    if (openModeRef.current === 'click') {
      return
    }
    clearDrawerTimers()
    closeTimerRef.current = window.setTimeout(() => {
      openModeRef.current = null
      setDrawerOpen(false)
      closeTimerRef.current = null
    }, TOOLBAR_POPOVER_HOVER_CLOSE_DELAY_MS)
  }

  const drawerCoords = usePortalPosition(pickerRef, popoverRef, drawerOpen, (t, p) => {
    const margin = 8
    let top: number
    let left: number
    if (side === 'right') {
      left = t.right + 6
      top = t.top + t.height / 2 - p.height / 2
    } else {
      top = t.bottom + 6
      left = t.left + t.width / 2 - p.width / 2
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - p.width - margin))
    top = Math.max(margin, Math.min(top, window.innerHeight - p.height - margin))
    return { top, left }
  })

  useOutsideDismiss({
    open: drawerOpen,
    refs: [pickerRef, popoverRef],
    onDismiss: () => {
      openModeRef.current = null
      setDrawerOpen(false)
    },
  })

  useEffect(() => () => clearDrawerTimers(), [])

  function renderCreationTargetButton(target: CreationTarget, icon: string, label: string) {
    const active = creationTarget === target
    const blockedReason = aroundSheetTargetRefused(project, face, target) ? sheetRefusal : undefined
    return (
      <ToolbarAction label={blockedReason ? `${label} — ${blockedReason}` : label} tooltipSide={tooltipSide}>
        <button
          type="button"
          className={[
            'toolbar-icon-btn',
            'toolbar-target-btn',
            target !== 'feature' ? `toolbar-target-btn--${target}` : '',
            active ? 'toolbar-icon-btn--active toolbar-target-btn--active' : '',
          ].join(' ')}
          onClick={() => onCreationTargetChange(target)}
          title={blockedReason ?? label}
          aria-label={label}
          aria-pressed={active}
          disabled={blockedReason !== undefined}
        >
          <Icon id={icon} />
        </button>
      </ToolbarAction>
    )
  }

  return (
    <div className={`toolbar-creation-block toolbar-creation-block--${creationTarget}`}>
      {/*
        On a square blank the Around sheet is round-only except for the work
        that never cuts it (issue #1112 decision 17): the target toggle, the
        last-shape button and every drawing row stay in place, and the entries
        that would cut the sheet are disabled with the reason instead of
        disappearing. The two targets that do not cut — a region and a
        construction line — stay live. The rotary group is unaffected, so Turn
        and Polygon work there as before (issue #1112 G).
      */}
      <div className="toolbar-target-toggle" role="group" aria-label="Creation target">
        {renderCreationTargetButton('feature', 'plus', t(CREATION_TARGET_LABEL_KEYS.feature))}
        {renderCreationTargetButton('line', 'snap-line', t(CREATION_TARGET_LABEL_KEYS.line))}
        {renderCreationTargetButton('region', 'pocket', t(CREATION_TARGET_LABEL_KEYS.region))}
        {renderCreationTargetButton('construction', 'construction', t(CREATION_TARGET_LABEL_KEYS.construction))}
      </div>
      <div
        className="toolbar-group toolbar-group--drawing toolbar-creation-picker"
        ref={pickerRef}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') {
            scheduleDrawerOpen()
          }
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') {
            scheduleDrawerClose()
          }
        }}
      >
            <ToolbarAction label={drawerOpen ? t('sketch.creation.closeDrawer') : t('sketch.creation.chooseTarget', { target: t(CREATION_TARGET_NOUN_KEYS[creationTarget]) })} tooltipSide={tooltipSide}>
              <button
                type="button"
                className={`toolbar-icon-btn toolbar-creation-picker__drawer-btn ${drawerOpen ? 'toolbar-icon-btn--active' : ''}`}
                onClick={(event) => {
                  clearDrawerTimers()
                  if (drawerOpen && openModeRef.current === 'click') {
                    openModeRef.current = null
                    setDrawerOpen(false)
                  } else {
                    openModeRef.current = 'click'
                    setDrawerOpen(true)
                  }
                  event.currentTarget.blur()
                }}
                aria-label={drawerOpen ? t('sketch.creation.closeDrawer') : t('sketch.creation.chooseTarget', { target: t(CREATION_TARGET_NOUN_KEYS[creationTarget]) })}
                aria-haspopup="menu"
                aria-expanded={drawerOpen}
              >
                <Icon id="feature-drawer" />
              </button>
            </ToolbarAction>
            <ToolbarActionButton
              icon={lastShapeOption.icon}
              label={pendingShape === lastShapeOption.value
                ? t('sketch.creation.cancelTool', { shape: t(lastShapeOption.nounKey) })
                : t('sketch.creation.addShape', { target: targetNoun, shape: t(lastShapeOption.nounKey) })}
              active={pendingShape === lastShapeOption.value}
              disabled={shapeRefusal(lastShapeOption.value) !== undefined}
              disabledReason={shapeRefusal(lastShapeOption.value)}
              tooltipSide={tooltipSide}
              onClick={() => runShapeTool(lastShapeOption.value)}
            />
            {drawerOpen
              ? createPortal(
                  <div
                    ref={popoverRef}
                    className="toolbar-popover toolbar-popover--floating toolbar-creation-picker__drawer"
                    style={{
                      position: 'fixed',
                      top: drawerCoords?.top ?? -9999,
                      left: drawerCoords?.left ?? -9999,
                      visibility: drawerCoords ? 'visible' : 'hidden',
                      display: 'flex',
                      flexDirection: 'column' as const,
                    }}
                    role="menu"
                    onPointerEnter={(event) => {
                      if (event.pointerType === 'mouse') {
                        clearDrawerTimers()
                      }
                    }}
                    onPointerLeave={(event) => {
                      if (event.pointerType === 'mouse') {
                        scheduleDrawerClose()
                      }
                    }}
                  >
                    <div style={{ display: 'flex' }}>
                      {primaryOptions.map((option) => (
                        <ToolbarActionButton
                          key={option.value}
                          icon={option.icon}
                          label={t('sketch.creation.addShape', { target: targetNoun, shape: t(option.nounKey) })}
                          active={lastShapeOption.value === option.value}
                          disabled={shapeRefusal(option.value) !== undefined}
                          disabledReason={shapeRefusal(option.value)}
                          tooltipSide="bottom"
                          onClick={() => { selectShape(option.value) }}
                        />
                      ))}
                    </div>
                    {secondaryOptions.length > 0 && (
                      <>
                        <div aria-hidden style={{ height: '1px', background: 'currentColor', opacity: 0.15, margin: '2px 0' }} />
                        <div style={{ display: 'flex' }}>
                          {secondaryOptions.map((option) => (
                            <ToolbarActionButton
                              key={option.value}
                              icon={option.icon}
                              label={t('sketch.creation.addShape', { target: targetNoun, shape: t(option.nounKey) })}
                              active={lastShapeOption.value === option.value}
                              disabled={shapeRefusal(option.value) !== undefined}
                              disabledReason={shapeRefusal(option.value)}
                              tooltipSide="bottom"
                              onClick={() => { selectShape(option.value) }}
                            />
                          ))}
                        </div>
                      </>
                    )}
                    <RotaryCreationGroup tooltipSide="bottom" />
                  </div>,
                  document.body,
                )
              : null}
      </div>
    </div>
  )
}

export { CreationActions }
