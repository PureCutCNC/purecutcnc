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
 * Scallop height display rounding (issue #893).
 *
 * Run with: npx tsx src/utils/scallopHeightFormat.test.ts
 */

import { spacingToScallopHeight } from '../engine/toolpaths/scallopHeight'
import { formatScallopHeight, formatStoredScallopHeight, roundScallopHeight } from './scallopHeightFormat'

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`FAIL: ${message} (expected ${String(expected)}, got ${String(actual)})`)
}

// The unit's usual places when they already give two significant digits.
assertEqual(formatScallopHeight(0.0126, 'inch'), '0.0126', 'inch keeps 4 dp for larger heights')
assertEqual(formatScallopHeight(0.0032864036, 'inch'), '0.0033', 'inch rounds to 4 dp')
assertEqual(formatScallopHeight(0.020449, 'mm'), '0.02', 'mm rounds to 3 dp and trims zeros')
assertEqual(formatScallopHeight(0.001, 'inch'), '0.001', 'exact value is unchanged')

// More places once 4/3 dp would leave fewer than two significant digits.
assertEqual(formatScallopHeight(0.0008051866, 'inch'), '0.00081', 'inch below 0.001 keeps two digits')
assertEqual(formatScallopHeight(0.000157, 'inch'), '0.00016', '1/16 in ball at 0.1 stepover')
assertEqual(formatScallopHeight(0.0000391, 'inch'), '0.000039', 'two extra places when needed')
assertEqual(formatScallopHeight(0.00005, 'inch'), '0.00005', 'fine inch target is not rounded up')
assertEqual(formatScallopHeight(0.00251, 'mm'), '0.0025', '1 mm ball at 0.1 stepover')
assertEqual(formatScallopHeight(0.0004, 'mm'), '0.0004', 'fine mm target is not rounded to zero')

assertEqual(roundScallopHeight(0.0008051866, 'inch'), 0.00081, 'stored inch value is rounded')
assertEqual(roundScallopHeight(0.020449, 'mm'), 0.02, 'stored mm value is rounded')
assertEqual(roundScallopHeight(0, 'inch'), 0, 'zero stays zero')
assertEqual(formatScallopHeight(roundScallopHeight(0.000157, 'inch'), 'inch'), formatScallopHeight(0.000157, 'inch'), 'stored and shown agree')

// Every default a ball endmill can produce keeps its cusp within 5 %, down
// to a 1/64 in or 0.2 mm tool at 5 % stepover.
for (const [units, diameters] of [['inch', [0.015625, 0.03125, 0.0625, 0.125, 0.25, 0.5]], ['mm', [0.2, 0.5, 1, 1.5, 3, 6, 12]]] as const) {
  for (const diameter of diameters) {
    for (let stepover = 0.05; stepover <= 0.5; stepover += 0.01) {
      const height = spacingToScallopHeight(diameter / 2, stepover * diameter)
      if (height === null) continue
      const error = Math.abs(roundScallopHeight(height, units) / height - 1)
      if (error > 0.05) throw new Error(`FAIL: ${units} ${diameter} at ${stepover.toFixed(2)} rounds ${height} with ${(error * 100).toFixed(1)} % error`)
    }
  }
}

// Editable fields show the stored value itself, only float noise trimmed.
assertEqual(formatStoredScallopHeight(0.00016), '0.00016', 'stored value is shown as is')
assertEqual(formatStoredScallopHeight(0.0006265703616725044), '0.00062657036', 'unrounded stored value keeps its digits')
assertEqual(formatStoredScallopHeight(0.1 + 0.2), '0.3', 'float noise is trimmed')

console.log('scallopHeightFormat tests passed')
