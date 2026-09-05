/**
 * Surface-finish coverage and scallop probe (issues #697, #698, #699, #705).
 *
 * Answers the question a move count cannot: how much material does the emitted
 * pass actually leave on the model, and *where* — sorted by surface slope, which
 * is the axis a constant-Z strategy is uneven on.
 *
 * Method, all in project units:
 *
 *   ideal(x,y)   the surface a perfect, infinitely dense pass with this tool
 *                would leave: the lower envelope of the cutter swept over every
 *                reachable tool-tip position. Reachability is the engine's own
 *                `safeToolTipZAt`, so a valley narrower than the cutter is
 *                charged to the tool, not to the strategy.
 *   cut(x,y)     the same lower envelope, swept only along the cut moves this
 *                operation actually emitted.
 *   scallop      cut - ideal, >= 0 by construction.
 *
 * A cell the pass never passes over is not a scallop, it is a hole, and is
 * counted separately as `miss%` — that column is the one #698 is about.
 *
 * Usage:
 *
 *   npx tsx scripts/waterline-coverage-probe.ts
 *       Sweep Adaptive spacing on the synthetic hills fixture. This is #698's
 *       first acceptance criterion: `miss%` in the flat band must not rise as
 *       the spacing gets finer.
 *
 *   npx tsx scripts/waterline-coverage-probe.ts --project <file.camj> --operation <id>
 *       Measure a real project instead. Add --spacing to override the
 *       operation's Adaptive spacing, repeatable to sweep it.
 *
 *   npx tsx scripts/waterline-coverage-probe.ts --fixture guitar \
 *     --pattern constant_scallop --tolerance 0.02
 *       Run #705's tracked guitar-top acceptance: a 6 mm ball at the 20 um
 *       cusp spacing on the carved top, which must hold p90 <= 0.020 mm and
 *       over% <= 10 across the combined 0-20 degree band with no unmachined
 *       area. For parallel and constant scallop, --spacing is the absolute
 *       pass spacing and is converted to the persisted Stepover ratio; with no
 *       --spacing the guitar runs at that cusp spacing.
 *
 * Options:
 *   --spacing <n>        Adaptive spacing to run, repeatable (project units)
 *   --stepdown <n>       override the operation stepdown
 *   --cell-divisor <n>   probe grid cells per tool radius (6, guitar 10)
 *   --tolerance <n>      finish budget for the over% column (default r/50)
 *   --pattern <name>     force a pocket pattern, e.g. parallel, for comparison
 *   --fixture <name>     synthetic fixture: hills (default) or guitar
 */

import { readFileSync } from 'node:fs'
import { normalizeProject } from '../src/store/helpers/projectFormat'
import { generateFinishSurfaceToolpath } from '../src/engine/toolpaths/finishSurface'
import { normalizeToolForProject } from '../src/engine/toolpaths/geometry'
import { splitFeatureTargets } from '../src/engine/toolpaths/regions'
import { loadSTLTransformedGeometry } from '../src/engine/csg'
import {
  computeXYBounds,
  getCachedHeightMap,
  safeToolTipZAt,
  type FinishSurfaceParallelCacheHost,
  type HeightMap,
} from '../src/engine/toolpaths/finishSurfaceParallel'
import { hillsWaterlineProject } from '../src/test/waterlineHillsFixture'
import { buildGuitarMesh } from '../src/test/guitarTopFixture'
import { surfaceTestProject } from '../src/test/surfaceSlopeFixtures'
import type { NormalizedTool, ToolpathMove } from '../src/engine/toolpaths/types'
import type { Operation, PocketPattern, Project, SketchFeature } from '../src/types/project'

interface Grid {
  width: number
  height: number
  originX: number
  originY: number
  cell: number
}

interface Band {
  label: string
  cells: number
  p50: number
  p90: number
  p99: number
  max: number
  missFraction: number
  overToleranceFraction: number
}

const SLOPE_BANDS = [
  { label: 'accept 0-20', minDeg: 0, maxDeg: 20 },
  { label: 'flat 0-5', minDeg: 0, maxDeg: 5 },
  { label: 'shallow 5-20', minDeg: 5, maxDeg: 20 },
  { label: 'medium 20-45', minDeg: 20, maxDeg: 45 },
  { label: 'steep 45-90', minDeg: 45, maxDeg: 90.1 },
]

function parseArgs(argv: string[]): {
  project?: string
  operation?: string
  spacings: number[]
  scallopHeight?: number
  stepdown?: number
  cellDivisor: number
  tolerance?: number
  pattern?: PocketPattern
  fixture: 'hills' | 'guitar'
} {
  const spacings: number[] = []
  let project: string | undefined
  let operation: string | undefined
  let scallopHeight: number | undefined
  let stepdown: number | undefined
  let cellDivisor: number | undefined
  let tolerance: number | undefined
  let pattern: PocketPattern | undefined
  let fixture: 'hills' | 'guitar' = 'hills'
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1]
    switch (argv[i]) {
      case '--project': project = value; i += 1; break
      case '--operation': operation = value; i += 1; break
      case '--spacing': spacings.push(Number(value)); i += 1; break
      case '--scallop-height': scallopHeight = Number(value); i += 1; break
      case '--stepdown': stepdown = Number(value); i += 1; break
      case '--cell-divisor': cellDivisor = Number(value); i += 1; break
      case '--tolerance': tolerance = Number(value); i += 1; break
      case '--pattern': pattern = value as PocketPattern; i += 1; break
      case '--fixture':
        if (value !== 'hills' && value !== 'guitar') throw new Error(`unknown fixture ${value}`)
        fixture = value
        i += 1
        break
      default: break
    }
  }
  // The guitar top defaults to a finer probe grid than everything else. The
  // grid sets the path sampling too (half its pitch), and on that fixture r/6
  // chords across curved constant-scallop contours: the *cut* envelope then
  // misses material the pass really removes and the residual is over-stated —
  // 0-20 degree p90 reads 0.0385 mm at r/6 against 0.0147 mm at r/10 for the
  // same toolpath. Every #697 guitar table was measured at r/10 for that
  // reason. An explicit --cell-divisor still wins.
  const defaultDivisor = fixture === 'guitar' ? 10 : 6
  return {
    project,
    operation,
    spacings,
    scallopHeight,
    stepdown,
    cellDivisor: cellDivisor ?? defaultDivisor,
    tolerance,
    pattern,
    fixture,
  }
}

function operationAtSpacing(
  operation: Operation,
  pattern: PocketPattern | undefined,
  spacing: number,
  toolDiameter: number,
  scallopHeight?: number,
): Operation {
  const selected = pattern ?? operation.pocketPattern
  return {
    ...operation,
    debugToolpath: true,
    ...(scallopHeight !== undefined ? { finishScallopHeight: scallopHeight } : {}),
    ...(pattern ? { pocketPattern: pattern } : {}),
    ...(selected === 'parallel' || selected === 'constant_scallop'
      ? { stepover: spacing / toolDiameter }
      : { waterlineMicroStepover: spacing }),
  }
}

/** Lower surface of the cutter as a drop per grid offset from its centre. */
function envelopeKernel(tool: NormalizedTool, cell: number): {
  reach: number
  size: number
  drop: Float32Array
} {
  const reach = Math.ceil(tool.radius / cell)
  const size = reach * 2 + 1
  const drop = new Float32Array(size * size)
  const isBall = tool.type === 'ball_endmill'
  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      const d = Math.hypot(dx, dy) * cell
      const at = (dy + reach) * size + (dx + reach)
      if (d > tool.radius) {
        drop[at] = Infinity
        continue
      }
      drop[at] = isBall ? tool.radius - Math.sqrt(Math.max(0, tool.radius * tool.radius - d * d)) : 0
    }
  }
  return { reach, size, drop }
}

function splat(
  field: Float32Array,
  grid: Grid,
  kernel: ReturnType<typeof envelopeKernel>,
  x: number,
  y: number,
  tipZ: number,
): void {
  const col = Math.round((x - grid.originX) / grid.cell)
  const row = Math.round((y - grid.originY) / grid.cell)
  const { reach, size, drop } = kernel
  for (let r = Math.max(0, row - reach); r <= Math.min(grid.height - 1, row + reach); r += 1) {
    const kernelRow = (r - row + reach) * size
    const fieldRow = r * grid.width
    for (let c = Math.max(0, col - reach); c <= Math.min(grid.width - 1, col + reach); c += 1) {
      const d = drop[kernelRow + (c - col + reach)]
      if (d === Infinity) continue
      const z = tipZ + d
      if (z < field[fieldRow + c]) field[fieldRow + c] = z
    }
  }
}

function idealSurface(tool: NormalizedTool, grid: Grid, heightMap: HeightMap): Float32Array {
  const kernel = envelopeKernel(tool, grid.cell)
  const field = new Float32Array(grid.width * grid.height).fill(Infinity)
  for (let row = 0; row < grid.height; row += 1) {
    const y = grid.originY + row * grid.cell
    for (let col = 0; col < grid.width; col += 1) {
      const x = grid.originX + col * grid.cell
      const tipZ = safeToolTipZAt(x, y, heightMap, tool)
      if (!Number.isFinite(tipZ)) continue
      splat(field, grid, kernel, x, y, tipZ)
    }
  }
  return field
}

function cutSurface(tool: NormalizedTool, grid: Grid, moves: ToolpathMove[]): Float32Array {
  const kernel = envelopeKernel(tool, grid.cell)
  const field = new Float32Array(grid.width * grid.height).fill(Infinity)
  const step = grid.cell * 0.5
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    const { from, to } = move
    const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
    const steps = Math.max(1, Math.ceil(length / step))
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps
      splat(field, grid, kernel,
        from.x + (to.x - from.x) * t,
        from.y + (to.y - from.y) * t,
        from.z + (to.z - from.z) * t)
    }
  }
  return field
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[at]
}

function measure(
  ideal: Float32Array,
  cut: Float32Array,
  grid: Grid,
  tolerance: number,
  missValue: number,
): { bands: Band[]; overall: Band } {
  const n = grid.width * grid.height
  const scallop = new Float32Array(n)
  const slopeDeg = new Float32Array(n)
  const inModel = new Uint8Array(n)

  for (let row = 0; row < grid.height; row += 1) {
    for (let col = 0; col < grid.width; col += 1) {
      const at = row * grid.width + col
      if (!Number.isFinite(ideal[at])) continue
      inModel[at] = 1
      scallop[at] = Number.isFinite(cut[at]) ? Math.max(0, cut[at] - ideal[at]) : missValue
      const left = col > 0 && Number.isFinite(ideal[at - 1]) ? ideal[at - 1] : ideal[at]
      const right = col < grid.width - 1 && Number.isFinite(ideal[at + 1]) ? ideal[at + 1] : ideal[at]
      const down = row > 0 && Number.isFinite(ideal[at - grid.width]) ? ideal[at - grid.width] : ideal[at]
      const up = row < grid.height - 1 && Number.isFinite(ideal[at + grid.width]) ? ideal[at + grid.width] : ideal[at]
      const gx = (right - left) / (2 * grid.cell)
      const gy = (up - down) / (2 * grid.cell)
      slopeDeg[at] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI
    }
  }

  const collect = (label: string, minDeg: number, maxDeg: number): Band => {
    const values: number[] = []
    let misses = 0
    let over = 0
    for (let at = 0; at < n; at += 1) {
      if (!inModel[at]) continue
      if (slopeDeg[at] < minDeg || slopeDeg[at] >= maxDeg) continue
      values.push(scallop[at])
      if (scallop[at] >= missValue) misses += 1
      if (scallop[at] > tolerance) over += 1
    }
    values.sort((a, b) => a - b)
    return {
      label,
      cells: values.length,
      p50: percentile(values, 50),
      p90: percentile(values, 90),
      p99: percentile(values, 99),
      max: values.length > 0 ? values[values.length - 1] : 0,
      missFraction: values.length > 0 ? misses / values.length : 0,
      overToleranceFraction: values.length > 0 ? over / values.length : 0,
    }
  }

  return {
    bands: SLOPE_BANDS.map((band) => collect(band.label, band.minDeg, band.maxDeg)),
    overall: collect('all', 0, 90.1),
  }
}

function formatBands(bands: Band[], overall: Band): string {
  const lines = [
    `  ${'band'.padEnd(14)}${'cells'.padStart(9)}${'%area'.padStart(7)}`
    + `${'p50'.padStart(11)}${'p90'.padStart(10)}${'p99'.padStart(10)}${'max'.padStart(10)}`
    + `${'miss%'.padStart(8)}${'over%'.padStart(8)}`,
  ]
  for (const band of [...bands, overall]) {
    const areaShare = overall.cells > 0 ? (band.cells / overall.cells) * 100 : 0
    lines.push(
      `  ${band.label.padEnd(14)}${String(band.cells).padStart(9)}${areaShare.toFixed(1).padStart(7)}`
      + `${band.p50.toFixed(4).padStart(11)}${band.p90.toFixed(4).padStart(10)}`
      + `${band.p99.toFixed(4).padStart(10)}${band.max.toFixed(4).padStart(10)}`
      + `${(band.missFraction * 100).toFixed(1).padStart(8)}${(band.overToleranceFraction * 100).toFixed(1).padStart(8)}`,
    )
  }
  return lines.join('\n')
}

function modelFeatureFor(project: Project, operation: Operation): SketchFeature {
  const split = splitFeatureTargets(
    project,
    operation.target.source === 'features' ? operation.target.featureIds : [],
  )
  const model = split.machiningFeatures.find((feature) => feature.operation === 'model' && feature.kind === 'stl')
  if (!model) throw new Error(`operation ${operation.id} has no imported-mesh target`)
  return model
}

function probe(
  project: Project,
  operation: Operation,
  options: { cellDivisor: number; tolerance?: number },
): void {
  const toolRecord = project.tools.find((candidate) => candidate.id === operation.toolRef)
  if (!toolRecord) throw new Error(`operation ${operation.id} has no tool`)
  const tool = normalizeToolForProject(toolRecord, project)
  const stl = loadSTLTransformedGeometry(modelFeatureFor(project, operation), project)
  if (!stl) throw new Error('imported mesh failed to load')

  const started = Date.now()
  const result = generateFinishSurfaceToolpath(project, operation)
  const seconds = (Date.now() - started) / 1000

  const cell = tool.radius / options.cellDivisor
  const bbox = computeXYBounds(stl.positions)
  const grid: Grid = {
    originX: bbox.minX,
    originY: bbox.minY,
    width: Math.max(1, Math.ceil((bbox.maxX - bbox.minX) / cell)) + 1,
    height: Math.max(1, Math.ceil((bbox.maxY - bbox.minY) / cell)) + 1,
    cell,
  }
  const heightMap = getCachedHeightMap(
    stl as FinishSurfaceParallelCacheHost, stl.positions, stl.index, bbox, cell,
  )
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 2; i < stl.positions.length; i += 3) {
    const z = stl.positions[i]
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const tolerance = options.tolerance ?? tool.radius * 0.02
  const { bands, overall } = measure(
    idealSurface(tool, grid, heightMap),
    cutSurface(tool, grid, result.moves),
    grid,
    tolerance,
    maxZ - minZ,
  )

  let cutLength = 0
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    cutLength += Math.hypot(
      move.to.x - move.from.x, move.to.y - move.from.y, move.to.z - move.from.z,
    )
  }

  console.log(
    `  moves ${result.moves.length}  cut ${cutLength.toFixed(0)}  gen ${seconds.toFixed(1)} s  `
    + `tolerance ${tolerance.toFixed(4)}`,
  )
  for (const warning of result.warnings) {
    const text = warning.code === 'debug'
      ? String(warning.params?.text ?? '')
      : `${warning.code} ${Object.values(warning.params ?? {}).join(' ')}`
    console.log(`  ! ${text}`)
  }
  console.log(formatBands(bands, overall))
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const spacings = args.spacings.length > 0 ? args.spacings : [1.2, 0.6, 0.3, 0.15]

  if (args.project) {
    const raw = JSON.parse(readFileSync(args.project, 'utf8')) as Project
    const project = normalizeProject(raw)
    const base = args.operation
      ? project.operations.find((candidate) => candidate.id === args.operation)
      : project.operations.find((candidate) => candidate.kind === 'finish_surface')
    if (!base) throw new Error(`no finish_surface operation ${args.operation ?? ''} in ${args.project}`)
    const runs = args.spacings.length > 0 ? args.spacings : [base.waterlineMicroStepover ?? 0]
    for (const spacing of runs) {
      const tool = project.tools.find((candidate) => candidate.id === base.toolRef)
      if (!tool) throw new Error(`operation ${base.id} has no tool`)
      const operation: Operation = {
        ...operationAtSpacing(base, args.pattern, spacing, tool.diameter, args.scallopHeight),
        ...(args.stepdown ? { stepdown: args.stepdown } : {}),
      }
      console.log(`\n=== ${base.id} spacing ${spacing === 0 ? 'auto' : spacing} ===`)
      probe({ ...project, operations: [operation] }, operation, args)
    }
    return
  }

  if (args.fixture === 'guitar') {
    const { project, operation } = surfaceTestProject(buildGuitarMesh({ cell: 1 }), 6)
    const cuspSpacing = 2 * Math.sqrt(2 * 3 * 0.02 - 0.02 ** 2)
    const runs = args.spacings.length > 0 ? args.spacings : [cuspSpacing]
    for (const spacing of runs) {
      const patched = operationAtSpacing(operation, args.pattern ?? 'constant_scallop', spacing, 6, args.scallopHeight)
      project.operations = [patched]
      console.log(`\n=== guitar, ${patched.pocketPattern} spacing ${spacing} mm ===`)
      probe(project, patched, args)
    }
    return
  }

  console.log('Synthetic hills fixture — flat "miss%" must not rise as spacing falls (#698).')
  for (const spacing of spacings) {
    const { project, operation } = hillsWaterlineProject({
      microStepover: spacing,
      ...(args.stepdown ? { stepdown: args.stepdown } : {}),
    })
    const patched = operationAtSpacing(operation, args.pattern, spacing, project.tools[0].diameter, args.scallopHeight)
    project.operations = [patched]
    console.log(`\n=== hills, Adaptive spacing ${spacing} mm ===`)
    probe(project, patched, args)
  }
}

main()
