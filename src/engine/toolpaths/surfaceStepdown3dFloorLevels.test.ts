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
 * Which flat regions earn their own 3D roughing Z level (#682).
 *
 * The resolver used to take every distinct Z carrying a horizontal triangle as
 * a critical floor level. A quantized depth map has one per grey step, so a
 * 291k-triangle relief produced 436 rough levels where the stepdown asked for
 * 6, and the whole per-level pipeline ran 436 times (#673).
 *
 * The rule under test: a flat region earns a level only when the cutter could
 * sit on it — flat area at that Z of at least `PI * initialInset^2`.
 *
 * Run with: npx tsx src/engine/toolpaths/surfaceStepdown3dFloorLevels.test.ts
 */

import { defaultTool, newProject, rectProfile, type Operation, type Project, type SketchFeature, type Tool } from '../../types/project'
import { serializeImportedMesh } from '../importedMesh'
import { generateStepLevels } from './pocket'
import { resolve3DSurfaceStepdown, type Resolved3DSurfaceLevel } from './surfaceStepdown3d'
import { projectWithFeatures } from '../../test/projectFixtures'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const TOOL_DIAMETER = 3.175
const TOOL_RADIUS = TOOL_DIAMETER / 2
/**
 * The exact boundary the rule draws for this tool at zero stock-to-leave: a
 * square plateau of this side has area `PI * radius^2`. The straddle fixtures
 * sit deliberately close to it on either side, so a threshold that moved would
 * flip one of them.
 */
const THRESHOLD_SQUARE_SIDE = Math.sqrt(Math.PI) * TOOL_RADIUS // 2.8135 mm

function makeTool(): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 'tool1',
    name: '3.175 mm flat endmill',
    type: 'flat_endmill',
    diameter: TOOL_DIAMETER,
    defaultStepdown: 2,
    defaultStepover: 0.4,
    maxCutDepth: 20,
  }
}

function makeRoughOperation(stepdown: number, stockToLeaveRadial = 0): Operation {
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
    stepdown,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  } as unknown as Operation
}

function appendQuad(
  vertices: number[],
  indices: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
): void {
  const offset = vertices.length / 3
  vertices.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2])
  indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3)
}

function appendWall(
  vertices: number[],
  indices: number[],
  a: [number, number],
  b: [number, number],
  minZ: number,
  maxZ: number,
): void {
  if (maxZ - minZ < 1e-9) return
  appendQuad(vertices, indices,
    [a[0], a[1], minZ], [b[0], b[1], minZ], [b[0], b[1], maxZ], [a[0], a[1], maxZ],
  )
}

function meshProject(
  name: string,
  vertices: number[],
  indices: number[],
  width: number,
  height: number,
  topZ: number,
  operation: Operation,
): { project: Project; operation: Operation } {
  const assetId = `${name}-mesh`
  const model: SketchFeature = {
    id: 'model1',
    name: 'Model STL',
    kind: 'stl',
    folderId: null,
    stl: {
      format: 'stl',
      meshAssetId: assetId,
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height },
      ]],
    },
    sketch: {
      profile: rectProfile(0, 0, width, height),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: topZ,
    z_bottom: 0,
    visible: true,
    locked: false,
  } as unknown as SketchFeature

  const project = projectWithFeatures({
    ...newProject(`surface3d-floor-levels-${name}`, 'mm'),
    tools: [makeTool()],
    modelAssets: {
      [assetId]: serializeImportedMesh({
        positions: new Float32Array(vertices),
        index: new Uint32Array(indices),
        bounds: { minX: 0, maxX: width, minY: 0, maxY: height, minZ: 0, maxZ: topZ },
      }, 'stl'),
    },
  }, [model])
  project.stock.thickness = topZ
  return { project, operation }
}

const BLOCK_SIDE = 40
const BLOCK_TOP_Z = 5
/** Deliberately off the stepdown grid, so only the critical-floor path can put a level here. */
const RECESS_FLOOR_Z = 2.9
const BLOCK_STEPDOWN = 2.07

/**
 * A solid block with one square recess whose floor is the plateau under test.
 *
 * Everything except `plateauSide` is fixed, so the two straddle fixtures differ
 * only in the one quantity the rule reads.
 */
function makeRecessedFloorProject(
  plateauSide: number,
  stockToLeaveRadial = 0,
  /**
   * Offsets the far half of the recess floor by this much, to model a plateau
   * whose vertices differ in the last bits. Under `Z_TOLERANCE` the two halves
   * are one level, so their areas have to be counted as one.
   */
  floorSplitEpsilon = 0,
): { project: Project; operation: Operation } {
  const vertices: number[] = []
  const indices: number[] = []
  const centre = BLOCK_SIDE / 2
  const half = plateauSide / 2
  const minX = centre - half, maxX = centre + half
  const minY = centre - half, maxY = centre + half
  const splitY = centre
  const farFloorZ = RECESS_FLOOR_Z + floorSplitEpsilon

  // Bottom face and outer walls.
  appendQuad(vertices, indices,
    [0, 0, 0], [BLOCK_SIDE, 0, 0], [BLOCK_SIDE, BLOCK_SIDE, 0], [0, BLOCK_SIDE, 0],
  )
  appendWall(vertices, indices, [0, 0], [BLOCK_SIDE, 0], 0, BLOCK_TOP_Z)
  appendWall(vertices, indices, [BLOCK_SIDE, 0], [BLOCK_SIDE, BLOCK_SIDE], 0, BLOCK_TOP_Z)
  appendWall(vertices, indices, [BLOCK_SIDE, BLOCK_SIDE], [0, BLOCK_SIDE], 0, BLOCK_TOP_Z)
  appendWall(vertices, indices, [0, BLOCK_SIDE], [0, 0], 0, BLOCK_TOP_Z)

  // Top deck, split around the recess.
  appendQuad(vertices, indices,
    [0, 0, BLOCK_TOP_Z], [BLOCK_SIDE, 0, BLOCK_TOP_Z], [BLOCK_SIDE, minY, BLOCK_TOP_Z], [0, minY, BLOCK_TOP_Z],
  )
  appendQuad(vertices, indices,
    [0, maxY, BLOCK_TOP_Z], [BLOCK_SIDE, maxY, BLOCK_TOP_Z], [BLOCK_SIDE, BLOCK_SIDE, BLOCK_TOP_Z], [0, BLOCK_SIDE, BLOCK_TOP_Z],
  )
  appendQuad(vertices, indices,
    [0, minY, BLOCK_TOP_Z], [minX, minY, BLOCK_TOP_Z], [minX, maxY, BLOCK_TOP_Z], [0, maxY, BLOCK_TOP_Z],
  )
  appendQuad(vertices, indices,
    [maxX, minY, BLOCK_TOP_Z], [BLOCK_SIDE, minY, BLOCK_TOP_Z], [BLOCK_SIDE, maxY, BLOCK_TOP_Z], [maxX, maxY, BLOCK_TOP_Z],
  )

  // The recess: its floor is the plateau, its walls close the solid. The floor
  // is two quads so it can be split by `floorSplitEpsilon`; at the default 0
  // they are coplanar and the seam wall below collapses to nothing.
  appendQuad(vertices, indices,
    [minX, minY, RECESS_FLOOR_Z], [maxX, minY, RECESS_FLOOR_Z],
    [maxX, splitY, RECESS_FLOOR_Z], [minX, splitY, RECESS_FLOOR_Z],
  )
  appendQuad(vertices, indices,
    [minX, splitY, farFloorZ], [maxX, splitY, farFloorZ],
    [maxX, maxY, farFloorZ], [minX, maxY, farFloorZ],
  )
  appendWall(vertices, indices, [minX, splitY], [maxX, splitY], RECESS_FLOOR_Z, farFloorZ)
  appendWall(vertices, indices, [minX, minY], [maxX, minY], RECESS_FLOOR_Z, BLOCK_TOP_Z)
  appendWall(vertices, indices, [maxX, minY], [maxX, maxY], RECESS_FLOOR_Z, BLOCK_TOP_Z)
  appendWall(vertices, indices, [maxX, maxY], [minX, maxY], farFloorZ, BLOCK_TOP_Z)
  appendWall(vertices, indices, [minX, maxY], [minX, minY], RECESS_FLOOR_Z, BLOCK_TOP_Z)

  return meshProject(
    `recess-${plateauSide}-${stockToLeaveRadial}-${floorSplitEpsilon}`,
    vertices, indices, BLOCK_SIDE, BLOCK_SIDE, BLOCK_TOP_Z,
    makeRoughOperation(BLOCK_STEPDOWN, stockToLeaveRadial),
  )
}

const GRID_CELLS = 12
const GRID_CELL_SIZE = 2
const GRID_SIDE = GRID_CELLS * GRID_CELL_SIZE
const GRID_BASE_Z = 1
const GRID_QUANTUM = 0.02
const GRID_STEPDOWN = 1

function gridCellZ(i: number, j: number): number {
  return GRID_BASE_Z + (i * GRID_CELLS + j) * GRID_QUANTUM
}

/**
 * A quantized depth map: every cell sits at its own Z, so every cell is its own
 * plateau of horizontal triangles. This is the shape of the reporter's mesh in
 * miniature — 144 distinct flat Z values, each far too small to hold the tool,
 * over one genuine floor at z=0.
 */
function makeQuantizedDepthMapProject(): { project: Project; operation: Operation } {
  const vertices: number[] = []
  const indices: number[] = []
  const topZ = gridCellZ(GRID_CELLS - 1, GRID_CELLS - 1)

  for (let i = 0; i < GRID_CELLS; i += 1) {
    for (let j = 0; j < GRID_CELLS; j += 1) {
      const x0 = i * GRID_CELL_SIZE, x1 = x0 + GRID_CELL_SIZE
      const y0 = j * GRID_CELL_SIZE, y1 = y0 + GRID_CELL_SIZE
      const z = gridCellZ(i, j)
      appendQuad(vertices, indices, [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z])

      // Risers to the neighbour on each side, and the outer skirt at the edges.
      if (i + 1 < GRID_CELLS) {
        const other = gridCellZ(i + 1, j)
        appendWall(vertices, indices, [x1, y0], [x1, y1], Math.min(z, other), Math.max(z, other))
      } else {
        appendWall(vertices, indices, [x1, y0], [x1, y1], 0, z)
      }
      if (i === 0) appendWall(vertices, indices, [x0, y0], [x0, y1], 0, z)
      if (j + 1 < GRID_CELLS) {
        const other = gridCellZ(i, j + 1)
        appendWall(vertices, indices, [x0, y1], [x1, y1], Math.min(z, other), Math.max(z, other))
      } else {
        appendWall(vertices, indices, [x0, y1], [x1, y1], 0, z)
      }
      if (j === 0) appendWall(vertices, indices, [x0, y0], [x1, y0], 0, z)
    }
  }

  // The one genuine floor in the fixture — the flat back of the plaque.
  appendQuad(vertices, indices,
    [0, 0, 0], [GRID_SIDE, 0, 0], [GRID_SIDE, GRID_SIDE, 0], [0, GRID_SIDE, 0],
  )

  return meshProject(
    'depth-map', vertices, indices, GRID_SIDE, GRID_SIDE, topZ,
    makeRoughOperation(GRID_STEPDOWN),
  )
}

function resolveLevels(project: Project, operation: Operation): Resolved3DSurfaceLevel[] {
  const resolved = resolve3DSurfaceStepdown(project, operation)
  assert(resolved.ok, `resolver refused: ${JSON.stringify(resolved.ok ? [] : resolved.result.warnings)}`)
  if (!resolved.ok) throw new Error('unreachable')
  return resolved.resolved.levels
}

function criticalZs(levels: Resolved3DSurfaceLevel[]): number[] {
  return levels.filter((level) => level.isCriticalFloorLevel).map((level) => level.z)
}

function hasLevelAt(levels: Resolved3DSurfaceLevel[], z: number): boolean {
  return levels.some((level) => Math.abs(level.z - z) < 1e-6)
}

// ── tests ───────────────────────────────────────────────────────────────────

function test_plateau_under_the_tool_disc_earns_no_level(): void {
  const side = 2.7
  assert(side < THRESHOLD_SQUARE_SIDE,
    `fixture must sit below the ${THRESHOLD_SQUARE_SIDE.toFixed(4)} mm boundary, got ${side}`)
  const { project, operation } = makeRecessedFloorProject(side)

  const stepLevels = generateStepLevels(BLOCK_TOP_Z, 0, BLOCK_STEPDOWN)
  assert(!stepLevels.some((z) => Math.abs(z - RECESS_FLOOR_Z) < 1e-6),
    'the recess floor must not coincide with a stepdown level, or the test proves nothing')

  const levels = resolveLevels(project, operation)
  assert(!hasLevelAt(levels, RECESS_FLOOR_Z),
    `a ${(side * side).toFixed(3)} mm^2 plateau cannot hold a ${TOOL_DIAMETER} mm cutter `
    + `(needs ${(Math.PI * TOOL_RADIUS * TOOL_RADIUS).toFixed(3)} mm^2) yet Z=${RECESS_FLOOR_Z} got its own level`)
}

function test_plateau_over_the_tool_disc_keeps_its_level(): void {
  const side = 2.95
  assert(side > THRESHOLD_SQUARE_SIDE,
    `fixture must sit above the ${THRESHOLD_SQUARE_SIDE.toFixed(4)} mm boundary, got ${side}`)
  const { project, operation } = makeRecessedFloorProject(side)

  const levels = resolveLevels(project, operation)
  assert(hasLevelAt(levels, RECESS_FLOOR_Z),
    `a ${(side * side).toFixed(3)} mm^2 plateau clears the `
    + `${(Math.PI * TOOL_RADIUS * TOOL_RADIUS).toFixed(3)} mm^2 bound but Z=${RECESS_FLOOR_Z} lost its level — `
    + 'a genuine floor would be left proud')
  assert(criticalZs(levels).some((z) => Math.abs(z - RECESS_FLOOR_Z) < 1e-6),
    `Z=${RECESS_FLOOR_Z} must carry isCriticalFloorLevel, or 3D cleanup skips its floor pass`)
}

/**
 * The two straddle fixtures differ by 0.25 mm of plateau side either side of
 * the boundary. This pins that the boundary is where the tool says it is, not
 * merely somewhere between them.
 */
function test_the_bound_tracks_stock_to_leave_radial(): void {
  const side = 2.95
  const area = side * side
  // Enough radial leave to push `PI * (radius + leave)^2` past the plateau the
  // bare tool cleared.
  const leave = 0.2
  assert(Math.PI * (TOOL_RADIUS + leave) ** 2 > area && Math.PI * TOOL_RADIUS ** 2 < area,
    'the fixture must clear the bare-tool bound and fail the stock-to-leave one')

  const { project, operation } = makeRecessedFloorProject(side, leave)
  const levels = resolveLevels(project, operation)
  assert(!hasLevelAt(levels, RECESS_FLOOR_Z),
    `with ${leave} mm radial stock to leave the cutter needs `
    + `${(Math.PI * (TOOL_RADIUS + leave) ** 2).toFixed(3)} mm^2 to sit on, more than the `
    + `${area.toFixed(3)} mm^2 plateau — Z=${RECESS_FLOOR_Z} should have lost its level`)
}

/**
 * A plateau whose vertices differ by less than `Z_TOLERANCE` is one level, so
 * its halves have to be one area too. Counted separately, each half here falls
 * under the bound the whole plateau clears, and a real floor would vanish.
 */
function test_a_plateau_split_below_z_tolerance_counts_once(): void {
  const side = 3.1
  const area = side * side
  const bound = Math.PI * TOOL_RADIUS * TOOL_RADIUS
  assert(area > bound && area / 2 < bound,
    `each half must fail the ${bound.toFixed(3)} mm^2 bound that the whole ${area.toFixed(3)} mm^2 plateau clears`)

  const { project, operation } = makeRecessedFloorProject(side, 0, 5e-7)
  const levels = resolveLevels(project, operation)
  assert(hasLevelAt(levels, RECESS_FLOOR_Z),
    `a plateau split across two Z values 5e-7 mm apart is one floor at Z=${RECESS_FLOOR_Z}; `
    + 'counting the halves separately dropped it')
}

function test_quantized_depth_map_collapses_to_the_stepdown(): void {
  const { project, operation } = makeQuantizedDepthMapProject()
  const topZ = gridCellZ(GRID_CELLS - 1, GRID_CELLS - 1)
  const plateauCount = GRID_CELLS * GRID_CELLS
  const plateauArea = GRID_CELL_SIZE * GRID_CELL_SIZE
  assert(plateauArea < Math.PI * TOOL_RADIUS * TOOL_RADIUS,
    `each cell must be too small for the cutter, got ${plateauArea} mm^2`)

  const stepLevels = generateStepLevels(topZ, 0, GRID_STEPDOWN)
  const levels = resolveLevels(project, operation)

  assert(levels.length <= stepLevels.length,
    `${plateauCount} quantized plateaus must not add levels: got ${levels.length} for a `
    + `${stepLevels.length}-level stepdown`)

  // The single genuine floor in the fixture survives the cull.
  const critical = criticalZs(levels)
  assert(critical.length === 1 && Math.abs(critical[0]) < 1e-6,
    `the flat back at Z=0 is the only machinable floor here; got critical Zs [${critical.map((z) => z.toFixed(4)).join(', ')}]`)

  for (let i = 0; i < GRID_CELLS; i += 1) {
    for (let j = 0; j < GRID_CELLS; j += 1) {
      const z = gridCellZ(i, j)
      assert(!critical.some((criticalZ) => Math.abs(criticalZ - z) < 1e-6),
        `quantization plateau Z=${z.toFixed(4)} became a critical floor level`)
    }
  }
}

// ── run ─────────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

const tests: Array<{ name: string; fn: () => void }> = [
  { name: 'a plateau under the tool disc earns no level', fn: test_plateau_under_the_tool_disc_earns_no_level },
  { name: 'a plateau over the tool disc keeps its level', fn: test_plateau_over_the_tool_disc_keeps_its_level },
  { name: 'the bound tracks stockToLeaveRadial', fn: test_the_bound_tracks_stock_to_leave_radial },
  { name: 'a plateau split below Z_TOLERANCE counts once', fn: test_a_plateau_split_below_z_tolerance_counts_once },
  { name: 'a quantized depth map collapses to the stepdown', fn: test_quantized_depth_map_collapses_to_the_stepdown },
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
