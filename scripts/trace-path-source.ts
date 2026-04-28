/**
 * Trace which function produces each cut move by adding source tags to paths.
 * 
 * We monkey-patch the Path3D[] push to tag each path with its source,
 * then analyze the final move list.
 */
import fs from 'node:fs'
import { Project, ResolvedPocketRegion, Point, Point3D, Path3D, ToolpathMove, ToolpathPoint } from '../src/types/project.ts'

// We'll re-implement the analysis inline, reading the CAMJ directly.
const CAMJ_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const camjRaw = fs.readFileSync(CAMJ_PATH, 'utf-8')
const project: Project = JSON.parse(camjRaw)

// Find letter A operation (op0008)
const op = project.operations.find(o => o.id === 'op0008')!
const tool = project.tools.find(t => t.id === op.toolId)!

console.log(`Operation: ${op.name} (${op.kind})`)
console.log(`Tool: ${tool.name}`)

// Import and run
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'

// Monkey-patch arrays to track source tags
const pathSources: { pathIdx: number, source: string, first: Point3D, last: Point3D }[] = []
let pathIdxCounter = 0

const originalPush = Array.prototype.push
Array.prototype.push = function(...args: any[]) {
  for (const arg of args) {
    if (Array.isArray(arg) && arg.length >= 2 && typeof arg[0]?.x === 'number' && typeof arg[0]?.z === 'number') {
      // This looks like a Path3D being pushed
      const stack = new Error().stack || ''
      let source = 'unknown'
      if (stack.includes('bridgeSiblingChildren')) source = 'bridgeSiblingChildren'
      else if (stack.includes('bridgeSplitArms')) source = 'bridgeSplitArms'
      else if (stack.includes('stepArms')) source = 'stepArms'
      else if (stack.includes('emitCollapseGeometry')) source = 'emitCollapseGeometry'
      else if (stack.includes('buildInteriorCornerBridge')) source = 'buildInteriorCornerBridge'
      else if (stack.includes('buildFreshSeedBootstrapCuts')) source = 'buildFreshSeedBootstrapCuts'
      else if (stack.includes('buildCenterlineRescuePath')) source = 'buildCenterlineRescuePath'
      else if (stack.includes('traceRegion')) source = 'traceRegion'
      pathSources.push({
        pathIdx: pathIdxCounter++,
        source,
        first: arg[0],
        last: arg[arg.length - 1],
      })
    }
  }
  return originalPush.apply(this, args)
}

const result = generateVCarveRecursiveToolpath(project, op)

// Restore
Array.prototype.push = originalPush

console.log(`\nTotal moves: ${result.moves.length}`)
console.log(`Total paths tracked: ${pathSources.length}`)

// Find move [35] and trace its path source
const targetMove = result.moves[35]
if (targetMove) {
  console.log(`\n=== Move [35] ===`)
  console.log(`  kind=${targetMove.kind} from=(${targetMove.from.x.toFixed(4)},${targetMove.from.y.toFixed(4)},${targetMove.from.z.toFixed(4)}) to=(${targetMove.to.x.toFixed(4)},${targetMove.to.y.toFixed(4)},${targetMove.to.z.toFixed(4)})`)
  
  // Find all moves that overlap with move [35]'s coordinates
  const fromPt = { x: targetMove.from.x, y: targetMove.from.y, z: targetMove.from.z }
  const toPt = { x: targetMove.to.x, y: targetMove.to.y, z: targetMove.to.z }
  
  // Search pathSources for any path whose start or end matches these coordinates
  console.log(`\nLooking for path that starts or ends at these coordinates:`)
  for (const ps of pathSources) {
    const f = ps.first, l = ps.last
    const matchStart = Math.abs(f.x - fromPt.x) < 0.01 && Math.abs(f.y - fromPt.y) < 0.01 && Math.abs(f.z - fromPt.z) < 0.01
    const matchEnd = Math.abs(l.x - toPt.x) < 0.01 && Math.abs(l.y - toPt.y) < 0.01 && Math.abs(l.z - toPt.z) < 0.01
    const reverse = Math.abs(f.x - toPt.x) < 0.01 && Math.abs(f.y - toPt.y) < 0.01 && Math.abs(f.z - toPt.z) < 0.01 &&
                    Math.abs(l.x - fromPt.x) < 0.01 && Math.abs(l.y - fromPt.y) < 0.01 && Math.abs(l.z - fromPt.z) < 0.01
    if (matchStart || matchEnd || reverse) {
      console.log(`  path[${ps.pathIdx}] SOURCE=${ps.source} first=(${f.x.toFixed(4)},${f.y.toFixed(4)},${f.z.toFixed(4)}) last=(${l.x.toFixed(4)},${l.y.toFixed(4)},${l.z.toFixed(4)})`)
    }
  }
}

// Also find move [29] (the descending tryDirectLink cut)
const move29 = result.moves[29]
if (move29) {
  console.log(`\n=== Move [29] (tryDirectLink candidate) ===`)
  console.log(`  kind=${move29.kind} from=(${move29.from.x.toFixed(4)},${move29.from.y.toFixed(4)},${move29.from.z.toFixed(4)}) to=(${move29.to.x.toFixed(4)},${move29.to.y.toFixed(4)},${move29.to.z.toFixed(4)})`)
}

// Find all long flat cuts
console.log(`\n=== All long flat cuts (xy > 0.1, dz === 0) ===`)
for (let i = 0; i < result.moves.length; i++) {
  const m = result.moves[i]
  if (m.kind !== 'cut') continue
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  if (xy > 0.1 && Math.abs(dz) < 0.001) {
    // Find which path source produced this
    for (const ps of pathSources) {
      const f = ps.first, l = ps.last
      const nearStart = Math.hypot(f.x - m.from.x, f.y - m.from.y) < 0.01 && Math.abs(f.z - m.from.z) < 0.01
      const nearEnd = Math.hypot(l.x - m.to.x, l.y - m.to.y) < 0.01 && Math.abs(l.z - m.to.z) < 0.01
      if (nearStart && nearEnd) {
        console.log(`  [${i}] xy=${xy.toFixed(4)} z=${m.from.z.toFixed(4)} SOURCE=${ps.source}`)
        break
      }
    }
  }
}

// Show all paths that are long flat connections at z=0.5595
console.log(`\n=== All paths at z≈0.5595 ===`)
for (const ps of pathSources) {
  if (Math.abs(ps.first.z - 0.5595) < 0.001 || Math.abs(ps.last.z - 0.5595) < 0.001) {
    const f = ps.first, l = ps.last
    const xy = Math.hypot(l.x - f.x, l.y - f.y)
    console.log(`  path[${ps.pathIdx}] SOURCE=${ps.source} len=${xy.toFixed(4)} first=(${f.x.toFixed(4)},${f.y.toFixed(4)},${f.z.toFixed(4)}) last=(${l.x.toFixed(4)},${l.y.toFixed(4)},${l.z.toFixed(4)})`)
  }
}
