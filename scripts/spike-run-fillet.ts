/**
 * Spike: size run-based corner filleting.
 *
 * Today's fillet is applied PER VERTEX and clamped to half the shorter adjacent
 * edge. On real geometry a corner is a RUN of short tessellated segments, so the
 * clamp collapses the fillet to a fraction of what was asked for (~7% on
 * pocket-feed-reduction). This prototype instead detects a corner as a run of
 * turning vertices, finds the virtual apex where the entry and exit tangents
 * meet, and replaces the whole run with ONE arc.
 *
 * Timing isolates the corner-velocity effect: all three variants are timed over
 * ring polylines only (no links, no entries) at a constant programmed feed with
 * no engagement feed scaling, so the only difference is corner geometry.
 */
import { readFileSync } from 'node:fs'
import { generatePocketToolpath } from '../src/engine/toolpaths/pocket'
import { normalizeProject } from '../src/store/helpers/projectFormat'
import type { Operation, Project } from '../src/types/project'
import type { ToolpathMove } from '../src/engine/toolpaths/types'

const ACCEL = 500, JD = 0.01
const FEEDS = [800, 2000, 4000]
interface P { x: number; y: number }

function rings(moves: ToolpathMove[]): P[][] {
  const out: P[][] = []
  let cur: P[] = []
  for (const m of moves) {
    if (m.kind !== 'cut') { if (cur.length >= 3) out.push(cur); cur = []; continue }
    if (cur.length === 0) cur.push({ x: m.from.x, y: m.from.y })
    cur.push({ x: m.to.x, y: m.to.y })
  }
  if (cur.length >= 3) out.push(cur)
  return out
}

const norm = (x: number, y: number): P => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l } }

/** Replace each run of turning vertices with a single tangent arc of radius R. */
function runFillet(input: P[], R: number, arcStep = 0.15): P[] {
  // `rings()` repeats the closing vertex; cyclic indexing must not see it twice
  // or the seam yields a zero-length edge and a garbage turn angle.
  const closed = input.length > 1
    && Math.hypot(input[0].x - input[input.length - 1].x, input[0].y - input[input.length - 1].y) < 1e-9
  const poly = closed ? input.slice(0, -1) : input
  const n = poly.length
  if (n < 4 || R <= 0) return input
  const turn: number[] = []
  for (let i = 0; i < n; i += 1) {
    const p = poly[(i - 1 + n) % n], c = poly[i], q = poly[(i + 1) % n]
    const u = norm(c.x - p.x, c.y - p.y), v = norm(q.x - c.x, q.y - c.y)
    turn.push(Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y))
  }
  const TURNING = 0.5 * Math.PI / 180
  const CORNER = 20 * Math.PI / 180
  // Maximal runs of consecutive turning vertices.
  const runs: Array<{ s: number; e: number; total: number }> = []
  let i = 0
  while (i < n) {
    if (Math.abs(turn[i]) <= TURNING) { i += 1; continue }
    let j = i, total = 0
    while (j < n && Math.abs(turn[j]) > TURNING) { total += turn[j]; j += 1 }
    if (Math.abs(total) > CORNER) runs.push({ s: i, e: j - 1, total })
    i = j
  }
  if (runs.length === 0) return input
  const replaced = new Map<number, P[] | null>()
  for (const run of runs) {
    const before = poly[(run.s - 1 + n) % n], first = poly[run.s]
    const last = poly[run.e], after = poly[(run.e + 1) % n]
    const uIn = norm(first.x - before.x, first.y - before.y)
    const uOut = norm(after.x - last.x, after.y - last.y)
    const cross = uIn.x * uOut.y - uIn.y * uOut.x
    const dot = uIn.x * uOut.x + uIn.y * uOut.y
    const theta = Math.atan2(cross, dot)
    // A near-reversal is not a corner — it is a slot turnaround. Filleting it
    // yields a hairpin (tiny radius over a ~180 degree sweep), which is far
    // worse than leaving it alone.
    const REVERSAL = 150 * Math.PI / 180
    if (Math.abs(theta) < CORNER || Math.abs(theta) > REVERSAL) continue
    // Virtual apex: intersection of the entry line (through `before`) and exit
    // line (through `after`).
    const den = uIn.x * uOut.y - uIn.y * uOut.x
    if (Math.abs(den) < 1e-12) continue
    const wx = after.x - before.x, wy = after.y - before.y
    const t = (wx * uOut.y - wy * uOut.x) / den
    const apex = { x: before.x + uIn.x * t, y: before.y + uIn.y * t }
    // The apex must lie AHEAD of `before` along the entry direction and BEHIND
    // `after` along the exit direction. Otherwise the tangent points land behind
    // the path and the emitted arc doubles back — a 180 degree reversal.
    if ((apex.x - before.x) * uIn.x + (apex.y - before.y) * uIn.y <= 0) continue
    if ((after.x - apex.x) * uOut.x + (after.y - apex.y) * uOut.y <= 0) continue
    const half = (Math.PI - Math.abs(theta)) / 2
    const tanDist = R / Math.tan(half)
    // Clamp to the straight available either side of the run.
    const availIn = Math.hypot(apex.x - before.x, apex.y - before.y)
    const availOut = Math.hypot(after.x - apex.x, after.y - apex.y)
    const d = Math.min(tanDist, availIn * 0.9, availOut * 0.9)
    if (!(d > 1e-6)) continue
    const rEff = d * Math.tan(half)
    // Too little room to be worth it: keep the original vertices.
    if (rEff < 0.2 * R) continue
    const t1 = { x: apex.x - uIn.x * d, y: apex.y - uIn.y * d }
    const t2 = { x: apex.x + uOut.x * d, y: apex.y + uOut.y * d }
    const sign = Math.sign(theta)
    const nIn = { x: -uIn.y * sign, y: uIn.x * sign }
    const centre = { x: t1.x + nIn.x * rEff, y: t1.y + nIn.y * rEff }
    const a1 = Math.atan2(t1.y - centre.y, t1.x - centre.x)
    const a2 = Math.atan2(t2.y - centre.y, t2.x - centre.x)
    let sweep = a2 - a1
    while (sweep > Math.PI) sweep -= 2 * Math.PI
    while (sweep < -Math.PI) sweep += 2 * Math.PI
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / arcStep))
    const arc: P[] = []
    for (let k = 0; k <= steps; k += 1) {
      const a = a1 + (sweep * k) / steps
      arc.push({ x: centre.x + rEff * Math.cos(a), y: centre.y + rEff * Math.sin(a) })
    }
    replaced.set(run.s, arc)
    for (let k = run.s + 1; k <= run.e; k += 1) replaced.set(k, null)
  }
  const out: P[] = []
  for (let k = 0; k < n; k += 1) {
    if (!replaced.has(k)) { out.push(poly[k]); continue }
    const arc = replaced.get(k)
    if (arc) out.push(...arc)
  }
  if (closed && out.length > 0) out.push({ x: out[0].x, y: out[0].y })
  return out
}

function junctionVelocity(phi: number): number {
  const sa = Math.sin((Math.PI - phi) / 2)
  if (sa >= 1 - 1e-12) return Infinity
  if (sa <= 1e-12) return 0
  return Math.sqrt(ACCEL * (JD * sa / (1 - sa)))
}

function timeMin(polys: P[][], feed: number, scale: number): number {
  const fps = feed / 60
  let t = 0
  for (const poly of polys) {
    let px: number | null = null, py: number | null = null
    for (let i = 0; i < poly.length - 1; i += 1) {
      const ux = (poly[i + 1].x - poly[i].x) * scale, uy = (poly[i + 1].y - poly[i].y) * scale
      const L = Math.hypot(ux, uy)
      if (L <= 0) continue
      let v = fps
      if (px !== null && py !== null) {
        const phi = Math.abs(Math.atan2(px * uy - py * ux, px * ux + py * uy))
        v = Math.min(fps, Math.max(junctionVelocity(phi), 0.05))
      }
      t += L / v
      px = ux; py = uy
    }
  }
  return t / 60
}

const file = process.argv[2] ?? 'src/engine/test-fixtures/pocket-feed-reduction.camj'
const project = normalizeProject(JSON.parse(readFileSync(file, 'utf8')) as Project)
const op = project.operations.find((o) => o.kind === 'pocket')
if (!op) throw new Error('no pocket operation')
const tool = project.tools.find((t) => t.id === op.toolRef)
if (!tool) throw new Error('no tool')
const scale = project.meta?.units === 'inch' ? 25.4 : 1
const targetR = Math.min(tool.diameter / 2, tool.diameter * op.stepover)

const sharp = rings(generatePocketToolpath(project, { ...op, roundOutsideCorners: false } as Operation).moves)
const current = rings(generatePocketToolpath(project, { ...op, roundOutsideCorners: true } as Operation).moves)
const proto = sharp.map((p) => runFillet(p, targetR))

const segs = (ps: P[][]): number => ps.reduce((a, p) => a + p.length - 1, 0)
console.log(`${file.split('/').pop()}  tool d=${(tool.diameter * scale).toFixed(2)}mm  target fillet r=${(targetR * scale).toFixed(2)}mm`)
console.log(`  segments: sharp=${segs(sharp)}  current=${segs(current)}  runFillet=${segs(proto)}`)
console.log(`  ${'variant'.padEnd(12)}${FEEDS.map((f) => `${f}mm/min`.padStart(11)).join('')}`)
for (const [name, ps] of [['sharp', sharp], ['current', current], ['runFillet', proto]] as Array<[string, P[][]]>) {
  console.log(`  ${name.padEnd(12)}${FEEDS.map((f) => timeMin(ps, f, scale).toFixed(2).padStart(11)).join('')}`)
}
// Diagnostic: junction deflection distribution per variant.
for (const [name, ps] of [['sharp', sharp], ['current', current], ['runFillet', proto]] as Array<[string, P[][]]>) {
  const defl: number[] = []
  for (const poly of ps) {
    for (let i = 1; i < poly.length - 1; i += 1) {
      const ux = poly[i].x - poly[i - 1].x, uy = poly[i].y - poly[i - 1].y
      const vx = poly[i + 1].x - poly[i].x, vy = poly[i + 1].y - poly[i].y
      if (Math.hypot(ux, uy) < 1e-12 || Math.hypot(vx, vy) < 1e-12) continue
      defl.push(Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)) * 180 / Math.PI)
    }
  }
  defl.sort((a, b) => a - b)
  const q = (f: number): number => defl[Math.min(defl.length - 1, Math.floor(f * defl.length))]
  const over90 = defl.filter((d) => d > 90).length
  console.log(`  ${name.padEnd(12)} deflection median=${q(0.5).toFixed(1)}deg p95=${q(0.95).toFixed(1)}deg max=${defl[defl.length-1].toFixed(1)}deg  over90=${over90}`)
}
