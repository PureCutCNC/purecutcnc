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
 * A band's finish floor cuts the material at that floor, all of it, and nothing
 * else (issue #757).
 *
 * An island whose `z_top` sits below the pocket top splits the pocket there, and
 * the floor pass at the split used to sweep the whole band: air over everything
 * but the island's top face, which is all the rough left at that Z. The first
 * attempt at a fix restricted the floor by insetting from the voids as if they
 * were walls, and left the maintainer's island top unmachined.
 *
 * Both failures are about *where* material gets cut, so every assertion is a
 * swept area measured against geometry built here from the features, never from
 * the engine's own band model:
 *
 * - **missed** — material at the floor outside the envelope the flat cuts at
 *   that Z sweep, opened by the noise radius so Clipper residue does not count;
 * - **air** — swept envelope outside the material grown by the tool radius, the
 *   most a cut centred on the material's own edge can overhang.
 *
 * Move counts prove nothing here: a rectangular ring is four moves and hides in
 * any threshold. And the parity corpus has no multi-band finish, so this suite
 * is the only guard.
 *
 * Run with: npx tsx src/engine/toolpaths/pocketFinishBandFloors.test.ts
 */

import ClipperLib from 'clipper-lib'

import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SketchFeature, SketchProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  LEFTOVER_NOISE_RADIUS,
  clip,
  differencePaths,
  pathsArea,
  polylines,
  toPath,
  type ClipperPath,
} from '../../test/pocketLeftover'
import { generatePocketToolpath } from './pocket'
import { resolvePocketRegions } from './resolver'
import type { PocketToolpathResult, ToolpathMove } from './types'

/** `toPath`'s scale — counts per project unit in the measurement helpers. */
const SCALE = 1e6
/** Arc chords sit this fraction of the radius inside the true arc; well under the noise radius. */
const ARC_FRACTION = 1e-4

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; console.log(`   ✓ ${name}`); return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

type Units = 'mm' | 'inch'

function feature(
  id: string,
  operation: SketchFeature['operation'],
  profile: SketchProfile,
  zBottom: number,
  zTop: number,
  kind: SketchFeature['kind'] = 'rect',
): SketchFeature {
  return {
    id,
    name: id,
    kind,
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function finishOperation(overrides: Partial<Operation>): Operation {
  return {
    id: 'op1',
    name: 'Finish',
    kind: 'pocket',
    pass: 'finish',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['pocket'] },
    toolRef: 't1',
    stepdown: 3,
    stepover: 0.5,
    feed: 100,
    plungeFeed: 50,
    rpm: 10000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 0,
    maxCarveDepth: 0,
    ...overrides,
  }
}

function scene(
  units: Units,
  diameter: number,
  features: SketchFeature[],
  overrides: Partial<Operation>,
): { project: Project; operation: Operation } {
  const operation = finishOperation(overrides)
  const base = projectWithFeatures(
    newProject('finish-band-floors', units),
    features.map((row) => ({ ...row, definitionId: row.id })),
  )
  return {
    project: { ...base, tools: [{ ...defaultTool(units, 1), id: 't1', diameter }], operations: [operation] },
    operation,
  }
}

function generate(
  units: Units,
  diameter: number,
  features: SketchFeature[],
  overrides: Partial<Operation>,
): PocketToolpathResult {
  const { project, operation } = scene(units, diameter, features, overrides)
  return generatePocketToolpath(project, operation)
}

// ── Geometry, at the measurement helpers' scale ─────────────────────────

const filled = (path: ClipperPath): ClipperPath => (ClipperLib.Clipper.Area(path) >= 0 ? path : [...path].reverse())

const rect = (x: number, y: number, w: number, h: number): ClipperPath[] => [filled(toPath([
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
]))]

const disc = (cx: number, cy: number, r: number): ClipperPath[] => [filled(toPath(
  Array.from({ length: 256 }, (_, index) => ({
    x: cx + r * Math.cos((2 * Math.PI * index) / 256),
    y: cy + r * Math.sin((2 * Math.PI * index) / 256),
  })),
))]

const intersect = (a: ClipperPath[], b: ClipperPath[]): ClipperPath[] => clip(a, b, ClipperLib.ClipType.ctIntersection)

function roundOffset(paths: ClipperPath[], distance: number, endType: number): ClipperPath[] {
  if (paths.length === 0) return []
  const offsetter = new ClipperLib.ClipperOffset()
  offsetter.ArcTolerance = Math.max(0.25, Math.abs(distance) * SCALE * ARC_FRACTION)
  offsetter.AddPaths(paths, ClipperLib.JoinType.jtRound, endType)
  const solution: ClipperPath[] = []
  offsetter.Execute(solution, distance * SCALE)
  return differencePaths(solution, [])
}

/** Closed areas grown (or shrunk, negative) by `distance` project units. */
const grow = (paths: ClipperPath[], distance: number): ClipperPath[] => roundOffset(
  paths,
  distance,
  ClipperLib.EndType.etClosedPolygon,
)

/** The flat cuts at `z` — contours, links and leads, not the descent onto them. */
function flatCutsAt(moves: ToolpathMove[], z: number): ToolpathMove[] {
  return moves.filter((move) => (move.kind === 'cut' || move.kind === 'lead_in')
    && Math.abs(move.from.z - z) < 1e-6
    && Math.abs(move.to.z - z) < 1e-6
    && Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) > 1e-9)
}

/** Everything a cutter of `radius` removes following `moves`. */
const sweptBy = (moves: ToolpathMove[], radius: number): ClipperPath[] => roundOffset(
  polylines(moves),
  radius,
  (ClipperLib.EndType as unknown as { etOpenRound: number }).etOpenRound,
)

/** Area left once slivers under the noise radius are opened away. */
const substantialArea = (paths: ClipperPath[]): number => pathsArea(grow(grow(paths, -LEFTOVER_NOISE_RADIUS), LEFTOVER_NOISE_RADIUS))

const warned = (result: PocketToolpathResult, code: string): boolean => result.warnings.some((warning) => warning.code === code)

// ── 1. An island top below the pocket top ──────────────────────────────

const MM_DIAMETER = 3
const MM_RADIUS = MM_DIAMETER / 2
const MM_AREA_TOLERANCE = 1e-3
const MM_EDGE_SLACK = 1e-3

const body = () => feature('body', 'add', rectProfile(10, 10, 80, 60), 0, 20)
/** Floor at 14, top at the stock top 20. */
const pocket = () => feature('pocket', 'subtract', rectProfile(20, 20, 60, 40), 14, 20)

console.log('\nPocket finish floor: the material at a band floor, all of it, and nothing else')

for (const pattern of ['offset', 'seeded_offset', 'parallel'] as const) {
  console.log(`\n  pattern: ${pattern}`)
  // `z_top` 17 is below the pocket top, so the resolver splits the pocket there
  // and the only material at Z 17 is the island's 20 x 20 top face.
  const islandFeature = feature('island', 'add', rectProfile(35, 30, 20, 20), 0, 17)
  const result = generate('mm', MM_DIAMETER, [body(), pocket(), islandFeature], { pocketPattern: pattern })
  const face = rect(35, 30, 20, 20)
  const swept = sweptBy(flatCutsAt(result.moves, 17), MM_RADIUS)

  const missed = substantialArea(differencePaths(face, swept))
  check(
    `${pattern}: the island face is cut whole at its Z`,
    missed <= MM_AREA_TOLERANCE,
    `${missed.toFixed(4)} mm² of the 400 mm² face left standing`,
  )
  // A ring rides the face edge, so its cutter overhangs the edge by a radius. A
  // raster keeps every line within a radius of the face — a line just outside
  // an edge can be the one that finishes it (1b) — and its spans run that same
  // radius past the face, so the raster overhangs by two.
  const overhang = pattern === 'parallel' ? 2 * MM_RADIUS : MM_RADIUS
  const air = substantialArea(differencePaths(swept, grow(face, overhang + MM_EDGE_SLACK)))
  check(
    `${pattern}: nothing is cut beyond the face's edge`,
    air <= MM_AREA_TOLERANCE,
    `${air.toFixed(1)} mm² swept more than ${overhang} mm outside the face — the floor still cuts air`,
  )
  check(
    `${pattern}: no "no finish contours" warning`,
    !warned(result, 'surfaceNoFinishContours'),
    `warnings: ${result.warnings.map((warning) => warning.code).join(', ')}`,
  )

  // The band below has nothing under it, so the restriction never runs there;
  // its floor must still be finished whole.
  const floorBelow = differencePaths(rect(20, 20, 60, 40), rect(35, 30, 20, 20))
  const reachable = grow(grow(floorBelow, -MM_RADIUS), MM_RADIUS)
  const missedBelow = substantialArea(differencePaths(reachable, sweptBy(flatCutsAt(result.moves, 14), MM_RADIUS)))
  check(
    `${pattern}: the pocket floor below is still finished whole`,
    missedBelow <= MM_AREA_TOLERANCE,
    `${missedBelow.toFixed(4)} mm² of reachable floor at Z 14 left standing`,
  )
}

// ── 1b. A raster wider than a radius keeps its scan lines where they were ──
{
  console.log('\n  pattern: parallel, stepover wider than a tool radius')
  // At 0.9 stepover the lines are 2.7 apart, more than the 1.5 radius, so which
  // lines survive matters. The domain's raster runs at y = 22.85 + 2.7k; with
  // the face from 28.75 to 48.75 the lines at 28.25 and 49.85 sit just outside
  // it, and each is the only line close enough to finish that edge. A raster
  // clipped to the face alone drops both and leaves a strip along each edge.
  const islandFeature = feature('island', 'add', rectProfile(35, 28.75, 20, 20), 0, 17)
  const result = generate('mm', MM_DIAMETER, [body(), pocket(), islandFeature], {
    pocketPattern: 'parallel',
    stepover: 0.9,
  })
  const face = rect(35, 28.75, 20, 20)
  const swept = sweptBy(flatCutsAt(result.moves, 17), MM_RADIUS)
  const missed = substantialArea(differencePaths(face, swept))
  check(
    'parallel 0.9: the face edges running along the raster are still cut',
    missed <= MM_AREA_TOLERANCE,
    `${missed.toFixed(4)} mm² of the face left standing — a line just outside an edge was dropped`,
  )
  const air = substantialArea(differencePaths(swept, grow(face, 2 * MM_RADIUS + MM_EDGE_SLACK)))
  check(
    'parallel 0.9: nothing is cut beyond the face\'s edge',
    air <= MM_AREA_TOLERANCE,
    `${air.toFixed(1)} mm² swept more than two radii outside the face`,
  )
}

// ── 2. The reported shape: an island top pierced by deeper pockets ───────
{
  console.log('\n  the reported shape (complex-pocket-test.camj, rebuilt here)')
  // Inch, 1/4 in cutter. The island top at 0.70 is a 1.375 x 0.75 face with a
  // circle and a rectangle cut through it and a corner taken by a deeper
  // rectangle that shares the pocket's void. Strips of the face are narrower
  // than the cutter, which is why insetting from the voids left nothing.
  const diameter = 0.25
  const radius = diameter / 2
  const features = [
    feature('body', 'add', rectProfile(0.25, 0.25, 3.5, 2.5), 0, 0.75),
    feature('pocket', 'subtract', rectProfile(0.5, 0.5, 3, 2), 0.59, 0.75),
    feature('island', 'add', rectProfile(1, 1.25, 1.375, 0.75), 0, 0.7),
    feature('circle', 'subtract', circleProfile(1.75, 1.625, 0.1768), 0.5, 0.75, 'circle'),
    feature('slot', 'subtract', rectProfile(1.125, 1.375, 0.375, 0.5), 0.6, 0.75),
    feature('deep', 'subtract', rectProfile(2, 0.75, 1, 1), 0.25, 0.75),
  ]
  const result = generate('inch', diameter, features, {
    stepdown: 0.25,
    stepover: 0.32,
    feed: 30,
    plungeFeed: 12,
    rpm: 18000,
    roundOutsideCorners: true,
    roundLinkCorners: true,
    xyLeadStrategy: 'arc',
  })
  const areaTolerance = 1e-6
  const face = differencePaths(
    intersect(rect(1, 1.25, 1.375, 0.75), rect(0.5, 0.5, 3, 2)),
    [...disc(1.75, 1.625, 0.1768), ...rect(1.125, 1.375, 0.375, 0.5), ...rect(2, 0.75, 1, 1)],
  )
  const swept = sweptBy(flatCutsAt(result.moves, 0.7), radius)

  const missed = substantialArea(differencePaths(face, swept))
  check(
    'reported: the pierced island face is cut whole',
    missed <= areaTolerance,
    `${missed.toFixed(6)} in² of the ${pathsArea(face).toFixed(4)} in² face left standing`,
  )
  check(
    'reported: no "no finish contours" warning',
    !warned(result, 'surfaceNoFinishContours'),
    `warnings: ${result.warnings.map((warning) => warning.code).join(', ')}`,
  )
  // Links between rings may cross the holes, so this is a bound rather than a
  // containment test — and a full-pocket pass exceeds it several times over.
  const sweptArea = pathsArea(swept)
  const bound = pathsArea(grow(face, diameter))
  check(
    'reported: what the island Z sweeps stays within a tool diameter of the face',
    sweptArea <= bound,
    `${sweptArea.toFixed(3)} in² swept against ${bound.toFixed(3)} in² — the pass still crosses the pocket`,
  )
  // The deep rectangle carries on to 0.25, so at the circle's floor, 0.50, its
  // footprint is open space and no floor belongs over it.
  const overDeep = substantialArea(intersect(sweptBy(flatCutsAt(result.moves, 0.5), radius), rect(2, 0.75, 1, 1)))
  check(
    'reported: no floor is cut over the deep rectangle where it carries on below',
    overDeep <= areaTolerance,
    `${overDeep.toFixed(4)} in² swept over the deep rectangle at Z 0.50`,
  )
}

// ── 3. Ledges ───────────────────────────────────────────────────────────
{
  console.log('\n  ledges: a pocket stepping in below its floor')
  const upper = rect(20, 20, 60, 40)
  // The floor roots of the upper band stand a tool radius plus a stepover off
  // the wall; their full ring set reaches everything within a radius of that.
  const rootReach = grow(rect(23, 23, 54, 34), MM_RADIUS)

  // A wide ledge is restricted like any island face.
  {
    const inner = feature('inner', 'subtract', rectProfile(30, 30, 40, 20), 8, 20)
    const result = generate('mm', MM_DIAMETER, [body(), pocket(), inner], { finishWalls: false })
    const ledge = differencePaths(upper, rect(30, 30, 40, 20))
    const swept = sweptBy(flatCutsAt(result.moves, 14), MM_RADIUS)
    const missed = substantialArea(differencePaths(intersect(ledge, rootReach), swept))
    check(
      'wide ledge: everything the full floor pass reached on the ledge is cut',
      missed <= MM_AREA_TOLERANCE,
      `${missed.toFixed(4)} mm² of reachable ledge left standing`,
    )
    const air = substantialArea(differencePaths(swept, grow(ledge, MM_RADIUS + MM_EDGE_SLACK)))
    check(
      'wide ledge: nothing is cut over the pocket that carries on below',
      air <= MM_AREA_TOLERANCE,
      `${air.toFixed(1)} mm² swept beyond the ledge grown by the tool radius`,
    )
  }

  // A ledge narrower than a radius plus a stepover lies wholly between the wall
  // and the first floor ring. Restricted, its root holds no material at all —
  // but the full pass skims its inner strip from a ring standing over the void,
  // and with walls off nothing else does. The guard keeps that pass.
  {
    const inner = feature('inner', 'subtract', rectProfile(22.5, 22.5, 55, 35), 8, 20)
    const result = generate('mm', MM_DIAMETER, [body(), pocket(), inner], { finishWalls: false })
    const ledge = differencePaths(upper, rect(22.5, 22.5, 55, 35))
    const reachable = intersect(ledge, rootReach)
    const missed = substantialArea(differencePaths(reachable, sweptBy(flatCutsAt(result.moves, 14), MM_RADIUS)))
    check(
      'narrow ledge: the strip the full floor pass reached is still cut',
      pathsArea(reachable) > 1 && missed <= MM_AREA_TOLERANCE,
      `${missed.toFixed(4)} of ${pathsArea(reachable).toFixed(4)} mm² of reachable ledge left standing`,
    )
    check(
      'narrow ledge: no "no finish contours" warning',
      !warned(result, 'surfaceNoFinishContours'),
      `warnings: ${result.warnings.map((warning) => warning.code).join(', ')}`,
    )
  }
}

// ── 4. A band floor with no material at it ──────────────────────────────
{
  console.log('\n  a band floor that is all void')
  // A subtract wider than the pocket, from 8 up to 17, splits the pocket at 17
  // with nothing standing there: everywhere under the pocket carries on down.
  // With walls off that band has nothing to cut at all, and "no finish
  // contours" about it would be a false alarm the full floor pass never raised.
  const under = feature('under', 'subtract', rectProfile(15, 15, 70, 50), 8, 17)
  const { project, operation } = scene('mm', MM_DIAMETER, [body(), pocket(), under], { finishWalls: false })
  const bandedAt17 = resolvePocketRegions(project, operation).bands.some((band) => Math.abs(band.bottomZ - 17) < 1e-9)
  const result = generatePocketToolpath(project, operation)
  check('void floor: the pocket is banded at 17 (the premise)', bandedAt17, 'no band ends at 17, so this case tests nothing')
  const cutsAt17 = flatCutsAt(result.moves, 17).length
  check('void floor: nothing is cut at 17', cutsAt17 === 0, `${cutsAt17} flat cuts at Z 17 over open space`)
  check(
    'void floor: no "no finish contours" warning',
    !warned(result, 'surfaceNoFinishContours'),
    `warnings: ${result.warnings.map((warning) => warning.code).join(', ')}`,
  )
}

// ── 5. Ground a clamp kept the band below out of ───────────────────────
{
  console.log('\n  a clamp whose clearance falls between two band floors')
  // The clamp's required clearance, 15.5, sits between the island top at 17 and
  // the pocket floor at 14. The band below is masked around it and never cut
  // there; the band above is not. What stands in that footprint is still
  // material at 17, so the floor there has to reach it rather than read the
  // band below's unmasked outline as void.
  const islandFeature = feature('island', 'add', rectProfile(35, 30, 20, 20), 0, 17)
  const { project, operation } = scene('mm', MM_DIAMETER, [body(), pocket(), islandFeature], {})
  project.meta = { ...project.meta, clampClearanceXY: 0, clampClearanceZ: 0 }
  project.clamps = [{ id: 'c1', name: 'Low clamp', type: 'step_clamp', x: 62, y: 35, w: 8, h: 10, height: 15.5, visible: true }]
  const result = generatePocketToolpath(project, operation)
  const missed = substantialArea(differencePaths(rect(62, 35, 8, 10), sweptBy(flatCutsAt(result.moves, 17), MM_RADIUS)))
  check(
    'clamp: the ground the band below never reached is finished at 17',
    missed <= MM_AREA_TOLERANCE,
    `${missed.toFixed(3)} of 80 mm² under the clamp's footprint left standing`,
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
