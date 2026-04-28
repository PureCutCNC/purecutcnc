/**
 * Find Z direction reversals (zig-zag signature) across all v_carve_recursive operations.
 * Run: npx tsx scripts/find-zigzag-all.ts
 */
import fs from 'node:fs'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operations = project.operations.filter(o => o.kind === 'v_carve_recursive' && o.enabled !== false)

const THRESHOLD = 0.01  // min |dz| to count as a directional move

for (const operation of operations) {
  const result = generateVCarveRecursiveToolpath(project, operation)
  const cuts = result.moves.map((m, i) => ({ ...m, i })).filter(m => m.kind === 'cut')

  // Find consecutive cut pairs where Z direction reverses significantly
  const reversals: Array<{ i: number, j: number, dz1: number, dz2: number, z: number, xy: string }> = []
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k]
    const b = cuts[k + 1]
    // Only consider consecutive moves (no rapid between them)
    if (b.i !== a.i + 1) continue
    const dz1 = a.to.z - a.from.z
    const dz2 = b.to.z - b.from.z
    if (Math.abs(dz1) > THRESHOLD && Math.abs(dz2) > THRESHOLD && Math.sign(dz1) !== Math.sign(dz2)) {
      reversals.push({
        i: a.i, j: b.i,
        dz1, dz2,
        z: a.to.z,
        xy: `(${a.to.x.toFixed(3)},${a.to.y.toFixed(3)})`,
      })
    }
  }

  console.log(`\n${operation.id} (${operation.name}): ${reversals.length} reversals`)
  for (const r of reversals) {
    const kind = Math.abs(r.dz2) < 0.005 ? 'tiny-connector'
      : Math.abs(r.dz1) < 0.005 ? 'tiny-connector'
      : Math.abs(r.dz1 + r.dz2) < 0.005 ? 'back-and-forth'
      : 'direction-change'
    console.log(`  [${r.i}]->[${r.j}] dz=${r.dz1.toFixed(4)}->${r.dz2.toFixed(4)} at z=${r.z.toFixed(4)} ${r.xy} [${kind}]`)
  }
}
