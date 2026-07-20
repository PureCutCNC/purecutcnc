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

import type { MessageKey } from '../en'
import { shellDe } from './shell'
import { sketchDe } from './sketch'
import { canvasDe } from './canvas'
import { featureTreeDe } from './featureTree'
import { camDe } from './cam'
import { dialogsDe } from './dialogs'
import { viewportDe } from './viewport'
import { appShellDe } from './appShell'
import { warningsDe } from './warnings'
import { languageManagerDe } from './languageManager'
import { themeManagerDe } from './themeManager'
import { bookletDe } from './booklet'
import { printDe } from './print'

/**
 * The complete German catalog, merged from per-area modules that mirror
 * `locales/en/`. Typed as a full record so the compiler enforces the
 * ship-complete contract; the runtime still resolves per key against English,
 * so a future partial locale only needs to relax this type.
 */
export const de: Record<MessageKey, string> = {
  ...shellDe,
  ...camDe,
  ...dialogsDe,
  ...warningsDe,
  ...sketchDe,
  ...canvasDe,
  ...featureTreeDe,
  ...viewportDe,
  ...appShellDe,
  ...languageManagerDe,
  ...themeManagerDe,
  ...bookletDe,
  ...printDe,
}
