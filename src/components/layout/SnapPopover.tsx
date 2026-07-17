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
import { Icon } from '../Icon'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import type { SnapMode, SnapSettings } from '../../sketch/snapping'

interface SnapPopoverProps {
  snapSettings: SnapSettings
  activeSnapMode?: SnapMode | null
  onToggleSnapEnabled: () => void
  onToggleSnapMode: (mode: SnapMode) => void
}

// Full label for accessibility, short label for the compact grid tile.
const SNAP_MODES: { mode: SnapMode; icon: string; labelKey: MessageKey; shortKey: MessageKey }[] = [
  { mode: 'grid', icon: 'snap-grid', labelKey: 'shell.snap.grid', shortKey: 'shell.snap.gridShort' },
  { mode: 'point', icon: 'snap-point', labelKey: 'shell.snap.point', shortKey: 'shell.snap.pointShort' },
  { mode: 'line', icon: 'snap-line', labelKey: 'shell.snap.line', shortKey: 'shell.snap.lineShort' },
  { mode: 'midpoint', icon: 'snap-midpoint', labelKey: 'shell.snap.midpoint', shortKey: 'shell.snap.midpointShort' },
  { mode: 'center', icon: 'snap-center', labelKey: 'shell.snap.center', shortKey: 'shell.snap.centerShort' },
  { mode: 'intersection', icon: 'snap-intersection', labelKey: 'shell.snap.intersection', shortKey: 'shell.snap.intersectionShort' },
  { mode: 'perpendicular', icon: 'snap-perpendicular', labelKey: 'shell.snap.perpendicular', shortKey: 'shell.snap.perpendicularShort' },
]

export function SnapPopover({
  snapSettings,
  activeSnapMode,
  onToggleSnapEnabled,
  onToggleSnapMode,
}: SnapPopoverProps) {
  const { t, tPlural } = useI18n()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useOutsideDismiss({ open, refs: containerRef, onDismiss: () => setOpen(false) })

  const enabledCount = snapSettings.modes.length

  return (
    <div className="snap-popover-host" ref={containerRef}>
      <div className="toolbar-action">
        <button
          className={`toolbar-icon-btn ${snapSettings.enabled ? 'toolbar-icon-btn--active' : ''} ${activeSnapMode ? 'toolbar-icon-btn--live' : ''}`}
          type="button"
          aria-label={snapSettings.enabled
            ? tPlural(enabledCount, 'shell.snap.enabledAria.one', 'shell.snap.enabledAria.other')
            : t('shell.snap.disabledAria')}
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          <Icon id="snap" />
          {snapSettings.enabled && enabledCount > 0 && (
            <span className="snap-popover-badge">{enabledCount}</span>
          )}
        </button>
        <span className="toolbar-tooltip toolbar-tooltip--bottom" role="tooltip">
          {t('shell.snap.settingsTooltip')}
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
              {snapSettings.enabled ? t('shell.snap.enabledButton') : t('shell.snap.disabledButton')}
            </button>
          </div>
          <div className="snap-popover-grid">
            {SNAP_MODES.map(({ mode, icon, labelKey, shortKey }) => {
              const active = snapSettings.enabled && snapSettings.modes.includes(mode)
              const emphasized = snapSettings.enabled && activeSnapMode === mode
              return (
                <button
                  key={mode}
                  className={`snap-popover-item ${active ? 'snap-popover-item--active' : ''} ${emphasized ? 'snap-popover-item--live' : ''}`}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={active}
                  aria-label={t(labelKey)}
                  onClick={() => onToggleSnapMode(mode)}
                >
                  <Icon id={icon} />
                  <span className="snap-popover-item-label">{t(shortKey)}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
