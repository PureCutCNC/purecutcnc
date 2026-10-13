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
import { activeFace, aroundUnavailableReason, isFaceEditInProgress, projectUsesBothFaces } from '../../store/helpers/activeFace'
import { switchWorkspaceFace } from '../../store/workspaceFace'
import { useI18n } from '../../i18n/i18nContext'
import { isRoundStock } from '../../types/project'
import type { Project, SetupFace } from '../../types/project'
import { Icon } from '../Icon'
import { machineMode, showsFaceSwitch } from '../cam/machineMode'

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
 * the "Other side" ghost toggle once the project uses both faces.
 *
 * The Around segment appears only on a round bar; without a rotary machine, or
 * when the machine's axis lies across the bar, it stays visible but disabled,
 * saying what is missing. A plasma machine hides the switch entirely (#960) —
 * a plasma table cuts through one sheet — unless the project already carries
 * content on both faces, which must stay reachable.
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

  const aroundReason = aroundUnavailableReason(project)
  const entries = aroundReason === 'needsRoundBar' ? FLAT_ENTRIES : [...FLAT_ENTRIES, AROUND_ENTRY]
  const aroundTitle = aroundReason === 'needsRotaryMachine'
    ? t('appShell.face.aroundNeedsRotaryMachine')
    : aroundReason === 'machineAxisMismatch'
      ? t('appShell.face.aroundAxisMismatch', {
        machineAxis: (project.meta.machineDefinitions?.[0]?.rotary?.about ?? '').toUpperCase(),
        stockAxis: (isRoundStock(project.stock) ? project.stock.axis : '').toUpperCase(),
      })
      : t('appShell.face.switchToAround')
  // The other-side toggle compares the two flat faces only: Around is not a
  // half-turn of either, so it is never shown there.
  const flatOtherSide = face !== 'around' && (face !== 'top' || hasBottomContent(project))

  return (
    <div className="face-switch">
      <span className="face-switch__label" aria-hidden="true">{t('appShell.face.label')}</span>
      <div className="face-switch__segments" role="group" aria-label={t('appShell.face.label')}>
        {entries.map((entry) => {
          const pressed = face === entry.face
          const unavailable = entry.face === 'around' && aroundReason !== null
          return (
            <button
              key={entry.face}
              type="button"
              className={`face-switch__segment face-switch__segment--${entry.face}${pressed ? ' face-switch__segment--active' : ''}`}
              aria-pressed={pressed}
              disabled={unavailable || (busy && !pressed)}
              title={unavailable
                ? aroundTitle
                : busy && !pressed
                  ? t('appShell.face.busy')
                  : entry.face === 'around'
                    ? t('appShell.face.switchToAround')
                    : t(entry.face === 'top' ? 'appShell.face.switchToTop' : 'appShell.face.switchToBottom')}
              onClick={() => { if (!pressed && !unavailable) switchWorkspaceFace(entry.face) }}
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
          title={t(showOtherSide ? 'appShell.face.hideOtherSide' : 'appShell.face.showOtherSide')}
          onClick={() => setShowOtherSide(!showOtherSide)}
        >
          <Icon id={showOtherSide ? 'eye' : 'eye-off'} size={16} />
          <span>{t('appShell.face.otherSide')}</span>
        </button>
      )}
    </div>
  )
}
