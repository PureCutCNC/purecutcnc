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

import { useId, useRef, useState } from 'react'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { useI18n } from '../../i18n/i18nContext'
import { Icon } from '../Icon'
import {
  VIEW_PRESET_ORDER,
  viewPresetMeta,
  type ViewPreset,
} from './viewPresets'

export interface ViewPresetMenuProps {
  /** Currently active named preset, or `null` when the camera is free-orbited. */
  activePreset: ViewPreset | null
  /** Snap to a named preset. */
  onSelect: (preset: ViewPreset) => void
  /** Frame the model in the current view (Fit to model). */
  onFit: () => void
  /** Reset to isometric orientation and reframe (Reset view). */
  onReset: () => void
}

/**
 * Single-button dropdown that shows the **current** camera view and opens a
 * menu of standard views plus Fit/Reset actions. Replaces the 7-button
 * preset row that lived in both `Viewport3D.tsx` and `SimulationViewport.tsx`
 * (issue #243). Mirrors the `AppearanceControl` dropdown pattern
 * (`useOutsideDismiss`, `role="menu"`, `menuitemradio`, `aria-checked`).
 */
export function ViewPresetMenu({ activePreset, onSelect, onFit, onReset }: ViewPresetMenuProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()

  useOutsideDismiss({ open, refs: hostRef, onDismiss: () => setOpen(false) })

  const currentMeta = viewPresetMeta(activePreset)
  const currentLabel = t(currentMeta.labelKey)

  const choose = (action: () => void) => {
    action()
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="view-preset-menu" ref={hostRef}>
      <button
        ref={triggerRef}
        className="preset-btn preset-btn--icon view-preset-menu__trigger"
        type="button"
        aria-label={t('viewport.viewMenu.ariaLabel')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={currentLabel}
        onClick={() => setOpen((previous) => !previous)}
      >
        <Icon id={currentMeta.iconId} />
      </button>

      {open && (
        <div className="view-preset-menu__panel" id={menuId} role="menu" aria-label={t('viewport.viewMenu.ariaLabel')}>
          <div className="view-preset-menu__heading">{t('viewport.viewMenu.headingStandard')}</div>
          <div className="view-preset-menu__options">
            {VIEW_PRESET_ORDER.map((preset) => {
              const meta = viewPresetMeta(preset)
              const selected = preset === activePreset
              return (
                <button
                  key={preset}
                  className={`view-preset-menu__option ${selected ? 'view-preset-menu__option--selected' : ''}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => choose(() => onSelect(preset))}
                >
                  <span className="view-preset-menu__icon" aria-hidden="true">
                    <Icon id={meta.iconId} size={20} />
                  </span>
                  <span className="view-preset-menu__label">{t(meta.labelKey)}</span>
                  <span className="view-preset-menu__check" aria-hidden="true">{selected ? '✓' : ''}</span>
                </button>
              )
            })}
          </div>

          <div className="view-preset-menu__heading view-preset-menu__heading--section">{t('viewport.viewMenu.headingActions')}</div>
          <div className="view-preset-menu__options">
            <button
              className="view-preset-menu__option view-preset-menu__option--action"
              type="button"
              role="menuitem"
              onClick={() => choose(onFit)}
            >
              <span className="view-preset-menu__label">{t('viewport.viewMenu.fit')}</span>
            </button>
            <button
              className="view-preset-menu__option view-preset-menu__option--action"
              type="button"
              role="menuitem"
              onClick={() => choose(onReset)}
            >
              <span className="view-preset-menu__label">{t('viewport.viewMenu.reset')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
