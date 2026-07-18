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

/** Depth-colour legend overlay shown on the sketch canvas. */
export function DepthLegend({ onToggleDepthLegend }: { onToggleDepthLegend?: () => void }) {
  const { t } = useI18n()

  return (
    <div className="sketch-depth-legend">
      <div className="sketch-depth-legend__header">
        <span>{t('canvas.legend.heading')}</span>
        <button
          className="sketch-depth-legend__toggle tree-action-btn"
          type="button"
          onClick={onToggleDepthLegend}
          aria-label={t('canvas.legend.collapseAria')}
          title={t('canvas.legend.collapseTitle')}
        >
          ▾
        </button>
      </div>
      <div className="sketch-depth-legend__items">
        <div className="sketch-depth-legend__item">
          <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--subtract" />
          <span>{t('canvas.legend.subtract')}</span>
        </div>
        <div className="sketch-depth-legend__item">
          <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--add" />
          <span>{t('canvas.legend.addFeature')}</span>
        </div>
        <div className="sketch-depth-legend__item">
          <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--region" />
          <span>{t('canvas.legend.regionInclude')}</span>
        </div>
        <div className="sketch-depth-legend__item">
          <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--region-exclude" />
          <span>{t('canvas.legend.regionExclude')}</span>
        </div>
        <div className="sketch-depth-legend__item">
          <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--imported-model" />
          <span>{t('canvas.legend.importedModel')}</span>
        </div>
        <div className="sketch-depth-legend__item">
          <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--selected" />
          <span>{t('canvas.legend.selected')}</span>
        </div>
      </div>
    </div>
  )
}
