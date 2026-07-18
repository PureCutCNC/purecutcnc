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

/**
 * First-run / empty-state onboarding overlay shown over the center viewport when
 * the project has no features. Offers the three happy-path entry points: draw a
 * shape, import a file, or open a bundled example project.
 */

import { useI18n } from '../../i18n/i18nContext'
import { ExampleProjectList } from '../project/ExampleProjectList'

interface EmptyStateOverlayProps {
  onDraw: () => void
  onImport: () => void
  /** Called after a bundled example has been loaded into the store. */
  onExampleOpened: () => void
}

export function EmptyStateOverlay({ onDraw, onImport, onExampleOpened }: EmptyStateOverlayProps) {
  const { t } = useI18n()
  return (
    <div className="empty-state-overlay">
      <div className="empty-state-card">
        <h2 className="empty-state-card__title">{t('viewport.empty.title')}</h2>
        <p className="empty-state-card__subtitle">{t('viewport.empty.subtitle')}</p>

        <div className="empty-state-card__actions">
          <button className="empty-state-action" type="button" onClick={onDraw}>
            <span className="empty-state-action__title">{t('viewport.empty.drawTitle')}</span>
            <span className="empty-state-action__meta">{t('viewport.empty.drawMeta')}</span>
          </button>
          <button className="empty-state-action" type="button" onClick={onImport}>
            <span className="empty-state-action__title">{t('viewport.empty.importTitle')}</span>
            <span className="empty-state-action__meta">{t('viewport.empty.importMeta')}</span>
          </button>
        </div>

        <div className="empty-state-card__examples">
          <div className="empty-state-card__examples-label">{t('viewport.empty.examplesLabel')}</div>
          <ExampleProjectList onOpened={onExampleOpened} />
        </div>
      </div>
    </div>
  )
}
