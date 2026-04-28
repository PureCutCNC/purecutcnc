/**
 * Deep trace: intercept paths BEFORE chainPaths/sortPathsNearestNeighbor
 * by wrapping the core traceRegion with our own collector.
 * 
 * This modifies a copy of the source temporarily to add debug markers.
 * 
 * Strategy: Instead of modifying source, let's reconstruct the paths
 * by looking at the output and deducing path boundaries from the structure.
 * 
 * In chainPaths, arms (length===2) are chained together, contours (length!==2) stay separate.
 * After that, sortPathsNearestNeighbor reorders them.
 * tryDirectLink creates moves BETWEEN paths.
 * 
 * So consecutive moves that form a regular pattern (no sudden jumps) are INSIDE a path.
 * Moves with sudden jumps are BETWEEN paths (tryDirectLink outputs).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Project } from '../src/types/project.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectPath = path.resolve(here, '../../purecutcnc/work/v-carve-skeleton-tests.camj')
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as Project

const op = project.operations.find((o: any) => o.id === 'op0006')!
const result = generateVCarveRecursiveToolpath(project, op)

// Detect path boundaries by looking for large XY jumps between consecutive moves
// (within the same kind) or kind changes (cut→rapid, rapid→cut)
console.log('=== PATH BOUNDARY DETECTION ===')
console.log('')

function pathBoundary(m1: any, m2: any): boolean {
  // Different kinds = boundary
  if (m1.kind !== m2.kind) return true
  // Large XY jump between end of m1 and start of m2
  const xy = Math.hypot(m2.from.x - m1.to.x, m2.from.y - m1.to.y)
  if (xy > 0.001) return true
  return false
}

for (let i = 0; i < result.moves.length - 1; i++) {
  const m = result.moves[i]
  const next = result.moves[i + 1]
  const xyJump = Math.hypot(next.from.x - m.to.x, next.from.y - m.to.y)
  
  if (pathBoundary(m, next)) {
    const mXy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    const nextXy = Math.hypot(next.to.x - next.from.x, next.to.y - next.from.y)
    console.log(`[${i}]→[${i+1}] BOUNDARY: ${m.kind}→${next.kind}, jump=${xyJump.toFixed(4)}"`)
    console.log(`     [${i}] ends at (${m.to.x.toFixed(3)},${m.to.y.toFixed(3)},${m.to.z.toFixed(4)})`)
    console.log(`     [${i+1}] starts at (${next.from.x.toFixed(3)},${next.from.y.toFixed(3)},${next.from.z.toFixed(4)})`)
    
    // For CUT→CUT boundaries, show the tryDirectLink decision
    if (m.kind === 'cut' && next.kind === 'cut') {
      const posZ = m.to.z
      const entryZ = next.from.z
      const safeZ = 0.95 // typical safeZ
      const depthBudget = safeZ - Math.min(posZ, entryZ)
      console.log(`     tryDirectLink: entry.z=${entryZ.toFixed(4)} pos.z=${posZ.toFixed(4)} desc=${entryZ < posZ}, budget=${depthBudget.toFixed(4)}, xy=${xyJump.toFixed(4)}`)
    }
  }
}

// Now let's specifically look at the spurious cut
console.log('\n=== SPURIOUS CUT ANALYSIS (move 162) ===')
const m161 = result.moves[161]
const m162 = result.moves[162]
const m163 = result.moves[163]
console.log(`[161] ends: (${m161.to.x.toFixed(3)},${m161.to.y.toFixed(3)},${m161.to.z.toFixed(4)})`)
console.log(`[162] from→to: (${m162.from.x.toFixed(3)},${m162.from.y.toFixed(3)},${m162.from.z.toFixed(4)})→(${m162.to.x.toFixed(3)},${m162.to.y.toFixed(3)},${m162.to.z.toFixed(4)})`)
console.log(`[163] from: (${m163.from.x.toFixed(3)},${m163.from.y.toFixed(3)},${m163.from.z.toFixed(4)})`)
console.log(`[162] is inter-path cut (tryDirectLink)`)
console.log(`[163-169] is what path? Let's check:`)
for (let i = 163; i < 170 && i < result.moves.length; i++) {
  const m = result.moves[i]
  console.log(`  [${i}] ${m.kind} (${m.from.x.toFixed(3)},${m.from.y.toFixed(3)},${m.from.z.toFixed(4)})→(${m.to.x.toFixed(3)},${m.to.y.toFixed(3)},${m.to.z.toFixed(4)})`)
}

// Check if [163-169] is a closed path
const start163 = result.moves[163].from
const end169 = result.moves[169].to
console.log(`\n[163-169] start: (${start163.x.toFixed(3)},${start163.y.toFixed(3)}) end: (${end169.x.toFixed(3)},${end169.y.toFixed(3)})`)
console.log(`Closed? ${Math.hypot(end169.x - start163.x, end169.y - start163.y) < 0.001}`)

// Now trace backward from [161] to find where this path started
console.log('\n=== TRACING PATH [144-161] ===')
// Find the start of this path by going backward from 161 to the last RAPID
let pathStart = 161
for (let i = 161; i >= 0; i--) {
  if (i > 0) {
    const prev = result.moves[i - 1]
    const curr = result.moves[i]
    if (prev.kind !== curr.kind || 
        Math.hypot(curr.from.x - prev.to.x, curr.from.y - prev.to.y) > 0.001) {
      pathStart = i
      break
    }
  }
}
console.log(`Path starts at move [${pathStart}]:`)
for (let i = pathStart; i <= 161; i++) {
  const m = result.moves[i]
  console.log(`  [${i}] (${m.from.x.toFixed(3)},${m.from.y.toFixed(3)},${m.from.z.toFixed(4)})→(${m.to.x.toFixed(3)},${m.to.y.toFixed(3)},${m.to.z.toFixed(4)})`)
}

// Also trace the path ending at [142]
console.log('\n=== TRACING PATH ENDING AT [142] ===')
let pathEnd = 142
for (let i = 142; i >= 0; i--) {
  if (i > 0) {
    const prev = result.moves[i - 1]
    const curr = result.moves[i]
    if (prev.kind !== curr.kind || 
        Math.hypot(curr.from.x - prev.to.x, curr.from.y - prev.to.y) > 0.001) {
      console.log(`Path [${i}]-[${pathEnd}]:`)
      for (let j = i; j <= pathEnd; j++) {
        const m = result.moves[j]
        console.log(`  [${j}] (${m.from.x.toFixed(3)},${m.from.y.toFixed(3)},${m.from.z.toFixed(4)})→(${m.to.x.toFixed(3)},${m.to.y.toFixed(3)},${m.to.z.toFixed(4)})`)
      }
      break
    }
  }
}
