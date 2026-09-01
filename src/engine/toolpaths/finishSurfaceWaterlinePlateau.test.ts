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
 * Waterline finish over a flat top (issue #699).
 *
 * The bug these guard against: a ring only started a tip fill when it had shrunk
 * by 30 % from the level below, and a plateau does not shrink. Nothing else
 * covers the inside of a feature's topmost contour — `emitProjectedBandFill`
 * only ever fills the annulus *between* two contours — so every flat top in the
 * model came out untouched, with no warning. On the hills fixture that was
 * 16.2 % of the flat surface area; on the mesa below it is the whole plateau.
 *
 * Measured on this fixture with the shipped gate restored: 0 cut samples inside
 * the 8 x 8 mm plateau and 0 % of it swept, against 2,146 samples and 100 % with
 * the fix. The small mesa is the other side of the rule — with the reachability
 * test dropped it collects 304 samples inside a top the cutter is not allowed to
 * stand on, and none with it in place.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurfaceWaterlinePlateau.test.ts
 */

import type { Operation, Project } from '../../types/project'
import type { ToolpathMove } from './types'
import { criticalWaterlineFloorZs, generateFinishSurfaceToolpath } from './finishSurface'
import { normalizeToolForProject } from './geometry'
import { loadSTLTransformedGeometry } from '../csg'
import { asSketchFeature, resolvedFeature } from '../../test/projectFixtures'
import {
  mesaCentre,
  mesaWaterlineProject,
  resolveMesaOptions,
  type MesaProjectOptions,
} from '../../test/waterlineMesaFixture'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** A plateau big enough to stand the 3 mm ball on: 64 mm^2 against PI * 1.5^2. */
const REACHABLE: MesaProjectOptions = { topHalf: 4 }
/** Under the bound, so #682/#685 rule it out: 5.76 mm^2 against PI * 1.5^2. */
const UNREACHABLE: MesaProjectOptions = { topHalf: 1.2 }

/** Keep the tool centre clear of the plateau rim, where a wall ring belongs. */
const RIM_MARGIN = 0.2

interface PlateauPass {
  /** Cut-move samples whose tool centre lies inside the plateau footprint. */
  insideSamples: number
  /** Z range of those samples. */
  insideZ: { min: number; max: number }
  /** Share of the plateau the cutter body passes over. */
  sweptCoverage: number
  moves: ToolpathMove[]
}

/**
 * Walk the emitted move stream over the plateau.
 *
 * Two different questions, and the fix has to answer both: does the cutter ever
 * travel *inside* the top (a ring around the mesa runs one tool radius outside
 * it, so this is zero unless something fills the top), and does what it emits
 * actually cover the top. Coverage is swept in XY on the same model
 * `finishSurfaceWaterlineBudget.test.ts` uses — a cell counts when some cut move
 * puts the cutter body over it.
 */
function measurePlateau(project: Project, operation: Operation, options: MesaProjectOptions): PlateauPass {
  const o = resolveMesaOptions(options)
  const centre = mesaCentre(options)
  const tool = normalizeToolForProject(project.tools[0], project)
  const result = generateFinishSurfaceToolpath(project, operation)

  const cell = 0.2
  const cells = Math.floor((2 * o.topHalf) / cell)
  const covered = new Uint8Array(cells * cells)
  const originX = centre.x - o.topHalf
  const originY = centre.y - o.topHalf
  const mark = (x: number, y: number): void => {
    const colStart = Math.max(0, Math.floor((x - originX - tool.radius) / cell))
    const colEnd = Math.min(cells - 1, Math.ceil((x - originX + tool.radius) / cell))
    const rowStart = Math.max(0, Math.floor((y - originY - tool.radius) / cell))
    const rowEnd = Math.min(cells - 1, Math.ceil((y - originY + tool.radius) / cell))
    for (let row = rowStart; row <= rowEnd; row += 1) {
      for (let col = colStart; col <= colEnd; col += 1) {
        const px = originX + (col + 0.5) * cell
        const py = originY + (row + 0.5) * cell
        if (Math.hypot(px - x, py - y) > tool.radius) continue
        covered[row * cells + col] = 1
      }
    }
  }

  let insideSamples = 0
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    const span = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    const steps = Math.max(1, Math.ceil(span / (cell * 0.5)))
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps
      const x = move.from.x + (move.to.x - move.from.x) * t
      const y = move.from.y + (move.to.y - move.from.y) * t
      mark(x, y)
      if (Math.abs(x - centre.x) > o.topHalf - RIM_MARGIN) continue
      if (Math.abs(y - centre.y) > o.topHalf - RIM_MARGIN) continue
      insideSamples += 1
      const z = move.from.z + (move.to.z - move.from.z) * t
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
  }

  let sweptCells = 0
  for (const value of covered) sweptCells += value
  return {
    insideSamples,
    insideZ: { min: minZ, max: maxZ },
    sweptCoverage: sweptCells / (cells * cells),
    moves: result.moves,
  }
}

/**
 * What the engine thinks of the fixture's top, so a fixture that drifts fails
 * here rather than turning one of the assertions below into a tautology.
 */
function plateauIsCritical(project: Project, options: MesaProjectOptions): boolean {
  const o = resolveMesaOptions(options)
  const stl = loadSTLTransformedGeometry(asSketchFeature(resolvedFeature(project, 'mesa-model')), project)
  if (!stl) throw new Error('mesa mesh failed to load')
  const tool = normalizeToolForProject(project.tools[0], project)
  const floors = criticalWaterlineFloorZs(stl.positions, stl.index, tool.radius)
  return [...floors].some((z) => Math.abs(z - o.topZ) <= 1e-6)
}

function testReachablePlateauTopIsMachined(): void {
  console.log('Testing a flat top at a critical floor Z is machined...')
  const { project, operation } = mesaWaterlineProject(REACHABLE)
  const o = resolveMesaOptions(REACHABLE)
  assert(plateauIsCritical(project, REACHABLE),
    'expected the 8 x 8 mm plateau to clear the reachable-floor bound')

  const pass = measurePlateau(project, operation, REACHABLE)
  console.log(`  ${pass.insideSamples} cut samples inside the plateau at z `
    + `${pass.insideZ.min.toFixed(3)}..${pass.insideZ.max.toFixed(3)}, `
    + `${(pass.sweptCoverage * 100).toFixed(1)}% of it swept`)

  // The defect, stated on the move stream: with the shrink gate the tool centre
  // never entered the plateau at all, because the only ring at its Z was the
  // wall contour one tool radius outside it.
  assert(pass.insideSamples > 0,
    'expected cutting moves inside the plateau footprint, got none — the flat top was skipped')
  assert(pass.insideZ.min > o.topZ - 0.05 && pass.insideZ.max <= o.topZ + 1e-6,
    `expected those moves to cut at the plateau height ${o.topZ}, got `
    + `${pass.insideZ.min.toFixed(3)}..${pass.insideZ.max.toFixed(3)}`)
  assert(pass.sweptCoverage > 0.99,
    `expected the plateau to be covered, got ${(pass.sweptCoverage * 100).toFixed(1)}%`)
}

function testUnreachablePlateauTopIsLeftAlone(): void {
  console.log('Testing a flat top too small to reach is still left alone...')
  const { project, operation } = mesaWaterlineProject(UNREACHABLE)
  assert(!plateauIsCritical(project, UNREACHABLE),
    'expected the 2.4 x 2.4 mm plateau to fall under the reachable-floor bound')

  const pass = measurePlateau(project, operation, UNREACHABLE)
  console.log(`  ${pass.insideSamples} cut samples inside the plateau, `
    + `${(pass.sweptCoverage * 100).toFixed(1)}% of it swept, ${pass.moves.length} moves total`)

  // The reachability rule #682/#685 established, which this fix inherits rather
  // than replaces: a plateau under PI * r^2 is surrounded within a tool radius
  // by material higher than itself, so a pass at its Z machines nothing the ring
  // above did not already machine. Relaxing the gate without that test puts 304
  // samples in here.
  assert(pass.insideSamples === 0,
    `expected no cutting moves inside a plateau the cutter cannot stand on, got ${pass.insideSamples}`)
}

testReachablePlateauTopIsMachined()
testUnreachablePlateauTopIsLeftAlone()

console.log('finishSurfaceWaterlinePlateau tests passed')
