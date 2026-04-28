import ClipperLib from 'clipper-lib'
import fs from 'node:fs'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
import { buildInsetRegions } from '../src/engine/toolpaths/pocket.ts'
import { buildInteriorCornerBridge, detectCorners, stepCorners } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Point, Project, Tool } from '../src/types/project.ts'
import type { ResolvedPocketRegion } from '../src/engine/toolpaths/types.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/purecutcnc.camj'

function bounds(points: Point[]): { minX: number, minY: number, maxX: number, maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return { minX, minY, maxX, maxY }
}

function fmtPoint(point: Point): string {
  return `(${point.x.toFixed(4)}, ${point.y.toFixed(4)})`
}

function fmtPoints(points: Point[]): string {
  return points.map(fmtPoint).join(', ')
}

function cornerSmoothingDistance(stepSize: number): number {
  return Math.max(1e-4, stepSize * 0.25)
}

function detectRecursiveCorners(contour: Point[]): Point[] {
  return detectCorners(contour)
}

function traceRegion(
  region: ResolvedPocketRegion,
  stepSize: number,
  slope: number,
  topZ: number,
  maxDepth: number,
  label: string,
  depth = 0,
  corners?: Point[],
): void {
  const activeCorners = corners ?? detectCorners(region.outer, cornerSmoothingDistance(stepSize))
  const currentZ = topZ - Math.min(maxDepth, (depth * stepSize) / slope)
  const nextZ = topZ - Math.min(maxDepth, ((depth + 1) * stepSize) / slope)
  const nextRegions = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)

  if (nextRegions.length !== 1) {
    if (nextRegions.length > 1 || activeCorners.length > 0) {
      console.log(`${label} depth=${depth} event=${nextRegions.length === 0 ? 'collapse' : `split(${nextRegions.length})`} active=${activeCorners.length}`)
    }
    return
  }

  const nextRegion = nextRegions[0]
  const { nextCorners, rejected } = stepCorners(activeCorners, region.outer, nextRegion.outer, currentZ, nextZ, stepSize)
  const bridges = buildInteriorCornerBridge(nextRegion.outer, nextCorners, nextZ, stepSize)
  const freshSmoothedNextCorners = detectCorners(nextRegion.outer, cornerSmoothingDistance(stepSize))
  const freshRawNextCorners = detectRecursiveCorners(nextRegion.outer)

  if (activeCorners.length >= 2 && (nextCorners.length < activeCorners.length || rejected.length > 0 || bridges.length > 0)) {
    const regionBounds = bounds(region.outer)
    const nextBounds = bounds(nextRegion.outer)
    console.log(`\n${label} depth=${depth}`)
    console.log(`  current bounds=(${regionBounds.minX.toFixed(4)}, ${regionBounds.minY.toFixed(4)}) -> (${regionBounds.maxX.toFixed(4)}, ${regionBounds.maxY.toFixed(4)})`)
    console.log(`  next    bounds=(${nextBounds.minX.toFixed(4)}, ${nextBounds.minY.toFixed(4)}) -> (${nextBounds.maxX.toFixed(4)}, ${nextBounds.maxY.toFixed(4)})`)
    console.log(`  active=${activeCorners.length} next=${nextCorners.length} rejected=${rejected.length} bridge=${bridges.length}`)
    console.log(`  active corners: ${fmtPoints(activeCorners)}`)
    console.log(`  next corners: ${fmtPoints(nextCorners)}`)
    console.log(`  fresh smoothed next corners (${freshSmoothedNextCorners.length}): ${fmtPoints(freshSmoothedNextCorners)}`)
    console.log(`  fresh raw next corners (${freshRawNextCorners.length}): ${fmtPoints(freshRawNextCorners)}`)
    for (const rejectedCorner of rejected) {
      console.log(
        `  rejected ${fmtPoint(rejectedCorner.corner)} best=${rejectedCorner.bestTarget ? fmtPoint(rejectedCorner.bestTarget) : 'null'} `
        + `dist=${Number.isFinite(rejectedCorner.bestDist) ? rejectedCorner.bestDist.toFixed(4) : 'inf'} `
        + `max=${rejectedCorner.maxJumpDist.toFixed(4)} hadCandidates=${rejectedCorner.hadCornerCandidates}`,
      )
    }
  }

  traceRegion(nextRegion, stepSize, slope, topZ, maxDepth, label, depth + 1, nextCorners.length > 0 ? nextCorners : undefined)
}

const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((entry) => entry.id === 'op0018') as Operation | undefined
const tool = project.tools.find((entry) => entry.id === operation?.toolRef) as Tool | undefined

if (!operation || !tool || tool.type !== 'v_bit' || !tool.vBitAngle) {
  throw new Error('Expected v-bit tool for op0018')
}

const resolved = resolvePocketRegions(project, operation)
const slope = Math.tan((tool.vBitAngle * Math.PI) / 360)

console.log(`bands=${resolved.bands.length} warnings=${resolved.warnings.join(' | ')}`)
resolved.bands.forEach((band, bandIndex) => {
  console.log(`\nBand ${bandIndex} top=${band.topZ} bottom=${band.bottomZ} regions=${band.regions.length}`)
  band.regions
    .map((region, regionIndex) => ({ region, regionIndex, b: bounds(region.outer) }))
    .sort((left, right) => left.b.minX - right.b.minX || left.b.minY - right.b.minY)
    .forEach(({ region, regionIndex, b }, orderIndex) => {
      const corners = detectCorners(region.outer, cornerSmoothingDistance(operation.stepover))
      console.log(
        `region order=${orderIndex} index=${regionIndex} bounds=(${b.minX.toFixed(4)}, ${b.minY.toFixed(4)}) -> (${b.maxX.toFixed(4)}, ${b.maxY.toFixed(4)}) `
        + `corners=${corners.length} islands=${region.islands.length}`,
      )
      traceRegion(region, operation.stepover, slope, band.topZ, Math.max(0, Math.min(operation.maxCarveDepth, band.topZ - band.bottomZ)), `band=${bandIndex} region=${regionIndex}`)
    })
})
