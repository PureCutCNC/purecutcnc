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

import { useI18n } from '../i18n/i18nContext'
import type { ToolpathRendererControl as RendererControl } from './canvas/toolpathRendererPreference'

/** Sketch-only application preference; not part of saved project settings. */
export function ToolpathRendererControl({ renderer }: { renderer: RendererControl }) {
  const { t } = useI18n()
  return (
    <>
      <button
        className={`viewport-toolpath-vis__item viewport-toolpath-vis__gpu ${renderer.choice === 'gpu' ? 'viewport-toolpath-vis__item--selected' : ''}`}
        type="button"
        aria-pressed={renderer.choice === 'gpu'}
        title={`${t('appShell.toolpath.renderer')}: ${t(renderer.choice === 'gpu' ? 'appShell.toolpath.rendererGpu' : 'appShell.toolpath.rendererCanvas')}`}
        onClick={() => renderer.onChange(renderer.choice === 'gpu' ? 'canvas' : 'gpu')}
      >
        <span className="viewport-toolpath-vis__swatch viewport-toolpath-vis__swatch--gpu" />
        {t('appShell.toolpath.rendererGpu')}
      </button>
      {renderer.status === 'loading' && (
        <span className="viewport-toolpath-renderer__status" role="status">{t('appShell.toolpath.rendererLoading')}</span>
      )}
      {renderer.status === 'fallback' && (
        <span className="viewport-toolpath-renderer__status" role="status">
          <span>{t('appShell.toolpath.rendererFallback')}</span>
          <button type="button" onClick={renderer.onRetry}>{t('appShell.toolpath.rendererRetry')}</button>
        </span>
      )}
    </>
  )
}
