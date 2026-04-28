import ClipperLib from 'clipper-lib'
import fs from 'node:fs'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
import { buildInsetRegions } from '../src/engine/toolpaths/pocket.ts'
import { detectCorners } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Point, Project } from '../src/types/project.ts'
import type { ResolvedPocketRegion } from '../src/engine/toolpaths/types.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const OPERATION_ID = 'op0012'

const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((entry) => entry.id === OPERATION_ID) as Operation | undefined
if (!operation) throw new Error(`${OPERATION_ID} not found`)

const resolved = resolvePocketRegions(project, operation)
const stepSize = operation.stepover
const cornerTol = Math.max(1e-4, stepSize * 0.25)

console.log(`Analyzing splits in ${OPERATION_ID}`)

function recursiveLogicContour(contour: Point[], stepSize: number): Point[] {
  // Simplified version - just return contour for now
  return contour
}

function walk(region: ResolvedPocketRegion, depth: number, regionIdx: number, maxDepth: number): void {
  if (depth > maxDepth) return
  
  const currentCorners = detectCorners(region.outer, cornerTol)
  const nextRegions = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)
  
  if (nextRegions.length > 1) {
    console.log(`\n=== SPLIT at depth=${depth} region=${regionIdx} ===`)
    console.log(`Parent corners: ${currentCorners.length}`)
    console.log(`Split into ${nextRegions.length} children`)
    
    const allChildCorners: { point: Point, childIdx: number }[] = []
    nextRegions.forEach((child, childIdx) => {
      const childCorners = detectCorners(child.outer, cornerTol)
      console.log(`  Child ${childIdx}: ${childCorners.length} corners`)
      childCorners.forEach(p => allChildCorners.push({ point: p, childIdx }))
    })

    console.log(`  Child-to-child connections (within ${stepSize * 10}):`)
    for (let i = 0; i < allChildCorners.length; i++) {
      for (let j = i + 1; j < allChildCorners.length; j++) {
        const a = allChildCorners[i]
        const b = allChildCorners[j]
        if (a.childIdx !== b.childIdx) {
          const dist = Math.hypot(b.point.x - a.point.x, b.point.y - a.point.y)
          if (dist < stepSize * 10) {
            console.log(`    Child ${a.childIdx} (${a.point.x.toFixed(4)}, ${a.point.y.toFixed(4)}) <-> Child ${b.childIdx} (${b.point.x.toFixed(4)}, ${b.point.y.toFixed(4)}) dist=${dist.toFixed(4)}`)
          }
        }
      }
    }
  }
  
  for (const r of nextRegions) {
    walk(r, depth + 1, regionIdx, maxDepth)
  }
}

resolved.bands.forEach((band) => {
  band.regions.forEach((region, idx) => {
    walk(region, 0, idx, 10)
  })
})
