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
 * The material a rotary operation leaves at a neighbour's wall foot (#1155 slice
 * rn-d), measured with the cutter's own body rather than the generator's sampled
 * heights.
 *
 * The sweep is one radial line per angle: at a fixed A the turned part is a
 * function `top(x)` -- the material's top radius at each along position -- because
 * every turning cut comes from outside. A pose then removes a **section** of the
 * cutter body from that profile:
 *
 * - a flat endmill is a cylinder standing on its bottom disc, so over its
 *   footprint `[along - r, along + r]` it removes everything above the tip;
 * - a ball endmill is a sphere of radius `r` whose lowest point is the tip, so at
 *   along offset `d` it removes the radii `tip + r - sqrt(r² - d²)` up to
 *   `tip + r + sqrt(r² - d²)`. Material **above** that band is not cut by the
 *   body and stays (an unsupported overhang the simulation keeps as well), which
 *   is why a ball leaves its own fillet at a wall's foot, and why the ball's check
 *   runs on the material an earlier rough left, exactly as the real job does.
 *
 * The measured figure is the leftover profile at the wall: the **edge**, the first
 * along position past the neighbour's face where no material above the level
 * stands, and the **ledge**, how far that edge sits past the leave boundary. It
 * is also the width of the material left standing between the two, because no
 * pose reached it. Before rn-d the finish's helix crossed the wall on a different
 * turn for every angle, so the edge wandered by up to one stepover and that
 * wander was the ledge; after it, a full ring at the wall's foot puts the edge on
 * the leave boundary at every angle.
 *
 * Nothing here asserts and nothing here reads the sampler.
 */

import { barMaxRadius, barPivotZ } from '../types/barStock'
import type { BarStock } from '../types/project'
import type { NormalizedTool, ToolpathMove } from '../engine/toolpaths/types'

/** The material standing at one angle: its top radius per along position. */
export interface WallFootProfile {
  /** The along positions, ascending, project units. */
  readonly along: number[]
  /** The material's top radius from the bar's axis at each along position. */
  readonly top: number[]
}

/** One cutter-body pose: where its tip is and how far off the axis it stands. */
export interface CutterPose {
  readonly along: number
  readonly radius: number
}

/** The distinct physical angles the sweep reports, in whole degrees. */
export interface AnglePoses {
  readonly angle: number
  readonly poses: readonly CutterPose[]
}

/**
 * Every pose the cutter occupies, grouped by physical angle in whole degrees.
 *
 * The pose is interpolated in `(along, A, tip radius)` -- the controller's own
 * motion -- at no more than a quarter tool radius of tool-centre travel, so the
 * angles between two emitted points are covered as well. The commanded A grows
 * without bound (it is never reduced modulo 360, #1091) and a helix visits every
 * physical angle once per turn, so grouping by physical angle is what makes "one
 * angle's material" a well-defined radial line.
 *
 * A pose belongs to every angle its **body** can reach, not only its own: the
 * cutter stands one radius off the axis, so at the outermost material radius it
 * subtends `asin(r / R)` of angle, and a ring emitted every 3.6 degrees would
 * otherwise leave most angles with no cut at all. The window is that subtended
 * angle (in degrees, plus half of the one-degree binning), so a pose's section is
 * applied to exactly the lines it can touch.
 */
export function cutterPosesByAngle(
  moves: readonly ToolpathMove[],
  stock: BarStock,
  tool: NormalizedTool,
  windowDeg?: number,
): AnglePoses[] {
  const pivot = barPivotZ(stock)
  const step = Math.max(tool.radius / 4, 1e-4)
  const poses: Array<CutterPose & { readonly angle: number }> = []
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    const alongFrom = stock.axis === 'x' ? move.from.x : move.from.y
    const alongTo = stock.axis === 'x' ? move.to.x : move.to.y
    const angleFrom = ((move.from.a ?? 0) * Math.PI) / 180
    const angleTo = ((move.to.a ?? 0) * Math.PI) / 180
    const radiusFrom = move.from.z - pivot
    const radiusTo = move.to.z - pivot
    const arc = Math.abs(angleTo - angleFrom) * Math.max(Math.abs(radiusFrom), Math.abs(radiusTo))
    const steps = Math.max(1, Math.ceil(Math.hypot(alongTo - alongFrom, arc, radiusTo - radiusFrom) / step))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const degrees = ((((angleFrom + (angleTo - angleFrom) * t) * 180) / Math.PI) % 360 + 360) % 360
      poses.push({
        along: alongFrom + (alongTo - alongFrom) * t,
        radius: radiusFrom + (radiusTo - radiusFrom) * t,
        angle: degrees,
      })
    }
  }
  const outer = Math.max(tool.radius, barMaxRadius(stock))
  const reach = windowDeg ?? (Math.asin(Math.min(1, tool.radius / outer)) * 180) / Math.PI + 0.5
  const angles: AnglePoses[] = []
  for (let angle = 0; angle < 360; angle++) {
    const members: CutterPose[] = []
    for (const pose of poses) {
      const delta = Math.abs(pose.angle - angle)
      if (Math.min(delta, 360 - delta) > reach) continue
      members.push({ along: pose.along, radius: pose.radius })
    }
    angles.push({ angle, poses: members })
  }
  return angles
}

/**
 * A profile of the untouched blank over `[from, to]`: the bar's largest radius at
 * every position, which is the material an operation sees before anything cuts it
 * (a square blank's corners included).
 */
export function blankProfile(
  stock: BarStock,
  from: number,
  to: number,
  tool: NormalizedTool,
  anchor = from,
): WallFootProfile {
  // Fine enough that the leave boundary is read to well inside the 0.001 in
  // acceptance: one step is a 128th of the cutter radius. The grid is anchored
  // on `anchor` (the wall's leave boundary in every caller), so that boundary is
  // a grid point and the leftover's edge is not quantised off it.
  const step = Math.max(tool.radius / 128, 1e-5)
  const first = anchor + Math.ceil((from - anchor) / step) * step
  const along: number[] = []
  const top: number[] = []
  for (let x = first; x <= to + 1e-12; x += step) {
    along.push(x)
    top.push(barMaxRadius(stock))
  }
  return { along, top }
}

/**
 * The profile after one angle's poses cut it.
 *
 * A flat endmill removes everything above its tip over its footprint; a ball
 * removes the band its section covers and leaves whatever stands above that band,
 * exactly as the swept body does.
 */
export function sweepProfile(
  profile: WallFootProfile,
  poses: readonly CutterPose[],
  tool: NormalizedTool,
): WallFootProfile {
  const top = [...profile.top]
  const ball = tool.type === 'ball_endmill'
  const radius = tool.radius
  const count = profile.along.length
  const step = count > 1 ? profile.along[1] - profile.along[0] : 0
  for (const pose of poses) {
    // The grid is uniform (`blankProfile` builds it that way), so a pose's
    // footprint is one index range rather than a scan of the whole window.
    const first = step > 0
      ? Math.max(0, Math.ceil((pose.along - radius - profile.along[0]) / step))
      : 0
    const last = step > 0
      ? Math.min(count - 1, Math.floor((pose.along + radius - profile.along[0]) / step))
      : count - 1
    for (let j = first; j <= last; j++) {
      const offset = profile.along[j] - pose.along
      if (Math.abs(offset) > radius + 1e-12) continue
      const current = top[j]
      if (!(current > pose.radius)) continue
      let lowest = pose.radius
      let highest = Number.POSITIVE_INFINITY
      if (ball) {
        const inside = radius * radius - offset * offset
        if (inside < 0) continue
        const spread = Math.sqrt(inside)
        lowest = pose.radius + radius - spread
        highest = pose.radius + radius + spread
      }
      if (current > highest) continue
      if (current > lowest) top[j] = lowest
    }
  }
  return { along: profile.along, top }
}

/** Where the leftover material at a wall sits. */
export interface WallFootLeftover {
  /**
   * The first along position past the face where the material stands at or below
   * the level: the leave's own boundary when the operation is right, further out
   * when a ledge is left.
   */
  readonly edge: number
  /** How far `edge` sits past the leave boundary, in the cut direction. */
  readonly ledge: number
  /** The width of the next band of material above the level, after `edge`. */
  readonly gapWidth: number
  /** The highest top radius the profile still carries beside the face. */
  readonly highest: number
}

/**
 * The material top an operation leaves **away** from the wall: the lowest radius
 * its profile still carries anywhere. That is its own cut surface -- plus the
 * sampler's conservative lift, #1045 slice F, which is why the theoretical
 * surface radius is the wrong level to compare against -- because a band the
 * operation failed to clear keeps material *above* it, never below. The blank the
 * operation never reaches stands at the bar's radius and cannot lower it, and the
 * neighbour's own step is above it for the same reason.
 */
export function leftoverLevel(profile: WallFootProfile): number {
  let level = Number.POSITIVE_INFINITY
  for (const top of profile.top) if (top < level) level = top
  return level
}

/**
 * The leftover at a wall, from a swept profile.
 *
 * `face` is the neighbour's end face, `direction` the side the operation cuts on
 * (`+1` past the face, `-1` before it), and `level` the material top the operation
 * leaves away from the wall ({@link leftoverLevel}); material above it is what this
 * operation failed to remove, while the band at the leave itself is entitled to
 * stand. `leave` is the radial stock the operation carries, so the leave boundary
 * is `face + direction * leave`.
 */
export function wallFootLeftover(
  profile: WallFootProfile,
  face: number,
  direction: 1 | -1,
  level: number,
  leave: number,
  tolerance: number,
): WallFootLeftover {
  const clearLevel = level + tolerance
  const step = profile.along.length > 1 ? profile.along[1] - profile.along[0] : 1
  let index = 0
  let distance = Number.POSITIVE_INFINITY
  for (let i = 0; i < profile.along.length; i++) {
    const candidate = Math.abs(profile.along[i] - face)
    if (candidate < distance) {
      distance = candidate
      index = i
    }
  }
  const clamp = (value: number): number => Math.max(0, Math.min(profile.top.length - 1, value))
  const walk = direction > 0 ? 1 : -1
  let highest = Number.NEGATIVE_INFINITY
  while (index >= 0 && index < profile.top.length && profile.top[index] > clearLevel) {
    if (profile.top[index] > highest) highest = profile.top[index]
    index += walk
  }
  const edge = profile.along[clamp(index)]
  let gapWidth = 0
  while (index >= 0 && index < profile.top.length && profile.top[index] <= clearLevel) {
    index += walk
    gapWidth += step
  }
  const clearance = direction > 0 ? edge - (face + leave) : (face - leave) - edge
  return { edge, ledge: clearance, gapWidth, highest }
}

/** The along window a wall check needs: a few tool radii each side of the face. */
export function wallFootWindow(face: number, tool: NormalizedTool, direction: 1 | -1): { from: number; to: number } {
  const span = 6 * tool.radius
  return direction > 0
    ? { from: face - 4 * tool.radius, to: face + span }
    : { from: face - span, to: face + 4 * tool.radius }
}
