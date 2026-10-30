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
 * Turn has its own icon (issue #1112 R2 item 15).
 *
 * It used to borrow `roundrect`, so a turned part read as a rounded rectangle
 * next to Polygon's hexagon. The new source is a side view of a turned part —
 * a dash-dot centreline with the profile mirrored above and below it, wide on
 * the left, a curved neck, narrower on the right — and the rotary command table
 * has to point at it, in the sprite the app actually loads.
 *
 * Mutations checked one at a time against these assertions:
 * - putting `icon: 'roundrect'` back in `RotarySolidActions.tsx` → the command
 *   assertions fail;
 * - deleting `stroke-dasharray` from `turn.svg` (dropping the centreline) → the
 *   artwork assertions fail;
 * - removing `turn.svg` without re-running the sprite build → the sprite
 *   assertion fails, which is the one an edit-and-forget would hit;
 * - copying the rounded rectangle's path into `turn.svg` → the "not the rounded
 *   rectangle" assertion fails.
 *
 * Run with: npx tsx src/components/layout/toolbar/turnIcon.test.ts
 */

import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const turnSource = readFileSync(new URL('../../../assets/icons/turn.svg', import.meta.url), 'utf8')
const roundRectSource = readFileSync(new URL('../../../assets/icons/roundrect.svg', import.meta.url), 'utf8')
const sprite = readFileSync(new URL('../../../../public/icons.svg', import.meta.url), 'utf8')
const actions = readFileSync(new URL('./RotarySolidActions.tsx', import.meta.url), 'utf8')

// ── Artwork ─────────────────────────────────────────────────────────

assert(/viewBox="0 0 24 24"/.test(turnSource), 'the icon uses the 24×24 grid every other icon uses')
assert(/stroke-width="1\.5"/.test(turnSource), 'the source keeps the 1.5 baseline stroke')
assert(
  /stroke-dasharray="[\d.\s]+"/.test(turnSource),
  'a dash-dot centreline is drawn with an element-level dash pattern (the consumer only sets stroke, not the dash)',
)
const turnPaths = [...turnSource.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1])
assert(turnPaths.length === 2, `the icon is the centreline plus one profile, got ${turnPaths.length} paths`)
assert(turnPaths.some((d) => /Z\s*$/i.test(d.trim())), 'the profile is a closed outline')
assert(
  turnPaths.every((d) => !roundRectSource.includes(d)),
  'the profile is not the rounded rectangle the icon used to borrow',
)
/** Every y a path visits, parsed by command arity (M/L take 2 numbers, C takes 6). */
function pathYValues(d: string): number[] {
  const tokens = d.match(/[MLCZ]|-?\d+(?:\.\d+)?/gi) ?? []
  const arity: Record<string, number> = { M: 2, L: 2, C: 6, Z: 0 }
  const ys: number[] = []
  let index = 0
  while (index < tokens.length) {
    const command = tokens[index].toUpperCase()
    const count = arity[command] ?? 0
    for (let step = 0; step < count; step += 2) {
      const y = Number(tokens[index + 1 + step + 1])
      if (Number.isFinite(y)) ys.push(y)
    }
    index += 1 + count
  }
  return ys
}

// The profile is mirrored about the centreline at y = 12: its widest reach above
// the centreline has to match its widest reach below it.
const profile = turnPaths.find((d) => /Z\s*$/i.test(d.trim()))!
const ys = pathYValues(profile)
const above = Math.min(...ys)
const below = Math.max(...ys)
assert(
  Math.abs((12 - above) - (below - 12)) < 1e-9,
  `the profile is mirrored above and below the centreline (top ${above}, bottom ${below})`,
)
assert(ys.includes(12) === false, 'the centreline is not part of the outlined profile')

// ── Sprite and command wiring ───────────────────────────────────────

assert(/<symbol id="turn"/.test(sprite), 'the generated sprite carries the icon (run `npm run sync-icons` after editing the source)')
assert(/icon: 'turn'/.test(actions), 'the Turn command uses the Turn icon')
assert(!/icon: 'roundrect'/.test(actions), 'no rotary command borrows the rounded rectangle icon any more')

console.log('turnIcon.test.ts passed')
