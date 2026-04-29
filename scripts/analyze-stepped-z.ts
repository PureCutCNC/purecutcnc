/**
 * Inspect the o and e paths for the stepped Z issue.
 * Run: npx tsx scripts/analyze-stepped-z.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project

for (const opId of ['op0046', 'op0012']) {
  const operation = project.operations.find(o => o.id === opId)!
  const result = generateVCarveRecursiveToolpath(project, operation)
  const moves = result.moves

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${opId} (${operation.name}) stepSize=${operation.stepover}`)
  console.log('='.repeat(60))

  // Find sequences where Z stays flat for multiple moves then jumps
  // This is the "stepped" pattern: tool moves at constant Z then snaps to new Z
  const cuts = moves.filter(m => m.kind === 'cut')

  // Look for flat-then-jump patterns
  console.log('\n--- Flat Z runs followed by Z jump ---')
  let flatStart = 0
  for (let i = 1; i <= cuts.length; i++) {
    const prev = cuts[i - 1]
    const curr = cuts[i]
    const dzPrev = Math.abs(prev.to.z - prev.from.z)
    const dzCurr = curr ? Math.abs(curr.to.z - curr.from.z) : Infinity

    // End of a flat run
    if (dzPrev < 0.001 && dzCurr >= 0.005) {
      const runLen = i - flatStart
      if (runLen >= 3) {
        const jump = curr ? (curr.to.z - curr.from.z) : 0
        console.log(`  flat run [${cuts[flatStart].i ?? flatStart}..${cuts[i-1].i ?? i-1}] len=${runLen} z=${prev.to.z.toFixed(4)} then jump dz=${jump.toFixed(4)}`)
      }
    }
    if (dzPrev >= 0.005) flatStart = i
  }

  // Show the first 60 cut moves with Z profile
  console.log('\n--- First 60 cut moves Z profile ---')
  let cutCount = 0
  for (let i = 0; i < moves.length && cutCount < 60; i++) {
    const m = moves[i]
    if (m.kind !== 'cut') continue
    cutCount++
    const dz = m.to.z - m.from.z
    const xy = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y)
    const dzStr = Math.abs(dz) < 0.001 ? '  flat' : dz > 0 ? `  +${dz.toFixed(4)}` : `  ${dz.toFixed(4)}`
    console.log(`  [${String(i).padStart(3)}] z:${m.from.z.toFixed(4)}->${m.to.z.toFixed(4)}${dzStr}  xy=${xy.toFixed(4)}`)
  }
}
