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
 * Mesh-slice decimation and the slice vertex budget for 3D roughing (#674).
 *
 * `sliceMeshAtZDetailed` emits one contour vertex per triangle-edge crossing,
 * every one of them used to enter a single `ClipperOffset.Execute` per Z level,
 * and that offset is superlinear in the total. A detailed relief STL sent 3D
 * roughing into a multi-second-per-level offset and Firefox killed the script
 * (#673).
 *
 * Run with: npx tsx src/engine/toolpaths/surfaceStepdown3dDecimation.test.ts
 */

import { defaultTool, newProject, rectProfile, type Operation, type Project, type SketchFeature, type Tool } from '../../types/project'
import { serializeImportedMesh } from '../importedMesh'
import { loadSTLTransformedGeometry } from '../csg'
import { buildMeshSliceIndex, sliceMeshAtZDetailed } from './meshSlicing'
import { DEFAULT_CLIPPER_SCALE, normalizeWinding, toClipperPath } from './geometry'
import {
  calculateClipperArea,
  intersectClipperPaths,
  unionClipperPathsEvenOdd,
} from './modelProtection'
import { simplifyClosedRing } from './arcReconstruction'
import {
  DEFAULT_SURFACE_3D_SLICE_VERTEX_BUDGET,
  resolve3DSurfaceStepdown,
  sliceDecimationTolerance,
  type Resolved3DSurfaceLevel,
} from './surfaceStepdown3d'
import type { ClipperPath } from './types'
import { asSketchFeature, projectWithFeatures, resolvedFeature } from '../../test/projectFixtures'
import { cpuRatio } from '../../test/cpuRatio'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── fixtures ────────────────────────────────────────────────────────────────
//
// A tapered relief tube. The cross-section is a radial modulation of a circle,
// so every horizontal slice is one closed ring with exactly `pointCount`
// vertices, and the taper makes each level's ring strictly larger than the ones
// above it — so the level's own fresh slice, not the protection inherited from
// above, is what has to contain the model.
//
// `sawtooth` is the reference half of the perf pair and the fixture that trips
// the budget. Alternating the radius by +/- SAWTOOTH_AMPLITUDE makes every ring
// vertex deviate from its neighbours' chord by 0.2 mm, two orders past any
// decimation tolerance this code can pick, so Douglas-Peucker cannot thin the
// ring. Same vertex count, same code path, same everything else — only
// simplifiability differs. It is not a *perfectly* invariant reference; see
// `test_decimation_cost_ratio` for the quad-wall property that keeps half of
// any slice removable and what that costs the measurement.

const BASE_RADIUS = 40
const LOBE_AMPLITUDE = 3
const DETAIL_AMPLITUDE = 0.4
const SAWTOOTH_AMPLITUDE = 0.1
const BOTTOM_TAPER = 1.05
const MODEL_TOP_Z = 3
const SILHOUETTE_HALF_WIDTH = 48

function ringRadius(index: number, pointCount: number, sawtooth: boolean, scale: number): number {
  const theta = (index / pointCount) * Math.PI * 2
  const base = BASE_RADIUS
    + LOBE_AMPLITUDE * Math.sin(8 * theta)
    + DETAIL_AMPLITUDE * Math.sin(37 * theta)
  const spike = sawtooth ? (index % 2 === 0 ? SAWTOOTH_AMPLITUDE : -SAWTOOTH_AMPLITUDE) : 0
  return (base + spike) * scale
}

function ringPoint(index: number, pointCount: number, sawtooth: boolean, scale: number): [number, number] {
  const theta = (index / pointCount) * Math.PI * 2
  const radius = ringRadius(index, pointCount, sawtooth, scale)
  return [radius * Math.cos(theta), radius * Math.sin(theta)]
}

/**
 * Side walls only — no caps. Slicing a tube gives a closed ring at every Z, so
 * the mesh is watertight as far as `sliceMeshAtZDetailed` is concerned and the
 * open-slice silhouette fallback never fires. It also halves the triangle count
 * of the budget fixture.
 */
function buildReliefMesh(pointCount: number, sawtooth: boolean): {
  positions: Float32Array
  index: Uint32Array
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
} {
  const positions = new Float32Array(pointCount * 2 * 3)
  const index = new Uint32Array(pointCount * 2 * 3)
  let maxRadius = 0

  for (let i = 0; i < pointCount; i += 1) {
    const [bx, by] = ringPoint(i, pointCount, sawtooth, BOTTOM_TAPER)
    const [tx, ty] = ringPoint(i, pointCount, sawtooth, 1)
    positions[i * 3] = bx
    positions[i * 3 + 1] = by
    positions[i * 3 + 2] = 0
    positions[(pointCount + i) * 3] = tx
    positions[(pointCount + i) * 3 + 1] = ty
    positions[(pointCount + i) * 3 + 2] = MODEL_TOP_Z
    maxRadius = Math.max(maxRadius, Math.hypot(bx, by), Math.hypot(tx, ty))
  }

  for (let i = 0; i < pointCount; i += 1) {
    const next = (i + 1) % pointCount
    const base = i * 6
    index[base] = i
    index[base + 1] = next
    index[base + 2] = pointCount + next
    index[base + 3] = i
    index[base + 4] = pointCount + next
    index[base + 5] = pointCount + i
  }

  assert(maxRadius < SILHOUETTE_HALF_WIDTH,
    `relief fixture radius ${maxRadius.toFixed(2)} must stay inside the silhouette`)

  return {
    positions,
    index,
    bounds: {
      minX: -maxRadius, maxX: maxRadius,
      minY: -maxRadius, maxY: maxRadius,
      minZ: 0, maxZ: MODEL_TOP_Z,
    },
  }
}

function makeTool(): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 'tool1',
    name: '3.175 mm flat endmill',
    type: 'flat_endmill',
    diameter: 3.175,
    defaultStepdown: 1,
    defaultStepover: 0.4,
    maxCutDepth: 20,
  }
}

function makeRoughOperation(): Operation {
  return {
    id: 'rough1',
    name: 'Rough surface',
    kind: 'rough_surface',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['model1'] },
    toolRef: 'tool1',
    stepdown: 1,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
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

/**
 * The silhouette is the plaque outline, not the relief detail — that is how a
 * real import behaves and it keeps the outer machining envelope cheap, so the
 * measurement below sees the island offset the report blamed rather than an
 * equally dense outer contour on both halves of the ratio.
 */
function makeReliefProject(
  name: string,
  pointCount: number,
  sawtooth: boolean,
): { project: Project; operation: Operation } {
  const mesh = buildReliefMesh(pointCount, sawtooth)
  const assetId = `relief-${name}`
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
    ...newProject(`surface3d-decimation-${name}`, 'mm'),
    tools: [makeTool()],
    modelAssets: { [assetId]: serializeImportedMesh(mesh, 'stl') },
  }, [model])
  project.stock.thickness = MODEL_TOP_Z
  return { project, operation: makeRoughOperation() }
}

function resolveLevels(project: Project, operation: Operation): Resolved3DSurfaceLevel[] {
  const resolved = resolve3DSurfaceStepdown(project, operation)
  assert(resolved.ok, `resolver refused: ${JSON.stringify(resolved.ok ? [] : resolved.result.warnings)}`)
  if (!resolved.ok) throw new Error('unreachable')
  return resolved.resolved.levels
}

function pathVertexCount(paths: ClipperPath[]): number {
  return paths.reduce((total, path) => total + path.length, 0)
}

/**
 * The undecimated keep-out at the same Z the resolver protects, built the way
 * `slicePolygonsToClipperPaths` built it before #674: raw slice polygons,
 * normalized winding, even-odd union, no thinning and no margin.
 */
function trueSliceAtLevel(project: Project, levelZ: number): ClipperPath[] {
  const stlData = loadSTLTransformedGeometry(asSketchFeature(resolvedFeature(project, 'model1')), project)
  assert(stlData !== null, 'fixture mesh must load')
  if (!stlData) throw new Error('unreachable')

  let modelTopZ = -Infinity
  let modelBottomZ = Infinity
  for (let i = 2; i < stlData.positions.length; i += 3) {
    const z = stlData.positions[i]
    if (z > modelTopZ) modelTopZ = z
    if (z < modelBottomZ) modelBottomZ = z
  }

  // Mirrors resolve3DSurfaceStepdown's own Z choice for the protection slice.
  const sliceSampleEpsilon = Math.max(Math.abs(modelTopZ - modelBottomZ) * 1e-6, 1e-6)
  const protectionZ = levelZ
  if (protectionZ > modelTopZ - sliceSampleEpsilon || protectionZ < modelBottomZ - sliceSampleEpsilon) {
    return []
  }
  const sliceZ = Math.min(
    modelTopZ - sliceSampleEpsilon,
    Math.max(modelBottomZ + sliceSampleEpsilon, protectionZ + sliceSampleEpsilon),
  )

  const sliceIndex = buildMeshSliceIndex(stlData.positions, stlData.index)
  const polygons = sliceMeshAtZDetailed(sliceIndex, sliceZ).polygons
  return unionClipperPathsEvenOdd(
    polygons
      .filter((poly) => poly.length >= 3)
      .map((poly) => toClipperPath(
        normalizeWinding(poly.map(([x, y]) => ({ x, y })), false),
        DEFAULT_CLIPPER_SCALE,
      )),
  )
}

// ── tests ───────────────────────────────────────────────────────────────────

const PERF_POINT_COUNT = 4_000
// Sized to clear DEFAULT_SURFACE_3D_SLICE_VERTEX_BUDGET on the sawtooth half:
// a tube wall contributes two slice vertices per ring point, so this lands near
// 60,000 against the 50,000 budget. The smooth half at the same point count
// thins on curvature rather than on N and stays far below it.
const BUDGET_POINT_COUNT = 30_000

function test_ring_simplifier_bounds_deviation(): void {
  const tolerance = 0.05
  const ring: Array<{ x: number; y: number }> = []
  for (let i = 0; i < 720; i += 1) {
    const theta = (i / 720) * Math.PI * 2
    ring.push({ x: 30 * Math.cos(theta), y: 30 * Math.sin(theta) })
  }
  ring.push({ ...ring[0] })

  const { points: simplified, deviation } = simplifyClosedRing(ring, tolerance)
  assert(simplified.length < ring.length / 4,
    `a 720-point circle should thin hard at ${tolerance} mm, kept ${simplified.length}`)
  assert(simplified.length >= 4, 'a simplified ring keeps at least a triangle')
  assert(Math.abs(simplified[0].x - simplified[simplified.length - 1].x) < 1e-12
    && Math.abs(simplified[0].y - simplified[simplified.length - 1].y) < 1e-12,
    'the simplified ring comes back closed')

  // Every original vertex stays within the *reported* deviation of the
  // simplified ring. This is the exact property the containment margin is
  // bought with: the caller expands by `deviation`, not by `tolerance`, so an
  // under-reported figure would be an under-sized keep-out.
  let worst = 0
  for (const point of ring) {
    let best = Infinity
    for (let i = 0; i < simplified.length - 1; i += 1) {
      const a = simplified[i]
      const b = simplified[i + 1]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len2 = dx * dx + dy * dy
      const t = len2 < 1e-18 ? 0 : Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2))
      best = Math.min(best, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)))
    }
    worst = Math.max(worst, best)
  }
  assert(worst <= deviation + 1e-12,
    `worst deviation ${worst.toFixed(9)} mm exceeds the reported ${deviation.toFixed(9)} mm`)
  assert(deviation > 0 && deviation <= tolerance,
    `a ring that thinned must report a deviation inside the tolerance, got ${deviation}`)

  // A sawtooth is every-vertex-is-a-corner, so nothing may be dropped and
  // nothing may be charged for. Zero deviation is what keeps a coarse mesh's
  // emitted program byte-identical.
  const spiky: Array<{ x: number; y: number }> = []
  for (let i = 0; i < 720; i += 1) {
    const theta = (i / 720) * Math.PI * 2
    const radius = 30 + (i % 2 === 0 ? 0.5 : -0.5)
    spiky.push({ x: radius * Math.cos(theta), y: radius * Math.sin(theta) })
  }
  spiky.push({ ...spiky[0] })
  const spikyResult = simplifyClosedRing(spiky, tolerance)
  assert(spikyResult.points.length === spiky.length,
    'a sawtooth ring keeps every vertex — this is what makes it the perf reference')
  assert(spikyResult.deviation === 0,
    `a ring that dropped nothing must charge nothing, got ${spikyResult.deviation}`)

  // A rectangle is the shape every coarse mesh slices to, and the one that has
  // to stay free.
  const rect = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 },
  ]
  const rectResult = simplifyClosedRing(rect, tolerance)
  assert(rectResult.deviation === 0 && rectResult.points.length === rect.length,
    `a rectangle must pass through untouched and uncharged, got ${JSON.stringify(rectResult)}`)

  // Degeneracy falls back rather than deleting a keep-out.
  const sliver = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 },
    { x: 20, y: 0.0001 }, { x: 10, y: 0.0001 }, { x: 0, y: 0.0001 },
    { x: 0, y: 0 },
  ]
  const simplifiedSliver = simplifyClosedRing(sliver, tolerance)
  assert(Math.abs(calculateClipperArea([toClipperPath(simplifiedSliver.points)])) > 0,
    'a sub-tolerance sliver keeps its original ring rather than collapsing to zero area')
  assert(simplifiedSliver.deviation === 0, 'a ring that fell back charges nothing')
}

/**
 * A rectangular tube: flat walls, four corners, and the same triangulated-quad
 * construction as every other box fixture in this suite. RDP has nothing to
 * drop but the mid-wall points that sit exactly on their neighbours' chord, so
 * the error it introduces is float noise, and the resolver charges no margin at
 * all. That zero is what keeps a coarse or box-like model emitting the program
 * it emitted before #674 — no expanded keep-out, no shifted envelope, no wider
 * cleanup wall probe.
 */
function test_coarse_mesh_pays_no_margin(): void {
  const half = 20
  const corners: Array<[number, number]> = [
    [-half, -half / 2], [half, -half / 2], [half, half / 2], [-half, half / 2],
  ]
  const positions = new Float32Array(corners.length * 2 * 3)
  const index = new Uint32Array(corners.length * 2 * 3)
  for (let i = 0; i < corners.length; i += 1) {
    positions[i * 3] = corners[i][0]
    positions[i * 3 + 1] = corners[i][1]
    positions[i * 3 + 2] = 0
    positions[(corners.length + i) * 3] = corners[i][0]
    positions[(corners.length + i) * 3 + 1] = corners[i][1]
    positions[(corners.length + i) * 3 + 2] = MODEL_TOP_Z
  }
  for (let i = 0; i < corners.length; i += 1) {
    const next = (i + 1) % corners.length
    const base = i * 6
    index[base] = i
    index[base + 1] = next
    index[base + 2] = corners.length + next
    index[base + 3] = i
    index[base + 4] = corners.length + next
    index[base + 5] = corners.length + i
  }

  const model: SketchFeature = {
    id: 'model1',
    name: 'Box STL',
    kind: 'stl',
    folderId: null,
    stl: {
      format: 'stl',
      meshAssetId: 'coarse-box',
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [corners.map(([x, y]) => ({ x, y }))],
    },
    sketch: {
      profile: rectProfile(-half, -half / 2, half * 2, half),
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
    ...newProject('surface3d-decimation-coarse', 'mm'),
    tools: [makeTool()],
    modelAssets: {
      'coarse-box': serializeImportedMesh({
        positions,
        index,
        bounds: { minX: -half, maxX: half, minY: -half / 2, maxY: half / 2, minZ: 0, maxZ: MODEL_TOP_Z },
      }, 'stl'),
    },
  }, [model])
  project.stock.thickness = MODEL_TOP_Z

  const resolved = resolve3DSurfaceStepdown(project, makeRoughOperation())
  assert(resolved.ok, 'the coarse box must resolve')
  if (!resolved.ok) throw new Error('unreachable')
  assert(resolved.resolved.levels.length >= 2,
    `expected machinable levels on the coarse box, got ${resolved.resolved.levels.length}`)
  // 1e-9 is `offsetClipperPaths`'s own no-op threshold, so a figure under it
  // provably moves nothing downstream.
  assert(resolved.resolved.decimationTolerance < 1e-9,
    `a box mesh must be charged no decimation margin, got ${resolved.resolved.decimationTolerance}`)
}

function test_decimation_thins_slice_contours(): void {
  const { project, operation } = makeReliefProject('smooth-perf', PERF_POINT_COUNT, false)
  const levels = resolveLevels(project, operation)
  assert(levels.length >= 2, `expected several rough levels, got ${levels.length}`)

  const tolerance = sliceDecimationTolerance(3.175 / 2)
  assert(tolerance > 0 && tolerance < 0.02 + 1e-12,
    `decimation tolerance ${tolerance} must stay inside its clamp band`)

  for (const level of levels) {
    const rawVertices = pathVertexCount(trueSliceAtLevel(project, level.z))
    if (rawVertices === 0) continue
    const keptVertices = pathVertexCount(level.clearablePaths)
    // clearablePaths carries the outer envelope as well as the model island, so
    // this compares the whole level's Clipper input against the island alone —
    // it can only understate the thinning.
    assert(keptVertices < rawVertices / 4,
      `Z=${level.z}: level kept ${keptVertices} contour vertices against ${rawVertices} raw slice `
      + 'vertices — decimation is not thinning the mesh slice')
  }
}

function test_decimated_keep_out_contains_the_true_slice(): void {
  const { project, operation } = makeReliefProject('smooth-containment', PERF_POINT_COUNT, false)
  const levels = resolveLevels(project, operation)

  let checked = 0
  for (const level of levels) {
    const truePaths = trueSliceAtLevel(project, level.z)
    if (truePaths.length === 0) continue
    checked += 1

    const trueArea = calculateClipperArea(truePaths)
    assert(trueArea > 1000, `Z=${level.z}: fixture slice should be a real cross-section, got ${trueArea}`)

    // The keep-out contains the true cross-section exactly when no part of that
    // cross-section is inside the region the rough pass is allowed to clear.
    // `clearablePaths` is the strictest form of this: it is what
    // `roughSurface.ts` insets for cutting *and* offsets inward by the tool
    // radius for its safe-link domain, so a leak here is both a gouge and a
    // link that travels across standing stock.
    const leak = calculateClipperArea(intersectClipperPaths(truePaths, level.clearablePaths))
    assert(leak <= CONTAINMENT_LEAK_LIMIT,
      `Z=${level.z}: ${leak.toFixed(6)} mm2 of the true model cross-section falls inside the `
      + `clearable region (limit ${CONTAINMENT_LEAK_LIMIT} mm2, slice area ${trueArea.toFixed(1)} mm2) — `
      + 'the decimated keep-out no longer contains the undecimated one')
  }
  assert(checked >= 2, `expected several levels with a real slice, checked ${checked}`)
}

// Measured 0, 0 and 8.15e-7 mm2 across the three levels with the margin in
// place; dropping `appliedDecimation` from the erode that applies it leaks
// 0.849 mm2 at Z=2 on this fixture. The limit is not zero because Clipper works
// in 1/10,000 mm integers and a boundary that lands within a unit of the true
// slice rounds to a sliver — but at 1e-3 mm2 it sits ~1,200x above the worst
// measured baseline and ~850x below a real regression.
const CONTAINMENT_LEAK_LIMIT = 1e-3

function test_slice_vertex_budget_refuses_a_mesh_it_cannot_bound(): void {
  const dense = makeReliefProject('sawtooth-budget', BUDGET_POINT_COUNT, true)
  const result = resolve3DSurfaceStepdown(dense.project, dense.operation)
  assert(!result.ok, 'a mesh past the slice vertex budget must refuse, not spin')
  if (result.ok) throw new Error('unreachable')

  assert(result.result.moves.length === 0, 'a refused operation emits no moves')
  assert(result.result.warnings.length === 1
    && result.result.warnings[0].code === 'surface3dMeshTooDense',
    `expected surface3dMeshTooDense, got ${JSON.stringify(result.result.warnings)}`)

  const params = result.result.warnings[0].params ?? {}
  assert(Number(params.vertices) > DEFAULT_SURFACE_3D_SLICE_VERTEX_BUDGET,
    `the warning must report the count that blew the budget, got ${JSON.stringify(params)}`)
  assert(Number(params.budget) === DEFAULT_SURFACE_3D_SLICE_VERTEX_BUDGET,
    `the warning must report the budget, got ${JSON.stringify(params)}`)

  // Same vertex count, same mesh construction, only simplifiable: decimation is
  // what keeps this one inside the budget. Delete the decimation and this half
  // starts refusing too.
  const smooth = makeReliefProject('smooth-budget', BUDGET_POINT_COUNT, false)
  const smoothResult = resolve3DSurfaceStepdown(smooth.project, smooth.operation)
  assert(smoothResult.ok,
    `the same vertex count decimates inside the budget: ${JSON.stringify(smoothResult.ok ? [] : smoothResult.result.warnings)}`)
  if (!smoothResult.ok) throw new Error('unreachable')
  assert(smoothResult.resolved.levels.length >= 2,
    'the decimated relief still resolves machinable levels')
}

function test_decimation_cost_ratio(): void {
  // Guarded work: the per-level Clipper offsets in `resolve3DSurfaceStepdown`,
  // whose cost is superlinear in the contour vertex count entering them.
  //
  // Subject and reference are the same mesh construction at the same
  // PERF_POINT_COUNT, resolved by the same function, so machine, clock rate,
  // allocator and microarchitecture all cancel. The reference's rings alternate
  // +/- 0.1 mm, which makes every *ring* vertex deviate 0.2 mm from its
  // neighbours' chord — two orders past any tolerance this code picks — so
  // Douglas-Peucker cannot thin it.
  //
  //                          subject (smooth)   reference (sawtooth)   ratio
  //     current                20, 20, 21ms      2266, 2266, 2341ms      .009 .009 .009
  //     decimation removed    731, 776, 775ms    3666, 3753, 3741ms      .199 .207 .207
  //
  // Limit is the geometric mid-point of the worst pair — highest baseline
  // (0.009) against lowest regression (0.199) — so ~4.7x clear either side.
  //
  // The reference is not perfectly invariant, and the second column is why:
  // it moved 1.6x across the mutation while the subject moved 39x. The cause is
  // structural and applies to any triangulated quad wall, not to this fixture
  // alone. Slicing quad `i` at Z yields two points — one on a vertical edge,
  // one on the shared diagonal — and they come out as
  //
  //     P_i = (1-t)b_i + t*top_i        D_i = (1-t)b_i + t*top_(i+1)
  //
  // so `P_i -> D_i` steps by `t*(top_(i+1) - top_i)` and `D_i -> P_(i+1)` by
  // `(1-t)*(b_(i+1) - b_i)`. When the bottom ring is a uniform scale of the top
  // one those two steps are parallel, and the midpoint is collinear to within
  // 1e-4 mm — measured, and measured again with the sawtooth phase flipped
  // between the rings and with an alternating angular jitter, both of which
  // only move which of the two families is the collinear one. Half of every
  // slice is therefore removable whatever the ring shape, so the reference
  // gets a 2x thinning it cannot avoid.
  //
  // That contamination makes the ratio *understate* the regression — the
  // conservative direction for a guard — and it is a fixed factor, not a
  // drifting one, so it costs sensitivity rather than stability. The measured
  // separation is 22x, with under 5% spread on either side.
  const smooth = makeReliefProject('smooth-ratio', PERF_POINT_COUNT, false)
  const sawtooth = makeReliefProject('sawtooth-ratio', PERF_POINT_COUNT, true)

  // Warm the mesh transform, slice-index and slice caches, and the JIT, so the
  // measured region is the Clipper work and the decimation pass only.
  resolve3DSurfaceStepdown(smooth.project, smooth.operation)
  resolve3DSurfaceStepdown(sawtooth.project, sawtooth.operation)

  const { ratio, subjectMs, referenceMs } = cpuRatio(
    { run: () => { resolve3DSurfaceStepdown(smooth.project, smooth.operation) } },
    { run: () => { resolve3DSurfaceStepdown(sawtooth.project, sawtooth.operation) } },
  )
  console.log(
    `  ${PERF_POINT_COUNT}-vertex relief: ${subjectMs.toFixed(0)}ms CPU vs `
    + `${referenceMs.toFixed(0)}ms undecimable reference (ratio ${ratio.toFixed(3)})`,
  )
  assert(ratio < DECIMATION_RATIO_LIMIT,
    `a smooth ${PERF_POINT_COUNT}-vertex relief cost ${ratio.toFixed(3)}x the undecimable reference `
    + `(limit ${DECIMATION_RATIO_LIMIT}x; ${subjectMs.toFixed(0)}ms vs ${referenceMs.toFixed(0)}ms CPU) — `
    + 'check that mesh slice contours are still decimated before they reach Clipper')
}

const DECIMATION_RATIO_LIMIT = 0.042

// ── run ─────────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

// The ratio runs first, deliberately. Every other test here resolves a dense
// relief, and with the decimation removed those become seconds of CPU that
// thermally load the machine before the measurement — which inflates the
// reference and makes the regression look smaller than it is. Measuring first
// puts the baseline and regressed runs in the same machine state.
const tests: Array<{ name: string; fn: () => void }> = [
  { name: 'decimation cost ratio against an undecimable reference', fn: test_decimation_cost_ratio },
  { name: 'closed-ring RDP bounds deviation and never deletes a ring', fn: test_ring_simplifier_bounds_deviation },
  { name: 'a coarse mesh is charged no decimation margin', fn: test_coarse_mesh_pays_no_margin },
  { name: 'decimation thins mesh slice contours', fn: test_decimation_thins_slice_contours },
  { name: 'decimated keep-out contains the true slice', fn: test_decimated_keep_out_contains_the_true_slice },
  { name: 'slice vertex budget refuses a mesh it cannot bound', fn: test_slice_vertex_budget_refuses_a_mesh_it_cannot_bound },
]

for (const { name, fn } of tests) {
  try {
    fn()
    console.log(`✓ ${name}`)
    passed += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
