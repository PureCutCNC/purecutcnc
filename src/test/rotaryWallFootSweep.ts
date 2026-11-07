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
 * - a flat endmill is a cylinder standing on its bottom disc, so at along offset
 *   `d` from its centre and angular offset `delta` from its own angle it removes
 *   down to `radius / cos(delta)` over the radii where
 *   `d² + s² sin²(delta) <= radius²`;
 * - a ball endmill is a sphere of radius `radius` whose lowest point is the tip,
 *   so its centre stands at `tip + radius` from the bar's axis and it removes the
 *   radial band `centre·cos(delta) ± sqrt(radius² - d² - centre² sin²(delta))`.
 *   Material **above** that band is not cut by the body and stays (an unsupported
 *   overhang the simulation keeps as well), which is why a ball leaves its own
 *   fillet at a wall's foot, and why the ball's check runs on the material an
 *   earlier rough left, exactly as the real job does.
 *
 * The angular offset matters (#1155 rn-d correction 1, review P2): the first cut
 * discarded it and applied the pose's whole axial footprint to every angle inside
 * its subtended arc, which credited a 1/4 in cutter (0.125 in radius) with cutting points up to
 * 0.00958 in beyond its own surface. The body is intersected here -- in the plane
 * of the angle line, with the pose's real angle -- so a pose only lowers material
 * its surface actually reaches.
 *
 * The measured figures are read from the leftover profile against a **specified**
 * level (`target surface + stock to leave`), never against the profile's own
 * lowest value (#1155 rn-d correction 2, review P1): comparing a profile with
 * itself reports zero leftover for an untouched blank and hid a foot ring that
 * cut 0.00915 in high.
 *
 * #1155 rn-e adds the **own-end** measure on the same sweep: `sweepByAngle`
 * pairs each whole degree's poses with the material they cut (an earlier
 * operation's profile where one runs first), `resample` moves a profile onto
 * another operation's grid, and `endRidge` reads the extra material a target's
 * own end -- or a wall face -- stands above the operation's **own interior**,
 * so a stepover scallop or the conservative sampler's lift is not mistaken for a
 * ridge. The committed check and `scripts/issue-1155-rn-e-ends-probe.ts` both
 * use these, so the probe and the test cannot drift apart.
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

/** One cutter-body pose: where its tip is, how far off the axis, and at what angle. */
export interface CutterPose {
  readonly along: number
  readonly radius: number
  /** The pose's own physical angle, degrees in `[0, 360)`. */
  readonly angle: number
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
 * applied to exactly the lines it can touch. The pose keeps its own angle, and
 * `sweepProfile` uses the offset between the two.
 *
 * Every whole degree also gets the pose the **motion itself** passes through
 * exactly on that line (#1155 rn-d correction 3, review P2). The flat body's
 * section at `delta = 0` reaches its whole axial footprint, so the first cut at
 * a wall's leave boundary is made by the pose on the angle line itself; a
 * sampling that only had poses 0.2 degrees either side would leave the boundary
 * standing and read the leftover a sampling step out. Adding the pose at the
 * line is not extra coverage -- the machine interpolates through it -- and it is
 * what lets `sweepProfile` stop crediting a pose 7 degrees off with the reach a
 * pose on the line has.
 */
export function cutterPosesByAngle(
  moves: readonly ToolpathMove[],
  stock: BarStock,
  tool: NormalizedTool,
  windowDeg?: number,
): AnglePoses[] {
  const pivot = barPivotZ(stock)
  const step = Math.max(tool.radius / 4, 1e-4)
  const poses: CutterPose[] = []
  /** The pose at each whole degree the commanded motion passes through. */
  const onLine: CutterPose[] = []
  // The motion is continuous in A: the machine interpolates between two emitted
  // points, so the tool passes every angle between them at the same along and
  // radius. Sampling only the emitted points left a foot-wide sliver at a ring's
  // tangent rim uncut at some angles, and the leftover then read a few
  // thousandths wide where the real sweep reaches the boundary. The pose step is
  // therefore capped in angle as well as in tool-centre travel.
  const angleStep = 0.5
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    const alongFrom = stock.axis === 'x' ? move.from.x : move.from.y
    const alongTo = stock.axis === 'x' ? move.to.x : move.to.y
    const angleFrom = move.from.a ?? 0
    const angleTo = move.to.a ?? 0
    const radiusFrom = move.from.z - pivot
    const radiusTo = move.to.z - pivot
    const arc = Math.abs(((angleTo - angleFrom) * Math.PI) / 180)
      * Math.max(Math.abs(radiusFrom), Math.abs(radiusTo))
    const travel = Math.ceil(Math.hypot(alongTo - alongFrom, arc, radiusTo - radiusFrom) / step)
    const turned = Math.ceil(Math.abs(angleTo - angleFrom) / angleStep)
    const steps = Math.max(1, travel, turned)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      poses.push({
        along: alongFrom + (alongTo - alongFrom) * t,
        radius: radiusFrom + (radiusTo - radiusFrom) * t,
        angle: (((angleFrom + (angleTo - angleFrom) * t) % 360) + 360) % 360,
      })
    }
    // The same motion, at the exact whole degrees it crosses.
    const firstWhole = Math.ceil(Math.min(angleFrom, angleTo))
    const lastWhole = Math.floor(Math.max(angleFrom, angleTo))
    for (let whole = firstWhole; whole <= lastWhole; whole++) {
      const t = angleTo === angleFrom ? 0 : (whole - angleFrom) / (angleTo - angleFrom)
      onLine.push({
        along: alongFrom + (alongTo - alongFrom) * t,
        radius: radiusFrom + (radiusTo - radiusFrom) * t,
        // The pose's own angle IS the whole degree, so `delta` is exactly 0.
        angle: ((whole % 360) + 360) % 360,
      })
    }
  }
  const outer = Math.max(tool.radius, barMaxRadius(stock))
  const reach = windowDeg ?? (Math.asin(Math.min(1, tool.radius / outer)) * 180) / Math.PI + 0.5
  const members: CutterPose[][] = Array.from({ length: 360 }, () => [])
  const span = Math.ceil(reach)
  for (const pose of poses) {
    const centre = Math.round(pose.angle)
    for (let offset = -span; offset <= span; offset++) {
      const angle = (centre + offset + 360) % 360
      const delta = Math.abs(pose.angle - angle)
      if (Math.min(delta, 360 - delta) > reach) continue
      members[angle].push(pose)
    }
  }
  // An on-line pose belongs to its own angle only: it is the motion at
  // `delta = 0`, and `sweepProfile` must not read it as an offset pose.
  for (const pose of onLine) members[Math.round(pose.angle) % 360].push(pose)
  return members.map((poses, angle) => ({ angle, poses }))
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
 * The profile after one angle's poses cut it, with the cutter body intersected in
 * the angle line's own plane.
 *
 * `angle` is the profile's physical angle in degrees; a pose soaks in with the
 * offset `delta = angle - pose.angle`. A flat endmill lowers the column to
 * `radius / cos(delta)` and only over the radii its surface reaches; a ball
 * removes its radial band and leaves whatever stands above it. With `delta = 0`
 * both reduce to the plain section the first cut used.
 */
export function sweepProfile(
  profile: WallFootProfile,
  poses: readonly CutterPose[],
  tool: NormalizedTool,
  angle: number,
): WallFootProfile {
  const top = [...profile.top]
  const ball = tool.type === 'ball_endmill'
  const radius = tool.radius
  const count = profile.along.length
  const step = count > 1 ? profile.along[1] - profile.along[0] : 0
  // The pose's axial footprint, widened by a **relative** epsilon (#1155 rn-e
  // correction 1). A pose's along position is interpolated from the emitted
  // move, so a ring the generator commands at 1.375 in arrives as
  // 1.3750000000012; the profile's own grid point at exactly 1.25 is then
  // `1.25e-12` *outside* the nominal rim, and the first grid point past the face
  // read as uncut, reporting a whole-blank column as leftover at the face
  // (the review's "highest leftover 0.50000 in at A0°"). A nanometre-scale
  // epsilon is below any machine tolerance and keeps the guard honest for the
  // poses that really are off the footprint.
  const scale = count > 0 ? Math.max(1, Math.abs(profile.along[0]), Math.abs(profile.along[count - 1])) : 1
  const rimEpsilon = Math.max(1e-9, scale * 1e-12)
  for (const pose of poses) {
    const delta = (((angle - pose.angle) * Math.PI) / 180)
    const cos = Math.cos(delta)
    if (!(cos > 0)) continue
    const sin = Math.abs(Math.sin(delta))
    const rim = radius + rimEpsilon
    // The grid is uniform (`blankProfile` builds it that way), so a pose's
    // footprint is one index range rather than a scan of the whole window. One
    // index either side is included so the guard below -- not the rounded index
    // arithmetic -- decides a point sitting exactly on the rim.
    const first = step > 0
      ? Math.max(0, Math.ceil((pose.along - rim - profile.along[0]) / step) - 1)
      : 0
    const last = step > 0
      ? Math.min(count - 1, Math.floor((pose.along + rim - profile.along[0]) / step) + 1)
      : count - 1
    // A ball's cutting sphere stands one radius above its tip; a flat's body is
    // the half-cylinder above the tip radius.
    const centre = pose.radius + radius
    for (let j = first; j <= last; j++) {
      const offset = profile.along[j] - pose.along
      if (Math.abs(offset) > rim) continue
      const current = top[j]
      if (!(current > pose.radius)) continue
      if (ball) {
        const inside = radius * radius - offset * offset - (centre * sin) * (centre * sin)
        if (inside < 0) continue
        const spread = Math.sqrt(inside)
        const lowest = centre * cos - spread
        const highest = centre * cos + spread
        if (current > highest) continue
        if (current > lowest) top[j] = lowest
        continue
      }
      // The flat's bottom face stands at the tip radius, so the body's surface at
      // this angle covers radii from `radius / cos` up to `reach`; material above
      // `reach` is over the cylinder and stays, material below the bottom face is
      // behind the tool.
      if (sin < 1e-12) {
        top[j] = pose.radius
        continue
      }
      const w = Math.sqrt(Math.max(0, radius * radius - offset * offset))
      const lowest = pose.radius / cos
      // The body's surface at this angle reaches radii up to `w / sin`: the
      // farther the pose's own line is from this one, the less of the axial
      // footprint its side covers. At the axial rim (`offset = radius`) `w` is
      // zero, so a pose **off** the line reaches nothing but the axis, whatever
      // its angle -- the section is a single point, not the whole column. The
      // same pose **on** the line is the `sin = 0` case above, which cuts its
      // whole footprint; that pose is in the list by construction
      // (`cutterPosesByAngle` adds the motion's own pose at every whole degree).
      // Crediting an off-line pose at the rim with infinite reach lowered
      // material 0.15485 in from a 0.125 in cutter's axis at 7 degrees offset
      // (#1155 rn-d correction 3, review P2).
      const highest = w / sin
      if (current > highest) continue
      if (current > lowest) top[j] = lowest
    }
  }
  return { along: profile.along, top }
}

/** Where the leftover material at a wall sits. */
export interface WallFootLeftover {
  /**
   * The first along position past the leave boundary where the material stands at
   * or below the specified level: the leave's own boundary when the operation is
   * right, further out when a ledge is left, and the foot zone's end when nothing
   * reaches the level at all.
   */
  readonly edge: number
  /** How far `edge` sits past the leave boundary, in the cut direction. */
  readonly ledge: number
  /** The lowest material top the operation reached inside the foot zone. */
  readonly depth: number
  /** The highest material top still standing inside the foot zone. */
  readonly highest: number
}

/**
 * The leftover at a wall, from a swept profile, against a **specified** level.
 *
 * `face` is the neighbour's end face, `direction` the side the operation cuts on
 * (`+1` past the face, `-1` before it), and `level` the surface the operation is
 * required to reach there -- `target surface + stock to leave`, decided by the
 * caller and never read off the profile. The first cut must reach it from the
 * leave boundary on; material above `level + tolerance` between the boundary and
 * the first clearing is the ledge, and its along width is what the acceptance
 * bounds. `reach` is how far past the boundary the foot zone extends -- the span
 * this operation's wall-foot ring can reach, `2 * tool radius` in every caller --
 * so a band that never comes down to the level is reported as the whole zone
 * rather than walked to the window's end.
 */
export function wallFootLeftover(
  profile: WallFootProfile,
  face: number,
  direction: 1 | -1,
  level: number,
  leave: number,
  tolerance: number,
  reach: number,
): WallFootLeftover {
  const clearLevel = level + tolerance
  const boundary = face + direction * leave
  const limit = boundary + direction * reach
  let index = 0
  let distance = Number.POSITIVE_INFINITY
  for (let i = 0; i < profile.along.length; i++) {
    const candidate = Math.abs(profile.along[i] - boundary)
    if (candidate < distance) {
      distance = candidate
      index = i
    }
  }
  const walk = direction > 0 ? 1 : -1
  let edge = limit
  let cleared = false
  let depth = Number.POSITIVE_INFINITY
  let highest = Number.NEGATIVE_INFINITY
  while (index >= 0 && index < profile.top.length) {
    const along = profile.along[index]
    if (direction > 0 ? along > limit + 1e-12 : along < limit - 1e-12) break
    const top = profile.top[index]
    if (top < depth) depth = top
    if (top > highest) highest = top
    if (!cleared && top <= clearLevel) {
      edge = along
      cleared = true
    }
    index += walk
  }
  return {
    edge,
    ledge: direction > 0 ? edge - boundary : boundary - edge,
    depth,
    highest,
  }
}

/** The along window a wall check needs: a few tool radii each side of the face. */
export function wallFootWindow(face: number, tool: NormalizedTool, direction: 1 | -1): { from: number; to: number } {
  const span = 6 * tool.radius
  return direction > 0
    ? { from: face - 4 * tool.radius, to: face + span }
    : { from: face - span, to: face + 4 * tool.radius }
}

/**
 * One angle's material after a whole operation's poses cut it (#1155 rn-e).
 *
 * The ridge a target's own end leaves is measured on the material the operation
 * **actually runs on** -- the ball rough on the untouched bar, a ball finish on
 * the material the rough left, a flat finish on the bar -- so this pairs the
 * per-angle poses with the profile they cut.
 */
export interface SweptAngle {
  readonly angle: number
  readonly profile: WallFootProfile
}

/**
 * Every whole degree's material profile after `moves` cut `blank` (#1155 rn-e).
 * `blank` is the untouched stock, or the profile an earlier operation left.
 */
export function sweepByAngle(
  moves: readonly ToolpathMove[],
  stock: BarStock,
  tool: NormalizedTool,
  window: { from: number; to: number },
  anchor: number,
  blank?: (angle: number) => WallFootProfile | null,
): SweptAngle[] {
  return cutterPosesByAngle(moves, stock, tool).map((entry) => {
    const base = blank?.(entry.angle)
      ?? blankProfile(stock, window.from, window.to, tool, anchor)
    return { angle: entry.angle, profile: sweepProfile(base, entry.poses, tool, entry.angle) }
  })
}

/**
 * The **ridge** a target's own end still carries: the material standing there
 * that the operation's own passes leave nowhere else.
 *
 * An absolute height bound would measure the operation's stepover scallop, not
 * the defect: a 1/4 in ball advancing 0.16 in leaves a 0.03 in cusp everywhere,
 * by design, and a conservative sampler lifts every sample by up to one cell.
 * The ridge is the *extra* material beside the end face, so each angle's
 * reference is the highest material its own interior reaches
 * (`interior.from..to` from the end), and the measured height is how far the
 * end band stands above that. Taking the interior's **highest** point -- its
 * cusp crest, and a polygon target's corner -- makes the check blind to the
 * scallop and corner phase and still catches the defect by the whole step from
 * the crest to the untouched blank (0.226 in on this fixture, over the 0.111 in
 * band the handoff calls "about one tool radius wide"). `width` is the along
 * extent of the extra material.
 */
export function endRidge(
  swept: readonly SweptAngle[],
  end: number,
  direction: 1 | -1,
  band: number,
  interior: { from: number; to: number },
  tolerance: number,
): { width: number; height: number; angle: number } {
  let width = 0
  let height = 0
  let angle = 0
  for (const entry of swept) {
    const { along, top } = entry.profile
    let reference = Number.NEGATIVE_INFINITY
    for (let i = 0; i < along.length; i++) {
      const distance = (along[i] - end) * direction
      if (distance < interior.from || distance > interior.to) continue
      if (top[i] > reference) reference = top[i]
    }
    if (!Number.isFinite(reference)) continue
    let worst = 0
    let extent = 0
    for (let i = 0; i < along.length; i++) {
      const distance = (along[i] - end) * direction
      if (distance < -1e-12 || distance > band) continue
      const excess = top[i] - reference
      if (excess <= tolerance) continue
      if (excess > worst) worst = excess
      if (distance > extent) extent = distance
    }
    if (worst > height + 1e-12) {
      height = worst
      width = extent
      angle = entry.angle
    }
  }
  return { width, height, angle }
}

/** Linear resampling of a material profile onto another along grid (#1155 rn-e). */
export function resample(profile: WallFootProfile, along: readonly number[]): WallFootProfile {
  const top: number[] = []
  let next = 0
  for (const x of along) {
    while (next + 1 < profile.along.length && profile.along[next + 1] < x) next++
    if (x <= profile.along[0]) {
      top.push(profile.top[0])
      continue
    }
    const last = profile.along.length - 1
    if (x >= profile.along[last]) {
      top.push(profile.top[last])
      continue
    }
    const span = profile.along[next + 1] - profile.along[next]
    const t = span > 0 ? (x - profile.along[next]) / span : 0
    top.push(profile.top[next] + (profile.top[next + 1] - profile.top[next]) * t)
  }
  return { along: [...along], top }
}
