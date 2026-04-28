/**
 * For each split site, list the parent corners, child corners, and which
 * parent->child bridges actually got emitted in the final toolpath.
 */
import ClipperLib from 'clipper-lib'
import fs from 'node:fs'
import { detectCorners, generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
import { buildInsetRegions } from '../src/engine/toolpaths/pocket.ts'
import type { Operation, Point, Project } from '../src/types/project.ts'
import type { ResolvedPocketRegion } from '../src/engine/toolpaths/types.ts'

const PROJECT_PATH = process.env.CAMJ_PATH ?? '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project

function fmt(p: Point): string { return `(${p.x.toFixed(4)}, ${p.y.toFixed(4)})` }

function findSplit(region: ResolvedPocketRegion, depth: number, stepSize: number): { depth: number, parent: ResolvedPocketRegion, children: ResolvedPocketRegion[] } | null {
  if (depth > 80) return null
  const next = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)
  if (next.length > 1) return { depth, parent: region, children: next }
  if (next.length === 1) return findSplit(next[0], depth + 1, stepSize)
  return null
}

const TARGETS = ['op0006', 'op0008', 'op0012']
for (const opId of TARGETS) {
  const operation = project.operations.find((o) => o.id === opId) as Operation
  if (!operation) continue
  const stepSize = operation.stepover
  const tol = Math.max(1e-4, stepSize * 0.25)
  console.log(`\n=== ${opId} ${operation.name} ===`)

  const resolved = resolvePocketRegions(project, operation)
  const result = generateVCarveRecursiveToolpath(project, operation)

  for (const band of resolved.bands) {
    band.regions.forEach((region, idx) => {
      const split = findSplit(region, 0, stepSize)
      if (!split) return
      const parentCorners = detectCorners(split.parent.outer, tol)
      const childCornerSets = split.children.map((c) => detectCorners(c.outer, tol))
      console.log(`region=${idx} split at depth=${split.depth} parents=${parentCorners.length} children=${split.children.length}`)
      parentCorners.forEach((p) => console.log(`  parent ${fmt(p)}`))
      childCornerSets.forEach((set, ci) => {
        console.log(`  child${ci} corners=${set.length}`)
        set.forEach((c) => console.log(`    ${fmt(c)}`))
      })

      // Find cuts whose .from is near a parent corner AND .to is near a child corner.
      const cuts = result.moves.filter((m) => m.kind === 'cut')
      const bridges = cuts.filter((m) => {
        const fromHits = parentCorners.some((p) => Math.hypot(p.x - m.from.x, p.y - m.from.y) < tol)
        if (!fromHits) return false
        return childCornerSets.some((set) => set.some((c) => Math.hypot(c.x - m.to.x, c.y - m.to.y) < tol))
      })
      console.log(`  bridges emitted: ${bridges.length}`)
      bridges.forEach((m) => {
        const childIdx = childCornerSets.findIndex((set) => set.some((c) => Math.hypot(c.x - m.to.x, c.y - m.to.y) < tol))
        console.log(`    parent ${fmt(m.from)} -> child${childIdx} ${fmt(m.to)} dz=${(m.to.z - m.from.z).toFixed(4)}`)
      })
    })
  }
}
