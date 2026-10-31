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

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { Icon } from '../../Icon'
import { usePortalPosition } from '../../../hooks/usePortalPosition'

type ToolbarActionButtonProps = {
  icon: string
  label: string
  active?: boolean
  emphasized?: boolean
  disabled?: boolean
  /** Shown in the tooltip and native title while disabled, so a refusal has a reason. */
  disabledReason?: string
  tooltipSide?: 'bottom' | 'right'
  /** Stable `data-command` hook, matching the top command bar's (e.g.
   *  "export-model"). The accessible name changes with state, so tests and
   *  command lookups must not key on it. */
  command?: string
  onClick: () => void
}

function ToolbarAction({
  label,
  tooltipSide = 'bottom',
  children,
}: {
  label: string
  tooltipSide?: 'bottom' | 'right'
  children: ReactNode
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const tooltipRef = useRef<HTMLSpanElement | null>(null)
  const [tooltipVisible, setTooltipVisible] = useState(false)
  const tooltipCoords = usePortalPosition(containerRef, tooltipRef, tooltipVisible, (triggerRect, tooltipRect) => {
    const margin = 8
    let top: number
    let left: number

    if (tooltipSide === 'right') {
      left = triggerRect.right + 8
      top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2
    } else {
      top = triggerRect.bottom + 8
      left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2
    }

    left = Math.max(margin, Math.min(left, window.innerWidth - tooltipRect.width - margin))
    top = Math.max(margin, Math.min(top, window.innerHeight - tooltipRect.height - margin))
    return { top, left }
  })

  return (
    <div
      className="toolbar-action"
      ref={containerRef}
      onMouseEnter={() => setTooltipVisible(true)}
      onMouseLeave={() => setTooltipVisible(false)}
      onFocusCapture={() => setTooltipVisible(true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setTooltipVisible(false)
        }
      }}
    >
      {children}
      {tooltipVisible && typeof document !== 'undefined'
        ? createPortal(
            <span
              className={`toolbar-tooltip toolbar-tooltip--${tooltipSide} toolbar-tooltip--floating`}
              ref={tooltipRef}
              role="tooltip"
              style={{
                top: tooltipCoords?.top ?? -9999,
                left: tooltipCoords?.left ?? -9999,
                visibility: tooltipCoords ? 'visible' : 'hidden',
              }}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </div>
  )
}

function ToolbarActionButton({
  icon,
  label,
  active = false,
  emphasized = false,
  disabled = false,
  disabledReason,
  tooltipSide = 'bottom',
  command,
  onClick,
}: ToolbarActionButtonProps) {
  const tooltip = disabled && disabledReason ? `${label} — ${disabledReason}` : label
  return (
    <ToolbarAction label={tooltip} tooltipSide={tooltipSide}>
      <button
        className={`toolbar-icon-btn ${active ? 'toolbar-icon-btn--active' : ''} ${emphasized ? 'toolbar-icon-btn--live' : ''}`}
        data-command={command}
        onClick={(event) => {
          onClick()
          event.currentTarget.blur()
        }}
        aria-label={label}
        title={disabled && disabledReason ? disabledReason : undefined}
        type="button"
        disabled={disabled}
      >
        <Icon id={icon} />
      </button>
    </ToolbarAction>
  )
}

export { ToolbarAction, ToolbarActionButton }
