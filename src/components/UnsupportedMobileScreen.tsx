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

export function UnsupportedMobileScreen() {
  const { t } = useI18n()
  return (
    <main className="unsupported-mobile-shell">
      <div className="unsupported-mobile-card">
        <div className="unsupported-mobile-eyebrow">{t('mobileBlocker.eyebrow')}</div>
        <h1>{t('mobileBlocker.title')}</h1>
        <p>{t('mobileBlocker.body')}</p>
        <div className="unsupported-mobile-actions">
          <a href="https://purecutcnc.github.io/downloads.html">{t('mobileBlocker.downloads')}</a>
          <a href="https://purecutcnc.github.io/">{t('mobileBlocker.website')}</a>
        </div>
      </div>
    </main>
  )
}
