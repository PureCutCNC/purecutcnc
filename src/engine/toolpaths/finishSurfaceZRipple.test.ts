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
 * The height-map finishes give a pass a smooth Z, with no one-cell zigzag
 * (issue #1212).
 *
 * `safeToolTipZAt` reads each height-map cell as a point at its centre, so it
 * peaks over every centre and dips between them by up to `(cell / 2)^2 / 2R`.
 * Constant scallop's vertices fall alternately on centres and on cell edges,
 * so its passes alternated up and down by that much from one vertex to the
 * next: ±0.0003 in on the guitar top, which #1209's exact simulation shading
 * showed as a honeycomb. `smoothToolTipZAt` is the read the passes use now.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurfaceZRipple.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGuitarMesh } from '../../test/guitarTopFixture'
import { slopeTestMesh, surfaceTestProject, type SurfaceTestMesh } from '../../test/surfaceSlopeFixtures'
import { asSketchFeature, resolvedFeature } from '../../test/projectFixtures'
import { loadSTLTransformedGeometry } from '../csg'
import { generateFinishSurfaceToolpath } from './finishSurface'
import {
  buildHeightMap,
  chooseHeightMapCellSize,
  computeXYBounds,
  getCachedHeightMap,
  safeToolTipZAt,
  smoothToolTipZAt,
  type FinishSurfaceParallelCacheHost,
  type HeightMap,
} from './finishSurfaceParallel'
import { normalizeToolForProject } from './geometry'
import type { NormalizedTool, ToolpathMove } from './types'
import type { Operation, Project } from '../../types/project'

const DEG = Math.PI / 180
const ball = (diameter: number): NormalizedTool =>
  ({ type: 'ball_endmill', diameter, radius: diameter / 2 }) as NormalizedTool

/** The dip of a single-sample read halfway between two centres along a row. */
const rowDip = (cellSize: number, radius: number): number => (cellSize / 2) ** 2 / (2 * radius)

/** The single-sample read's deepest dip, at half a cell's diagonal: the cap on any raise. */
const diagonalDip = (cellSize: number, radius: number): number => {
  const h = cellSize * Math.SQRT1_2
  return radius - Math.sqrt(radius * radius - h * h)
}

function mapOf(mesh: SurfaceTestMesh, cellSize: number): HeightMap {
  return buildHeightMap(mesh.positions, mesh.index, computeXYBounds(mesh.positions), cellSize)
}

/**
 * The largest departure of a sampled line from straight: each interior sample
 * against the mean of its two neighbours. Samples a quarter cell apart land on
 * centres and on cell edges alike, so the single-sample read's dip shows in
 * full.
 */
function lineRoughness(read: (x: number, y: number) => number, x0: number, x1: number, y: number, step: number): number {
  const zs: number[] = []
  for (let x = x0; x <= x1 + 1e-9; x += step) zs.push(read(x, y))
  let worst = 0
  for (let i = 1; i + 1 < zs.length; i += 1) worst = Math.max(worst, Math.abs(zs[i] - (zs[i - 1] + zs[i + 1]) / 2))
  return worst
}

test('the smooth read is free of the cell ripple on a plane, at every slope, and never below the single-sample read', () => {
  const tool = ball(4)
  const cellSize = 0.4
  // 0 to 30 degrees. Above about atan(cell / 2R) = 5.7 degrees the
  // single-sample read is convex between centres, which is where the first
  // attempt at this fix (interpolating the centre reads) measured short.
  for (const degrees of [0, 3, 10, 20, 30]) {
    const slope = Math.tan(degrees * DEG)
    const map = mapOf(slopeTestMesh((x, y) => 2 + 0.4 * x * slope + 0.9 * y * slope, 40, 30, 1), cellSize)
    const safe = (x: number, y: number) => safeToolTipZAt(x, y, map, tool)
    const smooth = (x: number, y: number) => smoothToolTipZAt(x, y, map, tool)
    // Along X and diagonally, through the middle, clear of the mesh's skirt.
    for (const y of [14.95, 15.1, 15.2]) {
      const before = lineRoughness(safe, 10, 30, y, cellSize / 4)
      const after = lineRoughness(smooth, 10, 30, y, cellSize / 4)
      assert(before > rowDip(cellSize, tool.radius) / 4,
        `${degrees} deg, y ${y}: the single-sample read shows no ripple (${before.toFixed(5)}), so this proves nothing`)
      // Sampling three times per cell side leaves the dip of a lattice a third
      // as fine, which a slope stretches by about 1 / cos^3: 0.0017 mm here
      // at 30 degrees, against 0.0073 for the single-sample read.
      const bound = rowDip(cellSize / 3, tool.radius) / Math.cos(degrees * DEG) ** 3
      assert(after <= bound * 1.15 && after <= before / 3,
        `${degrees} deg, y ${y}: the smooth read still ripples by ${after.toFixed(5)} (single-sample ${before.toFixed(5)})`)
    }
    for (let x = 10; x <= 30; x += 0.037) {
      for (let y = 10; y <= 20; y += 0.091) {
        const direct = safe(x, y)
        const raised = smooth(x, y)
        assert(raised >= direct, `${degrees} deg (${x}, ${y}): smooth ${raised} is below the single-sample read ${direct}`)
        assert(raised - direct <= diagonalDip(cellSize, tool.radius) + 1e-12,
          `${degrees} deg (${x}, ${y}): raised ${raised - direct} past the dip bound`)
      }
    }
  }
})

test('beside a vertical wall the smooth read keeps the floor: its raise is capped at the dip bound', () => {
  const tool = ball(4)
  const cellSize = 0.4
  // A 6 mm step at x = 20: a ball standing beside it sits on the floor until
  // its sphere reaches the top edge. Interpolating the step's cell would make
  // a ramp across it; the cap keeps the pass from riding up that ramp.
  const map = mapOf(slopeTestMesh((x) => (x < 20 ? 2 : 8), 40, 30, 0.25), cellSize)
  let raisedSomewhere = false
  for (let x = 14; x <= 26; x += 0.013) {
    const direct = safeToolTipZAt(x, 15.1, map, tool)
    const raised = smoothToolTipZAt(x, 15.1, map, tool)
    assert(raised >= direct)
    assert(raised - direct <= diagonalDip(cellSize, tool.radius) + 1e-12,
      `x ${x.toFixed(3)}: raised ${(raised - direct).toFixed(5)} above the single-sample read beside the wall`)
    if (raised - direct > 1e-6) raisedSomewhere = true
  }
  assert(raisedSomewhere, 'the smooth read never differs here, so the cap is untested')
})

test('a flat end mill keeps the single-sample read', () => {
  const tool = { type: 'flat_endmill', diameter: 4, radius: 2 } as NormalizedTool
  const map = mapOf(slopeTestMesh((x, y) => 2 + 0.2 * x + 0.1 * y, 40, 30, 1), 0.4)
  for (let x = 10; x <= 30; x += 0.11) {
    assert.equal(smoothToolTipZAt(x, 15.3, map, tool), safeToolTipZAt(x, 15.3, map, tool))
  }
})

test('for a ball and a V-bit, across map edges and uncovered cells, the smooth read is never below the single-sample read nor past the cap', () => {
  // A dome on a ramp, rasterised into a map three cells wider than the mesh on
  // every side, so the border cells hold no model (-Infinity) and sub-samples
  // there have non-finite corners. The sweep runs from outside the map, over
  // its edge and its empty border, onto the model.
  const cellSize = 0.4
  const mesh = slopeTestMesh((x, y) => {
    const dx = (x - 15) / 12, dy = (y - 10) / 8
    return 2 + 0.2 * x + 4 * Math.max(0, 1 - dx * dx - dy * dy)
  }, 30, 20, 1)
  const meshBounds = computeXYBounds(mesh.positions)
  const pad = 3 * cellSize
  const map = buildHeightMap(mesh.positions, mesh.index, {
    minX: meshBounds.minX - pad, maxX: meshBounds.maxX + pad, minY: meshBounds.minY - pad, maxY: meshBounds.maxY + pad,
  }, cellSize)
  const tools: Array<{ label: string; tool: NormalizedTool; cap: number }> = [
    { label: 'ball', tool: ball(4), cap: diagonalDip(cellSize, 2) },
    {
      label: '90-degree V-bit',
      tool: { type: 'v_bit', diameter: 4, radius: 2, vBitAngle: 90 } as NormalizedTool,
      cap: cellSize * Math.SQRT1_2 / Math.tan(45 * DEG),
    },
  ]
  for (const { label, tool, cap } of tools) {
    let raised = 0
    let raisedNearEdge = 0
    let offModel = 0
    for (let x = meshBounds.minX - pad - 1; x <= meshBounds.maxX + pad + 1; x += 0.057) {
      for (let y = meshBounds.minY - pad - 1; y <= meshBounds.maxY + pad + 1; y += 0.149) {
        const direct = safeToolTipZAt(x, y, map, tool)
        const smooth = smoothToolTipZAt(x, y, map, tool)
        if (!Number.isFinite(direct)) {
          assert.equal(smooth, direct, `${label} (${x}, ${y}): no model under the tool, yet the smooth read is ${smooth}`)
          offModel += 1
          continue
        }
        assert(smooth >= direct, `${label} (${x}, ${y}): smooth ${smooth} is below the single-sample read ${direct}`)
        assert(smooth - direct <= cap + 1e-12, `${label} (${x}, ${y}): raised ${smooth - direct}, past the cap ${cap}`)
        if (smooth > direct) {
          raised += 1
          const nearEdge = x < meshBounds.minX + 2 * cellSize || x > meshBounds.maxX - 2 * cellSize
            || y < meshBounds.minY + 2 * cellSize || y > meshBounds.maxY - 2 * cellSize
          if (nearEdge) raisedNearEdge += 1
        }
      }
    }
    assert(offModel > 0, `${label}: the sweep never left the model, so the empty border is untested`)
    assert(raised > 0, `${label}: the smooth read never differs, so this proves nothing`)
    assert(raisedNearEdge > 0, `${label}: nothing is raised near the model's edge, so the non-finite corners are untested`)
  }
})

interface PassStats {
  vertices: number
  alternating: number
}

/**
 * Along every run of joined cut moves: how many interior vertices sit off the
 * straight line between their neighbours (by XY distance) by more than
 * `threshold`, with the opposite sign to the vertex before. That alternation is
 * the zigzag; a curved pass bends one way for many vertices in a row.
 */
function passStats(moves: ToolpathMove[], threshold: number): PassStats {
  const cuts = moves.filter((move) => move.kind === 'cut')
  let vertices = 0
  let alternating = 0
  let previous: number | null = null
  for (let i = 1; i < cuts.length; i += 1) {
    const a = cuts[i - 1]
    const b = cuts[i]
    if (a.to.x !== b.from.x || a.to.y !== b.from.y) { previous = null; continue }
    const l1 = Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y)
    const l2 = Math.hypot(b.to.x - b.from.x, b.to.y - b.from.y)
    if (l1 < 1e-9 || l2 < 1e-9) { previous = null; continue }
    const residual = a.to.z - (a.from.z + (b.to.z - a.from.z) * l1 / (l1 + l2))
    vertices += 1
    if (previous !== null && previous * residual < 0 && Math.abs(previous) > threshold && Math.abs(residual) > threshold) {
      alternating += 1
    }
    previous = residual
  }
  return { vertices, alternating }
}

/**
 * The height map a strategy itself reads, out of the mesh's own cache, given
 * the cell size that strategy asks for from its tool and pass spacing.
 */
function strategyMap(project: Project, requestCell: (radius: number) => number) {
  const mesh = loadSTLTransformedGeometry(asSketchFeature(resolvedFeature(project, 'hills-model')), project)!
  const tool = normalizeToolForProject(project.tools[0], project)
  const bounds = computeXYBounds(mesh.positions)
  const cellSize = chooseHeightMapCellSize(bounds, Math.max(1e-6, requestCell(tool.radius)), [])
  return { tool, map: getCachedHeightMap(mesh as FinishSurfaceParallelCacheHost, mesh.positions, mesh.index, bounds, cellSize) }
}

/** Every cut vertex at or above the single-sample read, exactly; returns how many sit strictly above it. */
function assertNeverBelow(moves: ToolpathMove[], map: HeightMap, tool: NormalizedTool, label: string): number {
  let above = 0
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    const floor = safeToolTipZAt(move.to.x, move.to.y, map, tool)
    // Exactly: the smooth read reproduces the single-sample one bit for bit
    // before raising it, so not even a rounding error may put a vertex lower.
    assert(move.to.z >= floor, `${label}: a vertex at (${move.to.x}, ${move.to.y}) is ${floor - move.to.z} below the cutter-location read`)
    if (move.to.z > floor) above += 1
  }
  return above
}

function assertSmoothPasses(project: Project, operation: Operation, label: string): void {
  const result = generateFinishSurfaceToolpath({ ...project, operations: [operation] }, operation)
  const spacing = (operation.stepover ?? 0.5) * project.tools[0].diameter
  const { tool, map } = strategyMap(project, (radius) => Math.min(radius / 5, spacing))
  const threshold = rowDip(map.cellSize, tool.radius) / 2
  const stats = passStats(result.moves, threshold)
  assert(stats.vertices > 1000, `${label}: only ${stats.vertices} pass vertices`)
  // Before #1212, at this threshold: 44 % of vertices on the dome, 56 % on
  // the guitar top. After: 0.5 % and 2.3 %, the rest at real creases of the
  // 1 mm mesh rather than at the height map's cells.
  const share = stats.alternating / stats.vertices
  assert(share < 0.04, `${label}: ${(share * 100).toFixed(1)} % of pass vertices zigzag by more than ${threshold.toFixed(5)}`)
  // Never below the single-sample read: the smooth read only ever raises.
  assertNeverBelow(result.moves, map, tool, label)
}

test('parallel passes are never below the single-sample read, and are raised where it dipped', () => {
  // Parallel reads its own, finer map (`min(r/3, stepover/2)`) and seeds each
  // point with the raw height before `applyGougeProtection` raises it.
  const surface = (x: number, y: number): number => {
    const dx = (x - 30) / 26, dy = (y - 20) / 17
    return 2 + 0.15 * x + 7 * Math.max(0, 1 - dx * dx - dy * dy)
  }
  const { project, operation } = surfaceTestProject(slopeTestMesh(surface, 60, 40, 1), 4)
  const op: Operation = { ...operation, pocketPattern: 'parallel', pocketAngle: 0, stepover: 0.15 }
  const result = generateFinishSurfaceToolpath({ ...project, operations: [op] }, op)
  const stepoverDistance = 0.15 * project.tools[0].diameter
  const { tool, map } = strategyMap(project, (radius) => Math.min(radius / 3, stepoverDistance * 0.5))
  const above = assertNeverBelow(result.moves, map, tool, 'parallel dome on a ramp')
  assert(above > 100, `only ${above} parallel vertices sit above the single-sample read, so the smooth read is not in use`)
})

test('constant scallop passes on a synthetic carved surface have a smooth Z', () => {
  // A tilted dome on a ramp: slopes from 0 to about 25 degrees in every
  // direction, so passes cross the height map at every angle.
  const surface = (x: number, y: number): number => {
    const dx = (x - 30) / 26, dy = (y - 20) / 17
    return 2 + 0.15 * x + 7 * Math.max(0, 1 - dx * dx - dy * dy)
  }
  const { project, operation } = surfaceTestProject(slopeTestMesh(surface, 60, 40, 1), 4)
  assertSmoothPasses(project, { ...operation, pocketPattern: 'constant_scallop', stepover: 0.15 }, 'dome on a ramp')
})

test('constant scallop passes on the carved guitar top have a smooth Z', () => {
  // The procedural #697 carved top under a 6 mm ball: the shape behind the
  // honeycomb on the guitar project, at the 20 um cusp spacing.
  const { project, operation } = surfaceTestProject(buildGuitarMesh({ cell: 1 }), 6)
  const stepover = 2 * Math.sqrt(2 * 3 * 0.02 - 0.02 ** 2) / 6
  assertSmoothPasses(project, { ...operation, pocketPattern: 'constant_scallop', stepover }, 'guitar top')
})
