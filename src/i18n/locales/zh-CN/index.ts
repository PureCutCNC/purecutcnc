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
import { shellZhCN } from './shell'
import { sketchZhCN } from './sketch'
import { canvasZhCN } from './canvas'
import { featureTreeZhCN } from './featureTree'
import { camZhCN } from './cam'
import { dialogsZhCN } from './dialogs'
import { viewportZhCN } from './viewport'
import { appShellZhCN } from './appShell'
import { warningsZhCN } from './warnings'
import { languageManagerZhCN } from './languageManager'
import { themeManagerZhCN } from './themeManager'
import { bookletZhCN } from './booklet'
import { printZhCN } from './print'

/**
 * The complete Simplified Chinese catalog, merged from per-area modules that
 * mirror `locales/en/`. Typed as a full record so the compiler enforces the
 * ship-complete contract; the runtime still resolves per key against English,
 * so a future partial locale only needs to relax this type.
 */
export const zhCN: Record<MessageKey, string> = {
  ...shellZhCN,
  ...camZhCN,
  ...dialogsZhCN,
  ...warningsZhCN,
  ...sketchZhCN,
  ...canvasZhCN,
  ...featureTreeZhCN,
  ...viewportZhCN,
  ...appShellZhCN,
  ...languageManagerZhCN,
  ...themeManagerZhCN,
  ...bookletZhCN,
  ...printZhCN,
}
