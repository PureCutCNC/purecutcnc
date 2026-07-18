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

import type { MessageParams } from '../../i18n/catalog'
import type { camEn } from '../../i18n/locales/en/cam'
import { translate } from '../../i18n/store'

/**
 * Typed translation helper scoped to the cam catalog module — a thin
 * delegate to the i18n store now that the module is registered. Pure modules
 * (operationValidity, operationParamRefData) may call it freely; React
 * components that render its output must also call `useI18n()` so they
 * re-render when the locale changes (module-level translation does not
 * subscribe them).
 */
export const camT = (key: keyof typeof camEn, params?: MessageParams): string =>
  translate(key, params)
