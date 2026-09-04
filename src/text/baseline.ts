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
 * Curved text baselines.
 *
 * The text system never stores glyph geometry: it rebuilds a straight template
 * and maps it onto a feature frame. Curving text therefore does not need a new
 * feature kind or a second resolve path — it needs the *template* laid out on a
 * curve, which is what this module does.
 *
 * One operator (`bendShapesToBaseline`) covers both arc and path layouts and
 * both font styles, because by the time shapes reach it the skeleton and
 * outline pipelines have converged on the same thing: profiles tagged with a
 * `glyphIndex`.
 */

import { measureProfilePath, normalizedPathRange } from '../sketch/featureDistribution'
import { getProfileBounds, type Point, type SketchProfile } from '../types/project'
import type { TextBaselineAnchor, TextBaselineFit, TextBaselineOrientation } from '../types/project'
import { transformProfile } from '../geometry/profile'

const EPSILON = 1e-9

export interface TextBaselinePoint {
  point: Point
  tangent: Point
}

/**
 * A curve to lay text along, parameterised by **signed distance from the
 * layout's anchor point**. Negative distances are meaningful and expected —
 * a centred run starts at `-runLength / 2`.
 */
export interface TextBaseline {
  /**
   * The extent the user asked for (arc sweep as a length, or the picked path
   * span). Only `fit: 'fill'` consumes it; `natural` lets the run's own width
   * win and leaves this as a readout.
   */
  span: number
  at: (distance: number) => TextBaselinePoint
}

export interface TextTemplateBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  height: number
}

/** The minimum a shape needs to be bendable. Keeps this module free of a `text/index` import. */
export interface BendableShape {
  profile: SketchProfile
  glyphIndex?: number
}

export function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180
}

/**
 * Baseline around a circle centred on the template origin. The template is
 * mapped onto the feature frame afterwards, so the centre needs no coordinates
 * of its own — placing the frame places the circle.
 *
 * Angles follow the app's existing user-facing convention rather than the maths
 * one: `0` is 3 o'clock and **positive is clockwise on screen**, because sketch
 * space is Y-down and the exact-rotate field already feeds degrees straight
 * into a rotation there. 12 o'clock is therefore 270.
 *
 * `direction` does double duty. A glyph's "up" ends up 90 degrees to the left
 * of travel, so `cw` stands the text outside the circle (upright at the top)
 * and `ccw` stands it inside (upright at the bottom, reading normally). That is
 * the top-arc / bottom-arc choice, and it is why no separate flip control
 * exists.
 */
export function arcBaseline(
  radius: number,
  angleDegrees: number,
  sweepDegrees: number,
  direction: 'cw' | 'ccw',
): TextBaseline | null {
  if (!Number.isFinite(radius) || radius <= EPSILON) return null
  if (!Number.isFinite(angleDegrees) || !Number.isFinite(sweepDegrees)) return null

  const sign = direction === 'cw' ? 1 : -1
  const anchorAngle = degreesToRadians(angleDegrees)

  return {
    span: radius * Math.abs(degreesToRadians(sweepDegrees)),
    at: (distance: number) => {
      const angle = anchorAngle + (sign * distance) / radius
      // Tangent points the way travel goes, so the glyph's local +x follows it.
      const tangent = { x: -Math.sin(angle) * sign, y: Math.cos(angle) * sign }
      return {
        point: { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius },
        tangent,
      }
    },
  }
}

/**
 * Baseline along a guide outline, over the `[startOffset, endOffset]` span.
 *
 * Unlike the arc there is no separate anchor angle, so the anchor point is
 * derived from the span itself: `start` anchors at its beginning, `center` at
 * its midpoint, `end` at its end. That makes a natural-fit run sit *inside* the
 * picked span rather than running off one end of it.
 *
 * `reversed` walks the guide backwards. It is the path analogue of the arc's
 * `direction`, and matters for the same reason: on a closed guide it is the
 * difference between text reading around the outside of the shape and around
 * the inside.
 */
export function pathBaseline(
  profile: SketchProfile,
  startOffset: number,
  endOffset: number,
  anchor: TextBaselineAnchor,
  reversed: boolean,
): TextBaseline | null {
  const path = measureProfilePath(profile)
  if (!path) return null

  const range = normalizedPathRange(path, startOffset, endOffset)
  if (!range || range.span <= EPSILON) return null

  const anchorDistance = anchor === 'start'
    ? 0
    : anchor === 'center'
      ? range.span / 2
      : range.span

  return {
    span: range.span,
    at: (distance: number) => {
      // Walking the span backwards flips travel, which flips the tangent and
      // therefore which side of the curve the glyphs stand on.
      const along = reversed
        ? range.start + range.span - (anchorDistance + distance)
        : range.start + anchorDistance + distance
      // `path.at` already wraps a closed path and clamps an open one.
      const sample = path.at(along)
      return {
        point: sample.point,
        tangent: reversed ? { x: -sample.tangent.x, y: -sample.tangent.y } : sample.tangent,
      }
    },
  }
}

export interface BendResult<T extends BendableShape> {
  shapes: T[]
  /** Uniform scale applied to the run. 1 unless `fit: 'fill'` resized it. */
  scale: number
  /** Arc length the run actually occupies after fitting. */
  runLength: number
  /** True when a `natural` run is longer than the baseline span asked for. */
  overflows: boolean
}

/**
 * Lay a straight template's shapes along a baseline.
 *
 * Each glyph moves under a **similarity** transform — uniform scale, rotate,
 * translate — so letterforms are never sheared or stretched on one axis. That
 * is not fussiness: this is a CNC app, and a distorted letterform cuts as a
 * distorted letterform.
 *
 * Glyph size and glyph spacing therefore always move together. Spreading
 * positions to fill a span while leaving glyphs at their original size would
 * scatter letters across a wide sweep and overlap them on a narrow one; `fit`
 * picks which of the run's width and the baseline's span gives way, and both
 * halves follow it.
 */
export function bendShapesToBaseline<T extends BendableShape>(
  shapes: T[],
  bounds: TextTemplateBounds,
  baseline: TextBaseline,
  anchor: TextBaselineAnchor,
  fit: TextBaselineFit,
  orientation: TextBaselineOrientation,
): BendResult<T> {
  const naturalWidth = bounds.width
  if (shapes.length === 0 || naturalWidth <= EPSILON) {
    return { shapes, scale: 1, runLength: 0, overflows: false }
  }

  const scale = fit === 'fill' && baseline.span > EPSILON ? baseline.span / naturalWidth : 1
  const runLength = naturalWidth * scale
  const anchorOffset = anchor === 'start' ? 0 : anchor === 'center' ? -runLength / 2 : -runLength

  // The bottom of the straight run is the line that lands on the curve. It is
  // `maxY` in both font styles: skeleton glyph data is y-down with the feet at
  // y = 1, and outline profiles are flipped then normalised to minY = 0.
  const baselineY = bounds.maxY

  const groups = new Map<number, T[]>()
  shapes.forEach((shape, index) => {
    const key = shape.glyphIndex ?? -(index + 1)
    const group = groups.get(key)
    if (group) group.push(shape)
    else groups.set(key, [shape])
  })

  const bent: T[] = []
  for (const group of groups.values()) {
    const groupBounds = group
      .map((shape) => getProfileBounds(shape.profile))
      .reduce((acc, next) => ({
        minX: Math.min(acc.minX, next.minX),
        maxX: Math.max(acc.maxX, next.maxX),
        minY: Math.min(acc.minY, next.minY),
        maxY: Math.max(acc.maxY, next.maxY),
      }))
    const glyphCenterX = (groupBounds.minX + groupBounds.maxX) / 2
    const fraction = (glyphCenterX - bounds.minX) / naturalWidth
    const sample = baseline.at(anchorOffset + fraction * runLength)
    const angle = orientation === 'follow' ? Math.atan2(sample.tangent.y, sample.tangent.x) : 0
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    for (const shape of group) {
      bent.push({
        ...shape,
        profile: transformProfile(shape.profile, (point) => {
          const localX = (point.x - glyphCenterX) * scale
          const localY = (point.y - baselineY) * scale
          return {
            x: sample.point.x + localX * cos - localY * sin,
            y: sample.point.y + localX * sin + localY * cos,
          }
        }),
      })
    }
  }

  return {
    shapes: bent,
    scale,
    runLength,
    overflows: fit === 'natural' && baseline.span > EPSILON && runLength > baseline.span + EPSILON,
  }
}
