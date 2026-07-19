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

import { initI18nStore } from './store'

/**
 * Resolves the persisted (or auto-detected) locale and applies the document
 * language attribute before React renders, mirroring `bootstrapTheme()`: no
 * wrong-language flash, and screens outside the main app tree (phone
 * blocker) see the right locale too. Any storage failure falls back to
 * English.
 */
export function bootstrapI18n(): void {
  initI18nStore(typeof window === 'undefined' ? null : window.localStorage)
}
