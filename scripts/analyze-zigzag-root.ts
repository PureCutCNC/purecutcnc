/**
 * Focused analysis of the two zig-zag types to understand their exact origin in chainPaths.
 * Run: npx tsx scripts/analyze-zigzag-root.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project

// -----------------------------------------------------------------------
// PROBLEM 1: back-and-forth / interleaved chains
// Example: letter e moves [160]->[163], letter C moves [176]->[179]
//
// Pattern: two 2-point arm segments [A->B] and [C->B] (or [B->C] and [B->D])
// share endpoint B. chainPaths chains them: ...->A->B->C->B->D->...
// producing a back-and-forth at B.
//
// Root cause in chainPaths:
//   byStart maps B -> segment [B->C]
//   byEnd   maps B -> segment [A->B]
//   When building the chain for [A->B], it appends [B->C] (found via byStart[B])
//   Then tries byStart[C] — finds [C->B] (another arm that ends at B)
//   Appends it: A->B->C->B
//   This is a cycle through B.
//
// The fix: in chainPaths, when walking forward, check that the next segment's
// endpoint is not already in the current chain (cycle detection).
// -----------------------------------------------------------------------

console.log('=== PROBLEM 1: back-and-forth analysis ===\n')

// Letter e, cluster at moves [160-163]
{
  const operation = project.operations.find(o => o.id === 'op0012')!
  const result = generateVCarveRecursiveToolpath(project, operation)
  const moves = result.moves

  console.log('Letter e, moves [160-163]:')
  for (let i = 160; i <= 163; i++) {
    const m = moves[i]
    console.log(`  [${i}] from=(${m.from.x.toFixed(6)},${m.from.y.toFixed(6)},${m.from.z.toFixed(6)}) to=(${m.to.x.toFixed(6)},${m.to.y.toFixed(6)},${m.to.z.toFixed(6)})`)
  }
  // The pivot point B = moves[160].to = moves[161].from = moves[162].to = moves[163].from?
  const B = moves[160].to
  console.log(`  Pivot B = (${B.x.toFixed(6)},${B.y.toFixed(6)},${B.z.toFixed(6)})`)
  console.log(`  [161].from == B: ${moves[161].from.x === B.x && moves[161].from.y === B.y && moves[161].from.z === B.z}`)
  console.log(`  [162].to == [161].from: ${moves[162].to.x === moves[161].from.x && moves[162].to.y === moves[161].from.y && moves[162].to.z === moves[161].from.z}`)
  console.log(`  [163].from == [162].to: ${moves[163].from.x === moves[162].to.x && moves[163].from.y === moves[162].to.y && moves[163].from.z === moves[162].to.z}`)
  // So the chain is: [160]: X->B, [161]: B->C, [162]: C->B, [163]: B->X (back to start)
  // This is a cycle: X->B->C->B->X
  // chainPaths should detect that B is already visited and stop
  console.log(`  Chain: [160]X->B, [161]B->C, [162]C->B (back to B!), [163]B->?`)
  console.log(`  => chainPaths walks into a cycle at B`)
}

// -----------------------------------------------------------------------
// PROBLEM 2: direction-change / arm tip to deep end of next chain
// Example: letter T moves [37]->[38], [79]->[80], [87]->[88], [151]->[152]
//
// Pattern: arm chain ends at maxZ (0.75). tryDirectLink fires a direct cut
// to the start of the next path. The next path starts at a deep Z and
// continues descending — it's a different arm chain going in the opposite
// direction (from shallow to deep, entered from its deep end).
//
// Wait — the analysis shows "Rises immediately after: false" for all of these.
// So the next path is NOT entered from the wrong end. It's a genuine arm chain
// that starts deep and continues descending. The issue is that the arm tip at
// maxZ is being directly linked to a path that starts at a LOWER Z, creating
// a large sudden descent.
//
// Let's look at T [151]->[152] more carefully: dz=-0.2442, xy=0.2139
// The arm tip is at z=0.75, the next path starts at z=0.5058.
// The next path then rises: 0.5058 -> 0.5075 -> 0.5248 -> ...
// So it IS rising after the drop — but the drop itself is large.
//
// The real question: is the next path's entry point (z=0.5058) the correct
// Z for that XY location? Or is it a wrong-end entry where the path should
// have been entered from its other end (which would be at a higher Z)?
// -----------------------------------------------------------------------

console.log('\n=== PROBLEM 2: direction-change analysis ===\n')

{
  const operation = project.operations.find(o => o.id === 'op0009')!
  const result = generateVCarveRecursiveToolpath(project, operation)
  const moves = result.moves

  // T letter [151]->[152]: dz=-0.2442
  console.log('Letter T, moves [148-160]:')
  for (let i = 148; i <= 160; i++) {
    const m = moves[i]
    const dz = m.to.z - m.from.z
    const dir = dz > 0.01 ? 'UP' : dz < -0.01 ? 'DN' : '--'
    console.log(`  [${String(i).padStart(3)}] ${m.kind.padEnd(6)} ${dir} z:${m.from.z.toFixed(4)}->${m.to.z.toFixed(4)} xy=${Math.hypot(m.to.x-m.from.x,m.to.y-m.from.y).toFixed(4)}`)
  }

  // The path starting at [152] goes: 0.5058 -> 0.5075 -> 0.5248 -> 0.5422 -> ...
  // This is a rising arm chain. Its entry at z=0.5058 is the SHALLOW end.
  // The arm tip at [151] is at z=0.75 (maxZ).
  // tryDirectLink: pos.z=0.75, entry.z=0.5058, descent=0.1942
  // xyDist=0.2139, depthBudget = safeZ - min(0.75, 0.5058) = 0.95 - 0.5058 = 0.4442
  // 0.2139 < 0.4442 => approved
  // So this IS a wrong-end entry: the path [152..] rises from 0.5058 upward,
  // meaning its OTHER end (the deep end) is at a higher Z. Wait, no — if it
  // rises from 0.5058, then 0.5058 IS the shallow end (lowest Z = deepest cut).
  // The arm tip at 0.75 is shallower than 0.5058... no wait, higher Z = shallower cut.
  // z=0.75 = surface level (shallowest), z=0.5058 = deeper cut.
  // So the arm tip is at the surface and the next path starts at a deeper cut.
  // The path then rises (goes shallower) from 0.5058 toward 0.75.
  // This means the path was entered from its DEEP end and traversed toward shallow.
  // The other end of the path would be at a higher Z (shallower) — closer to 0.75.
  // sortPathsNearestNeighbor should have picked the shallow end (high Z) as entry
  // since the current position is at z=0.75.

  console.log('\nAnalysis of T [151]->[152]:')
  const m151 = moves[151], m152 = moves[152]
  console.log(`  Arm tip: z=${m151.to.z.toFixed(4)} at (${m151.to.x.toFixed(4)},${m151.to.y.toFixed(4)})`)
  console.log(`  Next path entry: z=${m152.from.z.toFixed(4)} at (${m152.from.x.toFixed(4)},${m152.from.y.toFixed(4)})`)
  // Find the other end of the path starting at [152]
  let i = 152
  while (i < moves.length - 1 && moves[i+1].kind === 'cut' && moves[i+1].i === undefined) i++
  // Just scan forward until a non-cut or a rapid
  let j = 152
  while (j < moves.length - 1 && moves[j+1].kind === 'cut') j++
  const pathEnd = moves[j]
  console.log(`  Path end (move [${j}]): z=${pathEnd.to.z.toFixed(4)} at (${pathEnd.to.x.toFixed(4)},${pathEnd.to.y.toFixed(4)})`)
  const xyToStart = Math.hypot(m152.from.x - m151.to.x, m152.from.y - m151.to.y)
  const xyToEnd = Math.hypot(pathEnd.to.x - m151.to.x, pathEnd.to.y - m151.to.y)
  console.log(`  XY dist from arm tip to path START: ${xyToStart.toFixed(4)}`)
  console.log(`  XY dist from arm tip to path END:   ${xyToEnd.toFixed(4)}`)
  console.log(`  Z dist from arm tip to path START: ${Math.abs(m151.to.z - m152.from.z).toFixed(4)}`)
  console.log(`  Z dist from arm tip to path END:   ${Math.abs(m151.to.z - pathEnd.to.z).toFixed(4)}`)
  console.log(`  => sortPathsNearestNeighbor picked the end with smaller XY dist`)
  console.log(`  => But the path END has Z closer to arm tip (${Math.abs(m151.to.z - pathEnd.to.z).toFixed(4)} vs ${Math.abs(m151.to.z - m152.from.z).toFixed(4)})`)
  console.log(`  => Fix: prefer the end whose Z is closer to current Z when choosing path entry`)
}

console.log('\n=== SUMMARY ===')
console.log('Problem 1 (back-and-forth): chainPaths walks into a cycle.')
console.log('  Two arm segments share a common endpoint B: [A->B] and [C->B].')
console.log('  chainPaths chains them as A->B->C->B, visiting B twice.')
console.log('  Fix: in chainPaths forward walk, stop if the candidate next segment')
console.log('  would bring us to a point already in the current chain (cycle guard).')
console.log('')
console.log('Problem 2 (direction-change): sortPathsNearestNeighbor picks the wrong end.')
console.log('  An arm tip at maxZ is linked to the deep end of a rising arm chain.')
console.log('  The path should be entered from its shallow end (high Z, close to maxZ).')
console.log('  Fix: in sortPathsNearestNeighbor end-selection, prefer the end whose Z')
console.log('  is closer to the current Z, not just the end closer in XY.')
