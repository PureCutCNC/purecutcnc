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
 * The waterline adaptive-refinement budget (issue #698).
 *
 * The bug these guard against: the refinement budget was a single global ring
 * counter spent from the top of the model down, so a *finer* Adaptive spacing
 * produced *worse* coverage — halving the spacing doubled what each band
 * consumed, the counter ran out higher up, and everything below it was left
 * uncut. On the hills fixture the share of flat area never cut ran
 * 14.3 / 14.3 / 16.2 / 33.9 % at 1.20 / 0.60 / 0.30 / 0.15 mm.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurfaceWaterlineBudget.test.ts
 */

import type { Operation, Project, SketchFeature } from '../../types/project'
import type { ToolpathMove } from './types'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { normalizeToolForProject } from './geometry'
import { computeXYBounds, getCachedHeightMap, type FinishSurfaceParallelCacheHost } from './finishSurfaceParallel'
import { loadSTLTransformedGeometry } from '../csg'
import { asSketchFeature, resolvedFeature } from '../../test/projectFixtures'
import { hillsWaterlineProject, type HillsProjectOptions } from '../../test/waterlineHillsFixture'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/**
 * A small hills mesh. Coarse enough to run four times in a unit test, fine
 * enough that the flat background and the dome flanks are still distinct.
 */
const FIXTURE: HillsProjectOptions = { spanX: 60, spanY: 45, cell: 1.2, plateauZ: 10, stepdown: 1 }

/** Slope below which a cell counts as flat, matching the probe's first band. */
const FLAT_DEGREES = 5

interface Coverage {
  /** Fraction of flat surface cells no cut move passes over. */
  flatNeverCut: number
  flatCells: number
  moves: number
  warnings: string[]
  result: ReturnType<typeof generateFinishSurfaceToolpath>
}

/**
 * Share of the flat surface that receives no cutting pass at all.
 *
 * Coverage is measured in XY — a cell counts as cut when some cut move puts the
 * cutter body over it — because "never cut" is about stock the pass never
 * reaches, not about how well it is finished. It is the same metric as
 * `scripts/waterline-coverage-probe.ts`, on a coarser grid.
 */
function measureFlatCoverage(project: Project, operation: Operation): Coverage {
  const feature: SketchFeature = asSketchFeature(resolvedFeature(project, 'hills-model'))
  const stl = loadSTLTransformedGeometry(feature, project)
  if (!stl) throw new Error('hills mesh failed to load')
  const tool = normalizeToolForProject(project.tools[0], project)
  const cell = tool.radius / 3
  const bbox = computeXYBounds(stl.positions)
  const heightMap = getCachedHeightMap(
    stl as FinishSurfaceParallelCacheHost,
    stl.positions,
    stl.index,
    bbox,
    cell,
  )
  const { width, height, data } = heightMap

  const result = generateFinishSurfaceToolpath(project, operation)
  const covered = new Uint8Array(width * height)
  const reach = Math.ceil(tool.radius / cell)
  const mark = (x: number, y: number): void => {
    const col = Math.round((x - heightMap.originX) / cell)
    const row = Math.round((y - heightMap.originY) / cell)
    for (let r = Math.max(0, row - reach); r <= Math.min(height - 1, row + reach); r += 1) {
      for (let c = Math.max(0, col - reach); c <= Math.min(width - 1, col + reach); c += 1) {
        if (Math.hypot(c - col, r - row) * cell > tool.radius) continue
        covered[r * width + c] = 1
      }
    }
  }
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    const span = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    const steps = Math.max(1, Math.ceil(span / (cell * 0.5)))
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps
      mark(move.from.x + (move.to.x - move.from.x) * t, move.from.y + (move.to.y - move.from.y) * t)
    }
  }

  const flatLimit = Math.tan((FLAT_DEGREES * Math.PI) / 180)
  let flatCells = 0
  let flatMissed = 0
  for (let row = 1; row < height - 1; row += 1) {
    for (let col = 1; col < width - 1; col += 1) {
      const at = row * width + col
      const here = data[at]
      const left = data[at - 1]
      const right = data[at + 1]
      const down = data[at - width]
      const up = data[at + width]
      if (![here, left, right, down, up].every((z) => Number.isFinite(z))) continue
      const gradient = Math.hypot((right - left) / (2 * cell), (up - down) / (2 * cell))
      if (gradient >= flatLimit) continue
      flatCells += 1
      if (!covered[at]) flatMissed += 1
    }
  }

  return {
    flatNeverCut: flatCells > 0 ? flatMissed / flatCells : 0,
    flatCells,
    moves: result.moves.length,
    warnings: result.warnings.map((warning) => warning.code),
    result,
  }
}

// Generating a waterline finish is the expensive part of this file, and several
// of the assertions below want the same run, so each configuration is generated
// once.
const runs = new Map<string, Coverage>()

function runAtSpacing(spacing: number, overrides: Partial<Operation> = {}): Coverage {
  const key = `${spacing}|${JSON.stringify(overrides)}`
  const cached = runs.get(key)
  if (cached) return cached
  const { project, operation } = hillsWaterlineProject({ ...FIXTURE, microStepover: spacing })
  const patched: Operation = { ...operation, ...overrides }
  project.operations = [patched]
  const coverage = measureFlatCoverage(project, patched)
  runs.set(key, coverage)
  return coverage
}

function testFinerSpacingNeverLosesCoverage(): void {
  console.log('Testing finer Adaptive spacing never loses flat-surface coverage...')
  const spacings = [1.2, 0.6, 0.3, 0.15]
  const measured = spacings.map((spacing) => ({ spacing, ...runAtSpacing(spacing) }))
  const report = measured
    .map((row) => `${row.spacing}mm ${(row.flatNeverCut * 100).toFixed(1)}%`)
    .join(', ')
  console.log(`  flat never cut: ${report} (${measured[0].flatCells} flat cells)`)

  for (let i = 1; i < measured.length; i += 1) {
    const coarser = measured[i - 1]
    const finer = measured[i]
    // Equal is fine — the hills fixture has a floor of flat plateau tops that no
    // spacing reaches (issue #699). What must never happen is the finer setting
    // covering *less*, which is what the top-down ring counter produced.
    assert(finer.flatNeverCut <= coarser.flatNeverCut + 1e-9,
      `expected ${finer.spacing}mm to cover at least as much flat area as ${coarser.spacing}mm, `
      + `got ${(finer.flatNeverCut * 100).toFixed(1)}% never cut against `
      + `${(coarser.flatNeverCut * 100).toFixed(1)}% — ${report}`)
  }

  // A guard on the guard: if the fixture ever stops having uncut flat area to
  // lose, the monotonicity assertion above becomes vacuous.
  assert(measured[0].flatNeverCut > 0.02,
    `expected the coarsest spacing to leave measurable uncut flat area, got ${(measured[0].flatNeverCut * 100).toFixed(1)}%`)
}

function projectedCuts(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move) => (
    move.kind === 'cut' && (move.source === 'projectedBand' || move.source === 'projectedCap')
  ))
}

/** Share of the refinement that lands in the lowest quarter of the Z range. */
function bottomBandShare(coverage: Coverage): number {
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const move of coverage.result.moves) {
    if (move.kind !== 'cut') continue
    minZ = Math.min(minZ, move.from.z, move.to.z)
    maxZ = Math.max(maxZ, move.from.z, move.to.z)
  }
  const bottomBand = minZ + (maxZ - minZ) * 0.25
  const cuts = projectedCuts(coverage.result.moves)
  if (cuts.length === 0) return 0
  let low = 0
  for (const move of cuts) {
    if (Math.min(move.from.z, move.to.z) <= bottomBand) low += 1
  }
  return low / cuts.length
}

function testRefinementIsNotSpentTopDown(): void {
  console.log('Testing a finer spacing does not push the refinement up the model...')
  const coarse = bottomBandShare(runAtSpacing(0.6))
  const fine = bottomBandShare(runAtSpacing(0.15))
  console.log(`  refinement in the lowest quarter: 0.6mm ${(coarse * 100).toFixed(1)}%, `
    + `0.15mm ${(fine * 100).toFixed(1)}%`)

  assert(coarse > 0.05,
    `expected the coarse run to put real refinement low on the model, got ${(coarse * 100).toFixed(1)}%`)
  // The defect, stated as a distribution: the budget was spent from the top of
  // the model down, so making the spacing finer doubled what the high bands
  // consumed and the bottom of the model got a shrinking share of it — down to
  // none at all. An allocation priced before it is spent cannot drift this way.
  assert(fine >= coarse * 0.75,
    `expected a finer spacing to keep refining the bottom of the model, `
    + `got ${(fine * 100).toFixed(1)}% of projected cuts in the lowest quarter against `
    + `${(coarse * 100).toFixed(1)}% at 0.6mm`)
}

function testBudgetIsSilentWhenItDoesNotBind(): void {
  console.log('Testing a project inside its budget raises no budget warning...')
  for (const spacing of [0.6, 0.15]) {
    const run = runAtSpacing(spacing)
    assert(!run.warnings.includes('waterlineRefinementCoarsened'),
      `expected no coarsening warning at ${spacing}mm, got ${JSON.stringify(run.warnings)}`)
    assert(!run.warnings.includes('waterlineRefinementTruncated'),
      `expected no truncation warning at ${spacing}mm, got ${JSON.stringify(run.warnings)}`)
  }
}

function coarsenedSpacing(warnings: Array<{ code: string; params?: Record<string, unknown> }>): {
  requested: number
  effective: number
} {
  const warning = warnings.find((candidate) => candidate.code === 'waterlineRefinementCoarsened')
  if (!warning) throw new Error(`expected waterlineRefinementCoarsened, got ${JSON.stringify(warnings.map((w) => w.code))}`)
  return {
    requested: Number(warning.params?.requested),
    effective: Number(warning.params?.effective),
  }
}

function testOverBudgetCoarseningIsProportionalAndAnnounced(): void {
  console.log('Testing an over-budget refinement is coarsened proportionally and says so...')
  // Halving the stepdown doubles the coarse level count, which is what pushes
  // this fixture's refinement demand past its coverage budget.
  const over = { stepdown: 0.25 }
  const coarse = runAtSpacing(0.3, over)
  const fine = runAtSpacing(0.15, over)

  const coarseSpacing = coarsenedSpacing(coarse.result.warnings)
  const fineSpacing = coarsenedSpacing(fine.result.warnings)
  console.log(`  coarsened ${coarseSpacing.requested} -> ${coarseSpacing.effective} `
    + `and ${fineSpacing.requested} -> ${fineSpacing.effective}`)

  assert(coarseSpacing.effective > coarseSpacing.requested,
    'expected the reported effective spacing to be coarser than the requested one')

  // The property that makes the response to Adaptive spacing monotone: the
  // budget scales the requested spacing by a factor that is a property of the
  // model, so halving the request halves what is actually machined. A budget
  // that did not do this is what made a finer setting produce a worse surface.
  const ratio = fineSpacing.effective / coarseSpacing.effective
  assert(Math.abs(ratio - 0.5) < 0.05,
    `expected halving the requested spacing to halve the effective one, got a ratio of ${ratio.toFixed(4)} `
    + `(${coarseSpacing.effective} -> ${fineSpacing.effective})`)

  assert(fine.flatNeverCut <= coarse.flatNeverCut + 1e-9,
    `expected the finer setting to cover at least as much flat area over budget too, `
    + `got ${(fine.flatNeverCut * 100).toFixed(1)}% against ${(coarse.flatNeverCut * 100).toFixed(1)}%`)
}

testFinerSpacingNeverLosesCoverage()
testRefinementIsNotSpentTopDown()
testBudgetIsSilentWhenItDoesNotBind()
testOverBudgetCoarseningIsProportionalAndAnnounced()

console.log('finishSurfaceWaterlineBudget tests passed')
