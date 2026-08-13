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
 * Structural test for the bundled tool library (issue #490).
 *
 * `parseToolLibraryFile` drops an invalid entry rather than throwing — the right
 * runtime behaviour, since one bad tool must not take the whole library down,
 * but it means a typo in `public/tool-library.json` removes a tool with no
 * error anywhere. The count assertion below is what turns that silent drop into
 * a failed build.
 *
 * The V-bit rules matter beyond parsing. A V-bit cannot plunge past its own cone
 * height, `D / (2·tan(θ/2))`, so that height is the deepest countersink it can
 * cut — and Drilling's Countersink mode (#489) refuses any plunge deeper than
 * `maxCutDepth`. An entry whose `maxCutDepth` sits below its cone height would
 * therefore ship a bit that cannot cut its own full-diameter countersink.
 *
 * Run with: npx tsx src/toolLibrary.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseToolLibraryFile } from './toolLibrary'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const libraryPath = fileURLToPath(new URL('../public/tool-library.json', import.meta.url))
const raw = JSON.parse(readFileSync(libraryPath, 'utf8')) as { tools: unknown[] }
const library = parseToolLibraryFile(raw)

assert(Array.isArray(raw.tools) && raw.tools.length > 0, 'tool-library.json should list tools')

// The load-bearing one: a dropped entry means a malformed tool.
assert(
  library.tools.length === raw.tools.length,
  `every bundled entry must survive parsing — ${raw.tools.length} in the file, `
  + `${library.tools.length} parsed (a dropped entry is a malformed one)`,
)

const seenKeys = new Set<string>()
const seenNames = new Set<string>()
for (const tool of library.tools) {
  assert(tool.key.length > 0, 'every entry needs a key')
  assert(!seenKeys.has(tool.key), `duplicate library key: ${tool.key}`)
  seenKeys.add(tool.key)

  // `toolMatchesLibraryEntry` compares on name among other fields, so two
  // entries sharing a name would fight over "already imported".
  assert(!seenNames.has(tool.name), `duplicate library tool name: ${tool.name}`)
  seenNames.add(tool.name)

  assert(tool.diameter > 0, `${tool.key}: diameter must be positive`)
  assert(tool.maxCutDepth >= 0, `${tool.key}: maxCutDepth cannot be negative`)
}

// ── V-bits ───────────────────────────────────────────────────────────

const vBits = library.tools.filter((tool) => tool.type === 'v_bit')
assert(vBits.length > 0, 'the library should ship V-bits')

for (const tool of vBits) {
  const angle = tool.vBitAngle
  assert(
    angle !== null && angle > 0 && angle < 180,
    `${tool.key}: a V-bit needs an included angle in (0, 180), got ${angle}`,
  )

  const coneHeight = tool.diameter / (2 * Math.tan((angle * Math.PI) / 360))
  assert(
    tool.maxCutDepth >= coneHeight,
    `${tool.key}: maxCutDepth ${tool.maxCutDepth} is below the cone height `
    + `${coneHeight.toFixed(4)}, so this bit cannot cut its own full-diameter countersink`,
  )
}

// Countersinking is the reason #490 added these: both fastener standards must be
// reachable, and a metric project must find a V-bit sized in mm rather than
// having to convert an imperial one.
for (const angle of [30, 60, 90, 120]) {
  for (const units of ['mm', 'inch'] as const) {
    assert(
      vBits.some((tool) => tool.vBitAngle === angle && tool.units === units),
      `the library should ship a ${angle}° V-bit in ${units}`,
    )
  }
}

assert(
  vBits.some((tool) => tool.vBitAngle === 82),
  'the library should ship an 82° bit for imperial flat-head countersinks',
)

console.log(`tool library: ${library.tools.length} entries, ${vBits.length} V-bits — all assertions passed`)
