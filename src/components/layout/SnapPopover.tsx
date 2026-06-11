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
import { Icon } from '../Icon'
import type { SnapMode, SnapSettings } from '../../sketch/snapping'

interface SnapPopoverProps {
  snapSettings: SnapSettings
  activeSnapMode?: SnapMode | null
  onToggleSnapEnabled: () => void
  onToggleSnapMode: (mode: SnapMode) => void
}

const SNAP_MODES: { mode: SnapMode; icon: string; label: string }[] = [
  { mode: 'grid', icon: 'snap-grid', label: 'Snap to grid' },
  { mode: 'point', icon: 'snap-point', label: 'Snap to point' },
  { mode: 'line', icon: 'snap-line', label: 'Snap to line' },
  { mode: 'midpoint', icon: 'snap-midpoint', label: 'Snap to midpoint' },
  { mode: 'center', icon: 'snap-center', label: 'Snap to center' },
  { mode: 'perpendicular', icon: 'snap-perpendicular', label: 'Snap perpendicular' },
]

export function SnapPopover({
  snapSettings,
  activeSnapMode,
  onToggleSnapEnabled,
  onToggleSnapMode,
}: SnapPopoverProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const enabledCount = snapSettings.modes.length

  return (
    <div className="snap-popover-host" ref={containerRef}>
      <div className="toolbar-action">
        <button
          className={`toolbar-icon-btn ${snapSettings.enabled ? 'toolbar-icon-btn--active' : ''} ${activeSnapMode ? 'toolbar-icon-btn--live' : ''}`}
          type="button"
          aria-label={snapSettings.enabled ? `Snapping enabled (${enabledCount} modes)` : 'Snapping disabled'}
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          <Icon id="snap" />
          {snapSettings.enabled && enabledCount > 0 && (
            <span className="snap-popover-badge">{enabledCount}</span>
          )}
        </button>
        <span className="toolbar-tooltip toolbar-tooltip--bottom" role="tooltip">
          Snap settings
        </span>
      </div>
      {open && (
        <div className="snap-popover" role="menu">
          <div className="snap-popover-header">
            <button
              className={`snap-popover-enable-btn ${snapSettings.enabled ? 'snap-popover-enable-btn--active' : ''}`}
              type="button"
              onClick={() => onToggleSnapEnabled()}
            >
              {snapSettings.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
          <div className="snap-popover-grid">
            {SNAP_MODES.map(({ mode, icon, label }) => {
              const active = snapSettings.enabled && snapSettings.modes.includes(mode)
              const emphasized = snapSettings.enabled && activeSnapMode === mode
              return (
                <button
                  key={mode}
                  className={`snap-popover-item ${active ? 'snap-popover-item--active' : ''} ${emphasized ? 'snap-popover-item--live' : ''}`}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={active}
                  aria-label={label}
                  onClick={() => onToggleSnapMode(mode)}
                >
                  <Icon id={icon} />
                  <span className="snap-popover-item-label">{label.replace('Snap ', '').replace('to ', '')}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
