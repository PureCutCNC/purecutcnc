/**
 * Exact coverage: is anything left behind when corners are rounded?
 *
 * No stamping. Both the sharp reference and the rounded candidate are tested by
 * exact point-to-segment distance against a shared cell grid, so sampling
 * artifacts cannot differ between them. A stamped rasteriser gave answers that
 * swung 100x with the step size; this does not.
 */
import { buildPocketFixturePack, type PocketFixtureEntry } from '../src/test/pocketFixturePack'
import { generatePocketToolpath } from '../src/engine/toolpaths/pocket'
import type { Operation } from '../src/types/project'
import type { ToolpathMove } from '../src/engine/toolpaths/types'

const CELL = Number(process.env.PC_CELL ?? '0.25')
type Seg = [number, number, number, number]

const segsOf = (moves: ToolpathMove[]): Seg[] => {
  const out: Seg[] = []
  for (const m of moves) {
    if (m.kind !== 'cut') continue
    if (Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y) <= 1e-9) continue
    out.push([m.from.x, m.from.y, m.to.x, m.to.y])
  }
  return out
}

function dist2(px: number, py: number, s: Seg): number {
  const [ax, ay, bx, by] = s
  const dx = bx - ax, dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
  const vx = ax + dx * t - px, vy = ay + dy * t - py
  return vx * vx + vy * vy
}

/** Uniform bucket index so each query tests only nearby segments. */
class Index {
  private readonly cells = new Map<string, Seg[]>()
  constructor(private readonly size: number, segs: Seg[]) {
    for (const s of segs) {
      const x0 = Math.floor(Math.min(s[0], s[2]) / size), x1 = Math.floor(Math.max(s[0], s[2]) / size)
      const y0 = Math.floor(Math.min(s[1], s[3]) / size), y1 = Math.floor(Math.max(s[1], s[3]) / size)
      for (let x = x0; x <= x1; x += 1) {
        for (let y = y0; y <= y1; y += 1) {
          const k = `${x},${y}`
          const list = this.cells.get(k)
          if (list) list.push(s); else this.cells.set(k, [s])
        }
      }
    }
  }
  covered(px: number, py: number, r: number): boolean {
    const r2 = r * r
    const cx = Math.floor(px / this.size), cy = Math.floor(py / this.size)
    const span = Math.ceil(r / this.size)
    for (let x = cx - span; x <= cx + span; x += 1) {
      for (let y = cy - span; y <= cy + span; y += 1) {
        const list = this.cells.get(`${x},${y}`)
        if (!list) continue
        for (const s of list) if (dist2(px, py, s) <= r2) return true
      }
    }
    return false
  }
}

const FACTORS = [1, 2, 3, 5, 8]
const pack = buildPocketFixturePack({ toolDiameter: 6, stepover: 0.4 }) as PocketFixtureEntry[]
const opOf = (e: PocketFixtureEntry): Operation => {
  const op = e.project.operations.find((c) => c.kind === 'pocket')
  if (!op) throw new Error('no pocket op')
  return op
}

console.log(`exact coverage, cell=${CELL}mm`)
for (const factor of FACTORS) {
  let missed = 0, refCells = 0
  for (const e of pack) {
    const op = opOf(e)
    const tool = e.project.tools.find((c) => c.id === op.toolRef)
    if (!tool) continue
    const r = tool.diameter / 2
    const sharp = generatePocketToolpath(e.project, { ...op, pocketFeedReduction: 'engagement', roundOutsideCorners: false } as Operation)
    process.env.PC_ROUND_FACTOR = String(factor)
    const round = generatePocketToolpath(e.project, { ...op, pocketFeedReduction: 'engagement', roundOutsideCorners: true } as Operation)
    const refSegs = segsOf(sharp.moves), candSegs = segsOf(round.moves)
    const refIdx = new Index(r, refSegs), candIdx = new Index(r, candSegs)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const s of refSegs) {
      minX = Math.min(minX, s[0], s[2]); maxX = Math.max(maxX, s[0], s[2])
      minY = Math.min(minY, s[1], s[3]); maxY = Math.max(maxY, s[1], s[3])
    }
    for (let y = minY - r; y <= maxY + r; y += CELL) {
      for (let x = minX - r; x <= maxX + r; x += CELL) {
        if (!refIdx.covered(x, y, r)) continue
        refCells += 1
        if (!candIdx.covered(x, y, r)) missed += 1
      }
    }
  }
  const a = missed * CELL * CELL
  console.log(`  x${factor} (r=${(2.4 * factor).toFixed(1)}mm)  leftBehind ${a.toFixed(2).padStart(8)}mm2 of ${(refCells * CELL * CELL).toFixed(0)}mm2  (${(100 * missed / Math.max(1, refCells)).toFixed(3)}%)`)
}
