/**
 * For each v-carve recursive operation, walk the inset offsets and report when
 * a region splits 1 → N. Also dump corner counts on the parent and each child
 * at the split level so we can design the corner-to-corner bridging rules.
 */
import ClipperLib from 'clipper-lib'
import fs from 'node:fs'
import { detectCorners } from '../src/engine/toolpaths/vcarveRecursive.ts'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
import { buildInsetRegions } from '../src/engine/toolpaths/pocket.ts'
import type { Operation, Point, Project } from '../src/types/project.ts'
import type { ResolvedPocketRegion } from '../src/engine/toolpaths/types.ts'

const PROJECT_PATH = process.env.CAMJ_PATH ?? '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project

function fmt(p: Point): string { return `(${p.x.toFixed(4)}, ${p.y.toFixed(4)})` }

function walk(region: ResolvedPocketRegion, depth: number, stepSize: number, label: string, maxDepth = 80): void {
  if (depth > maxDepth) return
  const next = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)
  if (next.length > 1) {
    const tol = Math.max(1e-4, stepSize * 0.25)
    const parentCorners = detectCorners(region.outer, tol)
    console.log(`  ${label} depth=${depth} -> ${next.length} children. parent-corners=${parentCorners.length}`)
    for (const c of parentCorners) console.log(`     parent corner ${fmt(c)}`)
    next.forEach((child, idx) => {
      const childCorners = detectCorners(child.outer, tol)
      console.log(`     child ${idx}: corners=${childCorners.length}`)
      for (const c of childCorners) console.log(`       child corner ${fmt(c)}`)
    })
    next.forEach((child, idx) => walk(child, depth + 1, stepSize, `${label}/c${idx}`, maxDepth))
    return
  }
  if (next.length === 1) walk(next[0], depth + 1, stepSize, label, maxDepth)
}

for (const operation of project.operations) {
  if (operation.kind !== 'v_carve_recursive' || operation.enabled === false) continue
  console.log(`\n=== ${operation.id} ${operation.name} ===`)
  const resolved = resolvePocketRegions(project, operation)
  for (const band of resolved.bands) {
    band.regions.forEach((region, idx) => walk(region, 0, operation.stepover, `r${idx}`))
  }
}
