/**
 * Debug letter A (op0008) — trace cross-cut lines back to source.
 * Run: npx tsx scripts/debug-letter-a.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((o) => o.id === 'op0008') as Operation
const result = generateVCarveRecursiveToolpath(project, operation)
const moves = result.moves

console.log(`op0008 letter A: totalMoves=${moves.length}`)

// Group consecutive cut moves by Z level (and direction)
interface Segment {
  startIdx: number
  endIdx: number
  count: number
  zRange: [number, number]  // [min, max]
  xyExtent: number          // total XY travel
  avgXY: { x: number, y: number }
  kind: 'descending' | 'rising' | 'flat' | 'mixed'
  direction: string
  xyStart: { x: number, y: number }
  xyEnd: { x: number, y: number }
}

const segments: Segment[] = []
let i = 0
while (i < moves.length) {
  if (moves[i].kind !== 'cut') { i++; continue }
  const startIdx = i
  let minZ = moves[i].from.z, maxZ = moves[i].from.z
  let totalXY = 0
  let sumX = 0, sumY = 0, count = 0
  let upCount = 0, dnCount = 0, flatCount = 0
  while (i < moves.length && moves[i].kind === 'cut') {
    const m = moves[i]
    minZ = Math.min(minZ, m.from.z, m.to.z)
    maxZ = Math.max(maxZ, m.from.z, m.to.z)
    totalXY += Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    sumX += m.from.x; sumY += m.from.y; count++
    const dz = m.to.z - m.from.z
    if (dz > 0.002) upCount++
    else if (dz < -0.002) dnCount++
    else flatCount++
    i++
  }
  const endIdx = i - 1
  let kind: Segment['kind'] = 'flat'
  if (upCount > dnCount && upCount > flatCount) kind = 'rising'
  else if (dnCount > upCount && dnCount > flatCount) kind = 'descending'
  
  segments.push({
    startIdx, endIdx, count,
    zRange: [minZ, maxZ],
    xyExtent: totalXY,
    avgXY: { x: sumX / count, y: sumY / count },
    kind,
    direction: upCount > 0 ? (dnCount > 0 ? 'UP/DN' : 'UP') : (dnCount > 0 ? 'DN' : '--'),
    xyStart: { x: moves[startIdx].from.x, y: moves[startIdx].from.y },
    xyEnd: { x: moves[endIdx].to.x, y: moves[endIdx].to.y },
  })
}

// Print segments
console.log('\n=== Cut segments grouped by continuity ===')
for (const seg of segments) {
  const zSpan = (seg.zRange[1] - seg.zRange[0]).toFixed(4)
  console.log(`[${String(seg.startIdx).padStart(3)}-${String(seg.endIdx).padStart(3)}] ${seg.kind.padEnd(10)} z=[${seg.zRange[0].toFixed(4)},${seg.zRange[1].toFixed(4)}] span=${zSpan} xy=${seg.xyExtent.toFixed(4)} dir=${seg.direction}`)
}

// Find links between segments — these are tryDirectLink connections
// A link is when the last point of segment N doesn't match the first point of segment N+1
console.log('\n=== Inter-segment links (gaps > 0.01 XY) ===')
for (let s = 0; s < segments.length - 1; s++) {
  const a = segments[s]
  const b = segments[s + 1]
  const mEnd = moves[a.endIdx]
  const mStart = moves[b.startIdx]
  const xyGap = Math.hypot(mStart.from.x - mEnd.to.x, mStart.from.y - mEnd.to.y)
  const zGap = Math.abs(mStart.from.z - mEnd.to.z)
  if (xyGap > 0.01 || zGap > 0.01) {
    console.log(`[${a.endIdx}]→[${b.startIdx}] xyGap=${xyGap.toFixed(4)} zGap=${zGap.toFixed(4)}`)
    console.log(`  end: (${mEnd.to.x.toFixed(4)},${mEnd.to.y.toFixed(4)},${mEnd.to.z.toFixed(4)})`)
    console.log(`  start: (${mStart.from.x.toFixed(4)},${mStart.from.y.toFixed(4)},${mStart.from.z.toFixed(4)})`)
  }
}

// Identify long flat cuts (xyDist > 0.1) that cross the interior
console.log('\n=== Long flat cuts (xyDist > 0.1, flat Z) ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  if (xy > 0.1 && Math.abs(dz) < 0.01) {
    console.log(`[${i}] xy=${xy.toFixed(4)} z=${m.from.z.toFixed(4)} from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)})`)
    // Show context: 2 moves before and after
    for (let j = Math.max(0, i-2); j <= Math.min(moves.length-1, i+2); j++) {
      const ctx = moves[j]
      const xyCtx = Math.hypot(ctx.to.x - ctx.from.x, ctx.to.y - ctx.from.y)
      const dzCtx = ctx.to.z - ctx.from.z
      console.log(`  ${j === i ? '>>>' : '   '}[${j}] ${ctx.kind} z=${ctx.from.z.toFixed(4)}→${ctx.to.z.toFixed(4)} xy=${xyCtx.toFixed(4)} dz=${dzCtx.toFixed(4)} (${ctx.from.x.toFixed(4)},${ctx.from.y.toFixed(4)})→(${ctx.to.x.toFixed(4)},${ctx.to.y.toFixed(4)})`)
    }
  }
}

// Identify long descending cuts (xyDist > 0.05, dz < -0.02)
console.log('\n=== Long descending cuts (xyDist > 0.05, dz < -0.02) ===')
for (let i = 0; i < moves.length; i++) {
  const m = moves[i]
  if (m.kind !== 'cut') continue
  const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
  const dz = m.to.z - m.from.z
  if (xy > 0.05 && dz < -0.02) {
    const slope = Math.abs(dz) / xy
    const vbitSlope = Math.tan(30 * Math.PI / 180) // 0.577 for 60° V-bit
    const exceedsVBit = slope > vbitSlope
    console.log(`[${i}] ${exceedsVBit ? '***EXCEEDS V-BIT***' : ''} xy=${xy.toFixed(4)} dz=${dz.toFixed(4)} slope=${slope.toFixed(4)} (vbit=${vbitSlope.toFixed(4)})`)
    console.log(`  from=(${m.from.x.toFixed(4)},${m.from.y.toFixed(4)},${m.from.z.toFixed(4)}) to=(${m.to.x.toFixed(4)},${m.to.y.toFixed(4)},${m.to.z.toFixed(4)})`)
    // Show context
    for (let j = Math.max(0, i-2); j <= Math.min(moves.length-1, i+2); j++) {
      const ctx = moves[j]
      const xyCtx = Math.hypot(ctx.to.x - ctx.from.x, ctx.to.y - ctx.from.y)
      const dzCtx = ctx.to.z - ctx.from.z
      console.log(`  ${j === i ? '>>>' : '   '}[${j}] ${ctx.kind} z=${ctx.from.z.toFixed(4)}→${ctx.to.z.toFixed(4)} xy=${xyCtx.toFixed(4)} dz=${dzCtx.toFixed(4)}`)
    }
  }
}

// Check if bridgeSiblingChildren paths are the source of flat cross-cuts
// by looking for patterns: long flat cut, short flat cut, long flat cut back
console.log('\n=== Back-and-forth patterns (bridgeSiblingChildren candidates) ===')
for (let i = 0; i < moves.length - 2; i++) {
  const ma = moves[i], mb = moves[i+1], mc = moves[i+2]
  if (ma.kind !== 'cut' || mb.kind !== 'cut' || mc.kind !== 'cut') continue
  const xyA = Math.hypot(ma.to.x - ma.from.x, ma.to.y - ma.from.y)
  const xyB = Math.hypot(mb.to.x - mb.from.x, mb.to.y - mb.from.y)
  const xyC = Math.hypot(mc.to.x - mc.from.x, mc.to.y - mc.from.y)
  if (xyA > 0.1 && xyC > 0.1 && xyB < 0.03) {
    const dzA = ma.to.z - ma.from.z, dzC = mc.to.z - mc.from.z
    if (Math.abs(dzA) < 0.01 && Math.abs(dzC) < 0.01) {
      console.log(`[${i}]→[${i+2}] flat back-and-forth at z=${ma.from.z.toFixed(4)} spans: ${xyA.toFixed(4)}+${xyC.toFixed(4)}`)
      console.log(`  [${i}] (${ma.from.x.toFixed(4)},${ma.from.y.toFixed(4)})→(${ma.to.x.toFixed(4)},${ma.to.y.toFixed(4)})`)
      console.log(`  [${i+1}] (${mb.from.x.toFixed(4)},${mb.from.y.toFixed(4)})→(${mb.to.x.toFixed(4)},${mb.to.y.toFixed(4)})`)
      console.log(`  [${i+2}] (${mc.from.x.toFixed(4)},${mc.from.y.toFixed(4)})→(${mc.to.x.toFixed(4)},${mc.to.y.toFixed(4)})`)
    }
  }
}
