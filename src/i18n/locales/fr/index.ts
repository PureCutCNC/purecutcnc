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
import { appShellFr } from './appShell'
import { bookletFr } from './booklet'
import { camFr } from './cam'
import { canvasFr } from './canvas'
import { dialogsFr } from './dialogs'
import { featureTreeFr } from './featureTree'
import { languageManagerFr } from './languageManager'
import { printFr } from './print'
import { shellFr } from './shell'
import { sketchFr } from './sketch'
import { themeManagerFr } from './themeManager'
import { viewportFr } from './viewport'
import { warningsFr } from './warnings'

/** Complete French built-in catalog. */
export const fr: Record<MessageKey, string> = {
  ...shellFr,
  ...sketchFr,
  ...camFr,
  ...dialogsFr,
  ...warningsFr,
  ...canvasFr,
  ...featureTreeFr,
  ...viewportFr,
  ...appShellFr,
  ...languageManagerFr,
  ...themeManagerFr,
  ...bookletFr,
  ...printFr,
}
