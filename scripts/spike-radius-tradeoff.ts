/**
 * Spike deliverable: the corner-radius trade-off, all three axes at once.
 *
 * For each fillet radius: material left behind (vs the sharp reference),
 * engagement above nominal, and feed-limited cycle time at several programmed
 * feeds. Geometry depends only on the radius, so each radius is generated once
 * and timed at every feed.
 *
 * WARNING: the leftBehind column here uses a STAMPED rasteriser and is NOT
 * reliable — its answers swing 100x with the sampling step. Use
 * `spike-coverage-exact.ts` for coverage. The time and engagement columns are
 * stable and reproduce across every resolution tried.
 *
 * Kinematics are a crude no-look-ahead model (centripetal limit on arcs,
 * GRBL-style junction deviation on vertices). Ratios between rows are the
 * trustworthy part; absolute minutes are pessimistic.
 */
import { buildPocketFixturePack, type PocketFixtureEntry } from '../src/test/pocketFixturePack'
import { generatePocketToolpath } from '../src/engine/toolpaths/pocket'
import type { Operation } from '../src/types/project'
import type { ToolpathMove } from '../src/engine/toolpaths/types'

const CELL = Number(process.env.PC_CELL ?? "0.5"), STEP = Number(process.env.PC_STEP ?? "0.4")
const ACCEL = 500, JD = 0.01
const FEEDS = [800, 2000, 4000]
const FACTORS = [1, 2, 3, 5]

function sweepGrid(moves: ToolpathMove[], radius: number): { minX: number; minY: number; w: number; h: number; bits: Uint8Array } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const m of moves) {
    if (m.kind !== 'cut') continue
    minX = Math.min(minX, m.from.x, m.to.x); maxX = Math.max(maxX, m.from.x, m.to.x)
    minY = Math.min(minY, m.from.y, m.to.y); maxY = Math.max(maxY, m.from.y, m.to.y)
  }
  const pad = radius + 2 * CELL
  minX -= pad; minY -= pad; maxX += pad; maxY += pad
  const w = Math.ceil((maxX - minX) / CELL) + 1, h = Math.ceil((maxY - minY) / CELL) + 1
  const bits = new Uint8Array(w * h)
  const rc = Math.ceil(radius / CELL), r2 = radius * radius
  for (const m of moves) {
    if (m.kind !== 'cut') continue
    const dx = m.to.x - m.from.x, dy = m.to.y - m.from.y
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / STEP))
    for (let i = 0; i <= n; i += 1) {
      const cx = m.from.x + (dx * i) / n, cy = m.from.y + (dy * i) / n
      const gx = Math.round((cx - minX) / CELL), gy = Math.round((cy - minY) / CELL)
      for (let oy = -rc; oy <= rc; oy += 1) {
        const yy = gy + oy
        if (yy < 0 || yy >= h) continue
        const py = minY + yy * CELL - cy
        for (let ox = -rc; ox <= rc; ox += 1) {
          const xx = gx + ox
          if (xx < 0 || xx >= w) continue
          const px = minX + xx * CELL - cx
          if (px * px + py * py <= r2) bits[yy * w + xx] = 1
        }
      }
    }
  }
  return { minX, minY, w, h, bits }
}

function junctionVelocity(phi: number): number {
  const sa = Math.sin((Math.PI - phi) / 2)
  if (sa >= 1 - 1e-12) return Infinity
  if (sa <= 1e-12) return 0
  return Math.sqrt(ACCEL * (JD * sa / (1 - sa)))
}

function timeMinutes(moves: ToolpathMove[], feed: number): number {
  const fps = feed / 60
  let t = 0, px: number | null = null, py: number | null = null
  for (const m of moves) {
    if (m.kind !== 'cut') { px = null; py = null; continue }
    const ux = m.to.x - m.from.x, uy = m.to.y - m.from.y
    const L = Math.hypot(ux, uy, m.to.z - m.from.z)
    if (L <= 0) continue
    const programmed = fps * (m.feedScale ?? 1)
    let v = programmed
    if (px !== null && py !== null) {
      const phi = Math.abs(Math.atan2(px * uy - py * ux, px * ux + py * uy))
      v = Math.min(programmed, Math.max(junctionVelocity(phi), 0.05))
    }
    t += L / v
    px = ux; py = uy
  }
  return t / 60
}

const pack = buildPocketFixturePack({ toolDiameter: 6, stepover: 0.4 }) as PocketFixtureEntry[]
const opOf = (e: PocketFixtureEntry): Operation => {
  const op = e.project.operations.find((c) => c.kind === 'pocket')
  if (!op) throw new Error(`${e.id}: no pocket operation`)
  return op
}
const radiusOf = (e: PocketFixtureEntry): number => {
  const op = opOf(e)
  const tool = e.project.tools.find((c) => c.id === op.toolRef)
  if (!tool) throw new Error(`${e.id}: no tool`)
  return tool.diameter / 2
}

// Sharp reference: coverage baseline and the rounding-off timing row.
const refGrids = new Map<string, ReturnType<typeof sweepGrid>>()
let refTimes = FEEDS.map(() => 0)
for (const e of pack) {
  const res = generatePocketToolpath(e.project, { ...opOf(e), pocketFeedReduction: 'engagement', roundOutsideCorners: false } as Operation)
  refGrids.set(e.id, sweepGrid(res.moves, radiusOf(e)))
  refTimes = refTimes.map((t, i) => t + timeMinutes(res.moves, FEEDS[i]))
}
console.log(`radius            leftBehind   above    ${FEEDS.map((f) => `${f}mm/min`.padStart(9)).join('')}`)
console.log(`sharp (off)          0.0mm2      -   ${refTimes.map((t) => t.toFixed(1).padStart(9)).join('')}`)

for (const factor of FACTORS) {
  process.env.PC_ROUND_FACTOR = String(factor)
  let missed = 0, above = 0, total = 0
  let times = FEEDS.map(() => 0)
  for (const e of pack) {
    const res = generatePocketToolpath(e.project, { ...opOf(e), pocketFeedReduction: 'engagement', roundOutsideCorners: true } as Operation)
    times = times.map((t, i) => t + timeMinutes(res.moves, FEEDS[i]))
    const eng = res.engagementTelemetry
    if (eng) { above += eng.distanceAboveNominal; total += eng.totalCutDistance }
    const g = sweepGrid(res.moves, radiusOf(e))
    const ref = refGrids.get(e.id)
    if (!ref) continue
    for (let gy = 0; gy < ref.h; gy += 1) {
      for (let gx = 0; gx < ref.w; gx += 1) {
        if (ref.bits[gy * ref.w + gx] !== 1) continue
        const x = ref.minX + gx * CELL, y = ref.minY + gy * CELL
        const cx = Math.round((x - g.minX) / CELL), cy = Math.round((y - g.minY) / CELL)
        const covered = cx >= 0 && cx < g.w && cy >= 0 && cy < g.h && g.bits[cy * g.w + cx] === 1
        if (!covered) missed += 1
      }
    }
  }
  const label = `x${factor} (r=${(2.4 * factor).toFixed(1)}mm)`
  console.log(`${label.padEnd(18)} ${(missed * CELL * CELL).toFixed(1).padStart(7)}mm2  ${(100 * above / Math.max(1, total)).toFixed(0).padStart(3)}%   ${times.map((t) => t.toFixed(1).padStart(9)).join('')}`)
}
