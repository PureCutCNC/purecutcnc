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
 * Issue #1209 P1 bench: can winner-move IDs rebuild the exact stock height at
 * sub-cell points?
 *
 *   npx tsx scripts/proto-1209/p1Accuracy.ts <file.camj> <movesPrefix> <detail> [samples]
 *
 * 1. Replays the dumped moves with the shipped `applyMoveToGrid` and with a
 *    bench copy of the flat kernel that also records the winner move per cell;
 *    the two `topZ` arrays must be identical.
 * 2. The oracle is the exact height h(p) = max(bottom, min(top, min over all
 *    moves of cutZ_m(p))) at random sub-cell points, using the same per-move
 *    math as the kernel, found through a bucket index of every move.
 * 3. Compares, at those points: today's cell value (what the flat top quad
 *    shows), and the analytic min over the winners of the 2×2 and 3×3 cells
 *    around the point (what a shader would evaluate).
 *
 * Writes `<movesPrefix>-<detail>.topz.bin` and `.winner.bin` for the GPU bench.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

import { normalizeProject } from '../../src/store/helpers/projectFormat'
import { createSimulationGrid } from '../../src/engine/simulation/grid'
import { applyMoveToGrid } from '../../src/engine/simulation/replay'
import type { ToolpathMove } from '../../src/engine/toolpaths/types'
import type { ToolType } from '../../src/types/project'

const [file, prefix, detailArg, samplesArg] = process.argv.slice(2)
const detail = Number(detailArg)
const SAMPLES = Number(samplesArg ?? 400000)
const NONE = 0xffffffff

const meta = JSON.parse(readFileSync(`${prefix}.meta.json`, 'utf8')) as {
  items: Array<{ name: string; toolType: ToolType; toolRadius: number; vBitAngle: number | null; start: number; count: number }>
}
const raw = readFileSync(`${prefix}.moves.bin`)
const mv = new Float64Array(raw.buffer, raw.byteOffset, raw.byteLength / 8)
const moveCount = mv.length / 7

// ---- per-move constants ----------------------------------------------------
const TYPE_FLAT = 0, TYPE_BALL = 1, TYPE_V = 2, TYPE_PLASMA = 3
const mItem = new Uint8Array(moveCount)
for (let m = 0; m < moveCount; m += 1) mItem[m] = mv[m * 7 + 6]
const itType = meta.items.map((it) => (it.toolType === 'ball_endmill' ? TYPE_BALL : it.toolType === 'v_bit' ? TYPE_V : it.toolType === 'plasma' ? TYPE_PLASMA : TYPE_FLAT))
const itRadius = meta.items.map((it) => it.toolRadius)
const itInvSlope = meta.items.map((it) => {
  if (it.toolType !== 'v_bit') return 0
  const angle = Math.max(1, Math.min(179, it.vBitAngle ?? 60))
  const slope = Math.tan((angle * Math.PI) / 360)
  return slope > 1e-9 ? 1 / slope : 0
})

// ---- 1. replay: shipped kernel vs winner-recording copy --------------------
const project = normalizeProject(JSON.parse(readFileSync(file, 'utf8')))
const reference = createSimulationGrid(project, { targetLongAxisCells: detail })
const grid = createSimulationGrid(project, { targetLongAxisCells: detail })
const { cols, rows, cellSize, originX, originY, stockBottomZ } = grid
const stockTop = grid.stockTopZ
const topZ = grid.topZ
const winner = new Uint32Array(cols * rows).fill(NONE)

let t0 = performance.now()
for (let m = 0; m < moveCount; m += 1) {
  const o = m * 7
  const move = { kind: 'cut', from: { x: mv[o], y: mv[o + 1], z: mv[o + 2] }, to: { x: mv[o + 3], y: mv[o + 4], z: mv[o + 5] } } as ToolpathMove
  const it = meta.items[mItem[m]]
  applyMoveToGrid(reference, move, it.toolRadius, it.toolType, it.vBitAngle)
}
const shippedMs = performance.now() - t0

/** Exact cutter lower surface of move m at (x, y), clamped to the bottom; +Inf outside its reach. */
function cutAt(m: number, x: number, y: number): number {
  const o = m * 7
  const x0 = mv[o], y0 = mv[o + 1], z0 = mv[o + 2]
  const dx = mv[o + 3] - x0, dy = mv[o + 4] - y0, dz = mv[o + 5] - z0
  const it = mItem[m]
  const r = itRadius[it]
  const lenSq = dx * dx + dy * dy
  const stationary = lenSq <= 1e-12
  let t = 0
  if (!stationary) {
    t = ((x - x0) * dx + (y - y0) * dy) / lenSq
    if (t < 0) t = 0
    else if (t > 1) t = 1
  }
  const ex = x - (x0 + dx * t), ey = y - (y0 + dy * t)
  const d2 = ex * ex + ey * ey
  const rt = r + 1e-9
  if (d2 > rt * rt) return Infinity
  const type = itType[it]
  const centerZ = type === TYPE_PLASMA ? stockBottomZ : stationary ? Math.min(z0, mv[o + 5]) : z0 + dz * t
  let cut: number
  if (type === TYPE_BALL) cut = centerZ + r - Math.sqrt(r * r - Math.min(r * r, d2))
  else if (type === TYPE_V) cut = centerZ + Math.sqrt(d2) * itInvSlope[it]
  else cut = centerZ
  return cut > stockBottomZ ? cut : stockBottomZ
}

const TIE_REACH = process.env.TIE === 'reach'
const reach = new Float32Array(TIE_REACH ? cols * rows : 0)
/** How far inside move m's footprint (x, y) lies: radius minus distance to the segment. */
function reachAt(m: number, x: number, y: number): number {
  const o = m * 7
  const x0 = mv[o], y0 = mv[o + 1], dx = mv[o + 3] - x0, dy = mv[o + 4] - y0
  const lenSq = dx * dx + dy * dy
  let t = lenSq > 1e-12 ? ((x - x0) * dx + (y - y0) * dy) / lenSq : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  return itRadius[mItem[m]] - Math.hypot(x - x0 - dx * t, y - y0 - dy * t)
}

t0 = performance.now()
for (let m = 0; m < moveCount; m += 1) {
  const o = m * 7
  const r = itRadius[mItem[m]]
  const c0 = Math.max(0, Math.floor((Math.min(mv[o], mv[o + 3]) - r - originX) / cellSize))
  const c1 = Math.min(cols - 1, Math.floor((Math.max(mv[o], mv[o + 3]) + r - originX) / cellSize))
  const r0 = Math.max(0, Math.floor((Math.min(mv[o + 1], mv[o + 4]) - r - originY) / cellSize))
  const r1 = Math.min(rows - 1, Math.floor((Math.max(mv[o + 1], mv[o + 4]) + r - originY) / cellSize))
  for (let row = r0; row <= r1; row += 1) {
    const y = originY + (row + 0.5) * cellSize
    for (let col = c0; col <= c1; col += 1) {
      const z = cutAt(m, originX + (col + 0.5) * cellSize, y)
      const idx = row * cols + col
      if (z < topZ[idx] - 1e-9) {
        topZ[idx] = z
        winner[idx] = m
        if (TIE_REACH) reach[idx] = reachAt(m, originX + (col + 0.5) * cellSize, y)
      } else if (TIE_REACH && z !== Infinity && z <= topZ[idx] + 1e-9) {
        // Same height (a shared floor or the stock bottom): keep the move whose
        // footprint contains the cell centre most deeply. topZ is untouched.
        const k = reachAt(m, originX + (col + 0.5) * cellSize, y)
        if (k > reach[idx]) { reach[idx] = k; winner[idx] = m }
      }
    }
  }
}
const winnerMs = performance.now() - t0
let diff = 0
for (let i = 0; i < topZ.length; i += 1) if (topZ[i] !== reference.topZ[i]) diff += 1
console.log(`grid ${cols}×${rows}, cell ${cellSize.toFixed(5)}, moves ${moveCount}`)
console.log(`replay: shipped ${shippedMs.toFixed(0)} ms, winner copy ${winnerMs.toFixed(0)} ms, cells differing from shipped: ${diff}`)
writeFileSync(`${prefix}-${detail}.topz.bin`, Buffer.from(topZ.buffer))
writeFileSync(`${prefix}-${detail}.winner.bin`, Buffer.from(winner.buffer))

// ---- 2. oracle: bucket index of every move --------------------------------
const B = 0.1
const bCols = Math.ceil((cols * cellSize) / B), bRows = Math.ceil((rows * cellSize) / B)
const counts = new Uint32Array(bCols * bRows + 1)
const range = (m: number) => {
  const o = m * 7, r = itRadius[mItem[m]]
  return [
    Math.max(0, Math.floor((Math.min(mv[o], mv[o + 3]) - r - originX) / B)),
    Math.min(bCols - 1, Math.floor((Math.max(mv[o], mv[o + 3]) + r - originX) / B)),
    Math.max(0, Math.floor((Math.min(mv[o + 1], mv[o + 4]) - r - originY) / B)),
    Math.min(bRows - 1, Math.floor((Math.max(mv[o + 1], mv[o + 4]) + r - originY) / B)),
  ]
}
for (let m = 0; m < moveCount; m += 1) {
  const [a, b, c, d] = range(m)
  for (let r = c; r <= d; r += 1) for (let q = a; q <= b; q += 1) counts[r * bCols + q + 1] += 1
}
for (let i = 1; i < counts.length; i += 1) counts[i] += counts[i - 1]
const fill = counts.slice(0, -1)
const bucket = new Uint32Array(counts[counts.length - 1])
for (let m = 0; m < moveCount; m += 1) {
  const [a, b, c, d] = range(m)
  for (let r = c; r <= d; r += 1) for (let q = a; q <= b; q += 1) bucket[fill[r * bCols + q]++] = m
}

/** Exact height and the move that sets it (NONE when uncut). */
function exact(x: number, y: number): [number, number] {
  const bq = Math.min(bCols - 1, Math.floor((x - originX) / B)), br = Math.min(bRows - 1, Math.floor((y - originY) / B))
  const k = br * bCols + bq
  let h = stockTop, w = NONE
  for (let i = counts[k]; i < counts[k + 1]; i += 1) {
    const m = bucket[i]
    const z = cutAt(m, x, y)
    if (z < h - 1e-9) { h = z; w = m }
  }
  return [h, w]
}

// ---- 3. reconstruction at random points ------------------------------------
function winnersAround(col: number, row: number, radius: number, out: Set<number>) {
  out.clear()
  for (let r = row - radius; r <= row + radius; r += 1) {
    if (r < 0 || r >= rows) continue
    for (let c = col - radius; c <= col + radius; c += 1) {
      if (c < 0 || c >= cols) continue
      const w = winner[r * cols + c]
      if (w !== NONE) out.add(w)
    }
  }
}
function winners2x2(x: number, y: number, out: Set<number>) {
  out.clear()
  const c0 = Math.floor((x - originX) / cellSize - 0.5), r0 = Math.floor((y - originY) / cellSize - 0.5)
  for (let r = r0; r <= r0 + 1; r += 1) for (let c = c0; c <= c0 + 1; c += 1) {
    if (r < 0 || r >= rows || c < 0 || c >= cols) continue
    const w = winner[r * cols + c]
    if (w !== NONE) out.add(w)
  }
}
const evalSet = (set: Set<number>, x: number, y: number) => {
  let h = stockTop
  for (const m of set) { const z = cutAt(m, x, y); if (z < h) h = z }
  return h
}

/** The winners plus their ±k neighbours in cut order (the adjacent segments of the same pass). */
const evalSetSeq = (set: Set<number>, x: number, y: number, k: number) => {
  let h = stockTop
  for (const m of set) {
    for (let d = -k; d <= k; d += 1) {
      const n = m + d
      if (n < 0 || n >= moveCount || mItem[n] !== mItem[m]) continue
      const z = cutAt(n, x, y); if (z < h) h = z
    }
  }
  return h
}

const isThrough = (z: number) => z <= stockBottomZ + 1e-6
/** A cell on a through-cut outline: through-cut status differs from a 4-neighbour. */
const rimCells: number[] = []
for (let r = 1; r < rows - 1; r += 1) for (let c = 1; c < cols - 1; c += 1) {
  const i = r * cols + c, t = isThrough(topZ[i])
  if (t !== isThrough(topZ[i - 1]) || t !== isThrough(topZ[i + 1]) || t !== isThrough(topZ[i - cols]) || t !== isThrough(topZ[i + cols])) rimCells.push(i)
}

let seed = 1209
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
const TOLS = [1e-4, 1e-3, 5e-3]

function run(label: string, pick: () => [number, number]) {
  const s = new Set<number>()
  const variants: Array<[string, (x: number, y: number, col: number, row: number) => number]> = [
    ['cell value     ', (_x, _y, col, row) => topZ[row * cols + col]],
    ['2x2            ', (x, y) => { winners2x2(x, y, s); return evalSet(s, x, y) }],
    ['3x3            ', (x, y, col, row) => { winnersAround(col, row, 1, s); return evalSet(s, x, y) }],
    ['2x2 + seq ±1   ', (x, y) => { winners2x2(x, y, s); return evalSetSeq(s, x, y, 1) }],
    ['3x3 + seq ±1   ', (x, y, col, row) => { winnersAround(col, row, 1, s); return evalSetSeq(s, x, y, 1) }],
    ['3x3 + seq ±3   ', (x, y, col, row) => { winnersAround(col, row, 1, s); return evalSetSeq(s, x, y, 3) }],
    ['5x5 + seq ±3   ', (x, y, col, row) => { winnersAround(col, row, 2, s); return evalSetSeq(s, x, y, 3) }],
  ]
  const errs = variants.map(() => [] as number[])
  const thrDis = variants.map(() => 0)
  let thrPoints = 0
  const t = performance.now()
  for (let n = 0; n < SAMPLES; n += 1) {
    const [x, y] = pick()
    const col = Math.min(cols - 1, Math.floor((x - originX) / cellSize)), row = Math.min(rows - 1, Math.floor((y - originY) / cellSize))
    const [h] = exact(x, y)
    const thr = isThrough(h)
    if (thr) thrPoints += 1
    variants.forEach(([, f], k) => {
      const v = f(x, y, col, row)
      errs[k].push(Math.abs(v - h))
      if (isThrough(v) !== thr) thrDis[k] += 1
    })
  }
  const q = (a: Float64Array, p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))]
  const pct = (v: number) => `${((100 * v) / SAMPLES).toFixed(3)}%`
  console.log(`\n[${label}] ${SAMPLES} points (${(performance.now() - t).toFixed(0)} ms), ${pct(thrPoints)} through-cut`)
  console.log(`  variant          rms       p95       p99.9     | over ${TOLS.join(' / ')} in        | through-cut disagree`)
  variants.forEach(([name], k) => {
    const a = Float64Array.from(errs[k]).sort()
    const rms = Math.sqrt(a.reduce((acc, v) => acc + v * v, 0) / a.length)
    const over = TOLS.map((tol) => pct(a.length - (() => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] > tol) hi = m; else lo = m + 1 } return lo })()))
    console.log(`  ${name} ${rms.toExponential(2)}  ${q(a, 0.95).toExponential(2)}  ${q(a, 0.999).toExponential(2)}  | ${over.join(' / ')} | ${pct(thrDis[k])}`)
  })
}

const W = cols * cellSize, H = rows * cellSize
run(`whole stock, detail ${detail}`, () => [originX + rand() * Math.min(W, 20), originY + rand() * Math.min(H, 15)])
run(`through-cut rim cells, detail ${detail} (${rimCells.length} cells)`, () => {
  const i = rimCells[Math.floor(rand() * rimCells.length)]
  return [originX + ((i % cols) + rand()) * cellSize, originY + (Math.floor(i / cols) + rand()) * cellSize]
})
const finishCells: number[] = []
for (let i = 0; i < topZ.length; i += 1) if (winner[i] !== NONE && meta.items[mItem[winner[i]]].toolType === 'ball_endmill' && !isThrough(topZ[i])) finishCells.push(i)
run(`ball-finished surface cells, detail ${detail} (${finishCells.length} cells)`, () => {
  const i = finishCells[Math.floor(rand() * finishCells.length)]
  return [originX + ((i % cols) + rand()) * cellSize, originY + (Math.floor(i / cols) + rand()) * cellSize]
})
console.log(`\nmemory: winner ${(winner.byteLength / 1e6).toFixed(1)} MB per grid; move table ${moveCount} moves (${((moveCount * 32) / 1e6).toFixed(1)} MB at 32 B/move)`)
