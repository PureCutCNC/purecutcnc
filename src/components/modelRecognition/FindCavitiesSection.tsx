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

import { DisclosureSection } from '../common/DisclosureSection'
import { useI18n } from '../../i18n/i18nContext'
import { useModelRecognitionStore } from '../../store/modelRecognitionStore'
import { useProjectStore } from '../../store/projectStore'
import { modelRecognitionRefusal } from '../../store/helpers/recognizedFeatures'

/**
 * The Properties entry to Find pockets and holes (issue #1206). It is a
 * button, not only a context-menu item, because a tablet has no right-click.
 * Shown only for a model the search can run on; other features get nothing.
 */
export function FindCavitiesSection({ featureId }: { featureId: string }) {
  const { t } = useI18n()
  const offered = useProjectStore((state) => modelRecognitionRefusal(state.project, featureId) === null)
  const request = useModelRecognitionStore((state) => state.requestModelRecognition)
  if (!offered) return null

  return (
    <DisclosureSection title={t('featureTree.findCavities.sectionTitle')} storageKey="feature-find-cavities" defaultOpen>
      <p className="properties-note find-cavities-section__hint">{t('featureTree.findCavities.sectionHint')}</p>
      <div className="properties-actions">
        <button
          className="feat-btn"
          type="button"
          onClick={() => request(featureId)}
          data-testid="find-cavities-open"
        >
          {t('featureTree.findCavities.command')}
        </button>
      </div>
    </DisclosureSection>
  )
}
