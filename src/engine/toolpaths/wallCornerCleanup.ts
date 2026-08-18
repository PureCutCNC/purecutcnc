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

import type { Point } from '../../types/project'
import { DEFAULT_FLATTEN_ARC_STEP } from './geometry'
import type { ContourSmoothingPlan, ContourTurnTransition } from './offsetSmoothing'

const EPS = 1e-9
const HANDLE_FACTORS = [1.25, 1, 0.8, 0.6, 0.45, 0.3] as const

export interface WallCornerCleanupOptions {
  /** True only inside or on the Pocket tool-centre domain. */
  isInsideDomain: (x: number, y: number) => boolean
  /** Angular chord budget shared with rounded contour tessellation. */
  arcStepRadians?: number
}

export interface WallCornerCleanupResult {
  /** One closed wall path: broad transitions followed immediately by their
   * exact source-span cleanup loops. No duplicated closing point. */
  points: Point[]
  cleanupCount: number
}

interface DirectedTransition extends ContourTurnTransition {
  firstIndex: number
  lastIndex: number
  runIndices: number[]
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function normalized(from: Point, to: Point): Point | null {
  const length = distance(from, to)
  if (!(length > EPS)) return null
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length }
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS
}

function pushDistinct(target: Point[], points: Point[]): void {
  for (const point of points) {
    if (target.length === 0 || !samePoint(target[target.length - 1], point)) {
      target.push(point)
    }
  }
}

function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t
  const uu = u * u
  const tt = t * t
  return {
    x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
    y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y,
  }
}

function pathInsideDomain(
  points: Point[],
  chordBudget: number,
  isInsideDomain: (x: number, y: number) => boolean,
): boolean {
  for (let index = 0; index + 1 < points.length; index += 1) {
    const a = points[index]
    const b = points[index + 1]
    const samples = Math.max(1, Math.ceil(distance(a, b) / chordBudget))
    for (let sample = 0; sample <= samples; sample += 1) {
      const t = sample / samples
      if (!isInsideDomain(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) {
        return false
      }
    }
  }
  return true
}

/** Chord budget for sampling a transition's motion, from the shared arc step. */
function chordBudgetFor(
  transition: DirectedTransition,
  options: WallCornerCleanupOptions,
): number {
  const arcStep = Math.max(options.arcStepRadians ?? DEFAULT_FLATTEN_ARC_STEP, 1e-3)
  return Math.max(2 * transition.effectiveRadius * Math.sin(arcStep / 2), 1e-6)
}

/** Build a teardrop-like fixed-end return, tangent to the outgoing shoulder at
 * the exit and the incoming shoulder at the entry. Larger handles are tried
 * first for lower curvature; domain pressure backs them off locally. */
function buildReturn(
  transition: DirectedTransition,
  source: Point[],
  options: WallCornerCleanupOptions,
): Point[] | null {
  const count = source.length
  const previous = source[(transition.firstIndex + count - 1) % count]
  const first = source[transition.firstIndex]
  const last = source[transition.lastIndex]
  const next = source[(transition.lastIndex + 1) % count]
  const arrivalTangent = normalized(previous, first)
  const exitTangent = normalized(last, next)
  if (!arrivalTangent || !exitTangent) return null

  const chord = distance(transition.exit, transition.entry)
  if (!(chord > EPS) || !(transition.effectiveRadius > EPS)) return null
  const chordBudget = chordBudgetFor(transition, options)

  for (const factor of HANDLE_FACTORS) {
    const handle = Math.max(transition.effectiveRadius * factor, chord * 0.2)
    const p0 = transition.exit
    const p1 = {
      x: p0.x + exitTangent.x * handle,
      y: p0.y + exitTangent.y * handle,
    }
    const p3 = transition.entry
    const p2 = {
      x: p3.x - arrivalTangent.x * handle,
      y: p3.y - arrivalTangent.y * handle,
    }
    const controlLength = distance(p0, p1) + distance(p1, p2) + distance(p2, p3)
    const steps = Math.max(8, Math.ceil(controlLength / chordBudget))
    const candidate: Point[] = []
    for (let step = 0; step <= steps; step += 1) {
      candidate.push(cubicPoint(p0, p1, p2, p3, step / steps))
    }
    candidate[0] = transition.exit
    candidate[candidate.length - 1] = transition.entry
    if (pathInsideDomain(candidate, chordBudget, options.isInsideDomain)) {
      return candidate
    }
  }
  return null
}

/**
 * Re-index the ring so the emission walk can run straight from 0 to n-1 with no
 * turn run wrapping the seam.
 *
 * Any cut that lands on a run *boundary* achieves that. An unrounded vertex is
 * one such boundary, but requiring one is wrong: on a plain rectangular pocket
 * wall every vertex is a rounded corner, so no unrounded vertex exists and the
 * whole cleanup used to decline — leaving Pocket to fall back to the sharp
 * contour on the single most common pocket shape, at every radius. The first
 * vertex of a run is equally a boundary, and cutting there makes that run start
 * at index 0 instead of wrapping.
 */
function rotatePlanForWalk(plan: ContourSmoothingPlan): {
  source: Point[]
  transitions: DirectedTransition[]
} | null {
  const count = plan.sourcePoints.length
  const covered = new Set(plan.transitions.flatMap((transition) => transition.runIndices))
  const unrounded = plan.sourcePoints.findIndex((_point, index) => !covered.has(index))
  // `plan.transitions` is in emitted contour order, so its first entry is the
  // run that wraps the seam when one does — cutting at its start unwraps it.
  const seam = unrounded >= 0 ? unrounded : plan.transitions[0]?.firstIndex ?? -1
  if (seam < 0) return null
  const source = [...plan.sourcePoints.slice(seam), ...plan.sourcePoints.slice(0, seam)]
  const remap = (index: number): number => (index - seam + count) % count
  const transitions = plan.transitions.map((transition): DirectedTransition => {
    const runIndices = transition.runIndices.map(remap).sort((a, b) => a - b)
    return {
      ...transition,
      firstIndex: runIndices[0],
      lastIndex: runIndices[runIndices.length - 1],
      runIndices,
    }
  }).sort((a, b) => a.firstIndex - b.firstIndex)
  if (transitions.some((transition) =>
    transition.runIndices.length === 0
    || transition.runIndices.some((index, offset) => index !== transition.firstIndex + offset))) {
    return null
  }
  return { source, transitions }
}

/**
 * Add immediate same-Z cleanup loops to a smoothed Pocket wall contour.
 *
 * Each loop follows the broad tangent transition first, returns smoothly from
 * its exit to its entry through the validated tool-centre domain, traverses
 * the exact source span (therefore restoring the sharp wall coverage), and
 * rejoins at the transition exit.
 *
 * A corner whose arc or return cannot be kept inside the tool-centre domain
 * keeps its exact source geometry instead — the legacy sharp path, which leaves
 * no stock and so needs no cleanup. `cleanupCount` reports how many corners were
 * actually rounded and cleaned, so a caller can tell a fully rounded ring from a
 * partly or wholly declined one. null is returned only when the plan cannot be
 * walked at all.
 */
export function buildWallCornerCleanupContour(
  plan: ContourSmoothingPlan,
  options: WallCornerCleanupOptions,
): WallCornerCleanupResult | null {
  if (plan.transitions.length === 0) {
    return { points: plan.points, cleanupCount: 0 }
  }
  const rotated = rotatePlanForWalk(plan)
  if (!rotated) return null
  const { source, transitions } = rotated
  const points: Point[] = []
  let cursor = 0
  let cleanupCount = 0
  for (const transition of transitions) {
    while (cursor < transition.firstIndex) {
      pushDistinct(points, [source[cursor]])
      cursor += 1
    }
    // The broad arc has to be checked too, not just the return that follows it.
    // Rounding cuts a corner, and on a *reflex* corner of a wall ring that cut
    // bulges the tool centre outward — off the ring and into the wall. The wall
    // ring sits on the boundary of its own domain, so this is not an edge case:
    // every reflex corner of every notched pocket does it.
    const arcStaysInside = pathInsideDomain(
      transition.transitionPoints,
      chordBudgetFor(transition, options),
      options.isInsideDomain,
    )
    const returnPath = arcStaysInside ? buildReturn(transition, source, options) : null
    if (!returnPath) {
      // Nothing safe to emit here, so this corner keeps exactly the geometry the
      // source has — the legacy sharp path, which needs no cleanup. Declining
      // one corner must not cost the whole ring its rounding: a single reflex
      // corner would otherwise disable the feature for the entire pocket.
      for (const index of transition.runIndices) {
        pushDistinct(points, [source[index]])
      }
      cursor = transition.lastIndex + 1
      continue
    }
    pushDistinct(points, transition.transitionPoints)
    pushDistinct(points, returnPath.slice(1))
    for (const index of transition.runIndices) {
      pushDistinct(points, [source[index]])
    }
    pushDistinct(points, [transition.exit])
    cursor = transition.lastIndex + 1
    cleanupCount += 1
  }
  while (cursor < source.length) {
    pushDistinct(points, [source[cursor]])
    cursor += 1
  }
  return { points, cleanupCount }
}
