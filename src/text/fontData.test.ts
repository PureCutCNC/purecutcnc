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

/**
 * Smoke test for parseFontJson — the typed font-parse seam that replaced the
 * `fontLoader.parse(... as any)` casts. Parsing a real typeface JSON should
 * yield a three `Font` whose glyph data round-trips.
 *
 * Run with: npx tsx src/text/fontData.test.ts
 */

import helvetikerRegular from 'three/examples/fonts/helvetiker_regular.typeface.json'
import { parseFontJson } from './fontData'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function testParsesTypefaceJson() {
  const font = parseFontJson(helvetikerRegular)
  assert(font.isFont === true, 'returns a three Font (isFont)')
  assert(typeof font.data.familyName === 'string' && font.data.familyName.length > 0, 'font carries a family name')
  assert(font.generateShapes('A', 10).length > 0, 'can generate glyph shapes from the parsed font')
  console.log('parses typeface JSON: PASSED')
}

try {
  testParsesTypefaceJson()
  console.log('\nAll fontData tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
