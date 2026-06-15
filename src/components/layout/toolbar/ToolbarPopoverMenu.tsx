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
import { useOutsideDismiss } from '../../../hooks/useOutsideDismiss'
import { usePortalPosition } from '../../../hooks/usePortalPosition'
import {
  TOOLBAR_POPOVER_HOVER_CLOSE_DELAY_MS,
  TOOLBAR_POPOVER_HOVER_OPEN_DELAY_MS,
} from './shared'
import type { PopoverMenuOption, PopoverOpenMode } from './shared'
import { ToolbarActionButton } from './primitives'

export function ToolbarPopoverMenu<T extends string>({
  triggerIcon,
  triggerLabelOpen,
  triggerLabelClosed,
  enabled,
  tooltipSide,
  columns,
  options,
  onSelect,
}: {
  triggerIcon: string
  triggerLabelOpen: string
  triggerLabelClosed: string
  enabled: boolean
  tooltipSide?: 'bottom' | 'right'
  columns: number
  options: PopoverMenuOption<T>[]
  onSelect: (value: T) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const openModeRef = useRef<PopoverOpenMode | null>(null)
  const effectiveOpen = open && enabled
  const side = tooltipSide ?? 'bottom'

  function clearHoverTimers() {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  function scheduleOpen() {
    if (!enabled) {
      return
    }
    if (openModeRef.current === 'click') {
      return
    }
    clearHoverTimers()
    openTimerRef.current = window.setTimeout(() => {
      openModeRef.current = 'hover'
      setOpen(true)
      openTimerRef.current = null
    }, TOOLBAR_POPOVER_HOVER_OPEN_DELAY_MS)
  }

  function scheduleClose() {
    if (openModeRef.current === 'click') {
      return
    }
    clearHoverTimers()
    closeTimerRef.current = window.setTimeout(() => {
      openModeRef.current = null
      setOpen(false)
      closeTimerRef.current = null
    }, TOOLBAR_POPOVER_HOVER_CLOSE_DELAY_MS)
  }

  // The popover is rendered in a portal on document.body (below) so the
  // scrollable left rail — whose overflow clips its absolutely-positioned
  // descendants — cannot cut it off. Position it from the trigger's bounding
  // rect, recomputing while it is open in case the rail scrolls or resizes.
  const coords = usePortalPosition(containerRef, popoverRef, effectiveOpen, (t, p) => {
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
    open: effectiveOpen,
    refs: [containerRef, popoverRef],
    onDismiss: () => {
      openModeRef.current = null
      setOpen(false)
    },
  })

  useEffect(() => () => clearHoverTimers(), [])

  return (
    <div
      className="toolbar-group toolbar-popover-host"
      ref={containerRef}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') {
          scheduleOpen()
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') {
          scheduleClose()
        }
      }}
    >
      <ToolbarActionButton
        icon={triggerIcon}
        label={effectiveOpen ? triggerLabelOpen : triggerLabelClosed}
        active={effectiveOpen}
        disabled={!enabled}
        tooltipSide={tooltipSide}
        onClick={() => {
          clearHoverTimers()
          if (open && openModeRef.current === 'click') {
            openModeRef.current = null
            setOpen(false)
          } else {
            openModeRef.current = 'click'
            setOpen(true)
          }
        }}
      />
      {effectiveOpen
        ? createPortal(
            <div
              ref={popoverRef}
              className="toolbar-popover toolbar-popover--floating"
              style={{
                position: 'fixed',
                top: coords?.top ?? -9999,
                left: coords?.left ?? -9999,
                visibility: coords ? 'visible' : 'hidden',
                gridTemplateColumns: `repeat(${columns}, auto)`,
              }}
              role="menu"
              onPointerEnter={(event) => {
                if (event.pointerType === 'mouse') {
                  clearHoverTimers()
                }
              }}
              onPointerLeave={(event) => {
                if (event.pointerType === 'mouse') {
                  scheduleClose()
                }
              }}
            >
              {options.map((option) => (
                <ToolbarActionButton
                  key={option.value}
                  icon={option.icon}
                  label={option.label}
                  tooltipSide="bottom"
                  onClick={() => {
                    onSelect(option.value)
                    openModeRef.current = null
                    setOpen(false)
                  }}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
