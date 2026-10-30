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
 * The Polygon (Hex) model has its own icon (issue #1112 rt3-d item 32).
 *
 * It used to borrow `ngon` — the regular-polygon *outline* shape — so a hex bar
 * cut on the lathe read as a flat hexagon drawn on a face. The new source is
 * the Turn icon's convention (item 15) applied to a hex bar: the dash-dot
 * centreline, a regular hexagonal section with its flat edges visible, and the
 * solid running along the axis. Both surfaces it hangs on — the drawer and the
 * tablet rail — read this one command table.
 *
 * Mutations checked one at a time against these assertions:
 * - putting `icon: 'ngon'` back in `RotarySolidActions.tsx` → the command
 *   assertions fail, and so does the "no command borrows the outline" one;
 * - deleting `stroke-dasharray` from `hex.svg` (dropping the centreline) → the
 *   artwork assertions fail;
 * - dropping the bar subpath so only the hexagon is left → the "runs along the
 *   axis / is not the outline shape" assertions fail, which is the item's own
 *   rule;
 * - making the section a non-regular hexagon (an arbitrary six-gon, e.g. by
 *   moving one vertex) → the equal-side and apothem-ratio assertions fail;
 * - removing `hex.svg` without re-running the sprite build → the sprite
 *   assertion fails, the one an edit-and-forget would hit.
 *
 * Run with: NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/layout/toolbar/hexIcon.test.ts
 */

import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const hexSource = readFileSync(new URL('../../../assets/icons/hex.svg', import.meta.url), 'utf8')
const ngonSource = readFileSync(new URL('../../../assets/icons/ngon.svg', import.meta.url), 'utf8')
const turnSource = readFileSync(new URL('../../../assets/icons/turn.svg', import.meta.url), 'utf8')
const roundRectSource = readFileSync(new URL('../../../assets/icons/roundrect.svg', import.meta.url), 'utf8')
const chamferRectSource = readFileSync(new URL('../../../assets/icons/chamferrect.svg', import.meta.url), 'utf8')
const sprite = readFileSync(new URL('../../../../public/icons.svg', import.meta.url), 'utf8')
const actions = readFileSync(new URL('./RotarySolidActions.tsx', import.meta.url), 'utf8')

// ── Artwork ─────────────────────────────────────────────────────────

assert(/viewBox="0 0 24 24"/.test(hexSource), 'the icon uses the 24×24 grid every other icon uses')
assert(/stroke-width="1\.5"/.test(hexSource), 'the source keeps the 1.5 baseline stroke')
assert(
  /stroke-dasharray="[\d.\s]+"/.test(hexSource),
  'the centreline is drawn with an element-level dash-dot pattern, like the Turn icon (the consumer sets only stroke)',
)

const hexPaths = [...hexSource.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1])
assert(hexPaths.length === 2, `the icon is the centreline plus one artwork path, got ${hexPaths.length}`)
const centreline = hexPaths.find((d) => / 12 H 22\.5$/.test(d))
assert(centreline !== undefined, 'one path is the horizontal centreline at y = 12')
const artwork = hexPaths.find((d) => d !== centreline)!
assert(!centreline.includes('Z'), 'the centreline is not part of an outline')

/** A path split into its subpaths: `{ points, closed }` per M..Z run. */
function subpaths(d: string): Array<{ points: Array<[number, number]>; closed: boolean }> {
  const runs = d.match(/M[^M]*/g) ?? []
  return runs.map((run) => ({
    points: [...run.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)]
      .map((match): [number, number] => [Number(match[1]), Number(match[2])]),
    closed: /Z/i.test(run),
  }))
}

const parts = subpaths(artwork)
assert(parts.length === 2, `the artwork is the section plus the bar running along the axis, got ${parts.length} subpaths`)
const section = parts.find((part) => part.closed)!
const bar = parts.find((part) => !part.closed)!
assert(section.points.length === 6, `the section is a hexagon, got ${section.points.length} vertices`)

const distance = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1])
const sides = section.points.map((point, index) => (
  distance(point, section.points[(index + 1) % section.points.length])
))
const shortest = Math.min(...sides)
const longest = Math.max(...sides)
assert(
  longest - shortest < 0.02,
  `the section is a regular hexagon: equal sides, got ${sides.map((side) => side.toFixed(3)).join(' / ')}`,
)

// Flat up: the widest reach is across corners (horizontal), the narrowest across
// flats (vertical) — a hexagon standing on a flat, not on a point.
const xs = section.points.map((point) => point[0])
const ys = section.points.map((point) => point[1])
const circumradius = (Math.max(...xs) - Math.min(...xs)) / 2
const apothem = (Math.max(...ys) - Math.min(...ys)) / 2
assert(
  Math.abs(apothem / circumradius - Math.sqrt(3) / 2) < 0.005,
  `the hexagon is flat up: apothem/circumradius is √3/2, got ${(apothem / circumradius).toFixed(4)}`,
)
// Mirrored about the centreline at y = 12, like the Turn icon's profile.
assert(
  Math.abs((12 - Math.min(...ys)) - (Math.max(...ys) - 12)) < 1e-9,
  `the section is mirrored above and below the centreline (top ${Math.min(...ys)}, bottom ${Math.max(...ys)})`,
)
assert(
  Math.min(...ys) < 12 && Math.max(...ys) > 12,
  'the section sits astride the centreline, so it reads as a solid around the axis',
)

// The bar runs from the section's flat edges out along the axis: "flat edges
// visible". Its two long edges are at the flats' own levels, not at the corners.
const barFaces = [...new Set(bar.points.map((point) => point[1]))].sort((a, b) => a - b)
assert(
  barFaces.length === 2
    && Math.abs(barFaces[0] - Math.min(...ys)) < 1e-9
    && Math.abs(barFaces[1] - Math.max(...ys)) < 1e-9,
  `the bar's long edges are the hexagon's flats (bar ${barFaces.join('/')}, flats ${Math.min(...ys)}/${Math.max(...ys)})`,
)
assert(
  Math.max(...bar.points.map((point) => point[0])) > 20,
  'the bar runs most of the grid width, so it reads as stock rather than a plate',
)

// ── Distinct from the icons it used to share or sit beside (item 32) ─
//
// The dash-dot centreline is deliberately the Turn icon's own (item 15): one
// convention for "stock on the axis". Everything else has to be this icon's.

const artPaths = (source: string): string[] =>
  [...source.matchAll(/<path[^>]*\sd="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((d) => d !== centreline)

assert(
  turnSource.includes(centreline),
  'the centreline is the Turn icon-wide convention, not a second dash pattern',
)
for (const [name, source] of [
  ['regular-polygon outline', ngonSource],
  ['Turn', turnSource],
  ['rounded rectangle', roundRectSource],
  ['chamfered rectangle', chamferRectSource],
] as const) {
  assert(!source.includes(artwork), `the ${name} icon does not carry this artwork`)
  const otherPaths = artPaths(source)
  assert(otherPaths.length > 0, `the ${name} icon has artwork to compare against`)
  assert(
    otherPaths.every((d) => !artwork.includes(d)),
    `no part of the ${name} icon is reused: the Hex model reads as its own shape`,
  )
}
assert(
  artPaths(ngonSource).every((d) => subpaths(d).length === 1),
  'the outline icon is a single hexagon — the shape this icon must not be',
)

// ── Sprite and command wiring ───────────────────────────────────────

assert(/<symbol id="hex"/.test(sprite), 'the generated sprite carries the icon (run `npm run sync-icons` after editing the source)')
assert(/icon: 'hex'/.test(actions), 'the Polygon (Hex) command uses the Hex icon')
assert(!/icon: 'ngon'/.test(actions), 'no rotary command borrows the regular-polygon outline icon any more')

console.log('hexIcon.test.ts passed')
