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
 * Waterline finish: slice decimation, the slice vertex budget, and the rule
 * that a critical floor level has to be reachable (issue #685).
 *
 * Waterline carried the whole of #674's defect in its own copy of
 * `slicePolygonsToClipperPaths`, and its own copy of #682's defect in
 * `finishSurface.ts`'s critical-floor scan. The reporter's 291k-triangle relief
 * built 438 levels, handed 3,978,229 contour vertices to Clipper, and took
 * 305.2 s.
 *
 * The safety argument here is not #677's. There the contours are a keep-out and
 * thinning can be paid for by expanding it; here the offset contours are the cut
 * path, so the error lands in the finished surface. See
 * `WATERLINE_SLICE_DECIMATION_TOLERANCE_MM` for why the bound has to be measured
 * on the boundary the cutter stays tangent to rather than on the ring, and
 * `test_thinned_surface_stays_within_tolerance` for the assertion that holds it.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurfaceWaterlineDecimation.test.ts
 */

import { defaultTool, newProject, rectProfile, type Operation, type Project, type SketchFeature, type Tool } from '../../types/project'
import { serializeImportedMesh } from '../importedMesh'
import { criticalWaterlineFloorZs, generateFinishSurfaceToolpath } from './finishSurface'
import {
  DEFAULT_WATERLINE_SLICE_VERTEX_BUDGET,
  WATERLINE_SLICE_DECIMATION_TOLERANCE_MM,
} from './finishSurfaceWaterline'
import { buildMeshSliceIndex, sliceMeshAtZ } from './meshSlicing'
import { simplifyClosedRing } from './arcReconstruction'
import { DEFAULT_CLIPPER_SCALE, normalizeWinding, toClipperPath } from './geometry'
import {
  calculateClipperArea,
  differenceClipperPaths,
  offsetClipperPaths,
  unionClipperPaths,
  unionClipperPathsEvenOdd,
} from './modelProtection'
import type { ClipperPath } from './types'
import { projectWithFeatures } from '../../test/projectFixtures'
import { cpuRatio } from '../../test/cpuRatio'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── fixtures ────────────────────────────────────────────────────────────────
//
// A tapered relief tube, the same family `surfaceStepdown3dDecimation.test.ts`
// uses: the cross-section is a radial modulation of a circle, so every
// horizontal slice is one closed ring of exactly `pointCount` vertices, and the
// taper makes each level's ring strictly larger than the ones above it.
//
// `sawtooth` alternates the radius by +/- 0.1 mm, which is two orders past any
// tolerance this code can pick, so Douglas-Peucker keeps every vertex. Same
// point count, same code path, same everything else — only simplifiability
// differs, which is what makes it the reference half of the cost ratio and the
// fixture that trips the budget.

const BASE_RADIUS = 40
const LOBE_AMPLITUDE = 3
const DETAIL_AMPLITUDE = 0.4
const SAWTOOTH_AMPLITUDE = 0.1
const BOTTOM_TAPER = 1.05
const MODEL_TOP_Z = 3
const SILHOUETTE_HALF_WIDTH = 48
const STEPDOWN = 0.5
const TOOL_DIAMETER = 1.5875

interface Mesh {
  positions: Float32Array
  index: Uint32Array
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
}

function ringPoint(index: number, pointCount: number, sawtooth: boolean, scale: number): [number, number] {
  const theta = (index / pointCount) * Math.PI * 2
  const base = BASE_RADIUS
    + LOBE_AMPLITUDE * Math.sin(8 * theta)
    + DETAIL_AMPLITUDE * Math.sin(37 * theta)
  const spike = sawtooth ? (index % 2 === 0 ? SAWTOOTH_AMPLITUDE : -SAWTOOTH_AMPLITUDE) : 0
  const radius = (base + spike) * scale
  return [radius * Math.cos(theta), radius * Math.sin(theta)]
}

/** Side walls only — a tube slices to a closed ring at every Z and needs no caps. */
function buildTube(corners: Array<[number, number]>, topCorners = corners): Mesh {
  const count = corners.length
  const positions = new Float32Array(count * 2 * 3)
  const index = new Uint32Array(count * 2 * 3)
  let maxRadius = 0
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = corners[i][0]
    positions[i * 3 + 1] = corners[i][1]
    positions[i * 3 + 2] = 0
    positions[(count + i) * 3] = topCorners[i][0]
    positions[(count + i) * 3 + 1] = topCorners[i][1]
    positions[(count + i) * 3 + 2] = MODEL_TOP_Z
    maxRadius = Math.max(maxRadius, Math.hypot(...corners[i]), Math.hypot(...topCorners[i]))
  }
  for (let i = 0; i < count; i += 1) {
    const next = (i + 1) % count
    const base = i * 6
    index[base] = i
    index[base + 1] = next
    index[base + 2] = count + next
    index[base + 3] = i
    index[base + 4] = count + next
    index[base + 5] = count + i
  }
  assert(maxRadius < SILHOUETTE_HALF_WIDTH,
    `fixture radius ${maxRadius.toFixed(2)} must stay inside the silhouette`)
  return {
    positions,
    index,
    bounds: { minX: -maxRadius, maxX: maxRadius, minY: -maxRadius, maxY: maxRadius, minZ: 0, maxZ: MODEL_TOP_Z },
  }
}

function buildReliefMesh(pointCount: number, sawtooth: boolean): Mesh {
  const bottom: Array<[number, number]> = []
  const top: Array<[number, number]> = []
  for (let i = 0; i < pointCount; i += 1) {
    bottom.push(ringPoint(i, pointCount, sawtooth, BOTTOM_TAPER))
    top.push(ringPoint(i, pointCount, sawtooth, 1))
  }
  return buildTube(bottom, top)
}

function makeTool(): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 'tool1',
    name: '1.5875 mm ball endmill',
    type: 'ball_endmill',
    diameter: TOOL_DIAMETER,
    defaultStepdown: STEPDOWN,
    defaultStepover: 0.25,
    maxCutDepth: 20,
  }
}

function makeWaterlineOperation(): Operation {
  return {
    id: 'finish1',
    name: 'Finish surface',
    kind: 'finish_surface',
    pass: 'finish',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['model1'] },
    toolRef: 'tool1',
    stepdown: STEPDOWN,
    stepover: 0.25,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'waterline',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
}

function makeProject(name: string, mesh: Mesh): Project {
  const assetId = `waterline-${name}`
  const model: SketchFeature = {
    id: 'model1',
    name: 'Relief STL',
    kind: 'stl',
    folderId: null,
    stl: {
      format: 'stl',
      meshAssetId: assetId,
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: -SILHOUETTE_HALF_WIDTH, y: -SILHOUETTE_HALF_WIDTH },
        { x: SILHOUETTE_HALF_WIDTH, y: -SILHOUETTE_HALF_WIDTH },
        { x: SILHOUETTE_HALF_WIDTH, y: SILHOUETTE_HALF_WIDTH },
        { x: -SILHOUETTE_HALF_WIDTH, y: SILHOUETTE_HALF_WIDTH },
      ]],
    },
    sketch: {
      profile: rectProfile(
        -SILHOUETTE_HALF_WIDTH, -SILHOUETTE_HALF_WIDTH,
        SILHOUETTE_HALF_WIDTH * 2, SILHOUETTE_HALF_WIDTH * 2,
      ),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: MODEL_TOP_Z,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  const project = projectWithFeatures({
    ...newProject(`waterline-decimation-${name}`, 'mm'),
    tools: [makeTool()],
    modelAssets: { [assetId]: serializeImportedMesh(mesh, 'stl') },
  }, [model])
  project.stock.thickness = MODEL_TOP_Z
  return project
}

/**
 * The shadow the cutter stays tangent to, rebuilt at a chosen tolerance.
 *
 * This is deliberately the *pre-offset* boundary rather than the emitted ring.
 * The ring is the tool-centre path and moves much further than the tolerance at
 * a concave trim vertex, where the cutter is tangent to both valley walls and
 * has bottomed out — what moves there is where it stops, not what it removes.
 */
function shadowAtTolerance(mesh: Mesh, tolerance: number): ClipperPath[] {
  const sliceIndex = buildMeshSliceIndex(mesh.positions, mesh.index)
  let shadow: ClipperPath[] = []
  for (let z = MODEL_TOP_Z; z > 1e-9; z -= STEPDOWN) {
    const polygons = sliceMeshAtZ(sliceIndex, Math.min(MODEL_TOP_Z - 1e-6, z))
    const paths = polygons
      .filter((poly) => poly.length >= 3)
      .map((poly) => {
        const ring = poly.map(([x, y]) => ({ x, y }))
        const thinned = tolerance > 0 ? simplifyClosedRing(ring, tolerance).points : ring
        return toClipperPath(normalizeWinding(thinned, false), DEFAULT_CLIPPER_SCALE)
      })
    const slice = unionClipperPathsEvenOdd(paths)
    if (slice.length > 0) shadow = shadow.length === 0 ? slice : unionClipperPaths([...shadow, ...slice])
  }
  return shadow
}

function pathVertexCount(paths: ClipperPath[]): number {
  return paths.reduce((total, path) => total + path.length, 0)
}

function areaOutside(subject: ClipperPath[], container: ClipperPath[]): number {
  if (subject.length === 0) return 0
  return Math.abs(calculateClipperArea(differenceClipperPaths(subject, container)))
}

// ── tests ───────────────────────────────────────────────────────────────────

/**
 * Surface error the shipped tolerance has to keep this fixture inside, in mm.
 *
 * The containment assertion below is deliberately *not* stated in units of
 * `WATERLINE_SLICE_DECIMATION_TOLERANCE_MM`. Written that way it scales with the
 * constant it is supposed to guard and survives any mutation of it — the first
 * draft of this test did exactly that and passed with the tolerance raised
 * tenfold. An absolute figure pins the claim the tolerance was chosen on.
 *
 * 0.01 mm is twice the shipped tolerance, so the fixture clears it with room,
 * and a tenfold loosening does not.
 */
const MAX_SURFACE_DEVIATION_MM = 0.01

const PERF_POINT_COUNT = 3_000
// A tube wall contributes one slice vertex per ring point, so a sawtooth ring
// this wide lands just past DEFAULT_WATERLINE_SLICE_VERTEX_BUDGET while the same
// point count smooth enough to thin stays far under it.
//
// Not 14,000, which hangs this generator on `main` as well as here — a ring
// sampled at an exact multiple of its own 8-lobe period degenerates somewhere in
// the offset, and 13,900 and 14,100 both resolve in under a second. That is a
// pre-existing defect with its own issue (#689), not something this fixture
// should carry.
const BUDGET_POINT_COUNT = 13_000

/**
 * The claim the tolerance is chosen on: the surface the cutter stays tangent to
 * does not move by more than the tolerance, in either direction.
 *
 * Stated as two Clipper booleans rather than as a vertex distance, because it
 * is the *material* that matters. Eroding the true shadow by the tolerance and
 * asking whether any of it escapes the thinned shadow is the gouge test — the
 * cutter runs at exactly the tool offset from the thinned boundary, so anything
 * of the true model outside it is material removed that should have stayed.
 * Dilating and asking the reverse is the ridge test.
 *
 * Mutation: raise `WATERLINE_SLICE_DECIMATION_TOLERANCE_MM` tenfold and both
 * areas become non-zero, because the bound is `MAX_SURFACE_DEVIATION_MM` rather
 * than the tolerance itself.
 */
function test_thinned_surface_stays_within_tolerance(): void {
  const mesh = buildReliefMesh(4_000, false)
  const tolerance = WATERLINE_SLICE_DECIMATION_TOLERANCE_MM
  const trueShadow = shadowAtTolerance(mesh, 0)
  const thinShadow = shadowAtTolerance(mesh, tolerance)

  assert(pathVertexCount(thinShadow) < pathVertexCount(trueShadow) / 2,
    `decimation must actually thin, ${pathVertexCount(trueShadow)} → ${pathVertexCount(thinShadow)}`)
  assert(thinShadow.length === trueShadow.length,
    `thinning must not change the ring topology, ${trueShadow.length} → ${thinShadow.length}`)

  const gouge = areaOutside(offsetClipperPaths(trueShadow, -MAX_SURFACE_DEVIATION_MM), thinShadow)
  const ridge = areaOutside(thinShadow, offsetClipperPaths(trueShadow, MAX_SURFACE_DEVIATION_MM))
  assert(gouge === 0,
    `the thinned surface must contain the true one eroded by ${MAX_SURFACE_DEVIATION_MM} mm, ${gouge} mm2 escaped`)
  assert(ridge === 0,
    `the thinned surface must stay inside the true one dilated by ${MAX_SURFACE_DEVIATION_MM} mm, ${ridge} mm2 escaped`)
  assert(tolerance * 2 <= MAX_SURFACE_DEVIATION_MM,
    `the shipped tolerance ${tolerance} mm must stay inside half the surface-error budget`)
}

/**
 * A coarse cross-section is charged nothing, which is what keeps an existing
 * box-like program byte-identical.
 *
 * A box slices to a rectangle with collinear mid-wall points, because every
 * triangulated quad wall leaves one. RDP drops those — 9 vertices become 5 —
 * and that is not a deviation: the reported error is exactly 0 and the ring
 * encloses the same area, so the emitted contour is the same contour with the
 * redundant points removed. What must not happen is any *charge*, since the
 * tolerance is the whole of the surface-error claim.
 */
function test_a_coarse_cross_section_is_untouched(): void {
  const half = 20
  const mesh = buildTube([[-half, -half / 2], [half, -half / 2], [half, half / 2], [-half, half / 2]])
  const sliceIndex = buildMeshSliceIndex(mesh.positions, mesh.index)
  const polygons = sliceMeshAtZ(sliceIndex, MODEL_TOP_Z / 2)
  assert(polygons.length > 0, 'the box tube must slice to something')

  for (const poly of polygons) {
    const ring = poly.map(([x, y]) => ({ x, y }))
    const { points, deviation } = simplifyClosedRing(ring, WATERLINE_SLICE_DECIMATION_TOLERANCE_MM)
    assert(deviation === 0, `a box cross-section must be charged nothing, got ${deviation}`)
    assert(points.length >= 5, `a box cross-section must keep its corners, got ${points.length}`)
    const before = Math.abs(calculateClipperArea([toClipperPath(normalizeWinding(ring, false), DEFAULT_CLIPPER_SCALE)]))
    const after = Math.abs(calculateClipperArea([toClipperPath(normalizeWinding(points, false), DEFAULT_CLIPPER_SCALE)]))
    assert(Math.abs(before - after) / Math.max(1, before) < 1e-9,
      `dropping collinear points must not change the enclosed area, ${before} → ${after}`)
  }

  const result = generateFinishSurfaceToolpath(makeProject('box', mesh), makeWaterlineOperation())
  assert(result.warnings.every((w) => w.code !== 'surface3dMeshTooDense'),
    'a box must not be refused')
  assert(result.moves.length > 0, 'a box must still emit a waterline program')
}

/**
 * A flat region earns a critical level only when the cutter fits on it.
 *
 * The quantized-staircase half is the shape behind #673: plateaus far too small
 * to stand a cutter on, each one previously worth a full mesh slice, shadow
 * union and ring offset.
 */
function test_only_a_reachable_floor_earns_a_level(): void {
  const toolRadius = TOOL_DIAMETER / 2

  // One genuine floor: a square plateau comfortably wider than the cutter.
  const floorHalf = toolRadius * 4
  const floor = new Float32Array([
    -floorHalf, -floorHalf, 1.25, floorHalf, -floorHalf, 1.25, floorHalf, floorHalf, 1.25,
    -floorHalf, floorHalf, 1.25,
  ])
  const floorIndex = new Uint32Array([0, 1, 2, 0, 2, 3])
  const kept = criticalWaterlineFloorZs(floor, floorIndex, toolRadius)
  assert(kept.size === 1 && kept.has(1.25),
    `a floor of ${(4 * floorHalf * floorHalf).toFixed(2)} mm2 must keep its level, got ${[...kept]}`)

  // A quantized depth map: 200 plateaus, each a tenth of the cutter's own disc,
  // spaced far enough apart in Z that nothing merges them.
  const stepHalf = toolRadius / 4
  const steps = 200
  const staircase = new Float32Array(steps * 4 * 3)
  const staircaseIndex = new Uint32Array(steps * 6)
  for (let s = 0; s < steps; s += 1) {
    const z = 0.5 + s * 1e-3
    const x = s * stepHalf * 4
    const base = s * 4
    const corners: Array<[number, number]> = [
      [x, 0], [x + stepHalf * 2, 0], [x + stepHalf * 2, stepHalf * 2], [x, stepHalf * 2],
    ]
    for (let c = 0; c < 4; c += 1) {
      staircase[(base + c) * 3] = corners[c][0]
      staircase[(base + c) * 3 + 1] = corners[c][1]
      staircase[(base + c) * 3 + 2] = z
    }
    staircaseIndex.set([base, base + 1, base + 2, base, base + 2, base + 3], s * 6)
  }
  const dropped = criticalWaterlineFloorZs(staircase, staircaseIndex, toolRadius)
  assert(dropped.size === 0,
    `${steps} sub-cutter plateaus must earn no levels at all, got ${dropped.size}`)

  // The rule is on area, not on plateau count: the same staircase under a
  // cutter small enough to stand on one step keeps every level.
  const smallCutterRadius = stepHalf / 2
  const keptSmall = criticalWaterlineFloorZs(staircase, staircaseIndex, smallCutterRadius)
  assert(keptSmall.size === steps,
    `a cutter that fits must keep all ${steps} levels, got ${keptSmall.size}`)
}

/**
 * Sub-tolerance Z noise on one physical plane is one floor, not many.
 *
 * A real export splits a single flat face across Z values differing in the last
 * bits — `Oldman-splash-final.camj` carries 151 of them within 5e-6 of each
 * other. Without the merge each bucket is charged separately and a plane that
 * clears the bound as a whole can be dropped in every piece.
 */
function test_float_noise_on_one_plane_merges(): void {
  const toolRadius = TOOL_DIAMETER / 2
  // Each strip is a fifth of the cutter's disc; together they are five times it.
  const strips = 25
  const stripWidth = toolRadius
  const stripDepth = toolRadius / 5
  const positions = new Float32Array(strips * 4 * 3)
  const index = new Uint32Array(strips * 6)
  for (let s = 0; s < strips; s += 1) {
    const z = 2 + s * 1e-8
    const y = s * stripDepth
    const base = s * 4
    const corners: Array<[number, number]> = [
      [0, y], [stripWidth, y], [stripWidth, y + stripDepth], [0, y + stripDepth],
    ]
    for (let c = 0; c < 4; c += 1) {
      positions[(base + c) * 3] = corners[c][0]
      positions[(base + c) * 3 + 1] = corners[c][1]
      positions[(base + c) * 3 + 2] = z
    }
    index.set([base, base + 1, base + 2, base, base + 2, base + 3], s * 6)
  }
  const merged = criticalWaterlineFloorZs(positions, index, toolRadius)
  assert(merged.size === 1,
    `float noise on one plane must merge to one floor, got ${merged.size}`)
}

/**
 * A mesh past the budget is refused rather than run.
 *
 * The smooth half is the control: same point count, same code path, thins below
 * the budget and resolves normally. Without it the refusal could be coming from
 * the raw vertex count rather than from the density decimation could not remove.
 *
 * Mutation: raise `DEFAULT_WATERLINE_SLICE_VERTEX_BUDGET` and the sawtooth half
 * stops refusing, which is what proves the refusal comes from this guard.
 */
function test_the_budget_refuses_a_mesh_it_cannot_bound(): void {
  const refused = generateFinishSurfaceToolpath(
    makeProject('budget-sawtooth', buildReliefMesh(BUDGET_POINT_COUNT, true)),
    makeWaterlineOperation(),
  )
  const warning = refused.warnings.find((w) => w.code === 'surface3dMeshTooDense')
  assert(warning !== undefined,
    `expected surface3dMeshTooDense, got ${JSON.stringify(refused.warnings.map((w) => w.code))}`)
  assert(refused.moves.length === 0, `a refused operation emits nothing, got ${refused.moves.length} moves`)
  const params = warning?.params ?? {}
  assert(Number(String(params.vertices).replace(/[^0-9]/g, '')) > DEFAULT_WATERLINE_SLICE_VERTEX_BUDGET,
    `the refusal must report the slice that blew the budget, got ${JSON.stringify(params)}`)
  assert(Number(String(params.budget).replace(/[^0-9]/g, '')) === DEFAULT_WATERLINE_SLICE_VERTEX_BUDGET,
    `the refusal must report the budget it measured against, got ${JSON.stringify(params)}`)

  const resolved = generateFinishSurfaceToolpath(
    makeProject('budget-smooth', buildReliefMesh(BUDGET_POINT_COUNT, false)),
    makeWaterlineOperation(),
  )
  assert(resolved.warnings.every((w) => w.code !== 'surface3dMeshTooDense'),
    `the same vertex count, thinnable, must resolve: ${JSON.stringify(resolved.warnings.map((w) => w.code))}`)
  assert(resolved.moves.length > 0, 'the thinnable control must emit a program')
}

/**
 * What decimation costs, against a fixture that provably cannot benefit from it.
 *
 * Subject and reference are the same operation on the same point count; only
 * simplifiability differs, so machine, clock rate and allocator cancel. The
 * reference is not perfectly invariant — a smooth ring and a sawtooth ring do
 * not emit the same downstream motion — so the ratio understates the saving
 * rather than drifting.
 *
 * Measured on node v26.0.0 / i7-8850H at 3,000 points, subject / reference /
 * ratio, over three runs either side of the mutation:
 *
 *     with decimation       103-107 ms / 1,161-1,326 ms / 0.081-0.092
 *     decimation deleted      4,942 ms /       1,828 ms / 2.703
 *
 * The threshold is the geometric mid-point of the *worst* pair — the highest
 * baseline against the lowest regression — which leaves 5.4x of headroom on
 * each side.
 *
 * The reference column moved 1,161 -> 1,828 ms across that mutation, so it is
 * contaminated: a sawtooth ring still has the collinear mid-wall point every
 * triangulated quad leaves, and RDP takes those for free. That makes the ratio
 * *understate* the regression, which is the safe direction, but it is why the
 * threshold is not set tighter.
 *
 * Verify by mutation: set `WATERLINE_SLICE_DECIMATION_TOLERANCE_MM` to 0 and
 * this must fail.
 */
function test_decimation_cost_ratio(): void {
  const smooth = makeProject('perf-smooth', buildReliefMesh(PERF_POINT_COUNT, false))
  const sawtooth = makeProject('perf-sawtooth', buildReliefMesh(PERF_POINT_COUNT, true))
  const operation = makeWaterlineOperation()
  generateFinishSurfaceToolpath(smooth, operation)
  generateFinishSurfaceToolpath(sawtooth, operation)

  const { ratio, subjectMs, referenceMs } = cpuRatio(
    { run: () => { generateFinishSurfaceToolpath(smooth, operation) }, reps: 3 },
    { run: () => { generateFinishSurfaceToolpath(sawtooth, operation) }, reps: 2 },
  )
  console.log(`  ${PERF_POINT_COUNT}-point relief: ${subjectMs.toFixed(0)}ms CPU vs ` +
    `${referenceMs.toFixed(0)}ms undecimable reference (ratio ${ratio.toFixed(3)})`)
  assert(ratio < 0.5,
    `decimated waterline should cost well under its undecimable reference, ratio ${ratio.toFixed(3)}`)
}

const tests: Array<[string, () => void]> = [
  ['the thinned surface stays within tolerance', test_thinned_surface_stays_within_tolerance],
  ['a coarse cross-section is untouched', test_a_coarse_cross_section_is_untouched],
  ['only a reachable floor earns a level', test_only_a_reachable_floor_earns_a_level],
  ['float noise on one plane merges to one floor', test_float_noise_on_one_plane_merges],
  ['the budget refuses a mesh it cannot bound', test_the_budget_refuses_a_mesh_it_cannot_bound],
  ['decimation cost ratio against an undecimable reference', test_decimation_cost_ratio],
]

let failed = 0
for (const [name, run] of tests) {
  try {
    run()
    console.log(`✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
