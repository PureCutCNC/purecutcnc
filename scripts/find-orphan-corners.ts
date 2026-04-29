import ClipperLib from 'clipper-lib'
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath, detectCorners } from '../src/engine/toolpaths/vcarveRecursive.ts'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
import { buildInsetRegions } from '../src/engine/toolpaths/pocket.ts'
import type { Operation, Point, Project } from '../src/types/project.ts'
import type { ResolvedPocketRegion } from '../src/engine/toolpaths/types.ts'

const PROJECT_PATH = process.env.CAMJ_PATH ?? '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const OPERATION_ID = process.env.OP_ID ?? 'op0006'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const allOperations = OPERATION_ID === 'all'
  ? project.operations.filter((o) => o.kind === 'v_carve_recursive' && o.enabled !== false)
  : ([project.operations.find((entry) => entry.id === OPERATION_ID)].filter(Boolean) as Operation[])
if (allOperations.length === 0) throw new Error(`${OPERATION_ID} not found`)
console.log(`project=${PROJECT_PATH} ops=${allOperations.map((o) => o.id).join(',')}`)

for (const operation of allOperations) {
  console.log(`\n=== ${operation.id} ${operation.name} ===`)
  const result = generateVCarveRecursiveToolpath(project, operation)
  const allCutPoints: Point[] = []
  for (const m of result.moves) {
    if (m.kind === 'cut') {
      allCutPoints.push({ x: m.from.x, y: m.from.y })
      allCutPoints.push({ x: m.to.x, y: m.to.y })
    }
  }

  function nearestCutDist(p: Point): number {
    let best = Infinity
    for (const q of allCutPoints) {
      const d = Math.hypot(p.x - q.x, p.y - q.y)
      if (d < best) best = d
    }
    return best
  }

  const resolved = resolvePocketRegions(project, operation)
  const stepSize = operation.stepover
  const cornerTol = Math.max(1e-4, stepSize * 0.25)
  const orphanThreshold = stepSize * 0.6

  interface Orphan { depth: number, region: number, point: Point, dist: number, afterSplit: boolean }
  const orphans: Orphan[] = []

  function walk(region: ResolvedPocketRegion, depth: number, regionIdx: number, maxDepth: number, afterSplit = false): void {
    if (depth > maxDepth) return
    const corners = detectCorners(region.outer, cornerTol)
    for (const c of corners) {
      const d = nearestCutDist(c)
      if (d > orphanThreshold) {
        orphans.push({ depth, region: regionIdx, point: c, dist: d, afterSplit })
      }
    }
    const next = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)
    const childAfterSplit = afterSplit || next.length > 1
    for (const r of next) walk(r, depth + 1, regionIdx, maxDepth, childAfterSplit)
  }

  resolved.bands.forEach((band) => {
    band.regions.forEach((region, idx) => walk(region, 0, idx, 50))
  })

  console.log(`cuts=${result.moves.filter((m) => m.kind === 'cut').length} orphans=${orphans.length}`)
  const byDepth = new Map<number, { count: number, afterSplit: number }>()
  for (const o of orphans) {
    const e = byDepth.get(o.depth) ?? { count: 0, afterSplit: 0 }
    e.count += 1
    if (o.afterSplit) e.afterSplit += 1
    byDepth.set(o.depth, e)
  }
  for (const [d, info] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  depth=${d} orphans=${info.count} afterSplit=${info.afterSplit}`)
  }
  orphans.sort((a, b) => b.dist - a.dist)
  for (const o of orphans.slice(0, 5)) {
    console.log(`    afterSplit=${o.afterSplit} depth=${o.depth} pt=(${o.point.x.toFixed(4)}, ${o.point.y.toFixed(4)}) nearestCut=${o.dist.toFixed(4)}`)
  }
}
