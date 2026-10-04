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
import { activeFace, activeSetup, projectUsesBothFaces } from '../../store/helpers/activeFace'
import { useI18n } from '../../i18n/i18nContext'
import { Icon } from '../Icon'
import { FaceSwitch } from './FaceSwitch'

interface FaceBannerProps {
  /**
   * Carry the face switch in the row. Tablet shells have no workspace header
   * and no room in the top command bar, so the switch lives here.
   */
  withSwitch?: boolean
}

/**
 * The row above the sketch that says which face it is on (issue #945): how
 * the stock was turned for Bottom, and which face a new feature lands on. A
 * Top-only project shows none of that — only the switch, where the row
 * carries it.
 */
export function FaceBanner({ withSwitch = false }: FaceBannerProps) {
  const { t } = useI18n()
  const face = useProjectStore((state) => activeFace(state.project))
  const flipAxis = useProjectStore((state) => activeSetup(state.project).orientation.axis)
  const bothFaces = useProjectStore((state) => projectUsesBothFaces(state.project))
  if (!bothFaces && !withSwitch) return null

  return (
    <div className={`face-banner face-banner--${face}`} data-face={face}>
      {withSwitch ? <FaceSwitch /> : null}
      {bothFaces && face === 'bottom' && (
        <div className="face-banner__note" role="status">
          <Icon id="refresh" size={16} />
          <span>
            {t(flipAxis === 'x' ? 'canvas.face.flippedAboutX' : 'canvas.face.flippedAboutY')}
            {' '}
            {t('canvas.face.topIsGhost')}
          </span>
        </div>
      )}
      {bothFaces && (
        <div className="face-banner__hint">
          <Icon id={face === 'top' ? 'face-top' : 'face-bottom'} size={16} />
          <span>{t(face === 'top' ? 'canvas.face.drawingOnTop' : 'canvas.face.drawingOnBottom')}</span>
        </div>
      )}
    </div>
  )
}
