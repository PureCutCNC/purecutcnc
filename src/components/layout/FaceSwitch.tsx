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

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { usePortalPosition } from '../../hooks/usePortalPosition'
import { useProjectStore } from '../../store/projectStore'
import { useFaceViewStore } from '../../store/faceViewStore'
import { activeFace, activeSetup, aroundUnavailableReason, isFaceEditInProgress, projectUsesBothFaces } from '../../store/helpers/activeFace'
import { switchWorkspaceFace } from '../../store/workspaceFace'
import { useI18n } from '../../i18n/i18nContext'
import type { Project, SetupFace } from '../../types/project'
import { Icon } from '../Icon'
import { machineMode, showsFaceSwitch } from '../cam/machineMode'
import { faceSwitchExtras } from './faceSwitchExtras'
import { faceIcon, faceLabelKey, faceMenu } from './faceSwitchMenu'
import { useShellMode } from './useShellMode'

/** Whether the project carries anything on Bottom: a Bottom setup or a Bottom feature. */
function hasBottomContent(project: Project): boolean {
  return project.setups.some((setup) => setup.kind !== 'around' && setup.orientation.angleDeg === 180)
    || project.features.some((feature) => (feature.authoringFace ?? 'top') === 'bottom')
}

/**
 * The workspace face control (issue #1112 slice B, decision 6; carried from
 * #1107). One compact button names the face the workspace is on — "Bottom ·
 * flipped X" on a flipped Bottom view — and opens a menu with the project's
 * faces and the "Show other side" ghost overlay. It replaces the old segmented
 * pills, the short flip chip and the separate eye.
 *
 * The tree's face section headings are the second home of the same action
 * (`FeatureTree`), so switching is one call in both places and the refusal
 * while an edit is in progress is one rule (`store/workspaceFace`).
 *
 * The Around entry appears only on a rotary project with a bar (issue #1028):
 * those two authoring conditions are the whole reason the face can be absent,
 * and no machine makes it unavailable — a missing, non-rotary or wrong-axis
 * machine still lets the user design on Around, and is enforced instead when a
 * program is posted (issue #1034). A plasma project hides the switch entirely
 * (#960) — a plasma table cuts through one sheet — unless the project already
 * carries content on both faces, which must stay reachable.
 */
export function FaceSwitch() {
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  const face = activeFace(project)
  const bothFaces = projectUsesBothFaces(project)
  const machine = useProjectStore((state) => machineMode(state.project))
  // A feature being edited, moved or combined belongs to the face it is on:
  // finishing that first keeps an edit from landing on a ghost.
  const busy = useProjectStore(isFaceEditInProgress)
  const showOtherSide = useFaceViewStore((state) => state.showOtherSide)
  const setShowOtherSide = useFaceViewStore((state) => state.setShowOtherSide)
  // The menu is portalled outside `.app-shell`, so it cannot inherit the
  // shell's own attribute: carry it on the portal root for the tablet tap
  // targets in face.css (issue #1112).
  const shellMode = useShellMode()

  const [open, setOpen] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuFocusPlaced = useRef(false)
  const menuId = useId()

  useOutsideDismiss({ open, refs: [hostRef, menuRef], onDismiss: () => setOpen(false) })

  // Escape closes the menu and gives the control its focus back, the same way
  // choosing an entry does. It is caught in the capture phase and swallowed:
  // an open menu owns Escape, so it cannot also cancel the sketch edit the
  // workspace is refusing to leave (issue #1112).
  useEffect(() => {
    if (!open) return
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', closeOnEscape, true)
    return () => document.removeEventListener('keydown', closeOnEscape, true)
  }, [open])

  // The menu is portalled to the body: the tablet face row clips its own
  // overflow, and an in-flow menu would be cut off there.
  const coords = usePortalPosition(triggerRef, menuRef, open, (anchor, floating) => {
    const margin = 8
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - floating.width - margin))
    const top = Math.min(anchor.bottom + 6, window.innerHeight - floating.height - margin)
    return { top, left }
  })

  // The menu is portalled to the end of the document, so opening it puts focus
  // on the face in view: Tab from the control would otherwise walk straight
  // past the menu into the rest of the shell (issue #1112).
  //
  // The first open has no measured position yet, and the menu is still
  // `visibility: hidden` until the layout effect above lands: `focus()` on a
  // hidden element is silently ignored, which left keyboard focus on the
  // control instead of the menu (issue #1112 slice B e2e). Wait for the
  // position, then move focus once — a later scroll re-position must not pull
  // focus back from an entry the user has already tabbed to.
  useEffect(() => {
    if (!open) {
      menuFocusPlaced.current = false
      return
    }
    if (coords === null || menuFocusPlaced.current) return
    menuFocusPlaced.current = true
    const checked = menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"][aria-checked="true"]')
    checked?.focus({ preventScroll: true })
  }, [open, coords])

  if (!showsFaceSwitch(machine, bothFaces)) return null

  const aroundAvailable = aroundUnavailableReason(project) === null
  const model = faceMenu({
    face,
    aroundAvailable,
    bothFaces,
    hasBottomContent: hasBottomContent(project),
    busy,
    showOtherSide,
  })
  // The control carries the face's own name and, on a flipped Bottom view, the
  // axis it was turned about: "Bottom · flipped X".
  const flipAxis = faceSwitchExtras({ face, bothFaces, axis: activeSetup(project).orientation.axis }).flipAxis
  const faceLabel = t(faceLabelKey(face))
  const label = flipAxis === null
    ? faceLabel
    : `${faceLabel} · ${t('appShell.face.flippedShort', { axis: flipAxis.toUpperCase() })}`
  const accessibleName = t('appShell.face.current', { face: label })

  function closeAndFocus(): void {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }

  function choose(next: SetupFace): void {
    switchWorkspaceFace(next)
    closeAndFocus()
  }

  return (
    <div className="face-switch" ref={hostRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`face-switch__trigger face-switch__trigger--${face}`}
        data-face={face}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={accessibleName}
        title={accessibleName}
        onClick={() => setOpen((previous) => !previous)}
      >
        <Icon id={faceIcon(face)} size={18} />
        <span className="face-switch__trigger-label">{label}</span>
        <Icon id="chevron-down" size={14} className="face-switch__chevron" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="face-switch__menu"
              data-shell-mode={shellMode}
              role="menu"
              aria-label={t('appShell.face.label')}
              style={{
                position: 'fixed',
                top: coords?.top ?? -9999,
                left: coords?.left ?? -9999,
                visibility: coords ? 'visible' : 'hidden',
              }}
            >
              {model.items.map((entry) => (
                <button
                  key={entry.face}
                  type="button"
                  role="menuitemradio"
                  aria-checked={entry.checked}
                  data-face={entry.face}
                  className={`face-switch__menu-item face-switch__menu-item--${entry.face}`}
                  disabled={entry.disabled}
                  title={t(entry.titleKey)}
                  onClick={() => choose(entry.face)}
                >
                  <Icon id={entry.icon} size={16} />
                  <span className="face-switch__menu-label">{t(entry.labelKey)}</span>
                  <span className="face-switch__menu-check" aria-hidden="true">
                    {entry.checked ? <Icon id="check" size={14} /> : null}
                  </span>
                </button>
              ))}
              {model.otherSide === null
                ? null
                : (
                    <>
                      <div className="face-switch__menu-separator" role="separator" />
                      <button
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={model.otherSide.checked}
                        className="face-switch__menu-item face-switch__menu-item--other-side"
                        title={t(showOtherSide ? 'appShell.face.hideOtherSide' : 'appShell.face.showOtherSide')}
                        onClick={() => {
                          setShowOtherSide(!showOtherSide)
                          closeAndFocus()
                        }}
                      >
                        <Icon id={showOtherSide ? 'eye' : 'eye-off'} size={16} />
                        <span className="face-switch__menu-label">{t('appShell.face.showOtherSideItem')}</span>
                        <span className="face-switch__menu-check" aria-hidden="true">
                          {showOtherSide ? <Icon id="check" size={14} /> : null}
                        </span>
                      </button>
                    </>
                  )}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
