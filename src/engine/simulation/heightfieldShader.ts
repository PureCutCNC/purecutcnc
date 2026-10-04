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
import type { SimulationGrid } from './types'

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

/**
 * A height change of at most this many cells across one edge is always shaded
 * as a slope. A ball finish on large stock samples each scallop with only two
 * or three cells, so the gradient reverses at nearly every edge and no neighbor
 * "continues" it; without this bound those edges were drawn as risers and the
 * finished surface turned into a grid of flat squares (issue #939). The steepest
 * edge a scallop can produce is stepover / tool diameter cells tall, so half a
 * cell covers ball finishing up to roughly 45 % stepover.
 */
export const SHALLOW_SLOPE_CELLS = 0.5

/** How much steeper than its neighbor an edge may be and still continue a slope. */
export const SLOPE_CONTINUATION_RATIO = 4

/**
 * One predicate decides whether a grid edge is a vertical step, shared by the
 * surface sheet and the wall mesh so the two can never disagree about it: the
 * surface shades a slope, the wall draws a step. If they disagree, the loser's
 * shading shows up as a dark rim on a flat top — a tab's stock-to-tab wall
 * painted its own normal onto the 20 mm top beside it (issue #829).
 *
 * An edge is a slope when it is shallow (see `SHALLOW_SLOPE_CELLS`) or when its
 * step continues the gradient on either side of it (same sign, comparable
 * magnitude), which is what a V-flank or a ball roundover looks like across
 * many cells. An isolated step is a wall, and so is any step onto a cell whose
 * material has been removed entirely. A cut-through cell beyond the edge is the
 * far side of a wall, never more of a slope: counting its drop as a gradient
 * would turn a tall tab's stock-to-tab wall back into a shaded slope.
 *
 * Written in the scalar subset `glslScalar.testSupport.ts` can run, so the unit
 * tests exercise this exact source rather than a TypeScript copy of it.
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

/**
 * How far a grid corner moves, in cells on each axis, when the wall outline
 * turns there as part of a stair jog (issue #939, part 2).
 */
export const OUTLINE_CORNER_SHIFT_CELLS = 0.25

/**
 * Walls along the cut outline instead of along cell edges.
 *
 * A wall that is not grid-aligned is sampled as a staircase: a fine sawtooth
 * near 45°, long runs with one-cell jogs nearer an axis. The heights cannot say
 * where inside a cell the real edge ran — a cell is either cut or not — but the
 * pattern of walls around a corner can: where the outline turns one way and
 * turns back a cell later, the corner is a jog of a slanted edge, not a real
 * corner of the part.
 *
 * So the geometry stays exactly as it is and only grid corners move. A corner
 * where the outline turns as part of a jog moves a quarter cell on both axes
 * into the turn — halfway to the midpoints of the two wall edges that meet
 * there. Every top quad and every wall quad touching that corner reads the same
 * offset, so tops and walls still meet with no gap and no overlap, and a 45°
 * staircase comes out as one straight wall.
 *
 * A corner is such a turn only when:
 *  - exactly two of its four edges are walls by `edgeIsStep`, at a right angle,
 *    so the surface and the walls still agree which edges are walls;
 *  - the outline turns back at the next corner along one of those walls. A lone
 *    turn is a real corner and stays sharp; four turns the same way around one
 *    cell are a one-cell island or hole, which must not shrink (a tab bridge
 *    can be one cell wide, issue #829).
 *
 * Written with scalar arguments and one lookup, `cellHeightAt(x, z)`, so the
 * unit tests can run this source against a height field of their own. Needs
 * `STEP_GLSL` and `cellHeightAt`.
 */
export const OUTLINE_TURN_GLSL = /* glsl */ `
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

  // Which way a corner moves: 0 not at all, 1 toward +X +Z, 2 toward -X +Z,
  // 3 toward +X -Z, 4 toward -X -Z. Four lookups for nearly every corner; the
  // rest only where two edges could be walls.
  //
  // The eight wall tests run through one loop on purpose. Shader compilers
  // inline every call, and this function is itself inlined wherever a shader
  // moves a corner: written out call by call, the wall shader took seconds to
  // compile on a software renderer.
  int outlineCornerTurn(int cornerX, int cornerZ, float stockBottomZ, float cellSize) {
    float northWest = cellHeightAt(cornerX - 1, cornerZ - 1);
    float northEast = cellHeightAt(cornerX, cornerZ - 1);
    float southWest = cellHeightAt(cornerX - 1, cornerZ);
    float southEast = cellHeightAt(cornerX, cornerZ);
    // A turn needs a wall leaving the corner along each axis. A straight wall,
    // by far the commonest corner that has walls at all, fails this.
    bool mayTurn =
      (edgeMayBeStep(northEast, southEast, stockBottomZ, cellSize) || edgeMayBeStep(northWest, southWest, stockBottomZ, cellSize)) &&
      (edgeMayBeStep(southWest, southEast, stockBottomZ, cellSize) || edgeMayBeStep(northWest, northEast, stockBottomZ, cellSize));
    // Everything below sits inside this one branch, with no early return: a
    // GPU compiler turns an early return ahead of a loop into a mask and runs
    // the loop for every vertex anyway, which tripled the frame time.
    int turn = 0;
    if (mayTurn) {
      // Tests 0..3: the walls leaving this corner east, west, south, north.
      // Tests 4..7: at the next corner along each of its two walls, the wall
      // that turns back and the wall that runs on.
      bool wall[8];
      int turnX = 0;
      int turnZ = 0;
      for (int test = 0; test < 8; test += 1) {
        int fromX = cornerX;
        int fromZ = cornerZ;
        int dirX = 0;
        int dirZ = 0;
        if (test == 0) {
          dirX = 1;
        } else if (test == 1) {
          dirX = -1;
        } else if (test == 2) {
          dirZ = 1;
        } else if (test == 3) {
          dirZ = -1;
        } else {
          if (test == 4) {
            // A turn has a wall along exactly one direction on each axis.
            // Anything else leaves turnX or turnZ at zero.
            turnX = wall[0] == wall[1] ? 0 : (wall[0] ? 1 : -1);
            turnZ = wall[2] == wall[3] ? 0 : (wall[2] ? 1 : -1);
          }
          if (test == 4) {
            fromX += turnX;
            dirZ = -turnZ;
          } else if (test == 5) {
            fromX += turnX;
            dirX = turnX;
          } else if (test == 6) {
            fromZ += turnZ;
            dirX = -turnX;
          } else {
            fromZ += turnZ;
            dirZ = turnZ;
          }
        }
        wall[test] = wallFrom(fromX, fromZ, dirX, dirZ, stockBottomZ, cellSize);
      }
      // A jog turns back at the next corner, the other way, instead of running on.
      bool backAlongX = wall[4] && !wall[5];
      bool backAlongZ = wall[6] && !wall[7];
      if (turnX != 0 && turnZ != 0 && (backAlongX || backAlongZ)) {
        turn = turnX > 0 ? (turnZ > 0 ? 1 : 3) : (turnZ > 0 ? 2 : 4);
      }
    }
    return turn;
  }
`

/**
 * The offset of a grid corner, for both vertex shaders. Needs `uCellSize`,
 * `uStockBottomZ` and `OUTLINE_TURN_GLSL`, which in turn needs
 * `OUTLINE_LOOKUP_GLSL` ahead of it.
 */
export const OUTLINE_CORNER_GLSL = /* glsl */ `
  // Offset of a grid corner in cells.
  vec2 outlineCornerOffset(ivec2 corner) {
    int turn = outlineCornerTurn(corner.x, corner.y, uStockBottomZ, uCellSize);
    if (turn == 0) {
      return vec2(0.0);
    }
    return ${OUTLINE_CORNER_SHIFT_CELLS.toFixed(4)} * vec2(
      turn == 1 || turn == 3 ? 1.0 : -1.0,
      turn == 1 || turn == 2 ? 1.0 : -1.0
    );
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
  // most a quarter cell, so a point that left its own cell's quad lies in the
  // quad of the neighbor across the edge it crossed.
  ivec2 outlineCellAt(vec2 positionInCells) {
    ivec2 cell = ivec2(floor(positionInCells));
    // A loop, so the corner rule is compiled into this shader once, not four times.
    vec2 corners[4];
    for (int index = 0; index < 4; index += 1) {
      ivec2 corner = cell + ivec2(index & 1, index >> 1);
      corners[index] = vec2(corner) + outlineCornerOffset(corner);
    }
    vec2 northWest = corners[0];
    vec2 northEast = corners[1];
    vec2 southWest = corners[2];
    vec2 southEast = corners[3];
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

/** The lookup `OUTLINE_TURN_GLSL` reads cells through. Needs `CELL_HEIGHT_GLSL`. */
export const OUTLINE_LOOKUP_GLSL = /* glsl */ `
  float cellHeightAt(int x, int z) {
    return cellHeight(ivec2(x, z));
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

  // The slight darkening of deeper cuts, shared so a riser inside a slope
  // matches the tops on either side of it.
  float depthDarken(float height, float stockTopZ) {
    float depthRatio = clamp((stockTopZ - height) / max(stockTopZ - uStockBottomZ, 0.001), 0.0, 1.0);
    return 1.0 - depthRatio * 0.12;
  }
`

const vertexShader = /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform vec2 uOrigin;
  uniform float uCellSize;
  uniform float uStockBottomZ;

  ${STEP_GLSL}

  ${CELL_HEIGHT_GLSL}

  ${OUTLINE_LOOKUP_GLSL}

  ${OUTLINE_TURN_GLSL}

  ${OUTLINE_CORNER_GLSL}

  flat out ivec2 vCell;
  // Position inside the cell, 0..1 on both axes.
  out vec2 vLocal;
  out float vHeight;

  void main() {
    vCell = ivec2(int(position.x + 0.5), gl_InstanceID);
    vLocal = position.yz;
    float height = texelFetch(uHeightfield, vCell, 0).r;
    vHeight = height;

    // The top stays flat at its own height; its corners follow the wall
    // outline, exactly as the wall mesh's do.
    ivec2 corner = vCell + ivec2(int(position.y + 0.5), int(position.z + 0.5));
    vec2 cornerInCells = vec2(corner) + outlineCornerOffset(corner);
    vec3 displaced = vec3(
      uOrigin.x + cornerInCells.x * uCellSize,
      height,
      uOrigin.y + cornerInCells.y * uCellSize
    );

    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform sampler2D uHeightfield;
  uniform vec3 uColor;
  uniform float uStockBottomZ;
  uniform float uStockTopZ;
  uniform float uCellSize;

  flat in ivec2 vCell;
  in vec2 vLocal;
  in float vHeight;
  out vec4 fragColor;

  ${LIGHTING_GLSL}

  ${STEP_GLSL}

  ${SLOPE_GRADIENT_GLSL}

  ${SURFACE_NORMAL_GLSL}

  void main() {
    float threshold = uStockBottomZ + 0.000001;
    if (vHeight <= threshold) {
      discard;
    }

    // This cell is a flat tread, lit by the smoothed surface it samples. A step
    // takes no part in that: the wall mesh draws the riser, and borrowing its
    // normal is what painted a dark band along every tab.
    float wide = gradientWidening(vec3(vLocal, 0.0));
    vec3 lighting = calcLighting(surfaceNormal(vCell, vLocal, wide));

    fragColor = vec4(uColor * lighting * depthDarken(vHeight, uStockTopZ), 1.0);
  }
`

export function createHeightfieldMaterial(
  heightfieldTexture: THREE.DataTexture,
  grid: SimulationGrid,
  stockColor: THREE.Color,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHeightfield: { value: heightfieldTexture },
      uColor: { value: stockColor },
      uStockBottomZ: { value: grid.stockBottomZ },
      uStockTopZ: { value: grid.stockTopZ },
      uOrigin: { value: new THREE.Vector2(grid.originX, grid.originY) },
      uCellSize: { value: grid.cellSize },
    },
    vertexShader,
    fragmentShader,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  })
}
