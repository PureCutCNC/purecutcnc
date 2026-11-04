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
 * The swept cutter/material reference on a chiral, tapered bar (#1103 slice
 * ca-a).
 *
 * A surface of revolution cannot tell a diagonal move (along and A advancing
 * together) from an along-only one: its material is the same at every A. This
 * model is a triangle that **scales and turns** as it is extruded along the bar,
 * so the material a cutter reaches at one pose depends on the along position
 * **and** on A. The reference support below is computed from the analytic
 * section -- the highest material a solid cutter body reaches inside its axial
 * footprint at that pose, including the off-axis reach and a ball's shank -- and
 * never from the sampler or the mesh the generator reads.
 *
 * It lives here rather than in one test file because two slices check their
 * emitted motion against it: `rotaryAroundPasses.test.ts` (ca-a's diagonal
 * reference on the ring path) and `rotaryContinuous.test.ts` (ca-c's helix, whose
 * every segment after run merging is one combined `(along, A)` move).
 */

import { barCentre, barPivotZ } from '../types/barStock'
import type { BarStock } from '../types/project'
import type { RotaryModelMesh } from '../engine/toolpaths/rotaryModel'
import type { NormalizedTool } from '../engine/toolpaths/types'

export interface ChiralModel {
  /** The section at the model's start, in (across, up) from the bar axis. */
  readonly vertices: readonly (readonly [number, number])[]
  readonly from: number
  readonly to: number
  readonly scale0: number
  readonly scale1: number
  readonly twist0: number
  readonly twist1: number
}

/** The model's section at one along position: scaled and turned about the axis. */
export function chiralSection(model: ChiralModel, along: number): Array<readonly [number, number]> {
  const t = Math.max(0, Math.min(1, (along - model.from) / (model.to - model.from)))
  const scale = model.scale0 + (model.scale1 - model.scale0) * t
  const twist = (model.twist0 + (model.twist1 - model.twist0) * t) * Math.PI / 180
  const cos = Math.cos(twist)
  const sin = Math.sin(twist)
  return model.vertices.map(([across, up]) => [
    scale * (across * cos - up * sin),
    scale * (across * sin + up * cos),
  ] as const)
}

/**
 * The best tip the `tool` can reach against one section edge at an axial offset
 * `dx`: `max over the edge of q - r + sqrt(r^2 - p^2 - dx^2)`, which is concave
 * on the edge's feasible interval, so a ternary search is exact.
 */
function ballEdgeSupport(
  p0: number,
  q0: number,
  p1: number,
  q1: number,
  radius: number,
  dx: number,
): number {
  const reachSq = radius * radius - dx * dx
  if (!(reachSq > 0)) return Number.NEGATIVE_INFINITY
  const reach = Math.sqrt(reachSq)
  const dp = p1 - p0
  let lo = 0
  let hi = 1
  if (Math.abs(dp) < 1e-12) {
    if (Math.abs(p0) > reach) return Number.NEGATIVE_INFINITY
  } else {
    const a = (-reach - p0) / dp
    const b = (reach - p0) / dp
    lo = Math.max(0, Math.min(a, b))
    hi = Math.min(1, Math.max(a, b))
    if (hi < lo) return Number.NEGATIVE_INFINITY
  }
  const value = (lambda: number): number => {
    const p = p0 + dp * lambda
    const disc = reachSq - p * p
    if (disc < 0) return Number.NEGATIVE_INFINITY
    return q0 + (q1 - q0) * lambda - radius + Math.sqrt(disc)
  }
  let left = lo
  let right = hi
  for (let step = 0; step < 40; step++) {
    const third = (right - left) / 3
    const m1 = left + third
    const m2 = right - third
    if (value(m1) < value(m2)) left = m1
    else right = m2
  }
  return Math.max(value(lo), value(hi), value((left + right) / 2))
}

/**
 * The lowest safe tool tip at one pose on the chiral model, from the section
 * alone.
 *
 * The cutter body spans its whole axial footprint (`along +/- r`) and its whole
 * cross-section reach (`|p| <= sqrt(r^2 - dx^2)`), so the support is the
 * maximum over that footprint. A flat tool's bottom face is a plane, so the
 * maximum is on the section's boundary inside the reach strip; a ball's lower
 * surface is a sphere, and the maximum on each edge is a concave one-dimensional
 * search. `tipOnly` reduces the reference to the vertical ray under the tool's
 * own axis, which is the mutation that ignores the body's reach.
 */
export function chiralSupport(
  model: ChiralModel,
  along: number,
  angleDeg: number,
  tool: NormalizedTool,
  tipOnly = false,
): number {
  const radius = tool.radius
  const ball = tool.type === 'ball_endmill'
  const angle = angleDeg * Math.PI / 180
  const alongSamples = tipOnly ? 0 : 8
  let best = Number.NEGATIVE_INFINITY
  for (let sample = 0; sample <= alongSamples; sample++) {
    const x = tipOnly ? along : along - radius + (2 * radius * sample) / alongSamples
    const dx = x - along
    const reach = Math.sqrt(Math.max(0, radius * radius - dx * dx))
    if (!tipOnly && !(reach > 0)) continue
    const t = Math.max(0, Math.min(1, (x - model.from) / (model.to - model.from)))
    const scale = model.scale0 + (model.scale1 - model.scale0) * t
    const twist = (model.twist0 + (model.twist1 - model.twist0) * t) * Math.PI / 180
    // Both the section's own turn and the stock's commanded turn are rotations
    // about the bar axis, so they compose.
    const phi = twist + angle
    const cos = Math.cos(phi)
    const sin = Math.sin(phi)
    const p: number[] = []
    const q: number[] = []
    for (const [across, up] of model.vertices) {
      p.push(scale * (across * cos - up * sin))
      q.push(scale * (across * sin + up * cos))
    }
    if (tipOnly) {
      for (let i = 0; i < p.length; i++) {
        if (Math.abs(p[i]) <= 1e-9) best = Math.max(best, q[i])
        const j = (i + 1) % p.length
        const dp = p[j] - p[i]
        if (Math.abs(dp) < 1e-12) continue
        const lambda = -p[i] / dp
        if (lambda < 0 || lambda > 1) continue
        best = Math.max(best, q[i] + (q[j] - q[i]) * lambda)
      }
      continue
    }
    if (!ball) {
      for (let i = 0; i < p.length; i++) {
        if (Math.abs(p[i]) <= reach + 1e-12) best = Math.max(best, q[i])
        const j = (i + 1) % p.length
        const dp = p[j] - p[i]
        if (Math.abs(dp) < 1e-12) continue
        for (const boundary of [-reach, reach]) {
          const lambda = (boundary - p[i]) / dp
          if (lambda < 0 || lambda > 1) continue
          best = Math.max(best, q[i] + (q[j] - q[i]) * lambda)
        }
      }
      continue
    }
    for (let i = 0; i < p.length; i++) {
      const j = (i + 1) % p.length
      best = Math.max(best, ballEdgeSupport(p[i], q[i], p[j], q[j], radius, dx))
    }
  }
  return best
}

/** A commanded diagonal path, parameterised by the emitted fraction. */
export interface DiagonalPath {
  along(f: number): number
  angle(f: number): number
  /** The tool tip, measured from the bar's pivot. */
  tip(f: number): number
}

/** The deepest gouge (`support - tip`) along the actual combined path. */
export function diagonalGouge(
  model: ChiralModel,
  tool: NormalizedTool,
  path: DiagonalPath,
  samples = 24,
  tipOnly = false,
): number {
  let worst = Number.NEGATIVE_INFINITY
  for (let step = 0; step <= samples; step++) {
    const f = step / samples
    const support = chiralSupport(model, path.along(f), path.angle(f), tool, tipOnly)
    worst = Math.max(worst, support - path.tip(f))
  }
  return worst
}

/** The chiral model extruded along the bar, with both end caps. */
export function chiralMesh(stock: BarStock, model: ChiralModel, steps: number): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  const n = model.vertices.length
  for (let s = 0; s <= steps; s++) {
    const along = model.from + (model.to - model.from) * s / steps
    for (const [across, up] of chiralSection(model, along)) {
      if (stock.axis === 'x') positions.push(along, centre + across, pivot + up)
      else positions.push(centre + across, along, pivot + up)
    }
  }
  for (let s = 0; s < steps; s++) {
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n
      const a = s * n + j
      const b = s * n + j2
      const c = (s + 1) * n + j2
      const d = (s + 1) * n + j
      index.push(a, b, c, a, c, d)
    }
  }
  for (let i = 1; i + 1 < n; i++) {
    index.push(0, i + 1, i, steps * n, steps * n + i, steps * n + i + 1)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/** A 20 mm bar with a chiral triangle whose taper and twist move with along. */
export const CHIRAL_VERTICES = [[-3, -1], [3, -3], [3.6, 3.6]] as const
export const CHIRAL_BAR_RADIUS = 10
export const CHIRAL_FROM = 4
export const CHIRAL_TO = 16
export const CHIRAL_ALLOWANCE_MM = 0.02
export const CHIRAL_SEEDS = (['x', 'y'] as const).flatMap((axis) => (['mm', 'inch'] as const).flatMap((units) =>
  (['ball_endmill', 'flat_endmill'] as const).map((type) => ({ axis, units, type }))))
