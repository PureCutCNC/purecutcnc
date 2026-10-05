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
import { activeFace, isFaceEditInProgress, projectUsesBothFaces } from '../../store/helpers/activeFace'
import { switchWorkspaceFace } from '../../store/workspaceFace'
import { useI18n } from '../../i18n/i18nContext'
import type { SetupFace } from '../../types/project'
import { Icon } from '../Icon'

const FACES: readonly SetupFace[] = ['top', 'bottom']

/**
 * The Top | Bottom segmented control in the workspace header, plus the
 * "Other side" ghost toggle once the project uses both faces.
 */
export function FaceSwitch() {
  const { t } = useI18n()
  const face = useProjectStore((state) => activeFace(state.project))
  const bothFaces = useProjectStore((state) => projectUsesBothFaces(state.project))
  // A feature being edited, moved or combined belongs to the face it is on:
  // finishing that first keeps an edit from landing on a ghost.
  const busy = useProjectStore(isFaceEditInProgress)
  const showOtherSide = useFaceViewStore((state) => state.showOtherSide)
  const setShowOtherSide = useFaceViewStore((state) => state.setShowOtherSide)

  return (
    <div className="face-switch">
      <span className="face-switch__label" aria-hidden="true">{t('appShell.face.label')}</span>
      <div className="face-switch__segments" role="group" aria-label={t('appShell.face.label')}>
        {FACES.map((entry) => {
          const pressed = face === entry
          return (
            <button
              key={entry}
              type="button"
              className={`face-switch__segment face-switch__segment--${entry}${pressed ? ' face-switch__segment--active' : ''}`}
              aria-pressed={pressed}
              disabled={busy && !pressed}
              title={busy && !pressed ? t('appShell.face.busy') : t(entry === 'top' ? 'appShell.face.switchToTop' : 'appShell.face.switchToBottom')}
              onClick={() => { if (!pressed) switchWorkspaceFace(entry) }}
            >
              <Icon id={entry === 'top' ? 'face-top' : 'face-bottom'} size={18} />
              <span>{t(entry === 'top' ? 'appShell.face.top' : 'appShell.face.bottom')}</span>
            </button>
          )
        })}
      </div>
      {bothFaces && (
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
