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
 * The rotary group's own icons (issue #1165, after #1112 rt3-d item 32).
 *
 * Polygon (Hex) is drawn as the bar seen end-on: a dashed circle for the round
 * stock and a regular, flat-up hexagon inside it for the flats, with a dot on
 * the axis. Thread and Flutes no longer borrow the surface-finish and end-mill
 * icons; each has its own side view of the bar.
 *
 * Mutations checked one at a time against these assertions:
 * - putting `icon: 'ngon'` back in `RotarySolidActions.tsx` → the command
 *   assertions fail;
 * - deleting the dashed circle (dropping the stock) → the stock assertions fail;
 * - moving one hexagon vertex → the equal-side and apothem-ratio assertions fail;
 * - growing the hexagon onto the circle → the "inside the stock" assertion fails;
 * - putting `icon: 'surface'` or `icon: 'tool-endmill'` back in
 *   `RotaryPatternActions.tsx` → the Thread/Flutes command assertions fail;
 * - removing a source SVG without re-running the sprite build → the sprite
 *   assertions fail.
 *
 * Run with: NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/layout/toolbar/hexIcon.test.ts
 */

import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const icon = (name: string): string =>
  readFileSync(new URL(`../../../assets/icons/${name}.svg`, import.meta.url), 'utf8')
const hexSource = icon('hex')
const ngonSource = icon('ngon')
const sprite = readFileSync(new URL('../../../../public/icons.svg', import.meta.url), 'utf8')
const solidActions = readFileSync(new URL('./RotarySolidActions.tsx', import.meta.url), 'utf8')
const patternActions = readFileSync(new URL('./RotaryPatternActions.tsx', import.meta.url), 'utf8')

// ── Hex artwork ─────────────────────────────────────────────────────

assert(/viewBox="0 0 24 24"/.test(hexSource), 'the icon uses the 24×24 grid every other icon uses')
assert(/stroke-width="1\.5"/.test(hexSource), 'the source keeps the 1.5 baseline stroke')

const stock = /<circle[^>]*cx="([\d.]+)"[^>]*cy="([\d.]+)"[^>]*r="([\d.]+)"[^>]*stroke-dasharray="[\d.\s]+"/.exec(hexSource)
assert(stock, 'the round stock is a dashed circle')
const [cx, cy, r] = [Number(stock[1]), Number(stock[2]), Number(stock[3])]
assert(cx === 12 && cy === 12, 'the stock is centred on the grid')

const paths = [...hexSource.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1])
const section = paths.find((d) => /Z\s*$/.test(d))
assert(section, 'one path is the closed hexagonal section')
const points = [...section.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)]
  .map((match): [number, number] => [Number(match[1]), Number(match[2])])
assert(points.length === 6, `the section is a hexagon, got ${points.length} vertices`)

const distance = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1])
const sides = points.map((point, index) => distance(point, points[(index + 1) % points.length]))
assert(
  Math.max(...sides) - Math.min(...sides) < 0.02,
  `the section is a regular hexagon: equal sides, got ${sides.map((side) => side.toFixed(3)).join(' / ')}`,
)
const xs = points.map((point) => point[0])
const ys = points.map((point) => point[1])
const circumradius = (Math.max(...xs) - Math.min(...xs)) / 2
const apothem = (Math.max(...ys) - Math.min(...ys)) / 2
assert(
  Math.abs(apothem / circumradius - Math.sqrt(3) / 2) < 0.005,
  `the hexagon is flat up: apothem/circumradius is √3/2, got ${(apothem / circumradius).toFixed(4)}`,
)
assert(
  Math.abs((Math.max(...xs) + Math.min(...xs)) / 2 - cx) < 1e-9 && Math.abs((Math.max(...ys) + Math.min(...ys)) / 2 - cy) < 1e-9,
  'the hexagon is centred on the bar axis',
)
assert(
  points.every((point) => distance(point, [cx, cy]) < r - 1),
  'the flats sit inside the stock with a visible gap, so the corners do not merge with the dashes',
)
assert(paths.some((d) => /^M 12 12 H 12\.\d+$/.test(d)), 'a dot marks the bar axis')

// ── Distinct from the outline icon it used to borrow (item 32) ─────

const artwork = (source: string): string[] => [...source.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1])
assert(
  artwork(ngonSource).every((d) => !hexSource.includes(d)),
  'no part of the regular-polygon outline is reused: the Hex model reads as its own shape',
)
assert(!/<circle/.test(ngonSource), 'the outline icon has no stock circle — the cue that sets the Hex model apart')

// ── Thread and Flutes ───────────────────────────────────────────────

for (const name of ['thread', 'flutes']) {
  const source = icon(name)
  assert(/viewBox="0 0 24 24"/.test(source), `${name}: uses the 24×24 grid`)
  assert(artwork(source).length >= 2, `${name}: draws the bar and its cuts`)
}
assert(/icon: 'thread'/.test(patternActions), 'the Thread command uses its own icon')
assert(/icon: 'flutes'/.test(patternActions), 'the Flutes command uses its own icon')
assert(!/icon: '(surface|tool-endmill)'/.test(patternActions), 'Thread and Flutes no longer borrow the surface or end-mill icon')

// ── Sprite and command wiring ───────────────────────────────────────

for (const name of ['hex', 'thread', 'flutes']) {
  assert(new RegExp(`<symbol id="${name}"`).test(sprite), `the generated sprite carries ${name} (run \`npm run sync-icons\` after editing the source)`)
}
assert(/icon: 'hex'/.test(solidActions), 'the Polygon (Hex) command uses the Hex icon')
assert(!/icon: 'ngon'/.test(solidActions), 'no rotary command borrows the regular-polygon outline icon any more')

console.log('hexIcon.test.ts passed')
