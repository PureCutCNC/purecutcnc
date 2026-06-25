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
import { useOutsideDismiss } from '../../../hooks/useOutsideDismiss'
import { usePortalPosition } from '../../../hooks/usePortalPosition'
import type { CreationTarget } from '../../../store/types'
import {
  CREATION_SHAPE_OPTIONS,
  TOOLBAR_POPOVER_HOVER_CLOSE_DELAY_MS,
  TOOLBAR_POPOVER_HOVER_OPEN_DELAY_MS,
} from './shared'
import type { CreationShape, PopoverOpenMode } from './shared'
import { ToolbarAction, ToolbarActionButton } from './primitives'

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
  onRoundRect: () => void
  onChamferRect: () => void
}) {
  const [lastShape, setLastShape] = useState<CreationShape>('rect')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const openModeRef = useRef<PopoverOpenMode | null>(null)
  const side = tooltipSide ?? 'bottom'
  const availableShapeOptions = creationTarget === 'region'
    ? CREATION_SHAPE_OPTIONS.filter((option) => option.value !== 'text')
    : CREATION_SHAPE_OPTIONS
  const lastShapeOption = availableShapeOptions.find((option) => option.value === lastShape) ?? availableShapeOptions[0]
  const primaryOptions = availableShapeOptions.filter((o) => o.tier === 'primary')
  const secondaryOptions = availableShapeOptions.filter((o) => o.tier === 'secondary')

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
    return (
      <ToolbarAction label={label} tooltipSide={tooltipSide}>
        <button
          type="button"
          className={[
            'toolbar-icon-btn',
            'toolbar-target-btn',
            target === 'region' ? 'toolbar-target-btn--region' : '',
            active ? 'toolbar-icon-btn--active toolbar-target-btn--active' : '',
          ].join(' ')}
          onClick={() => onCreationTargetChange(target)}
          title={label}
          aria-label={label}
          aria-pressed={active}
        >
          <Icon id={icon} />
        </button>
      </ToolbarAction>
    )
  }

  return (
    <div className={`toolbar-creation-block toolbar-creation-block--${creationTarget}`}>
      <div className="toolbar-target-toggle" role="group" aria-label="Creation target">
        {renderCreationTargetButton('feature', 'plus', 'Create features')}
        {renderCreationTargetButton('region', 'pocket', 'Create regions')}
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
        <ToolbarAction label={drawerOpen ? 'Close shape drawer' : `Choose ${creationTarget} shape`} tooltipSide={tooltipSide}>
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
            aria-label={drawerOpen ? 'Close shape drawer' : `Choose ${creationTarget} shape`}
            aria-haspopup="menu"
            aria-expanded={drawerOpen}
          >
            <Icon id="feature-drawer" />
          </button>
        </ToolbarAction>
        <ToolbarActionButton
          icon={lastShapeOption.icon}
          label={pendingShape === lastShapeOption.value ? `Cancel ${lastShapeOption.noun} tool` : `Add ${creationTarget} ${lastShapeOption.noun}`}
          active={pendingShape === lastShapeOption.value}
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
                      label={`Add ${creationTarget} ${option.noun}`}
                      active={lastShapeOption.value === option.value}
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
                          label={`Add ${creationTarget} ${option.noun}`}
                          active={lastShapeOption.value === option.value}
                          tooltipSide="bottom"
                          onClick={() => { selectShape(option.value) }}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>,
              document.body,
            )
          : null}
      </div>
    </div>
  )
}

export { CreationActions }
