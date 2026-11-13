/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * #1173: the block-time, Z-flip and in-ring-break counts of one rotary
 * operation, from its generated moves (an inch project, feed in ipm).
 *
 * Usage:
 *   npx tsx scripts/issue-1173-block-counter.ts <project.camj> <op id>
 *
 * Block time is the inverse-time model the export uses: the move's length --
 * along, Z and the arc at the larger tip radius -- over the operation's feed.
 * The first JSON line has the counts; the second the commanded A-rate ratio
 * between adjacent blocks of one run. Optional switches (environment):
 * NO_HEX=1 drops feature f0184 (Frank's Hex); SHOW_FLIPS, SHOW_TINY, SHOW_RATIO
 * list the offending moves; SHOW_TURN=<along> dumps one ring or turn.
 */
import { readFileSync } from 'node:fs'
import { normalizeProject } from '../src/store/helpers/projectFormat'
import { computeOperationToolpath } from '../src/engine/toolpaths/generateOperation'
import { barPivotZ, barMaxRadius } from '../src/types/barStock'
const project = normalizeProject(JSON.parse(readFileSync(process.argv[2], 'utf8')))
if (process.env.NO_HEX) (project as { features: unknown[] }).features = project.features.filter((f) => f.id !== "f0184")
const op = project.operations.find((o) => o.id === (process.argv[3] ?? 'op0197'))!
const t0 = performance.now()
const env = computeOperationToolpath(project, op)!
const ms = performance.now() - t0
const moves = env.result.moves
const pivot = barPivotZ(project.stock as never); const top = barMaxRadius(project.stock as never)
const feed = op.feed ?? 30
let tiny = 0, tinyOverlap = 0, flips = 0, breaks = 0, maxRatio = 0, maxRatioOverlap = 0
const overlapMax = 1.25 + 0.125 + 0.02 + 0.04 + 0.08 // hex end + R + leave + cell + stepover
const times: number[] = []
const rotCut = moves.filter((m) => m.kind === 'cut' && m.from.a !== undefined && Math.abs((m.to.a ?? 0) - (m.from.a ?? 0)) > 1e-9)
for (const m of rotCut) {
  const r = Math.max(m.from.z, m.to.z) - pivot
  const len = Math.hypot(m.to.x - m.from.x, m.to.z - m.from.z, r * ((m.to.a! - m.from.a!) * Math.PI / 180))
  times.push(len / feed * 60)
}
for (let i = 0; i < rotCut.length; i++) {
  const t = times[i]; const inOv = rotCut[i].to.x <= overlapMax
  if (t < 0.010) { tiny++; if (inOv) tinyOverlap++ }
  if (i > 0 && rotCut[i - 1].to.x === rotCut[i].from.x && rotCut[i - 1].to.a === rotCut[i].from.a) {
    const ratio = Math.max(t, times[i - 1]) / Math.min(t, times[i - 1])
    if (Math.min(t, times[i - 1]) < 0.05) { maxRatio = Math.max(maxRatio, ratio); if (inOv) maxRatioOverlap = Math.max(maxRatioOverlap, ratio) }
  }
  if (i > 1) {
    const a = rotCut[i - 2], b = rotCut[i - 1], c = rotCut[i]
    if (a.to.x === b.to.x && b.to.x === c.to.x && a.to.a === b.from.a && b.to.a === c.from.a) {
      const d1 = b.to.z - b.from.z, d2 = c.to.z - c.from.z
      if (d1 * d2 < 0 && Math.abs(d1) > 0.1 / 25.4 && Math.abs(d2) > 0.1 / 25.4) flips++
    }
  }
}
// breaks: a move up to >= bar top (travel height) and back down at the same along position, inside a layer
for (let i = 0; i + 2 < moves.length; i++) {
  const up = moves[i]
  if (up.to.z - pivot >= top - 1e-9 && up.from.z - pivot < top - 1e-9 && Math.abs(up.to.x - up.from.x) < 1e-9) {
    // find the next move that comes down at the same along position
    let j = i + 1
    while (j < moves.length && moves[j].to.z - pivot >= top - 1e-9) j++
    if (j < moves.length && Math.abs(moves[j].to.x - up.from.x) < 1e-9 && moves[j].to.a !== up.from.a) breaks++
  }
}
console.log(JSON.stringify({ op: op.id, ms: Math.round(ms), moves: moves.length, rotCuts: rotCut.length, flipsOver01mm: flips, blocksUnder10ms: tiny, inOverlap: tinyOverlap, maxAdjRatioWithShortBlock: +maxRatio.toFixed(1), overlap: +maxRatioOverlap.toFixed(1), sameRingBreaks: breaks, minBlockMs: +(Math.min(...times) * 1000).toFixed(2) }))
if (process.env.SHOW_FLIPS) for (let i = 2; i < rotCut.length; i++) {
  const a = rotCut[i - 2], b = rotCut[i - 1], c = rotCut[i]
  if (a.to.x === b.to.x && b.to.x === c.to.x && a.to.a === b.from.a && b.to.a === c.from.a) {
    const d1 = b.to.z - b.from.z, d2 = c.to.z - c.from.z
    if (d1 * d2 < 0 && Math.abs(d1) > 0.1 / 25.4 && Math.abs(d2) > 0.1 / 25.4) console.log('flip at x', b.to.x.toFixed(4), 'A', a.to.a!.toFixed(2), b.to.a!.toFixed(2), c.to.a!.toFixed(2), 'tips', [a.to, b.to, c.to].map((p) => (p.z - pivot).toFixed(4)).join(' '))
  }
}
if (process.env.SHOW_TINY) {
  const byA = new Map<number, number>(); const byX = new Map<string, number>(); const dAs: number[] = []
  const samples: string[] = []
  for (let i = 0; i < rotCut.length; i++) if (times[i] < 0.010) {
    const m = rotCut[i]; const a = Math.round(((m.to.a! % 360) + 360) % 360)
    byA.set(a, (byA.get(a) ?? 0) + 1); const xk = (Math.round(m.to.x * 20) / 20).toFixed(2); byX.set(xk, (byX.get(xk) ?? 0) + 1)
    dAs.push(Math.abs(m.to.a! - m.from.a!))
    if (samples.length < 12) samples.push(`x${m.from.x.toFixed(4)}->${m.to.x.toFixed(4)} A${m.from.a!.toFixed(3)}->${m.to.a!.toFixed(3)} tip ${(m.from.z - pivot).toFixed(4)}->${(m.to.z - pivot).toFixed(4)} ${(times[i] * 1000).toFixed(2)}ms`)
  }
  console.log('tiny by A(deg):', [...byA.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([a, n]) => `${a}:${n}`).join(' '))
  console.log('tiny by along(0.05in):', [...byX.entries()].sort().map(([a, n]) => `${a}:${n}`).join(' '))
  dAs.sort((a, b) => a - b); console.log('dA quantiles', dAs[0]?.toFixed(4), dAs[dAs.length >> 1]?.toFixed(4), dAs[dAs.length - 1]?.toFixed(4))
  samples.forEach((s) => console.log('  ', s))
}
if (process.env.SHOW_TURN) {
  const x0 = Number(process.env.SHOW_TURN)
  let n = 0; const out: string[] = []
  for (let i = 0; i < rotCut.length && n < 400; i++) {
    const m = rotCut[i]
    if (m.from.x >= x0 && m.from.x < x0 + 0.08) { n++; out.push(`${(((m.from.a! % 360) + 360) % 360).toFixed(2)}+${(m.to.a! - m.from.a!).toFixed(3)} ${(m.to.z - pivot).toFixed(5)} ${(times[i] * 1000).toFixed(1)}`) }
  }
  console.log(out.join(' | '))
}
if (process.env.SHOW_RATIO) {
  let n = 0
  for (let i = 1; i < rotCut.length; i++) {
    const p = rotCut[i - 1], c = rotCut[i]
    if (!(p.to.x === c.from.x && p.to.a === c.from.a)) continue
    const s = Math.min(times[i], times[i - 1]), l = Math.max(times[i], times[i - 1])
    if (s < 0.05 && l / s > 5) {
      n++
      if (n <= 12) console.log(`ratio ${(l / s).toFixed(1)} x${c.from.x.toFixed(4)} A${p.from.a!.toFixed(2)}+${(p.to.a! - p.from.a!).toFixed(3)} (${(times[i - 1] * 1000).toFixed(1)}ms, dz ${(p.to.z - p.from.z).toFixed(4)}) then +${(c.to.a! - c.from.a!).toFixed(3)} (${(times[i] * 1000).toFixed(1)}ms, dz ${(c.to.z - c.from.z).toFixed(4)})`)
    }
  }
  console.log('pairs violating ratio>5 with short<50ms:', n)
}
{
  // A-speed (deg/s) change between adjacent blocks of one run
  const rates = rotCut.map((m, i) => Math.abs(m.to.a! - m.from.a!) / times[i])
  let worst = 1, over2 = 0, over15 = 0
  for (let i = 1; i < rotCut.length; i++) {
    const p = rotCut[i - 1], c = rotCut[i]
    if (!(p.to.x === c.from.x && p.to.a === c.from.a)) continue
    const r = Math.max(rates[i], rates[i - 1]) / Math.min(rates[i], rates[i - 1])
    worst = Math.max(worst, r); if (r > 2) over2++; if (r > 1.5) over15++
  }
  console.log(JSON.stringify({ aRateWorstAdjRatio: +worst.toFixed(2), pairsOver1_5: over15, pairsOver2: over2 }))
}
