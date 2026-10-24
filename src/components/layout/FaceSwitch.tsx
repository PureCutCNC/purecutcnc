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

import { useProjectStore } from '../../store/projectStore'
import { useFaceViewStore } from '../../store/faceViewStore'
import { activeFace, activeSetup, aroundUnavailableReason, isFaceEditInProgress, projectUsesBothFaces } from '../../store/helpers/activeFace'
import { switchWorkspaceFace } from '../../store/workspaceFace'
import { useI18n } from '../../i18n/i18nContext'
import type { Project, SetupFace } from '../../types/project'
import { Icon } from '../Icon'
import { machineMode, showsFaceSwitch } from '../cam/machineMode'
import { faceSwitchExtras } from './faceSwitchExtras'

/** One segment: the face it selects, and the icon and label it wears. */
interface FaceEntry {
  face: SetupFace
  icon: string
  label: 'appShell.face.top' | 'appShell.face.bottom' | 'appShell.face.around'
}

const FLAT_ENTRIES: readonly FaceEntry[] = [
  { face: 'top', icon: 'face-top', label: 'appShell.face.top' },
  { face: 'bottom', icon: 'face-bottom', label: 'appShell.face.bottom' },
]

const AROUND_ENTRY: FaceEntry = { face: 'around', icon: 'face-around', label: 'appShell.face.around' }

/** Whether the project carries anything on Bottom: a Bottom setup or a Bottom feature. */
function hasBottomContent(project: Project): boolean {
  return project.setups.some((setup) => setup.kind !== 'around' && setup.orientation.angleDeg === 180)
    || project.features.some((feature) => (feature.authoringFace ?? 'top') === 'bottom')
}

/**
 * The Top | Bottom | Around segmented control in the workspace header, plus
 * the "Other side" ghost toggle and, on a flipped Bottom view, the short
 * "Flipped about X/Y" chip (issue #1102 slice E).
 *
 * The Around segment appears only on a rotary project with a round bar
 * (issue #1028): those two authoring conditions are the whole reason the
 * segment can be absent, and no machine makes it unavailable — a missing,
 * non-rotary or wrong-axis machine still lets the user design on Around, and
 * is enforced instead when a program is posted (issue #1034). A plasma project
 * hides the switch entirely (#960) — a plasma table cuts through one sheet —
 * unless the project already carries content on both faces, which must stay
 * reachable.
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

  if (!showsFaceSwitch(machine, bothFaces)) return null

  // A non-rotary project has no Around face at all (issue #1028), so its
  // segment is hidden exactly as it is without a round bar. Nothing else can
  // make the segment unavailable: the machine is not an authoring condition
  // (issue #1034), so an Around segment that is shown is always usable.
  const entries = aroundUnavailableReason(project) === null
    ? [...FLAT_ENTRIES, AROUND_ENTRY]
    : FLAT_ENTRIES
  // The other-side toggle compares the two flat faces only: Around is not a
  // half-turn of either, so it is never shown there.
  const flatOtherSide = face !== 'around' && (face !== 'top' || hasBottomContent(project))
  // A Bottom view is a flipped stock: the switch says so in a short chip
  // instead of the old note row, and only once both faces are in use.
  const extras = faceSwitchExtras({ face, bothFaces, axis: activeSetup(project).orientation.axis })

  return (
    <div className="face-switch">
      <span className="face-switch__label" aria-hidden="true">{t('appShell.face.label')}</span>
      <div className="face-switch__segments" role="group" aria-label={t('appShell.face.label')}>
        {entries.map((entry) => {
          const pressed = face === entry.face
          return (
            <button
              key={entry.face}
              type="button"
              className={`face-switch__segment face-switch__segment--${entry.face}${pressed ? ' face-switch__segment--active' : ''}`}
              aria-pressed={pressed}
              disabled={busy && !pressed}
              title={busy && !pressed
                ? t('appShell.face.busy')
                : entry.face === 'around'
                  ? t('canvas.face.aroundTurnsBar')
                  : t(entry.face === 'top' ? 'appShell.face.switchToTop' : 'appShell.face.switchToBottom')}
              onClick={() => { if (!pressed) switchWorkspaceFace(entry.face) }}
            >
              <Icon id={entry.icon} size={18} />
              <span>{t(entry.label)}</span>
            </button>
          )
        })}
      </div>
      {bothFaces && flatOtherSide && (
        <button
          type="button"
          className={`face-switch__ghost face-switch__ghost--${face === 'top' ? 'bottom' : 'top'}${showOtherSide ? ' face-switch__ghost--on' : ''}`}
          aria-pressed={showOtherSide}
          aria-label={t('appShell.face.otherSide')}
          title={t(showOtherSide ? 'appShell.face.hideOtherSide' : 'appShell.face.showOtherSide')}
          onClick={() => setShowOtherSide(!showOtherSide)}
        >
          <Icon id={showOtherSide ? 'eye' : 'eye-off'} size={16} />
        </button>
      )}
      {extras.flipChip !== null && (
        <span
          className="face-switch__chip"
          role="status"
          title={`${t(extras.flipChip === 'x' ? 'canvas.face.flippedAboutX' : 'canvas.face.flippedAboutY')} ${t('canvas.face.topIsGhost')}`}
        >
          <Icon id="refresh" size={16} />
          <span>{t('appShell.face.flipped', { axis: extras.flipChip.toUpperCase() })}</span>
        </span>
      )}
    </div>
  )
}
