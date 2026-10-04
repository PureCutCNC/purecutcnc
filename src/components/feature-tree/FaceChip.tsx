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

import { useI18n } from '../../i18n/i18nContext'
import { useFaceViewStore } from '../../store/faceViewStore'
import type { SetupFace } from '../../types/project'

/** The small TOP / BOTTOM tag that names a stock face (issue #945). */
export function FaceChip({ face }: { face: SetupFace }) {
  const { t } = useI18n()
  return (
    <span className={`face-chip face-chip--${face}`}>
      {t(face === 'top' ? 'featureTree.face.chipTop' : 'featureTree.face.chipBottom')}
    </span>
  )
}

/**
 * The properties row that names the face the selection is authored on and
 * opens the confirmation for changing it. The change itself is never made
 * from here.
 */
export function AuthoringFaceRow({ face, featureIds }: { face: SetupFace; featureIds: readonly string[] }) {
  const { t } = useI18n()
  const requestFaceChange = useFaceViewStore((state) => state.requestFaceChange)
  return (
    <div className="properties-field face-row">
      <span>{t('featureTree.face.authoringFace')}</span>
      <div className="face-row__value">
        <FaceChip face={face} />
        <button className="feat-btn face-row__change" type="button" onClick={() => requestFaceChange(featureIds)}>
          {t('featureTree.face.change')}
        </button>
      </div>
    </div>
  )
}
