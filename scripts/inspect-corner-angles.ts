/**
 * For each detected corner on each offset level of a feature, print its turn
 * angle. Goal: see whether spurious "jitter" corners on smooth curves have
 * different (smaller) turn angles than real shape corners.
 */
import ClipperLib from 'clipper-lib'
import fs from 'node:fs'
import { detectCorners } from '../src/engine/toolpaths/vcarveRecursive.ts'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
import { buildInsetRegions } from '../src/engine/toolpaths/pocket.ts'
import type { Operation, Point, Project } from '../src/types/project.ts'

const PROJECT_PATH = process.env.CAMJ_PATH ?? '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const OPERATION_ID = process.env.OP_ID ?? 'op0047'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((o) => o.id === OPERATION_ID) as Operation
const stepSize = operation.stepover
const cornerTol = Math.max(1e-4, stepSize * 0.25)

function turnAngleDeg(contour: Point[], target: Point): number {
  // Find vertex closest to target, then compute turn angle there.
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < contour.length; i += 1) {
    const d = Math.hypot(contour[i].x - target.x, contour[i].y - target.y)
    if (d < bestDist) { bestDist = d; bestIdx = i }
  }
  const n = contour.length
  const prev = contour[(bestIdx - 1 + n) % n]
  const curr = contour[bestIdx]
  const next = contour[(bestIdx + 1) % n]
  const dx1 = curr.x - prev.x, dy1 = curr.y - prev.y
  const dx2 = next.x - curr.x, dy2 = next.y - curr.y
  const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2)
  if (len1 < 1e-12 || len2 < 1e-12) return 0
  const cos = (dx1 * dx2 + dy1 * dy2) / (len1 * len2)
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
}

const resolved = resolvePocketRegions(project, operation)
console.log(`op=${OPERATION_ID} stepSize=${stepSize}`)
for (const band of resolved.bands) {
  for (const [regIdx, region] of band.regions.entries()) {
    let curr = region
    for (let depth = 0; depth < 25; depth += 1) {
      const corners = detectCorners(curr.outer, cornerTol)
      if (corners.length > 0) {
        const angles = corners.map((c) => turnAngleDeg(curr.outer, c))
        const minA = Math.min(...angles)
        const maxA = Math.max(...angles)
        const avgA = angles.reduce((s, a) => s + a, 0) / angles.length
        console.log(
          `region=${regIdx} depth=${depth} corners=${corners.length} `
          + `angle min=${minA.toFixed(1)}° max=${maxA.toFixed(1)}° avg=${avgA.toFixed(1)}°`,
        )
      }
      const next = buildInsetRegions(curr, stepSize, ClipperLib.JoinType.jtRound)
      if (next.length !== 1) break
      curr = next[0]
    }
  }
}
