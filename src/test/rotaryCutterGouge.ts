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
 * The cutter-body sweep the #1155 gouge checks share: walk every cut move of a
 * rotary operation at no more than a quarter tool radius of tool-centre travel
 * and report the deepest point of the real cutter body that sits inside a solid
 * the operation must not cut.
 *
 * The body is the tool's own, in the tool's own frame: `lateral` and `along` are
 * the two directions perpendicular to the tool axis (the bar's cross-section and
 * its axial direction), `rise` is distance up the axis from the tip. A flat
 * endmill is a cylinder of the tool radius standing on the tip disc; a ball
 * endmill is a sphere whose lowest point is the tip, with the shank's cylinder
 * of the tool radius above its equator. The **along extent** is part of the body
 * and not a detail: the cutter is a disc in the bar's axial direction too, so a
 * pass whose centre is a full radius past a neighbour's end face still has its
 * body touching that face, and a checker that samples only the lateral direction
 * cannot see the overlap.
 *
 * The solid is supplied as a depth function, so the caller owns the geometry it
 * protects: the same sweep runs against the Hex prism, the Turn cylinder and
 * anything else a case needs.
 */

import type { BarStock } from '../types/project'
import { barCentre, barPivotZ } from '../types/barStock'
import type { ToolpathMove } from '../engine/toolpaths/types'

/** One point of the cutter body, relative to the tip, in the tool's own frame. */
export interface BodyPoint {
  readonly lateral: number
  readonly along: number
  readonly rise: number
}

/**
 * How far inside the protected solid a point in the **stock frame** lies.
 * Positive is inside; anything at or below zero is outside, and a point outside
 * the solid's along span must be reported as deeply outside so it can never win
 * the maximum.
 */
export type SolidDepth = (along: number, across: number, up: number) => number

/** The cutter the sweep moves: its radius and whether it is a ball. */
export interface SweptCutter {
  readonly radius: number
  readonly type: 'flat' | 'ball'
}

export interface CutterGougeReport {
  /** Deepest penetration into the solid, project units; negative means clear. */
  readonly depth: number
  /** Where the deepest body point was, for a failing message. */
  readonly where: string
}

/** The real cutter's body, sampled in the tool's own frame. */
export function cutterBody(radius: number, type: 'flat' | 'ball'): BodyPoint[] {
  const points: BodyPoint[] = []
  const longitudes = 16
  const rises = [0, radius / 2, radius, 2 * radius]
  if (type === 'flat') {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const rr = radius * fraction
      for (let i = 0; i < longitudes; i++) {
        const theta = (i / longitudes) * Math.PI * 2
        for (const rise of rises) {
          points.push({ lateral: rr * Math.cos(theta), along: rr * Math.sin(theta), rise })
        }
      }
    }
    return points
  }
  // The ball: its lower hemisphere, centred one radius up the axis.
  for (let latitude = 0; latitude <= 8; latitude++) {
    const phi = (latitude / 8) * Math.PI / 2
    for (let i = 0; i < longitudes; i++) {
      const theta = (i / longitudes) * Math.PI * 2
      points.push({
        lateral: radius * Math.sin(phi) * Math.cos(theta),
        along: radius * Math.sin(phi) * Math.sin(theta),
        rise: radius * (1 - Math.cos(phi)),
      })
    }
  }
  // The shank above the equator: a cylinder of the tool radius.
  for (let i = 0; i < longitudes; i++) {
    const theta = (i / longitudes) * Math.PI * 2
    for (const rise of [radius, 2 * radius]) {
      points.push({ lateral: radius * Math.cos(theta), along: radius * Math.sin(theta), rise })
    }
  }
  return points
}

/**
 * Sweep `cutter` along `moves` and report the deepest penetration into the solid
 * `depth` describes.
 *
 * A rotary move's motion is straight in `(along, A, tip radius)`, not in XYZ (a
 * ring's chord would cut through the bar), so the pose is interpolated in those
 * three coordinates and rebuilt in the stock frame. `A` rotates the **model**
 * into the tool's frame -- `centre + across cos - up sin` across and
 * `pivot + across sin + up cos` up, the sampler's own `turnModelInto`
 * arithmetic -- so the cutter body is mapped back by the inverse.
 *
 * The step is at most a quarter tool radius of tool-centre travel, so no gap
 * between two emitted points can hide an overlap.
 */
export function deepestCutterGouge(
  moves: readonly ToolpathMove[],
  stock: BarStock,
  cutter: SweptCutter,
  depth: SolidDepth,
): CutterGougeReport {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const body = cutterBody(cutter.radius, cutter.type)
  const step = cutter.radius / 4
  let deepest = Number.NEGATIVE_INFINITY
  let where = 'nowhere'
  for (let index = 0; index < moves.length; index++) {
    const move = moves[index]
    if (move.kind === 'rapid') continue
    const alongFrom = stock.axis === 'x' ? move.from.x : move.from.y
    const alongTo = stock.axis === 'x' ? move.to.x : move.to.y
    const angleFrom = ((move.from.a ?? 0) * Math.PI) / 180
    const angleTo = ((move.to.a ?? 0) * Math.PI) / 180
    const radiusFrom = move.from.z - pivot
    const radiusTo = move.to.z - pivot
    const arc = Math.abs(angleTo - angleFrom) * Math.max(Math.abs(radiusFrom), Math.abs(radiusTo))
    const steps = Math.max(1, Math.ceil(Math.hypot(alongTo - alongFrom, arc, radiusTo - radiusFrom) / step))
    for (let pose = 0; pose <= steps; pose++) {
      const t = pose / steps
      const along = alongFrom + (alongTo - alongFrom) * t
      const angle = angleFrom + (angleTo - angleFrom) * t
      const radius = radiusFrom + (radiusTo - radiusFrom) * t
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      for (const point of body) {
        // The stock frame is the tool frame rotated by `-A`: the tip's own
        // position is `(r sin A, r cos A)` off the bar's centreline, and a body
        // point `(lateral, along, rise)` moves with it.
        const across = centre + cos * point.lateral + sin * (radius + point.rise)
        const up = pivot - sin * point.lateral + cos * (radius + point.rise)
        const candidate = depth(along + point.along, across, up)
        if (candidate > deepest) {
          deepest = candidate
          where = `move ${index} (${move.kind}) at along ${(along + point.along).toFixed(3)}, `
            + `A ${((angle * 180) / Math.PI).toFixed(1)}°, tip radius ${radius.toFixed(3)}, `
            + `body offset (${point.lateral.toFixed(3)}, ${point.along.toFixed(3)}, ${point.rise.toFixed(3)})`
        }
      }
    }
  }
  return { depth: deepest, where }
}
