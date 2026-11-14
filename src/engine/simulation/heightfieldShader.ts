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

import * as THREE from 'three'
import type { AroundFrame } from '../aroundFrame'
import { AROUND_CELL_GLSL, AROUND_FRAME_GLSL, aroundShader, aroundUniforms } from './aroundWrap'
import type { FlatRoundBarDescriptor, SimulationGrid } from './types'
import { SHALLOW_SLOPE_CELLS } from './stepThreshold'

// theme-exempt: scene lighting reference — matches SimulationViewport light rig
// Shared lighting code matching the scene lights in SimulationViewport:
//   AmbientLight(0xffffff, 0.7) // theme-exempt: scene lighting reference
//   DirectionalLight(0xffffff, 0.9) at (120, 180, 120) // theme-exempt: scene lighting reference
//   DirectionalLight(0x96b6ff, 0.35) at (-120, 80, -80) // theme-exempt: scene lighting reference
export const LIGHTING_GLSL = /* glsl */ `
  vec3 calcLighting(vec3 normal) {
    vec3 keyDir = normalize(vec3(120.0, 180.0, 120.0));
    vec3 fillDir = normalize(vec3(-120.0, 80.0, -80.0));
    vec3 fillColor = vec3(0.588, 0.714, 1.0);

    float diff1 = max(dot(normal, keyDir), 0.0);
    float diff2 = max(dot(normal, fillDir), 0.0);

    return vec3(0.7) + vec3(0.9) * diff1 + fillColor * 0.35 * diff2;
  }
`

// The bound lives in its own module so the replay kernel can share it
// without importing three.
export { SHALLOW_SLOPE_CELLS }

/** How much steeper than its neighbor an edge may be and still continue a slope. */
export const SLOPE_CONTINUATION_RATIO = 4

/**
 * One predicate decides whether a grid edge is a vertical step, shared by the
 * surface sheet and the wall mesh so the two can never disagree about it: the
 * surface shades a slope, the wall draws a step. If they disagree, the loser's
 * shading shows up as a dark rim on a flat top — a tab's stock-to-tab wall
 * painted its own normal onto the 20 mm top beside it (issue #829).
 *
 * An edge is a slope when it is at or below half a cell tall (see
 * `SHALLOW_SLOPE_CELLS`) or when its step continues the gradient on either side
 * of it (same sign, comparable magnitude), which is what a V-flank or a ball
 * roundover looks like across many cells. An isolated step is a wall, and so is any step onto a cell whose
 * material has been removed entirely. A cut-through cell beyond the edge is the
 * far side of a wall, never more of a slope: counting its drop as a gradient
 * would turn a tall tab's stock-to-tab wall back into a shaded slope.
 *
 * Written in the scalar subset `glslScalar.testSupport.ts` can run, so the unit
 * tests exercise this exact function rather than a TypeScript copy of it.
 */
export const STEP_GLSL = /* glsl */ `
  bool edgeIsStep(float hNear, float hFar, float hNearBeyond, float hFarBeyond, float stockBottomZ, float cellSize) {
    float dCenter = hFar - hNear;
    if (dCenter == 0.0) {
      // Adjacent cells at equal height — nothing here for either mesh to draw.
      return false;
    }
    float cutThroughZ = stockBottomZ + 0.000001;
    if (min(hNear, hFar) <= cutThroughZ) {
      return true;
    }
    if (abs(dCenter) <= ${SHALLOW_SLOPE_CELLS.toFixed(4)} * cellSize) {
      return false;
    }
    float dNear = hNearBeyond > cutThroughZ ? hNear - hNearBeyond : 0.0;
    float dFar = hFarBeyond > cutThroughZ ? hFarBeyond - hFar : 0.0;
    bool slopeContinues =
      (dNear * dCenter > 0.0 && abs(dCenter) <= ${SLOPE_CONTINUATION_RATIO.toFixed(1)} * abs(dNear)) ||
      (dFar * dCenter > 0.0 && abs(dCenter) <= ${SLOPE_CONTINUATION_RATIO.toFixed(1)} * abs(dFar));
    return !slopeContinues;
  }
`

/**
 * The surface's lighting gradient along one axis, as a scalar function of the
 * cell heights around a point. Stage-agnostic and, like `STEP_GLSL`, written in
 * the subset the unit tests can run.
 *
 * Up close the gradient is that of a quadratic B-spline through the cell
 * heights: the height change across the cell's two edges, blended linearly by
 * position along the axis, and a quadratic B-spline blend of the three
 * neighboring lines across it. That makes the lighting continuous across every
 * cell border instead of jumping once per cell, and at a cell's centre it
 * reduces to the central difference the shader used before.
 *
 * Zoomed out, a scallop two or three cells wide is narrower than a pixel, and
 * lighting it faithfully aliases into moiré rings. `wide` (0..1) blends in a
 * stencil twice as long — the four edges around the point on the cell's own
 * line, under a tent weight — which averages a scallop that narrow away and
 * leaves the form underneath.
 *
 * Steps are left out of all of it. An edge `edgeIsStep` calls a step contributes
 * no height change and hides the cells beyond it, and a neighboring line that
 * lies across a step from this cell is replaced by this cell's own line, so a
 * flat top beside a tab wall or a kerf stays lit as a flat top right up to its
 * rim (issue #829).
 *
 * Cost shapes the rest. This runs for every fragment of every cell, and a full
 * `edgeIsStep` is the expensive part, so only the four edges of the cell itself
 * get one (the caller passes them in, shared between the two axes). Every other
 * edge of the stencil is used only when it is shallow — which `edgeIsStep` would
 * call a slope too — and otherwise repeats the cell's own edge beside it. A
 * shallow finished surface, the case this smoothing exists for, is blended in
 * full; a steep flank blends along its own line only.
 */
export const SLOPE_GRADIENT_GLSL = /* glsl */ `
  // Height change across an edge the predicate was not asked about: its own
  // when it is certain to be a slope, otherwise that of the cell's edge beside it.
  float shallowSlopeDelta(float hFrom, float hTo, float fallback, float stockBottomZ, float cellSize) {
    float delta = hTo - hFrom;
    bool shallow =
      min(hFrom, hTo) > stockBottomZ + 0.000001 &&
      abs(delta) <= ${SHALLOW_SLOPE_CELLS.toFixed(4)} * cellSize;
    return shallow ? delta : fallback;
  }

  // Close-up gradient: the cell's own two edges blended along the axis, and
  // the same on the two neighboring lines blended across it.
  float nearGradient(
    float before, float after,
    float lineBefore1, float lineBefore2, float lineBefore3,
    float lineAfter1, float lineAfter2, float lineAfter3,
    bool lineStepBefore, bool lineStepAfter,
    float localAlong, float localAcross, float stockBottomZ, float cellSize
  ) {
    float own = mix(before, after, localAlong);
    // A neighboring line across a step belongs to a different face.
    float lineBefore = lineStepBefore ? own : mix(
      shallowSlopeDelta(lineBefore1, lineBefore2, before, stockBottomZ, cellSize),
      shallowSlopeDelta(lineBefore2, lineBefore3, after, stockBottomZ, cellSize),
      localAlong
    );
    float lineAfter = lineStepAfter ? own : mix(
      shallowSlopeDelta(lineAfter1, lineAfter2, before, stockBottomZ, cellSize),
      shallowSlopeDelta(lineAfter2, lineAfter3, after, stockBottomZ, cellSize),
      localAlong
    );
    float weightBefore = 0.5 * (1.0 - localAcross) * (1.0 - localAcross);
    float weightAfter = 0.5 * localAcross * localAcross;
    return weightBefore * lineBefore + (1.0 - weightBefore - weightAfter) * own + weightAfter * lineAfter;
  }

  // Zoomed-out gradient: the four edges around the point on the cell's own
  // line, under a tent weight.
  float farGradient(
    float h0, float h1, float h3, float h4,
    float before, float after, bool stepBefore, bool stepAfter,
    float localAlong, float stockBottomZ, float cellSize
  ) {
    float farBefore = stepBefore ? 0.0 : shallowSlopeDelta(h0, h1, before, stockBottomZ, cellSize);
    float farAfter = stepAfter ? 0.0 : shallowSlopeDelta(h3, h4, after, stockBottomZ, cellSize);
    return 0.25 * (
      (1.0 - localAlong) * farBefore +
      (2.0 - localAlong) * before +
      (1.0 + localAlong) * after +
      localAlong * farAfter
    );
  }

  // Height change per cell along one axis, at (localAlong, localAcross) inside
  // a cell, both 0..1.
  //   h0..h4                five cells along the axis, the cell itself in the middle
  //   lineBefore1..3        the cell before on the across axis (2), and the
  //                         cells either side of it along this axis (1 and 3)
  //   lineAfter1..3         the same for the cell after
  //   stepBefore/After      is the cell's edge to h1 / h3 a step
  //   lineStepBefore/After  is the cell's edge to lineBefore2 / lineAfter2 a step
  float axisGradient(
    float h0, float h1, float h2, float h3, float h4,
    float lineBefore1, float lineBefore2, float lineBefore3,
    float lineAfter1, float lineAfter2, float lineAfter3,
    bool stepBefore, bool stepAfter, bool lineStepBefore, bool lineStepAfter,
    float localAlong, float localAcross, float wide, float stockBottomZ, float cellSize
  ) {
    // The surface may shade only the edges the wall mesh does not own.
    float before = stepBefore ? 0.0 : h2 - h1;
    float after = stepAfter ? 0.0 : h3 - h2;
    // Each half is skipped where the zoom gives it no weight: that is most of
    // the screen, and this runs for every fragment.
    float near = 0.0;
    if (wide < 1.0) {
      near = nearGradient(
        before, after,
        lineBefore1, lineBefore2, lineBefore3,
        lineAfter1, lineAfter2, lineAfter3,
        lineStepBefore, lineStepAfter,
        localAlong, localAcross, stockBottomZ, cellSize
      );
    }
    float far = 0.0;
    if (wide > 0.0) {
      far = farGradient(h0, h1, h3, h4, before, after, stepBefore, stepAfter, localAlong, stockBottomZ, cellSize);
    }
    return mix(near, far, wide);
  }
`

/**
 * The wall mesh's height lookup: outside the stock there is no material, the
 * same as a cut-through cell, which is what makes the stock's own border a wall.
 * Needs `uHeightfield` and `uStockBottomZ`.
 */
export const CELL_HEIGHT_GLSL = /* glsl */ `
  float cellHeight(ivec2 cell) {
    ivec2 inside = clamp(cell, ivec2(0), textureSize(uHeightfield, 0) - ivec2(1));
    return inside == cell ? texelFetch(uHeightfield, inside, 0).r : uStockBottomZ;
  }
`

/** Offset code steps per cell: offsets of up to half a cell fit 0..254 around 127. */
export const OUTLINE_OFFSET_SCALE = 254

/**
 * How strongly a corner is pulled toward where it was, against the boundary
 * lines' unit weight. Weak enough to leave a corner between two crossing lines
 * on their intersection; it only decides where along a straight wall a corner
 * sits (where it was), and stops a lone line from moving it along itself.
 */
export const OUTLINE_CORNER_PULL = 0.05

/**
 * The corner texture's direction code meaning "no smoothed direction": the
 * walls there keep their own face normal.
 */
export const OUTLINE_NORMAL_NONE = 255

/**
 * Walls along the cut outline instead of along cell edges (issue #973).
 *
 * A wall that is not grid-aligned is sampled as a staircase: drawn on cell
 * edges it zigzags, and its faces light as alternating X- and Y-facing streaks.
 * A cell's height cannot say where between two cell centres the cut really
 * ended, but the replay kernel knows: it records, per cell, where the tool's
 * boundary crossed the lines to its east and south neighbours' centres and
 * which way the boundary faced (`edgeCrossings.ts`).
 *
 * So the geometry stays exactly as it is and only grid corners move. Each
 * corner is placed by dual contouring: the point nearest, in least squares, to
 * the boundary lines through the crossings on the walls that leave it, pulled
 * slightly toward the corner itself so a straight wall keeps its corners'
 * spacing along it. A curve comes out as the curve, and where two boundary
 * lines meet at an angle — a real corner of the part — the corner lands on
 * their intersection and stays sharp. A corner stays within half a cell of
 * where it was. Every top quad, wall quad and underside hole touching a corner
 * reads the same position, so tops and walls still meet with no gap and no
 * overlap.
 *
 * Which edges are walls is still `edgeIsStep`, the one predicate the surface
 * uses (issue #829). A wall edge with no recorded crossing — the grid's own
 * edge, or a step the kernel left to slope rules — keeps a crossing at its
 * cell edge, so it stays where it was drawn before.
 *
 * Nothing here runs per vertex: `outlineCorners.ts` solves every corner once
 * into a texture whenever the heights change, and the meshes read it through
 * `OUTLINE_CORNER_GLSL`. A per-vertex outline rule took the guitar render from
 * 12.4 to 32.3 ms on a Radeon Pro 560X (issue #939 part 2).
 *
 * Written in the scalar subset against two lookups, `cellHeightAt(x, z)` and
 * `cellCrossing(x, z, channel)` (the byte, 0..255), so the unit tests can run
 * this source against fields of their own. Needs `STEP_GLSL`.
 */
export const OUTLINE_WALL_GLSL = /* glsl */ `
  // Cheap, and never false for an edge edgeIsStep calls a step.
  bool edgeMayBeStep(float hNear, float hFar, float stockBottomZ, float cellSize) {
    if (hNear == hFar) {
      return false;
    }
    return min(hNear, hFar) <= stockBottomZ + 0.000001
      || abs(hFar - hNear) > ${SHALLOW_SLOPE_CELLS.toFixed(4)} * cellSize;
  }

  // Is the grid edge that leaves corner (cornerX, cornerZ) in direction
  // (dirX, dirZ) a wall? One of dirX, dirZ is +1 or -1, the other 0. A corner
  // is the lattice point at a cell's low-X low-Z corner.
  bool wallFrom(int cornerX, int cornerZ, int dirX, int dirZ, float stockBottomZ, float cellSize) {
    // The two cells the edge separates differ by (acrossX, acrossZ).
    int acrossX = dirZ != 0 ? 1 : 0;
    int acrossZ = dirX != 0 ? 1 : 0;
    int farX = cornerX + min(dirX, 0);
    int farZ = cornerZ + min(dirZ, 0);
    float hNear = cellHeightAt(farX - acrossX, farZ - acrossZ);
    float hFar = cellHeightAt(farX, farZ);
    if (!edgeMayBeStep(hNear, hFar, stockBottomZ, cellSize)) {
      return false;
    }
    return edgeIsStep(
      hNear, hFar,
      cellHeightAt(farX - 2 * acrossX, farZ - 2 * acrossZ),
      cellHeightAt(farX + acrossX, farZ + acrossZ),
      stockBottomZ, cellSize
    );
  }

  // The corner's position and wall direction, packed into one exact number:
  // x offset code + 256 * z offset code + 65536 * direction code. An offset code
  // is offset * ${OUTLINE_OFFSET_SCALE} + 127 (0..254, 127 = unmoved); the
  // direction code is the wall's line angle over pi in 0..254, or
  // ${OUTLINE_NORMAL_NONE} where the corner has no wall or no one direction.
  float outlineCornerSolve(int cornerX, int cornerZ, float stockBottomZ, float cellSize) {
    // Least squares on the boundary lines, plus a weak pull toward the corner.
    float a11 = ${OUTLINE_CORNER_PULL.toFixed(4)};
    float a12 = 0.0;
    float a22 = ${OUTLINE_CORNER_PULL.toFixed(4)};
    float b1 = 0.0;
    float b2 = 0.0;
    float normalSumX = 0.0;
    float normalSumZ = 0.0;
    float pointSumX = 0.0;
    float pointSumZ = 0.0;
    int walls = 0;
    // Sides 0..3: the walls leaving the corner east, west, south, north.
    for (int side = 0; side < 4; side += 1) {
      int dirX = side == 0 ? 1 : (side == 1 ? -1 : 0);
      int dirZ = side == 2 ? 1 : (side == 3 ? -1 : 0);
      if (!wallFrom(cornerX, cornerZ, dirX, dirZ, stockBottomZ, cellSize)) {
        continue;
      }
      walls += 1;
      // An east or west wall is crossed by the north-south line between the
      // cells either side of it, stored as the south line of the northern cell;
      // a south or north wall by the east line of the western cell.
      bool alongX = side < 2;
      int ownerX = side == 0 ? cornerX : cornerX - 1;
      int ownerZ = side == 2 ? cornerZ : cornerZ - 1;
      int position = cellCrossing(ownerX, ownerZ, alongX ? 2 : 0);
      float along = position == 0 ? 0.5 : float(position - 1) / 254.0;
      // The crossing, relative to the corner, in cells.
      float pointX = alongX ? (side == 0 ? 0.5 : -0.5) : along - 0.5;
      float pointZ = alongX ? along - 0.5 : (side == 2 ? 0.5 : -0.5);
      float normalX = 0.0;
      float normalZ = 0.0;
      if (position == 0) {
        // No crossing: the cell edge itself, facing the taller cell.
        float rise = alongX
          ? cellHeightAt(ownerX, ownerZ + 1) - cellHeightAt(ownerX, ownerZ)
          : cellHeightAt(ownerX + 1, ownerZ) - cellHeightAt(ownerX, ownerZ);
        float facing = rise >= 0.0 ? 1.0 : -1.0;
        normalX = alongX ? 0.0 : facing;
        normalZ = alongX ? facing : 0.0;
      } else {
        float angle = float(cellCrossing(ownerX, ownerZ, alongX ? 3 : 1)) * (6.283185307179586 / 256.0);
        normalX = cos(angle);
        normalZ = sin(angle);
      }
      float distance = normalX * pointX + normalZ * pointZ;
      a11 += normalX * normalX;
      a12 += normalX * normalZ;
      a22 += normalZ * normalZ;
      b1 += normalX * distance;
      b2 += normalZ * distance;
      normalSumX += normalX;
      normalSumZ += normalZ;
      pointSumX += pointX;
      pointSumZ += pointZ;
    }
    float determinant = a11 * a22 - a12 * a12;
    float offsetX = (a22 * b1 - a12 * b2) / determinant;
    float offsetZ = (a11 * b2 - a12 * b1) / determinant;
    // A corner stays within half a cell. The crossings lie on the edges of
    // that square, so where the lines meet outside it the crossings' average
    // is still on the outline (on it exactly for a straight wall), where
    // clamping the solution would pull it off.
    if (walls > 0 && (abs(offsetX) > 0.5 || abs(offsetZ) > 0.5)) {
      offsetX = pointSumX / float(walls);
      offsetZ = pointSumZ / float(walls);
    }
    float xCode = floor(offsetX * ${OUTLINE_OFFSET_SCALE.toFixed(1)} + 127.5);
    float zCode = floor(offsetZ * ${OUTLINE_OFFSET_SCALE.toFixed(1)} + 127.5);
    float direction = ${OUTLINE_NORMAL_NONE.toFixed(1)};
    // Walls facing opposite ways (both sides of something thin) have no one
    // direction; they keep their own face normals.
    if (walls > 0 && normalSumX * normalSumX + normalSumZ * normalSumZ > 0.01) {
      // The line runs at right angles to the normal; its angle in [0, pi).
      float angle = atan(normalSumZ, normalSumX) + 1.5707963267948966;
      if (angle < 0.0) {
        angle += 3.141592653589793;
      }
      if (angle >= 3.141592653589793) {
        angle -= 3.141592653589793;
      }
      if (angle >= 3.141592653589793) {
        angle -= 3.141592653589793;
      }
      direction = min(floor(angle * (254.0 / 3.141592653589793) + 0.5), 254.0);
    }
    return xCode + 256.0 * zCode + 65536.0 * direction;
  }
`

/**
 * A wall's lighting normal at one of its corners: the boundary's direction
 * from the corner texture where it has one, turned to face the same way as the
 * wall's own face normal; otherwise that face normal. Needs `uOutlineCorners`.
 */
export const OUTLINE_NORMAL_GLSL = /* glsl */ `
  vec3 outlineWallNormal(ivec2 corner, vec3 faceNormal) {
    ivec2 inside = clamp(corner, ivec2(0), textureSize(uOutlineCorners, 0) - ivec2(1));
    int code = int(texelFetch(uOutlineCorners, inside, 0).b * 255.0 + 0.5);
    if (code >= ${OUTLINE_NORMAL_NONE} || inside != corner) {
      return faceNormal;
    }
    float angle = float(code) * (3.141592653589793 / 254.0);
    vec3 smoothed = vec3(-sin(angle), 0.0, cos(angle));
    return dot(smoothed, faceNormal) < 0.0 ? -smoothed : smoothed;
  }
`

/** The lookup `OUTLINE_WALL_GLSL` reads cells through. Needs `CELL_HEIGHT_GLSL`. */
export const OUTLINE_LOOKUP_GLSL = /* glsl */ `
  float cellHeightAt(int x, int z) {
    return cellHeight(ivec2(x, z));
  }
`

/**
 * The offset of a grid corner, read from the precomputed corner texture. Every
 * mesh that places a corner — the top surface, both wall strips and the
 * underside — goes through this one function, so they cannot disagree on where
 * a corner is. Needs `uOutlineCorners`, a `(cols + 1) × (rows + 1)` texture.
 */
export const OUTLINE_CORNER_GLSL = /* glsl */ `
  // Offset of a grid corner in cells.
  vec2 outlineCornerOffset(ivec2 corner) {
    ivec2 inside = clamp(corner, ivec2(0), textureSize(uOutlineCorners, 0) - ivec2(1));
    if (inside != corner) {
      return vec2(0.0);
    }
    vec2 code = floor(texelFetch(uOutlineCorners, inside, 0).rg * 255.0 + 0.5);
    return (code - 127.0) / ${OUTLINE_OFFSET_SCALE.toFixed(1)};
  }
`

/**
 * Which cell's top covers a point, once the corners have moved: the stock
 * underside asks this per fragment so its holes end on the same outline as the
 * walls above them. Needs `OUTLINE_CORNER_GLSL`.
 */
export const OUTLINE_CELL_GLSL = /* glsl */ `
  float outlineSide(vec2 from, vec2 to, vec2 point) {
    vec2 edge = to - from;
    vec2 offset = point - from;
    return edge.x * offset.y - edge.y * offset.x;
  }

  // positionInCells is in cell units from the grid origin. A corner moves at
  // most half a cell, so a point that left its own cell's quad lies in the
  // quad of the neighbor across the edge it crossed.
  ivec2 outlineCellAt(vec2 positionInCells, ivec2 lastCell) {
    ivec2 cell = clamp(ivec2(floor(positionInCells)), ivec2(0), lastCell);
    vec2 northWest = vec2(cell) + outlineCornerOffset(cell);
    vec2 northEast = vec2(cell + ivec2(1, 0)) + outlineCornerOffset(cell + ivec2(1, 0));
    vec2 southWest = vec2(cell + ivec2(0, 1)) + outlineCornerOffset(cell + ivec2(0, 1));
    vec2 southEast = vec2(cell + ivec2(1, 1)) + outlineCornerOffset(cell + ivec2(1, 1));
    if (outlineSide(northWest, southWest, positionInCells) > 0.0) {
      cell.x -= 1;
    } else if (outlineSide(northEast, southEast, positionInCells) < 0.0) {
      cell.x += 1;
    }
    if (outlineSide(northWest, northEast, positionInCells) < 0.0) {
      cell.y -= 1;
    } else if (outlineSide(southWest, southEast, positionInCells) > 0.0) {
      cell.y += 1;
    }
    return cell;
  }
`

/**
 * The slight darkening of deeper cuts, shared by every stock surface so a
 * riser inside a slope, the heightfield tops and the round bar's static lower
 * half all shade depth the same way. Needs `uStockBottomZ`.
 */
export const DEPTH_DARKEN_GLSL = /* glsl */ `  // The slight darkening of deeper cuts, shared so a riser inside a slope
  // matches the tops on either side of it.
  float depthDarken(float height, float stockTopZ) {
    float depthRatio = clamp((stockTopZ - height) / max(stockTopZ - uStockBottomZ, 0.001), 0.0, 1.0);
    return 1.0 - depthRatio * 0.12;
  }
`

/**
 * A flat round bar's silhouette (issue #1049): the material ends on the circle
 * of the bar's own radius, whatever the grid spacing. A grid whose across
 * extent is not exactly the diameter puts the outermost material cell's
 * boundary a little inside or outside that circle (a Ø41 mm bar at 96 cells
 * overshoots by 0.667 mm). The wall mesh pulls an overshooting boundary back
 * onto the silhouette and the surface sheet discards whatever lies beyond it,
 * so both meet the static lower half on the same circle instead of leaving an
 * open equator gap. Written in the scalar subset the tests can run.
 */
export const ROUND_BAR_SILHOUETTE_GLSL = /* glsl */ `
  // The bar's silhouette: the across coordinate clamped to [centre - radius, centre + radius].
  float roundBarSilhouetteAcross(float across, float centre, float radius) {
    return clamp(across, centre - radius, centre + radius);
  }

  bool roundBarOutsideSilhouette(float across, float centre, float radius) {
    return abs(across - centre) > radius;
  }
`

/**
 * A square blank's silhouette (issue #1112 rt3-b): the bar view draws nothing
 * outside the blank's own cross-section.
 *
 * The wrapped heightfield stores one radius per across cell, taken at the
 * cell's own angle, and draws each cell as a flat quad at that radius with a
 * radial wall to its neighbour. A round bar's polygon is inscribed in its
 * circle by construction, so the render can only ever be inside it. A square
 * blank's section is `halfSide / max(|sin|, |cos|)`, which *rises* away from
 * the blank's flats, so the cell-centre radius is the largest radius in its
 * cell: near a corner the quad overshoots the blank's flats and the wall
 * between two cells straddles the true surface there, leaving a ragged fin up
 * to one cell step (~0.02 in at the default detail) outside the blank — below
 * its bottom face along both uncut ends, and above its top face, visibly as a
 * ragged silhouette edge from any angle and as a thin lip under the ends from
 * a low one. The turned middle shows none of it: its radius is far smaller
 * than the blank's, so its own facets have nothing to poke out of.
 *
 * Clamping each rendered radius onto the blank's true surface removes every
 * one of those, without touching a single heightfield value: `topZ` is still
 * the cell's own radius, every cut is unchanged, and only the drawn position
 * moves — and only where it is outside the blank. A block or a round bar
 * passes no side and compiles exactly the shader it did before. Written in the
 * scalar subset the tests can run.
 */
export const SQUARE_BLANK_SILHOUETTE_GLSL = /* glsl */ `
  // The blank's surface radius along the ray at one angle: half the side on a
  // flat, side/√2 at a corner.
  float squareBlankSurfaceRadius(float side, float angle) {
    float s = abs(sin(angle));
    float c = abs(cos(angle));
    return 0.5 * side / max(max(s, c), 0.000001);
  }

  // A radial height clamped onto the blank, so the drawn surface never leaves
  // the square it represents.
  float squareBlankSilhouetteRadius(float side, float angle, float radius) {
    float surface = squareBlankSurfaceRadius(side, angle);
    return radius < surface ? radius : surface;
  }
`

/**
 * The smoothed surface normal at any point inside a cell, shared by the surface
 * sheet and by the wall mesh (which fills the small risers inside a slope with
 * the surface's own shading). Fragment-stage only (it reads screen
 * derivatives); needs `uHeightfield`, `uCellSize`, `uStockBottomZ`, `STEP_GLSL`
 * and `SLOPE_GRADIENT_GLSL`.
 */
export const SURFACE_NORMAL_GLSL = /* glsl */ `
  // The stencil's lookup repeats the border cell past the stock's edge instead
  // of testing every fetch for it. For the edges the stencil reads that is the
  // same answer as the walls' cellHeight gives: a repeated cell adds no height
  // change, and a cut-through one beyond an edge is ignored by edgeIsStep.
  float stencilHeight(ivec2 cell, ivec2 lastCell) {
    return texelFetch(uHeightfield, clamp(cell, ivec2(0), lastCell), 0).r;
  }

  // Unit normal of the smoothed surface at a point inside a cell. Thirteen
  // cells: the cell, two more each way along both axes, and its four diagonals.
  vec3 surfaceNormal(ivec2 cell, vec2 local, float wide) {
    ivec2 lastCell = textureSize(uHeightfield, 0) - ivec2(1);
    float center = stencilHeight(cell, lastCell);
    float west2 = stencilHeight(cell + ivec2(-2, 0), lastCell);
    float west = stencilHeight(cell + ivec2(-1, 0), lastCell);
    float east = stencilHeight(cell + ivec2(1, 0), lastCell);
    float east2 = stencilHeight(cell + ivec2(2, 0), lastCell);
    float north2 = stencilHeight(cell + ivec2(0, -2), lastCell);
    float north = stencilHeight(cell + ivec2(0, -1), lastCell);
    float south = stencilHeight(cell + ivec2(0, 1), lastCell);
    float south2 = stencilHeight(cell + ivec2(0, 2), lastCell);
    float northWest = stencilHeight(cell + ivec2(-1, -1), lastCell);
    float northEast = stencilHeight(cell + ivec2(1, -1), lastCell);
    float southWest = stencilHeight(cell + ivec2(-1, 1), lastCell);
    float southEast = stencilHeight(cell + ivec2(1, 1), lastCell);

    // Most of a 2.5D job is flat stock and flat floors, where there is nothing
    // to classify or blend.
    float relief =
      abs(west2 - center) + abs(west - center) + abs(east - center) + abs(east2 - center) +
      abs(north2 - center) + abs(north - center) + abs(south - center) + abs(south2 - center) +
      abs(northWest - center) + abs(northEast - center) + abs(southWest - center) + abs(southEast - center);
    if (relief == 0.0) {
      return vec3(0.0, 1.0, 0.0);
    }

    bool stepWest = edgeIsStep(west, center, west2, east, uStockBottomZ, uCellSize);
    bool stepEast = edgeIsStep(center, east, west, east2, uStockBottomZ, uCellSize);
    bool stepNorth = edgeIsStep(north, center, north2, south, uStockBottomZ, uCellSize);
    bool stepSouth = edgeIsStep(center, south, north, south2, uStockBottomZ, uCellSize);

    float dhdx = axisGradient(
      west2, west, center, east, east2,
      northWest, north, northEast,
      southWest, south, southEast,
      stepWest, stepEast, stepNorth, stepSouth,
      local.x, local.y, wide, uStockBottomZ, uCellSize
    ) / uCellSize;
    float dhdz = axisGradient(
      north2, north, center, south, south2,
      northWest, west, southWest,
      northEast, east, southEast,
      stepNorth, stepSouth, stepWest, stepEast,
      local.y, local.x, wide, uStockBottomZ, uCellSize
    ) / uCellSize;
    return normalize(vec3(-dhdx, 1.0, -dhdz));
  }

  // How far to widen the stencil, from how many cells one pixel covers at this
  // fragment (positionInCells is the fragment's position in cell units). Full
  // detail while a cell is two pixels or more, fully widened once it is one.
  float gradientWidening(vec3 positionInCells) {
    float cellsPerPixel = max(length(dFdx(positionInCells)), length(dFdy(positionInCells)));
    return smoothstep(0.5, 1.0, cellsPerPixel);
  }

${DEPTH_DARKEN_GLSL}`

const vertexShader = (flatRoundBar: boolean, squareBlank: boolean, outline: boolean): string => /* glsl */ `
  uniform sampler2D uHeightfield;
${outline ? `  // Issue #973: each grid corner's offset onto the wall outline.
  uniform sampler2D uOutlineCorners;
${OUTLINE_CORNER_GLSL}` : ''}  uniform vec2 uOrigin;
  uniform float uCellSize;
${flatRoundBar ? `  // Which world axis runs across the bar (0 = X, 1 = Z).
  uniform float uBarAxis;
` : ''}${squareBlank ? `  // The square blank's side, for the silhouette its own cross-section draws.
  uniform float uBlankSide;
` : ''}${squareBlank ? SQUARE_BLANK_SILHOUETTE_GLSL : ''}
  ${AROUND_FRAME_GLSL}
#ifdef AROUND_WRAP
  out float vAcross;
#endif
  flat out ivec2 vCell;
  // Position inside the cell, 0..1 on both axes.
  out vec2 vLocal;
  out float vHeight;
${flatRoundBar ? `  // World coordinate across the bar, so the top can stop on its silhouette.
  out float vAcrossWorld;
` : ''}
  void main() {
    vCell = ivec2(int(position.x + 0.5), gl_InstanceID);
    vLocal = position.yz;
    float height = texelFetch(uHeightfield, vCell, 0).r;
    vHeight = height;

${outline ? `    // The top stays flat at its own height; its corners follow the wall
    // outline, exactly as the wall mesh's and the underside's do (issue #973).
    ivec2 corner = vCell + ivec2(int(position.y + 0.5), int(position.z + 0.5));
    vec2 cornerInCells = vec2(corner) + outlineCornerOffset(corner);
    vec3 displaced = vec3(
      uOrigin.x + cornerInCells.x * uCellSize,
      height,
      uOrigin.y + cornerInCells.y * uCellSize
    );
` : `    vec3 displaced = vec3(
      uOrigin.x + (position.x + position.y) * uCellSize,
      height,
      uOrigin.y + (float(gl_InstanceID) + position.z) * uCellSize
    );
`}
#ifdef AROUND_WRAP
    displaced = aroundClampSheet(displaced);
${squareBlank ? `    // A square blank's section is widest at its cell centres, so the drawn quad
    // can reach past the blank's flats near a corner: clamp it back onto the
    // square the heightfield stands for (issue #1112 rt3-b).
    displaced.y = squareBlankSilhouetteRadius(uBlankSide, 6.283185307179586 * ((uAroundX ? displaced.z : displaced.x) - uAroundZero) / uAroundPeriod, displaced.y);
` : ''}    vAcross = uAroundX ? displaced.z : displaced.x;
    displaced = aroundPosition(displaced);
#endif
${flatRoundBar ? `    vAcrossWorld = uBarAxis < 0.5 ? displaced.z : displaced.x;
` : ''}    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`

const fragmentShader = (flatRoundBar: boolean): string => /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform vec3 uColor;
  uniform float uStockBottomZ;
  uniform float uStockTopZ;
  uniform float uCellSize;

  ${AROUND_FRAME_GLSL}
#ifdef AROUND_WRAP
  in float vAcross;
  uniform mat4 modelMatrix;
#endif
  ${AROUND_CELL_GLSL}
  flat in ivec2 vCell;
  in vec2 vLocal;
  in float vHeight;
${flatRoundBar ? `  in float vAcrossWorld;
  uniform float uBarCentre;
  uniform float uBarRadius;
` : ''}  out vec4 fragColor;

  ${LIGHTING_GLSL}

  ${STEP_GLSL}

  ${SLOPE_GRADIENT_GLSL}

  ${SURFACE_NORMAL_GLSL}
${flatRoundBar ? `  ${ROUND_BAR_SILHOUETTE_GLSL}
` : ''}
  void main() {
    float threshold = uStockBottomZ + 0.000001;
    if (vHeight <= threshold) {
      discard;
    }
${flatRoundBar ? `    // The flat top is part of the bar's silhouette: an outermost cell that
    // reaches past the radius is clipped back onto the circle, where the wall
    // mesh and the static lower half meet it (issue #1049).
    if (roundBarOutsideSilhouette(vAcrossWorld, uBarCentre, uBarRadius)) {
      discard;
    }
` : ''}
    // This cell is a flat tread, lit by the smoothed surface it samples. A step
    // takes no part in that: the wall mesh draws the riser, and borrowing its
    // normal is what painted a dark band along every tab.
    float wide = gradientWidening(vec3(vLocal, 0.0));
    vec3 lighting = calcLighting(surfaceNormal(vCell, vLocal, wide));
#ifdef AROUND_WRAP
    lighting = calcLighting(normalize(mat3(modelMatrix) * aroundSurfaceNormal(surfaceNormal(vCell, vLocal, wide), vAcross)));
#endif

    fragColor = vec4(uColor * lighting * depthDarken(vHeight, uStockTopZ), 1.0);
  }
`

export function createHeightfieldMaterial(
  heightfieldTexture: THREE.DataTexture,
  grid: SimulationGrid,
  stockColor: THREE.Color,
  frame?: AroundFrame,
  flatRoundBar?: FlatRoundBarDescriptor,
  squareBlankSide?: number,
  outlineCorners?: THREE.Texture,
): THREE.ShaderMaterial {
  const roundBar = flatRoundBar !== undefined
  // Sub-cell walls (issue #973) are a flat-sheet feature: a wrapped grid's
  // seam would need its own periodic corner lookup, so it keeps cell edges.
  const outline = frame === undefined ? outlineCorners : undefined
  // Only the wrapped bar view of a square blank has a silhouette to clamp to;
  // a block, a flat setup or a round bar compiles exactly the shader it did.
  const blankSide = frame === undefined ? undefined : squareBlankSide
  return new THREE.ShaderMaterial({
    ...(frame ? { defines: { AROUND_WRAP: 1 } } : {}),
    uniforms: {
      ...aroundUniforms(frame),
      uHeightfield: { value: heightfieldTexture },
      uColor: { value: stockColor },
      uStockBottomZ: { value: grid.stockBottomZ },
      uStockTopZ: { value: grid.stockTopZ },
      uOrigin: { value: new THREE.Vector2(grid.originX, grid.originY) },
      uCellSize: { value: grid.cellSize },
      ...(flatRoundBar
        ? {
            uBarAxis: { value: flatRoundBar.axis === 'x' ? 0 : 1 },
            uBarCentre: { value: flatRoundBar.centre },
            uBarRadius: { value: flatRoundBar.radius },
          }
        : {}),
      ...(blankSide !== undefined ? { uBlankSide: { value: blankSide } } : {}),
      ...(outline ? { uOutlineCorners: { value: outline } } : {}),
    },
    vertexShader: aroundShader(vertexShader(roundBar, blankSide !== undefined, outline !== undefined), frame),
    fragmentShader: aroundShader(fragmentShader(roundBar), frame),
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  })
}
