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

export function ToolpathGpuSuggestion({ onEnable, onDismiss }: { onEnable: () => void; onDismiss: () => void }) {
  const { t } = useI18n()
  const finish = (action: () => void, button: HTMLButtonElement) => {
    const panel = button.closest('.viewport-toolpath-vis')
    action()
    const target = panel?.querySelector<HTMLButtonElement>('.viewport-toolpath-vis__gpu')
      ?? panel?.querySelector<HTMLButtonElement>('.viewport-toolpath-vis__label')
    target?.focus()
  }
  return (
    <aside className="toolpath-gpu-suggestion" aria-label={t('appShell.toolpath.gpuSuggestionTitle')}>
      <div role="status">
        <strong>{t('appShell.toolpath.gpuSuggestionTitle')}</strong>
        <p>{t('appShell.toolpath.gpuSuggestionBody')}</p>
      </div>
      <div className="toolpath-gpu-suggestion__actions">
        <button type="button" className="toolpath-gpu-suggestion__enable" onClick={event => finish(onEnable, event.currentTarget)}>
          {t('appShell.toolpath.gpuSuggestionEnable')}
        </button>
        <button type="button" onClick={event => finish(onDismiss, event.currentTarget)}>{t('appShell.toolpath.gpuSuggestionDismiss')}</button>
      </div>
    </aside>
  )
}
