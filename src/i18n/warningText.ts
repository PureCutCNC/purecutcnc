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

import type { ToolpathWarning } from '../engine/toolpaths/warningCodes'
import type { MessageKey } from './locales/en'
import { translate } from './store'

/**
 * The single presentation mapper for structured engine warnings: resolves
 * `{ code, params }` to localized text in the active locale. Callers render
 * at display time (React components re-render via `useI18n()`), so switching
 * language re-translates visible warnings. The one nested translation is the
 * clamp move-kind word: engines pass a raw `moveKindId` and the localized
 * word is injected as `{moveKind}`.
 */
export function toolpathWarningText(warning: ToolpathWarning): string {
  let params = warning.params
  if (params && typeof params.moveKindId === 'string') {
    params = { ...params, moveKind: translate(`warnings.moveKind.${params.moveKindId}` as MessageKey) }
  }
  return translate(`warnings.${warning.code}` as MessageKey, params)
}

/** Convenience for rendering a whole warning list. */
export function toolpathWarningTexts(warnings: readonly ToolpathWarning[]): string[] {
  return warnings.map(toolpathWarningText)
}
