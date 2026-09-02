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

// Original procedural guitar-top fixture used in issue #697, retained for #702.
/**
 * Carved-top guitar body test mesh (Les Paul character), in mm.
 *
 * Built the way a carved top actually is: an outline, and a height profile
 * driven by distance inward from that outline. That gives the three things
 * that matter for this comparison —
 *   - a flat binding ledge at the rim,
 *   - a concave recurve then a ~17 deg shoulder just inside it,
 *   - a very gently domed centre (about 1 deg) that covers most of the area,
 * and, critically, a surface whose natural "grain" follows the body outline.
 */

import type { SurfaceTestMesh as Mesh } from './surfaceSlopeFixtures'

export interface GuitarOptions {
  cell?: number
  /** Flat binding ledge width at the rim. */
  ledge?: number
  /** Height gained across the recurve/shoulder. */
  shoulderRise?: number
  /** Distance inward over which the shoulder completes. */
  shoulderWidth?: number
  /** Extra height gained across the centre dome. */
  domeRise?: number
  /** Rim thickness below the ledge (the vertical side of the body). */
  rimHeight?: number
}

interface Disc { cx: number; cy: number; r: number }

// Single-cutaway body: lower bout, upper bout, waist blend, cutaway bite.
const LOWER: Disc = { cx: 0, cy: -78, r: 160 }
const UPPER: Disc = { cx: 0, cy: 92, r: 128 }
const WAIST_L: Disc = { cx: -196, cy: 10, r: 96 }
const WAIST_R: Disc = { cx: 196, cy: 10, r: 96 }
const CUTAWAY: Disc = { cx: -150, cy: 150, r: 92 }

// Span is the body's own bounding box plus a 6 mm ledge of surrounding stock,
// so the flat surround does not dominate the area being measured.
const SPAN_X = 332
const SPAN_Y = 470
const OFF_X = 166
const OFF_Y = 244

function inside(x: number, y: number): boolean {
  const px = x - OFF_X
  const py = y - OFF_Y
  const inDisc = (d: Disc): boolean => Math.hypot(px - d.cx, py - d.cy) <= d.r
  if (!(inDisc(LOWER) || inDisc(UPPER))) return false
  if (inDisc(WAIST_L) || inDisc(WAIST_R)) return false
  if (inDisc(CUTAWAY)) return false
  return true
}

/** Smoothstep — concave up over the first half, which is the recurve. */
function smoothstep(t: number): number {
  const u = Math.max(0, Math.min(1, t))
  return u * u * (3 - 2 * u)
}

export function carveHeight(distanceInward: number, o: Required<GuitarOptions>): number {
  if (distanceInward <= o.ledge) return o.rimHeight
  const u = distanceInward - o.ledge
  const shoulder = o.shoulderRise * smoothstep(u / o.shoulderWidth)
  // Centre dome: a long, very gentle rise that keeps most of the top near 1 deg.
  const dome = o.domeRise * smoothstep(u / 170)
  return o.rimHeight + shoulder + dome
}

/** Grid distance (in cells) to the nearest outside cell, by two-pass chamfer. */
function distanceInwardField(mask: Uint8Array, w: number, h: number, cell: number): Float32Array {
  const INF = 1e9
  const d = new Float32Array(w * h)
  for (let i = 0; i < w * h; i += 1) d[i] = mask[i] ? INF : 0
  const D1 = cell
  const D2 = cell * Math.SQRT2
  const relax = (at: number, from: number, cost: number): void => {
    const candidate = d[from] + cost
    if (candidate < d[at]) d[at] = candidate
  }
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < w; col += 1) {
      const at = row * w + col
      if (d[at] === 0) continue
      if (col > 0) relax(at, at - 1, D1)
      if (row > 0) relax(at, at - w, D1)
      if (row > 0 && col > 0) relax(at, at - w - 1, D2)
      if (row > 0 && col < w - 1) relax(at, at - w + 1, D2)
    }
  }
  for (let row = h - 1; row >= 0; row -= 1) {
    for (let col = w - 1; col >= 0; col -= 1) {
      const at = row * w + col
      if (d[at] === 0) continue
      if (col < w - 1) relax(at, at + 1, D1)
      if (row < h - 1) relax(at, at + w, D1)
      if (row < h - 1 && col < w - 1) relax(at, at + w + 1, D2)
      if (row < h - 1 && col > 0) relax(at, at + w - 1, D2)
    }
  }
  // Cells outside the body sit at the rim height, so clamp them to 0 inward.
  return d
}

export function buildGuitarMesh(options: GuitarOptions = {}): Mesh & { spanX: number; spanY: number } {
  const o: Required<GuitarOptions> = {
    cell: options.cell ?? 1.0,
    ledge: options.ledge ?? 5,
    shoulderRise: options.shoulderRise ?? 11,
    shoulderWidth: options.shoulderWidth ?? 62,
    domeRise: options.domeRise ?? 3,
    rimHeight: options.rimHeight ?? 6,
  }
  const nx = Math.round(SPAN_X / o.cell)
  const ny = Math.round(SPAN_Y / o.cell)
  const w = nx + 1
  const h = ny + 1

  const mask = new Uint8Array(w * h)
  for (let j = 0; j <= ny; j += 1) {
    for (let i = 0; i <= nx; i += 1) {
      mask[j * w + i] = inside((i / nx) * SPAN_X, (j / ny) * SPAN_Y) ? 1 : 0
    }
  }
  const inward = distanceInwardField(mask, w, h, o.cell)

  const positions: number[] = []
  const index: number[] = []
  for (let j = 0; j <= ny; j += 1) {
    const y = (j / ny) * SPAN_Y
    for (let i = 0; i <= nx; i += 1) {
      const x = (i / nx) * SPAN_X
      const at = j * w + i
      positions.push(x, y, mask[at] ? carveHeight(inward[at], o) : 0)
    }
  }
  const at = (i: number, j: number): number => j * w + i

  // Only quads fully inside the body get a top face; the rest is the flat
  // ground the body stands on, which keeps the mesh a closed solid.
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1)
      index.push(a, b, c, a, c, d)
    }
  }

  // Bottom plane and skirt, mirroring hills.ts.
  const boundary: Array<[number, number]> = []
  for (let i = 0; i < nx; i += 1) boundary.push([i, 0])
  for (let j = 0; j < ny; j += 1) boundary.push([nx, j])
  for (let i = nx; i > 0; i -= 1) boundary.push([i, ny])
  for (let j = ny; j > 0; j -= 1) boundary.push([0, j])
  const ringStart = positions.length / 3
  for (const [i, j] of boundary) positions.push((i / nx) * SPAN_X, (j / ny) * SPAN_Y, -4)
  for (let k = 0; k < boundary.length; k += 1) {
    const next = (k + 1) % boundary.length
    const t0 = at(boundary[k][0], boundary[k][1])
    const t1 = at(boundary[next][0], boundary[next][1])
    index.push(t0, ringStart + k, ringStart + next, t0, ringStart + next, t1)
  }
  const corner = (i: number, j: number): number =>
    ringStart + boundary.findIndex(([bi, bj]) => bi === i && bj === j)
  const c00 = corner(0, 0), c10 = corner(nx, 0), c11 = corner(nx, ny), c01 = corner(0, ny)
  index.push(c00, c11, c10, c00, c01, c11)

  return {
    positions: new Float32Array(positions),
    index: new Uint32Array(index),
    spanX: SPAN_X,
    spanY: SPAN_Y,
  }
}
