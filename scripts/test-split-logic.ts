import ClipperLib from 'clipper-lib'
import fs from 'node:fs'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver.ts'
import { buildInsetRegions } from '../src/engine/toolpaths/pocket.ts'
import { detectCorners, generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Point, Project } from '../src/types/project.ts'
import type { ResolvedPocketRegion } from '../src/engine/toolpaths/types.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const OPERATION_ID = 'op0012'

const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((entry) => entry.id === OPERATION_ID) as Operation | undefined
if (!operation) throw new Error(`${OPERATION_ID} not found`)

const resolved = resolvePocketRegions(project, operation)
const stepSize = operation.stepover

console.log(`Testing split logic in ${OPERATION_ID}, stepSize=${stepSize}`)

function walk(region: ResolvedPocketRegion, depth: number, regionIdx: number, maxDepth: number): void {
  if (depth > maxDepth) return
  
  const nextRegions = buildInsetRegions(region, stepSize, ClipperLib.JoinType.jtRound)
  
  if (nextRegions.length > 1) {
    console.log(`\n=== SPLIT at depth=${depth} region=${regionIdx} ===`)
    console.log(`  Parent contour: ${region.outer.length} points`)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    region.outer.forEach(p => {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    })
    console.log(`  Parent bounds: (${minX.toFixed(4)}, ${minY.toFixed(4)}) to (${maxX.toFixed(4)}, ${maxY.toFixed(4)})`)
    
    const allChildCorners: { point: Point, childIdx: number }[] = []
    
    nextRegions.forEach((child, childIdx) => {
      const corners = detectCorners(child.outer, stepSize * 0.25)
      console.log(`  Child ${childIdx}: ${corners.length} corners`)
      corners.forEach(c => {
         console.log(`    Corner at (${c.x.toFixed(4)}, ${c.y.toFixed(4)})`)
         allChildCorners.push({ point: c, childIdx })
      })
    })

    // Show cross-child corner proximity
    console.log(`  Cross-child corner pairs (within ${(stepSize * 30).toFixed(4)}):`)
    for (let i = 0; i < allChildCorners.length; i++) {
      for (let j = i + 1; j < allChildCorners.length; j++) {
        const a = allChildCorners[i]
        const b = allChildCorners[j]
        if (a.childIdx !== b.childIdx) {
          const dist = Math.hypot(b.point.x - a.point.x, b.point.y - a.point.y)
          if (dist < stepSize * 30) {
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

// Run full toolpath and report sibling bridge cuts
console.log('\n=== Full toolpath generation ===')
const result = generateVCarveRecursiveToolpath(project, operation)
console.log(`Total moves: ${result.moves.length}`)
console.log(`Warnings: ${result.warnings.join(', ') || 'none'}`)
