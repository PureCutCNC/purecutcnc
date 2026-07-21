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
import { shellEs } from './shell'
import { sketchEs } from './sketch'
import { canvasEs } from './canvas'
import { featureTreeEs } from './featureTree'
import { camEs } from './cam'
import { dialogsEs } from './dialogs'
import { viewportEs } from './viewport'
import { appShellEs } from './appShell'
import { warningsEs } from './warnings'
import { languageManagerEs } from './languageManager'
import { themeManagerEs } from './themeManager'
import { bookletEs } from './booklet'
import { printEs } from './print'

/** Complete built-in Spanish catalog. */
export const es: Record<MessageKey, string> = {
  ...shellEs,
  ...camEs,
  ...dialogsEs,
  ...warningsEs,
  ...sketchEs,
  ...canvasEs,
  ...featureTreeEs,
  ...viewportEs,
  ...appShellEs,
  ...languageManagerEs,
  ...themeManagerEs,
  ...bookletEs,
  ...printEs,
}
