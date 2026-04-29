/**
 * Walk the offsets of a feature and dump detected corners on each level. The
 * goal is to see whether `detectCorners` is producing spurious vertices on
 * smooth curves (which would explain wall-anchor cuts emitted there).
 */
import ClipperLib from 'clipper-lib'
import fs from 'node:fs'
import { detectCorners } from '../src/engine/toolpaths/vcarveRecursive.ts'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
import { buildInsetRegions } from '../src/engine/toolpaths/pocket.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = process.env.CAMJ_PATH ?? '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const OPERATION_ID = process.env.OP_ID ?? 'op0047'  // circle by default
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((o) => o.id === OPERATION_ID) as Operation
const stepSize = operation.stepover
const cornerTol = Math.max(1e-4, stepSize * 0.25)

console.log(`op=${OPERATION_ID} stepSize=${stepSize} cornerTol=${cornerTol}`)
const resolved = resolvePocketRegions(project, operation)
for (const band of resolved.bands) {
  for (const [regIdx, region] of band.regions.entries()) {
    let curr = region
    for (let depth = 0; depth < 30; depth += 1) {
      const corners = detectCorners(curr.outer, cornerTol)
      console.log(`region=${regIdx} depth=${depth} contour-vertices=${curr.outer.length} detected-corners=${corners.length}`)
      for (const c of corners.slice(0, 6)) {
        console.log(`    corner (${c.x.toFixed(4)}, ${c.y.toFixed(4)})`)
      }
      const next = buildInsetRegions(curr, stepSize, ClipperLib.JoinType.jtRound)
      if (next.length !== 1) {
        console.log(`region=${regIdx} depth=${depth + 1} -> ${next.length} subregions, stopping`)
        break
      }
      curr = next[0]
    }
  }
}
