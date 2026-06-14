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

import { FontLoader, type Font, type FontData } from 'three/examples/jsm/loaders/FontLoader.js'

const fontLoader = new FontLoader()

/**
 * Parse a typeface JSON blob into a three `Font`.
 *
 * Imported `*.typeface.json` modules are typed by their inferred JSON shape,
 * which doesn't structurally satisfy three's `FontData`; the data is a valid
 * typeface at runtime, so the single cast lives here instead of at each call.
 */
export function parseFontJson(data: unknown): Font {
  return fontLoader.parse(data as FontData)
}
