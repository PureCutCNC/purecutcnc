import ClipperLib from 'clipper-lib'
import fs from 'node:fs'
import { detectCorners } from '../src/engine/toolpaths/vcarveRecursive.ts'
import { buildInsetRegions } from '../src/engine/toolpaths/pocket.ts'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
import type { Operation, Point, Project } from '../src/types/project.ts'
import type { ResolvedPocketRegion } from '../src/engine/toolpaths/types.ts'

const PROJECT_PATH = process.env.CAMJ_PATH ?? '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const OPERATION_ID = process.env.OP_ID ?? 'op0006'
const TARGET = {
  x: Number(process.env.TARGET_X ?? '2.0499'),
  y: Number(process.env.TARGET_Y ?? '1.0673'),
}
const TARGET_TOL = Number(process.env.TARGET_TOL ?? '0.003')

const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((entry) => entry.id === OPERATION_ID) as Operation | undefined
if (!operation) throw new Error(`${OPERATION_ID} not found`)

const stepSize = operation.stepover
const cornerSmoothingDistance = Math.max(stepSize * 0.25, 1e-4)

function pointDist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function detectRecursiveCorners(contour: Point[]): Point[] {
  return detectCorners(contour, cornerSmoothingDistance)
}

function contourBounds(contour: Point[]): { minX: number, maxX: number, minY: number, maxY: number } {
  return contour.reduce((acc, p) => ({
    minX: Math.min(acc.minX, p.x),
    maxX: Math.max(acc.maxX, p.x),
    minY: Math.min(acc.minY, p.y),
    maxY: Math.max(acc.maxY, p.y),
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  })
}

function nearestPoints(label: string, points: Point[], target: Point, count = 8): void {
  const nearest = points
    .map((p) => ({ p, d: pointDist(p, target) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
  console.log(label)
  for (const { p, d } of nearest) {
    console.log(`  (${p.x.toFixed(4)}, ${p.y.toFixed(4)}) d=${d.toFixed(4)}`)
  }
}

function walk(region: ResolvedPocketRegion, depth: number, path: string, afterSplit: boolean): void {
  const currentCorners = detectRecursiveCorners(region.outer)
  const matchingCorner = currentCorners.find((corner) => pointDist(corner, TARGET) <= TARGET_TOL)
  if (matchingCorner) {
    const nextRegions = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)
    const bounds = contourBounds(region.outer)
    console.log(`FOUND depth=${depth} path=${path} afterSplit=${afterSplit} currentCorners=${currentCorners.length} nextRegions=${nextRegions.length}`)
    console.log(`  region bounds x=[${bounds.minX.toFixed(4)}, ${bounds.maxX.toFixed(4)}] y=[${bounds.minY.toFixed(4)}, ${bounds.maxY.toFixed(4)}]`)
    console.log(`  matching corner=(${matchingCorner.x.toFixed(4)}, ${matchingCorner.y.toFixed(4)})`)
    console.log('  current recursive corners:')
    for (const corner of currentCorners) {
      console.log(`    (${corner.x.toFixed(4)}, ${corner.y.toFixed(4)}) d=${pointDist(corner, TARGET).toFixed(4)}`)
    }
    nearestPoints('  nearest current contour vertices:', region.outer, TARGET, 10)
    if (nextRegions.length > 0) {
      nextRegions.forEach((nextRegion, index) => {
        const nextCorners = detectRecursiveCorners(nextRegion.outer)
        const nextBounds = contourBounds(nextRegion.outer)
        console.log(`  child ${index}: corners=${nextCorners.length} verts=${nextRegion.outer.length} x=[${nextBounds.minX.toFixed(4)}, ${nextBounds.maxX.toFixed(4)}] y=[${nextBounds.minY.toFixed(4)}, ${nextBounds.maxY.toFixed(4)}]`)
        nearestPoints(`    nearest next corners child ${index}:`, nextCorners, TARGET, 8)
        nearestPoints(`    nearest next contour vertices child ${index}:`, nextRegion.outer, TARGET, 12)
      })
    }
    console.log('')
  }

  const next = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)
  const childAfterSplit = afterSplit || next.length > 1
  next.forEach((child, index) => walk(child, depth + 1, `${path}.${index}`, childAfterSplit))
}

console.log(`project=${PROJECT_PATH} op=${OPERATION_ID} target=(${TARGET.x}, ${TARGET.y}) step=${stepSize}`)
const resolved = resolvePocketRegions(project, operation)
resolved.bands.forEach((band, bandIndex) => {
  band.regions.forEach((region, regionIndex) => {
    walk(region, 0, `b${bandIndex}.r${regionIndex}`, false)
  })
})
