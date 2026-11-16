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
 * Model recognition, slice 1 of issue #1206: the detector on meshes built in
 * code, so every expected outline and depth is known exactly.
 *
 * Each block is a 60 x 40 x 20 plate (Z 0..20) with cavities cut into it by
 * Manifold, which gives the triangulation a real tessellated solid has.
 *
 * Mutation checks (each made the named block fail, then was reverted):
 * - `recognize.ts`, reach loop removed                      -> T-slot
 * - `recognize.ts`, the island overhang check removed       -> overhang
 * - `recognize.ts`, top always the mesh top                 -> counterbore
 * - `recognize.ts`, a banded container no longer stops the top -> counterbore
 * - `recognize.ts`, `bottom` always `flat` below slab 0     -> drill point
 * - `recognize.ts`, `clearBelow` never true                 -> plate on a foot
 * - `recognize.ts`, `clearBelow` always true                -> T-slot
 * - `recognize.ts`, island top fixed at the first level     -> chamfered boss
 * - `recognize.ts`, `partOfCavity` always false             -> drill point
 * - `sections.ts`, `loopsMatch` always true for two holes   -> pocket + hole (throws)
 * - `fit.ts`, `MIN_CIRCLE_CORNERS` 6                        -> octagon
 * - `fit.ts`, `asCircle` always null                        -> pocket + hole
 * - `levels.ts`, vertical-wall levels dropped               -> drill point
 * - `recognize.ts`, both tolerances an absolute 0.02        -> inches
 * - `recognize.ts`, the stand-on check always true          -> overhanging cap
 * - `recognize.ts`, a solid loop may be an island            -> boss in a pocket
 * - `recognize.ts`, the open-mesh check for a solid removed  -> open mesh
 *
 * Run with: npx tsx src/engine/modelRecognition/recognize.test.ts
 */

import type { Manifold } from 'manifold-3d'
import { getManifoldModule } from '../csg'
import { recognizeCavities } from './recognize'
import type { ModelRecognitionResult, RecognitionMesh, RecognizedCavity } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertNear(actual: number, expected: number, message: string, tolerance = 1e-3): void {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`)
}

const module = await getManifoldModule()
const { Manifold: M } = module

function plate(): Manifold {
  return M.cube([60, 40, 20])
}

function box(x: number, y: number, z: number, w: number, d: number, h: number): Manifold {
  return M.cube([w, d, h]).translate([x, y, z])
}

function cylinder(x: number, y: number, z: number, radius: number, height: number, segments = 32): Manifold {
  return M.cylinder(height, radius, radius, segments).translate([x, y, z])
}

/** A cone frustum, `radiusBottom` at `z` and `radiusTop` at `z + height`. Either may be 0. */
function frustum(
  x: number, y: number, z: number,
  radiusBottom: number, radiusTop: number, height: number, segments = 32,
): Manifold {
  if (radiusBottom > 0) return M.cylinder(height, radiusBottom, radiusTop, segments).translate([x, y, z])
  return M.cylinder(height, radiusTop, 0, segments).rotate([180, 0, 0]).translate([x, y, z + height])
}

/** A square frustum: `sideBottom` across at `z`, `sideTop` across at `z + height`. */
function squareFrustum(
  x: number, y: number, z: number,
  sideBottom: number, sideTop: number, height: number,
): Manifold {
  return M.cylinder(height, sideBottom / Math.SQRT2, sideTop / Math.SQRT2, 4)
    .rotate([0, 0, 45])
    .translate([x, y, z])
}

function toMesh(solid: Manifold): RecognitionMesh {
  const mesh = solid.getMesh()
  assert(mesh.numProp === 3 && mesh.triVerts.length > 0, 'fixture solid must not be empty')
  return { positions: new Float32Array(mesh.vertProperties), index: new Uint32Array(mesh.triVerts) }
}

function recognize(solid: Manifold): ModelRecognitionResult {
  return recognizeCavities(toMesh(solid))
}

function outlineBounds(cavity: { outline: { x: number; y: number }[] }): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = cavity.outline.map((point) => point.x)
  const ys = cavity.outline.map((point) => point.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

function assertCircle(cavity: RecognizedCavity, x: number, y: number, radius: number, label: string): void {
  assert(cavity.shape === 'hole' && cavity.circle !== null, `${label}: is a round hole`)
  assertNear(cavity.circle!.center.x, x, `${label}: centre X`)
  assertNear(cavity.circle!.center.y, y, `${label}: centre Y`)
  assertNear(cavity.circle!.radius, radius, `${label}: radius is the designed one, not the facets' inner radius`)
  assert(cavity.profile.segments.length === 1 && cavity.profile.segments[0].type === 'circle', `${label}: profile is one circle`)
}

function assertSpan(cavity: { zBottom: number; zTop: number }, zBottom: number, zTop: number, label: string): void {
  assertNear(cavity.zBottom, zBottom, `${label}: bottom`)
  assertNear(cavity.zTop, zTop, `${label}: top`)
}

// ---------------------------------------------------------------------------
// A plain plate has nothing to find
// ---------------------------------------------------------------------------
{
  const result = recognize(plate())
  assert(result.cavities.length === 0 && result.skipped.length === 0, 'plain plate: nothing found')
  assert(!result.meshOpen && !result.levelsTruncated, 'plain plate: closed, not truncated')
}

// ---------------------------------------------------------------------------
// Blind pocket and through hole
// ---------------------------------------------------------------------------
{
  const result = recognize(plate().subtract(box(5, 5, 12, 20, 10, 8)).subtract(cylinder(40, 10, -5, 3, 30)))
  assert(result.cavities.length === 2 && result.skipped.length === 0, 'pocket + hole: exactly two cavities')

  const pocket = result.cavities.find((cavity) => cavity.shape === 'pocket')!
  assert(pocket.bottom === 'flat', 'pocket: flat floor')
  assertSpan(pocket, 12, 20, 'pocket')
  const bounds = outlineBounds(pocket)
  assertNear(bounds.minX, 5, 'pocket: min X')
  assertNear(bounds.maxX, 25, 'pocket: max X')
  assertNear(bounds.minY, 5, 'pocket: min Y')
  assertNear(bounds.maxY, 15, 'pocket: max Y')
  assert(pocket.outline.length === 4, 'pocket: four corners, no points left along the edges')
  assert(pocket.profile.segments.every((segment) => segment.type === 'line'), 'pocket: straight sides')
  assert(!pocket.flaredAbove && pocket.islands.length === 0, 'pocket: plain')

  const hole = result.cavities.find((cavity) => cavity.shape === 'hole')!
  assert(hole.bottom === 'through', 'hole: through')
  assertSpan(hole, 0, 20, 'hole')
  assertCircle(hole, 40, 10, 3, 'hole')
}

// ---------------------------------------------------------------------------
// A plate standing on a foot: its holes are still through holes
// ---------------------------------------------------------------------------
{
  // The plate's underside is at Z 0 but the foot goes down to -4, so the hole
  // does not reach the mesh's lowest point. Nothing is under it, though.
  const result = recognize(plate().add(box(48, 4, -4, 10, 10, 4)).subtract(cylinder(20, 20, -10, 3, 40)))
  assert(result.cavities.length === 1 && result.skipped.length === 0, 'plate on a foot: one cavity')
  const [hole] = result.cavities
  assertCircle(hole, 20, 20, 3, 'plate on a foot')
  assertSpan(hole, 0, 20, 'plate on a foot')
  assert(hole.bottom === 'through', `plate on a foot: the hole is through, got ${hole.bottom}`)
}

// ---------------------------------------------------------------------------
// Counterbore: two cavities stacked at the step, not two overlapping ones
// ---------------------------------------------------------------------------
{
  const result = recognize(plate().subtract(cylinder(30, 20, 14, 5.5, 10, 48)).subtract(cylinder(30, 20, -5, 3.3, 30, 48)))
  assert(result.cavities.length === 2 && result.skipped.length === 0, 'counterbore: two cavities')
  const [upper, lower] = result.cavities
  assertCircle(upper, 30, 20, 5.5, 'counterbore')
  assertSpan(upper, 14, 20, 'counterbore')
  assert(upper.bottom === 'flat', 'counterbore: stands on the step')
  assertCircle(lower, 30, 20, 3.3, 'counterbore bolt hole')
  assertSpan(lower, 0, 14, 'counterbore bolt hole')
  assert(lower.bottom === 'through' && !lower.flaredAbove, 'counterbore bolt hole: through, stops at the step')
}

// ---------------------------------------------------------------------------
// Stepped pocket: a deeper pocket in the floor of a wider one
// ---------------------------------------------------------------------------
{
  const result = recognize(plate().subtract(box(10, 8, 15, 40, 24, 5)).subtract(box(20, 14, 9, 12, 8, 7)))
  assert(result.cavities.length === 2 && result.skipped.length === 0, 'stepped pocket: two cavities')
  const [wide, deep] = result.cavities
  assertSpan(wide, 15, 20, 'stepped pocket, wide part')
  assertSpan(deep, 9, 15, 'stepped pocket, deep part')
  assert(wide.bottom === 'flat' && deep.bottom === 'flat', 'stepped pocket: both floors flat')
  assertNear(outlineBounds(deep).minX, 20, 'stepped pocket, deep part: min X')
  assertNear(outlineBounds(deep).maxX, 32, 'stepped pocket, deep part: max X')
}

// ---------------------------------------------------------------------------
// Boss in a pocket: an island with its own height; a chamfered boss keeps its top
// ---------------------------------------------------------------------------
{
  const pocketSolid = box(10, 8, 10, 40, 24, 10)
  const boss = cylinder(30, 20, 10, 4, 6)
  const result = recognize(plate().subtract(pocketSolid.subtract(boss)))
  assert(result.cavities.length === 1 && result.skipped.length === 0, 'boss: one cavity')
  const [pocket] = result.cavities
  assertSpan(pocket, 10, 20, 'boss pocket')
  assert(pocket.outline.length === 4 && pocket.bottom === 'flat', 'boss pocket: rectangle on a flat floor')
  assert(pocket.islands.length === 1, 'boss pocket: one island')
  const [island] = pocket.islands
  assert(island.circle !== null, 'boss: round')
  assertNear(island.circle!.radius, 4, 'boss: radius')
  assertNear(island.circle!.center.x, 30, 'boss: centre X')
  assertSpan(island, 10, 16, 'boss')

  const chamferedBoss = cylinder(30, 20, 10, 4, 5).add(frustum(30, 20, 15, 4, 3, 1))
  const chamfered = recognize(plate().subtract(pocketSolid.subtract(chamferedBoss)))
  assert(chamfered.cavities.length === 1, 'chamfered boss: one cavity')
  assertSpan(chamfered.cavities[0].islands[0], 10, 16, 'chamfered boss: island reaches the top of the chamfer')
  assertNear(chamfered.cavities[0].islands[0].circle!.radius, 4, 'chamfered boss: footprint is the base')

  // The boss is material inside the pocket — an island, not a body of its own.
  assert(result.solids.length === 1 && result.solids[0].outline.length === 4, 'boss: the only body is the plate')
  assertSpan(result.solids[0], 0, 20, 'boss: the plate is the whole height')
}

// ---------------------------------------------------------------------------
// Drill-point hole: the straight part is drawn, the cone is its bottom
// ---------------------------------------------------------------------------
{
  const drilled = cylinder(15, 30, 10, 2.5, 15, 24).add(frustum(15, 30, 8.5, 0, 2.5, 1.5, 24))
  const result = recognize(plate().subtract(drilled))
  assert(result.cavities.length === 1, 'drill point: one cavity')
  assert(result.skipped.length === 0, 'drill point: the cone is not listed on its own')
  const [hole] = result.cavities
  assertCircle(hole, 15, 30, 2.5, 'drill point')
  assertSpan(hole, 10, 20, 'drill point')
  assert(hole.bottom === 'taper', 'drill point: bottom narrows, not flat')
}

// ---------------------------------------------------------------------------
// Chamfered rim: one cavity to the surface, with the straight part's outline
// ---------------------------------------------------------------------------
{
  const chamfered = cylinder(30, 30, 9, 2, 10, 24).add(frustum(30, 30, 19, 2, 3, 1.5, 24))
  const result = recognize(plate().subtract(chamfered))
  assert(result.cavities.length === 1, 'chamfered rim: one cavity')
  assert(result.skipped.length === 0, 'chamfered rim: the chamfer is not listed on its own')
  const [hole] = result.cavities
  assertCircle(hole, 30, 30, 2, 'chamfered rim')
  assertSpan(hole, 9, 20, 'chamfered rim')
  assert(hole.bottom === 'flat' && hole.flaredAbove, 'chamfered rim: flat floor, flared above')
}

// ---------------------------------------------------------------------------
// Chamfer between a counterbore and its bolt hole: still stacked at the step
// ---------------------------------------------------------------------------
{
  const solid = plate()
    .subtract(cylinder(30, 20, 14, 6, 10, 48))
    .subtract(cylinder(30, 20, -5, 3, 30, 48))
    .subtract(frustum(30, 20, 13, 3, 4, 1, 48))
  const result = recognize(solid)
  assert(result.cavities.length === 2 && result.skipped.length === 0, 'chamfered counterbore: two cavities')
  const [upper, lower] = result.cavities
  assertSpan(upper, 14, 20, 'chamfered counterbore')
  assert(upper.bottom === 'flat', 'chamfered counterbore: the step is a flat floor despite the chamfer in it')
  assertSpan(lower, 0, 14, 'chamfered counterbore bolt hole')
  assertNear(lower.circle!.radius, 3, 'chamfered counterbore bolt hole: radius')
  assert(lower.flaredAbove, 'chamfered counterbore bolt hole: flared above')
}

// ---------------------------------------------------------------------------
// Drafted pocket: walls never vertical, reported and not drawn
// ---------------------------------------------------------------------------
{
  const result = recognize(plate().subtract(frustum(30, 20, 12, 5, 6, 8, 48)))
  assert(result.cavities.length === 0, 'drafted pocket: nothing drawn')
  assert(result.skipped.length === 1 && result.skipped[0].reason === 'taperedWalls', 'drafted pocket: reported as tapered')
  assertSpan(result.skipped[0], 12, 20, 'drafted pocket')
  const bounds = outlineBounds(result.skipped[0])
  assertNear(bounds.maxX - bounds.minX, 12, 'drafted pocket: reported at its widest', 0.05)
}

// ---------------------------------------------------------------------------
// T-slot: the neck is drawn, the wide part under it is an undercut
// ---------------------------------------------------------------------------
{
  const result = recognize(plate().subtract(box(10, 18, 14, 40, 4, 10)).subtract(box(10, 14, 8, 40, 12, 6)))
  assert(result.cavities.length === 1, 'T-slot: only the neck is drawn')
  const [neck] = result.cavities
  assertSpan(neck, 14, 20, 'T-slot neck')
  assert(neck.bottom === 'open', 'T-slot neck: opens into the wider slot')
  assertNear(outlineBounds(neck).maxY - outlineBounds(neck).minY, 4, 'T-slot neck: width')
  assert(result.skipped.length === 1 && result.skipped[0].reason === 'undercut', 'T-slot: wide part reported as an undercut')
  assertSpan(result.skipped[0], 8, 14, 'T-slot wide part')
}

// ---------------------------------------------------------------------------
// Shelf across half a pocket: nothing is drawn underneath it
// ---------------------------------------------------------------------------
{
  // The pocket is the full rectangle from 10 to 14 and from 16 up, with a
  // shelf closing its left half (X 10..30) between 14 and 16.
  const result = recognize(plate().subtract(box(10, 8, 10, 40, 24, 10)).add(box(10, 8, 14, 20, 24, 2)))
  for (const cavity of result.cavities) {
    const underShelf = cavity.zBottom < 15.9 && outlineBounds(cavity).minX < 29.9
    assert(!underShelf, 'shelf: no drawn cavity reaches under it')
  }
  const above = result.cavities.find((cavity) => Math.abs(cavity.zBottom - 16) < 1e-3)!
  assert(above !== undefined && above.bottom === 'flat', 'shelf: the pocket above it is drawn down to the shelf')
  assertNear(outlineBounds(above).minX, 10, 'shelf: the pocket above it is the full rectangle')
  const under = result.skipped.find((entry) => entry.reason === 'undercut')!
  assert(under !== undefined, 'shelf: the part under it is reported as an undercut')
  assertSpan(under, 10, 14, 'shelf: undercut span')
}

// ---------------------------------------------------------------------------
// Mushroom boss: a cap wider than its stem overhangs the pocket floor
// ---------------------------------------------------------------------------
{
  // The pocket's own loop never changes, so only the material inside it tells.
  const mushroom = cylinder(30, 20, 10, 2, 4).add(cylinder(30, 20, 14, 5, 3))
  const result = recognize(plate().subtract(box(10, 8, 10, 40, 24, 10).subtract(mushroom)))
  assert(result.cavities.length === 0, 'overhang: the pocket is not drawn with a stem-sized island')
  assert(result.skipped.length === 1 && result.skipped[0].reason === 'undercut', 'overhang: reported as an undercut')
}

// ---------------------------------------------------------------------------
// Faceted circles: 12 sides is a circle, 8 sides is an octagon
// ---------------------------------------------------------------------------
{
  const result = recognize(plate().subtract(cylinder(20, 20, -5, 4, 30, 12)).subtract(cylinder(40, 20, -5, 4, 30, 8)))
  assert(result.cavities.length === 2, 'faceted circles: two cavities')
  const round = result.cavities.find((cavity) => cavity.shape === 'hole')!
  const octagon = result.cavities.find((cavity) => cavity.shape === 'pocket')!
  assert(round !== undefined && octagon !== undefined, 'faceted circles: one hole and one pocket')
  assertCircle(round, 20, 20, 4, 'coarse circle')
  assert(octagon.outline.length === 8 && octagon.circle === null, 'octagon: eight corners, not a circle')
  assert(octagon.profile.segments.every((segment) => segment.type === 'line'), 'octagon: straight sides')
}

// ---------------------------------------------------------------------------
// Slot: straight sides with arcs for the round ends
// ---------------------------------------------------------------------------
{
  const slot = cylinder(20, 20, 12, 4, 10, 48).add(cylinder(40, 20, 12, 4, 10, 48)).add(box(20, 16, 12, 20, 8, 10))
  const result = recognize(plate().subtract(slot))
  assert(result.cavities.length === 1, 'slot: one cavity')
  const [cavity] = result.cavities
  assert(cavity.shape === 'pocket' && cavity.circle === null, 'slot: a pocket, not a hole')
  const arcs = cavity.profile.segments.filter((segment) => segment.type === 'arc')
  const lines = cavity.profile.segments.filter((segment) => segment.type === 'line')
  assert(lines.length === 2, `slot: two straight sides, got ${lines.length}`)
  assert(arcs.length >= 2 && arcs.length <= 6, `slot: a few arcs for the ends, got ${arcs.length}`)
  for (const arc of arcs) {
    if (arc.type !== 'arc') continue
    const nearLeft = Math.hypot(arc.center.x - 20, arc.center.y - 20) < 1e-3
    const nearRight = Math.hypot(arc.center.x - 40, arc.center.y - 20) < 1e-3
    assert(nearLeft || nearRight, 'slot: every arc is centred on an end')
    assertNear(Math.hypot(arc.to.x - arc.center.x, arc.to.y - arc.center.y), 4, 'slot: arc radius')
  }
}

// ---------------------------------------------------------------------------
// Solids: the bodies the pockets and holes are cut out of
// ---------------------------------------------------------------------------
{
  // A plain plate is one body, as tall as the plate, with its own outline.
  const result = recognize(plate())
  assert(result.solids.length === 1 && result.skippedSolids.length === 0, 'plain plate solid: one body, nothing skipped')
  const [solid] = result.solids
  assertSpan(solid, 0, 20, 'plain plate solid')
  const bounds = outlineBounds(solid)
  assertNear(bounds.minX, 0, 'plain plate solid: min X')
  assertNear(bounds.maxX, 60, 'plain plate solid: max X')
  assertNear(bounds.minY, 0, 'plain plate solid: min Y')
  assertNear(bounds.maxY, 40, 'plain plate solid: max Y')
  assert(solid.outline.length === 4, 'plain plate solid: four corners, no points left along the edges')
  assert(solid.circle === null, 'plain plate solid: a rectangle, not a circle')
  assert(solid.profile.segments.every((segment) => segment.type === 'line'), 'plain plate solid: straight sides')
}

{
  // A raised boss stacks on the plate: two bodies, bottom first.
  const result = recognize(plate().add(box(20, 10, 20, 20, 20, 8)))
  assert(result.solids.length === 2 && result.skippedSolids.length === 0, 'raised boss: two bodies, nothing skipped')
  const [base, boss] = result.solids
  assertSpan(base, 0, 20, 'raised boss: the plate')
  assertSpan(boss, 20, 28, 'raised boss: the boss')
  const baseBounds = outlineBounds(base)
  assertNear(baseBounds.maxX - baseBounds.minX, 60, 'raised boss: the plate is the base')
  const bossBounds = outlineBounds(boss)
  assertNear(bossBounds.minX, 20, 'raised boss: boss min X')
  assertNear(bossBounds.maxX, 40, 'raised boss: boss max X')
  assertNear(bossBounds.minY, 10, 'raised boss: boss min Y')
  assertNear(bossBounds.maxY, 30, 'raised boss: boss max Y')
  assert(base.outline.length === 4 && boss.outline.length === 4, 'raised boss: both are rectangles')
}

{
  // Holes are not part of a solid's outline; the cavities already found are
  // what cut it, so the body stays the plate's outer rectangle.
  const result = recognize(plate()
    .subtract(box(5, 5, 12, 20, 10, 8))
    .subtract(cylinder(40, 10, -5, 3, 30))
    .subtract(cylinder(30, 30, 14, 5.5, 10, 48)))
  assert(result.solids.length === 1, 'cut plate solid: still one body')
  const bounds = outlineBounds(result.solids[0])
  assertNear(bounds.minX, 0, 'cut plate solid: min X')
  assertNear(bounds.maxX, 60, 'cut plate solid: max X')
  assertNear(bounds.minY, 0, 'cut plate solid: min Y')
  assertNear(bounds.maxY, 40, 'cut plate solid: max Y')
  assert(result.solids[0].outline.length === 4, 'cut plate solid: the outer rectangle, not the holes')
}

{
  // A chamfered top: the straight body, with the chamfer reported. A body ends
  // where its straight walls end; nothing is carried up through the chamfer.
  const chamfered = M.cube([40, 40, 15]).add(squareFrustum(20, 20, 15, 40, 28.284271247461902, 5))
  const result = recognize(chamfered)
  assert(result.solids.length === 1, 'chamfered top: one body')
  assertSpan(result.solids[0], 0, 15, 'chamfered top')
  assert(result.skippedSolids.length === 1 && result.skippedSolids[0].reason === 'taperedWalls', 'chamfered top: the chamfer is reported')
  assertSpan(result.skippedSolids[0], 15, 20, 'chamfered top: the chamfered band')
}

{
  // A cap wider than its stem overhangs empty space, so it is not a body.
  const cap = box(20, 20, 0, 20, 20, 10).add(box(10, 10, 10, 40, 40, 10))
  const result = recognize(cap)
  assert(result.solids.length === 1, 'overhanging cap: only the stem is a body')
  assertSpan(result.solids[0], 0, 10, 'overhanging cap: the stem')
  const stemBounds = outlineBounds(result.solids[0])
  assertNear(stemBounds.minX, 20, 'overhanging cap: stem min X')
  assertNear(stemBounds.maxX, 40, 'overhanging cap: stem max X')
  assert(result.skippedSolids.length === 1 && result.skippedSolids[0].reason === 'undercut', 'overhanging cap: the cap is reported')
  assertSpan(result.skippedSolids[0], 10, 20, 'overhanging cap: the cap')
  assert(!result.solids.some((solid) => Math.abs(solid.zTop - 20) < 1e-3), 'overhanging cap: the cap is not a body')
}

{
  // A bar standing on end is a round body, fitted to the designed radius.
  const result = recognize(cylinder(20, 20, 0, 10, 20, 32))
  assert(result.solids.length === 1 && result.skippedSolids.length === 0, 'round bar: one body')
  const [bar] = result.solids
  assert(bar.circle !== null, 'round bar: round')
  assertNear(bar.circle!.center.x, 20, 'round bar: centre X')
  assertNear(bar.circle!.center.y, 20, 'round bar: centre Y')
  assertNear(bar.circle!.radius, 10, 'round bar: the designed radius, not the facets\' inner radius')
  assertSpan(bar, 0, 20, 'round bar')
}

{
  // The same stepped part in inches gives the same bodies, scaled.
  const reference = recognize(plate().add(box(20, 10, 20, 20, 20, 8)))
  const inch = 1 / 25.4
  const inches = recognize(plate().add(box(20, 10, 20, 20, 20, 8)).scale([inch, inch, inch]))
  assert(inches.solids.length === reference.solids.length, 'inches: the same bodies')
  assert(inches.skippedSolids.length === 0, 'inches: nothing skipped')
  inches.solids.forEach((solid, i) => {
    assertNear(solid.zBottom, reference.solids[i].zBottom * inch, `inches: body ${i} bottom`, 1e-4)
    assertNear(solid.zTop, reference.solids[i].zTop * inch, `inches: body ${i} top`, 1e-4)
    const actual = outlineBounds(solid)
    const expected = outlineBounds(reference.solids[i])
    assertNear(actual.minX, expected.minX * inch, `inches: body ${i} min X`, 1e-4)
    assertNear(actual.maxY, expected.maxY * inch, `inches: body ${i} max Y`, 1e-4)
  })
}

// ---------------------------------------------------------------------------
// Open mesh: a missing wall triangle is reported, and nothing near it is drawn
// ---------------------------------------------------------------------------
{
  const mesh = toMesh(plate().subtract(box(5, 5, 12, 20, 10, 8)).subtract(cylinder(40, 10, -5, 3, 30)))
  // Drop one triangle of the pocket's wall at x = 5.
  const kept: number[] = []
  let dropped = false
  for (let i = 0; i < mesh.index.length; i += 3) {
    const corners = [mesh.index[i], mesh.index[i + 1], mesh.index[i + 2]].map((vertex) => ({
      x: mesh.positions[vertex * 3], y: mesh.positions[vertex * 3 + 1], z: mesh.positions[vertex * 3 + 2],
    }))
    const onWall = corners.every((corner) => Math.abs(corner.x - 5) < 1e-6 && corner.y > 4 && corner.y < 16 && corner.z > 11)
    if (onWall && !dropped) {
      dropped = true
      continue
    }
    kept.push(mesh.index[i], mesh.index[i + 1], mesh.index[i + 2])
  }
  assert(dropped, 'open mesh: fixture lost a wall triangle')
  const result = recognizeCavities({ positions: mesh.positions, index: new Uint32Array(kept) })
  assert(result.meshOpen, 'open mesh: flagged')
  assert(result.cavities.length === 0, 'open mesh: nothing is drawn through the open heights')
  assert(result.skipped.some((entry) => entry.reason === 'openMesh'), 'open mesh: the hole is reported, not dropped')
  // The plate's own walls pass through the open heights too, so the body is
  // reported and not offered as a solid to draw.
  assert(result.solids.length === 0, 'open mesh: the body is not offered as a solid')
  assert(result.skippedSolids.some((entry) => entry.reason === 'openMesh'), 'open mesh: the body is reported')
}

// ---------------------------------------------------------------------------
// The same part in inches, and placed off the origin at an angle
// ---------------------------------------------------------------------------
{
  const part = plate()
    .subtract(box(5, 5, 12, 20, 10, 8))
    .subtract(cylinder(40, 10, -5, 3, 30))
    .subtract(cylinder(30, 30, 14, 5.5, 10, 48))
    .subtract(cylinder(30, 30, -5, 3.3, 30, 48))
  const reference = recognize(part)
  assert(reference.cavities.length === 4, 'reference part: four cavities')

  const inch = 1 / 25.4
  const inches = recognize(part.scale([inch, inch, inch]))
  assert(inches.cavities.length === 4 && inches.skipped.length === 0, 'inches: the same four cavities')
  inches.cavities.forEach((cavity, i) => {
    const expected = reference.cavities[i]
    assert(cavity.shape === expected.shape && cavity.bottom === expected.bottom, `inches: cavity ${i} kind`)
    assertNear(cavity.zBottom, expected.zBottom * inch, `inches: cavity ${i} bottom`, 1e-4)
    assertNear(cavity.zTop, expected.zTop * inch, `inches: cavity ${i} top`, 1e-4)
    if (expected.circle) assertNear(cavity.circle!.radius, expected.circle.radius * inch, `inches: cavity ${i} radius`, 1e-4)
  })

  const angle = 30
  const placed = recognize(part.rotate([0, 0, angle]).translate([120, -45, 7]))
  assert(placed.cavities.length === 4 && placed.skipped.length === 0, 'placed: the same four cavities')
  const radians = (angle * Math.PI) / 180
  const place = (x: number, y: number): { x: number; y: number } => ({
    x: x * Math.cos(radians) - y * Math.sin(radians) + 120,
    y: x * Math.sin(radians) + y * Math.cos(radians) - 45,
  })
  const throughHole = placed.cavities.find((cavity) => cavity.circle && Math.abs(cavity.circle.radius - 3) < 1e-3)!
  assert(throughHole !== undefined, 'placed: the 3 mm hole is found')
  assertNear(throughHole.circle!.center.x, place(40, 10).x, 'placed: hole centre X')
  assertNear(throughHole.circle!.center.y, place(40, 10).y, 'placed: hole centre Y')
  assertSpan(throughHole, 7, 27, 'placed: hole')
  const pocket = placed.cavities.find((cavity) => cavity.shape === 'pocket')!
  assertSpan(pocket, 19, 27, 'placed: pocket')
  const corner = place(5, 5)
  assert(
    pocket.outline.some((point) => Math.hypot(point.x - corner.x, point.y - corner.y) < 1e-3),
    'placed: pocket corner lands where the rotation puts it',
  )
}

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------
{
  const empty = recognizeCavities({ positions: new Float32Array(0), index: new Uint32Array(0) })
  assert(empty.cavities.length === 0 && empty.skipped.length === 0, 'empty mesh: nothing, no throw')
  const flat = recognizeCavities({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    index: new Uint32Array([0, 1, 2]),
  })
  assert(flat.cavities.length === 0, 'flat mesh: nothing, no throw')
}

console.log('modelRecognition/recognize.test.ts: all assertions passed')
