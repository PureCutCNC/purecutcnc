import fs from 'node:fs'
import path from 'node:path'
import type { Operation, Point, Project, SketchFeature } from '../src/types/project.ts'
import { generateEdgeRouteToolpath } from '../src/engine/toolpaths/edge.ts'
import { generateRoughSurfaceToolpath } from '../src/engine/toolpaths/roughSurface.ts'
import { generateFinishSurfaceToolpath } from '../src/engine/toolpaths/finishSurface.ts'
import { significantSilhouettePaths } from '../src/engine/toolpaths/silhouette.ts'
import type { ToolpathBounds, ToolpathMove } from '../src/engine/toolpaths/types.ts'

const projectPath = process.argv[2]

if (!projectPath) {
  console.error('Usage: npx tsx scripts/diagnose-stl-cam.ts <project.camj>')
  process.exit(1)
}

const project = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as Project

function polygonArea(points: Point[]): number {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return area / 2
}

function pointBounds(paths: Point[][]): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const path of paths) {
    for (const point of path) {
      minX = Math.min(minX, point.x)
      maxX = Math.max(maxX, point.x)
      minY = Math.min(minY, point.y)
      maxY = Math.max(maxY, point.y)
    }
  }

  return Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minY) && Number.isFinite(maxY)
    ? { minX, maxX, minY, maxY }
    : null
}

function formatBounds(bounds: ToolpathBounds | ReturnType<typeof pointBounds>): string {
  if (!bounds) return 'none'
  return `x ${bounds.minX.toFixed(4)}..${bounds.maxX.toFixed(4)}, y ${bounds.minY.toFixed(4)}..${bounds.maxY.toFixed(4)}`
    + ('minZ' in bounds ? `, z ${bounds.minZ.toFixed(4)}..${bounds.maxZ.toFixed(4)}` : '')
}

function cutCount(moves: ToolpathMove[]): number {
  return moves.filter((move) => move.kind === 'cut').length
}

function generateOperation(operation: Operation) {
  switch (operation.kind) {
    case 'edge_route_outside':
    case 'edge_route_inside':
      return generateEdgeRouteToolpath(project, operation)
    case 'rough_surface':
      return generateRoughSurfaceToolpath(project, operation)
    case 'finish_surface':
      return generateFinishSurfaceToolpath(project, operation)
    default:
      return null
  }
}

console.log(`Project: ${project.meta.name}`)
console.log(`Path: ${path.resolve(projectPath)}`)
console.log(`Units: ${project.meta.units}`)
console.log('')

const stlFeatures = project.features.filter((feature): feature is SketchFeature => feature.kind === 'stl')
console.log(`STL features: ${stlFeatures.length}`)
for (const feature of stlFeatures) {
  const storedPaths = feature.stl?.silhouettePaths ?? []
  const significantPaths = significantSilhouettePaths(storedPaths)
  const areas = storedPaths
    .map((storedPath) => Math.abs(polygonArea(storedPath)))
    .sort((left, right) => right - left)
  const largestArea = areas[0] ?? 0
  const secondArea = areas[1] ?? 0

  console.log(`- ${feature.id} ${feature.name}`)
  console.log(`  operation=${feature.operation}, z=${feature.z_bottom}..${feature.z_top}`)
  console.log(`  stored silhouette paths=${storedPaths.length}, significant=${significantPaths.length}`)
  console.log(`  largest area=${largestArea.toExponential(6)}, second=${secondArea.toExponential(6)}`)
  console.log(`  significant bounds=${formatBounds(pointBounds(significantPaths))}`)
}

console.log('')
console.log('STL-related operations:')
for (const operation of project.operations) {
  const result = generateOperation(operation)
  if (!result) continue

  console.log(`- ${operation.id} ${operation.kind} ${operation.name}`)
  console.log(`  target=${operation.target.source === 'features' ? operation.target.featureIds.join(',') : operation.target.source}`)
  console.log(`  moves=${result.moves.length}, cuts=${cutCount(result.moves)}, bounds=${formatBounds(result.bounds)}`)
  if ('stepLevels' in result) {
    console.log(`  stepLevels=${result.stepLevels.length}`)
  }
  if (result.warnings.length > 0) {
    console.log(`  warnings=${result.warnings.join(' | ')}`)
  }
}
