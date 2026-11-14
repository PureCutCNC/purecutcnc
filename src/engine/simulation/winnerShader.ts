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
 * The GLSL of winner-move shading (issue #1209). A cell's height is the
 * kernel's sample at its centre; between centres the true surface is the
 * lowest of the cutter surfaces of the moves that cut there. The flat kernel
 * records the move that won each cell (`SimulationGrid.winners`), and the
 * surface shader evaluates those moves — the winners of the 2×2 cells around
 * the fragment, plus each winner's neighbour on either side in cut order (the
 * next segment of the same pass) — exactly at the fragment's position.
 *
 * `WINNER_CUT_GLSL` is the per-move math, kept to the scalar subset so the
 * tests run this text against the kernel (`glslScalar.testSupport.ts`). It is
 * the kernel's own formula: the closest point on the move's XY segment, the
 * tool centre's Z there, and the flat, ball, V-bit or torch profile.
 */

/** Texels per row of the move table texture: WebGL2's guaranteed minimum size. */
export const MOVE_TABLE_TEXTURE_WIDTH = 2048
/** The most rows the table may use, for the same reason. */
export const MOVE_TABLE_TEXTURE_MAX_ROWS = 2048
/** A cutter height meaning "this move does not reach the point". */
export const WINNER_NO_CUT = 1e30

export const WINNER_CUT_GLSL = /* glsl */ `
  // How far along the move's XY segment its closest point to (px, py) lies,
  // clamped to the part of the move that has been cut (maxT < 1 only for the
  // move playback is partway through).
  float winnerMoveT(float x0, float y0, float x1, float y1, float px, float py, float maxT) {
    float dx = x1 - x0;
    float dy = y1 - y0;
    float lengthSq = dx * dx + dy * dy;
    if (lengthSq <= 1e-12) {
      return 0.0;
    }
    float t = ((px - x0) * dx + (py - y0) * dy) / lengthSq;
    return clamp(t, 0.0, maxT);
  }

  // The move's cutter surface at (px, py), never below the stock bottom, or
  // WINNER_NO_CUT outside its reach. toolType: 0 flat/drill, 1 ball, 2 V-bit,
  // 3 plasma torch (a full-depth kerf).
  float winnerCutZ(
    float x0, float y0, float z0, float x1, float y1, float z1,
    float toolType, float radius, float invSlope,
    float px, float py, float bottom, float maxT
  ) {
    float t = winnerMoveT(x0, y0, x1, y1, px, py, maxT);
    float ex = px - (x0 + (x1 - x0) * t);
    float ey = py - (y0 + (y1 - y0) * t);
    float distanceSq = ex * ex + ey * ey;
    float reach = radius + 1e-9;
    if (distanceSq > reach * reach) {
      return ${WINNER_NO_CUT.toExponential()};
    }
    float dx = x1 - x0;
    float dy = y1 - y0;
    float centerZ = dx * dx + dy * dy <= 1e-12 ? min(z0, z1) : z0 + (z1 - z0) * t;
    float cut = centerZ;
    if (toolType > 2.5) {
      cut = bottom;
    } else if (toolType > 1.5) {
      cut = centerZ + sqrt(distanceSq) * invSlope;
    } else if (toolType > 0.5) {
      cut = centerZ + radius - sqrt(max(radius * radius - distanceSq, 0.0));
    }
    return max(cut, bottom);
  }

  // One component of the cutter surface's slope at (px, py): d/dx when
  // alongX, else d/dy. Zero where the surface sits on the stock bottom.
  float winnerCutSlope(
    float x0, float y0, float z0, float x1, float y1, float z1,
    float toolType, float radius, float invSlope,
    float px, float py, float bottom, float maxT, bool alongX
  ) {
    if (winnerCutZ(x0, y0, z0, x1, y1, z1, toolType, radius, invSlope, px, py, bottom, maxT) <= bottom) {
      return 0.0;
    }
    float dx = x1 - x0;
    float dy = y1 - y0;
    float lengthSq = dx * dx + dy * dy;
    float t = winnerMoveT(x0, y0, x1, y1, px, py, maxT);
    float ex = px - (x0 + dx * t);
    float ey = py - (y0 + dy * t);
    float e = alongX ? ex : ey;
    // The tool centre's Z follows t, which moves with the point only inside
    // the segment.
    float slope = 0.0;
    if (lengthSq > 1e-12 && t > 0.0 && t < maxT) {
      slope = (z1 - z0) * (alongX ? dx : dy) / lengthSq;
    }
    if (toolType > 2.5) {
      return 0.0;
    }
    if (toolType > 1.5) {
      return slope + invSlope * e / max(sqrt(ex * ex + ey * ey), 1e-9);
    }
    if (toolType > 0.5) {
      return slope + e / sqrt(max(radius * radius - ex * ex - ey * ey, 1e-12));
    }
    return slope;
  }
`

/**
 * The fragment-side lookup around `WINNER_CUT_GLSL`: which moves to evaluate,
 * from the winner and move-table textures. Not scalar, so the rendered e2e
 * test covers it.
 */
export const WINNER_SURFACE_GLSL = /* glsl */ `
  uniform highp usampler2D uWinners;
  uniform highp sampler2D uMoveTable;
  // Per tool slot: profile code, radius, V-bit inverse slope.
  uniform vec3 uMoveTools[8];
  uniform int uMoveCount;
  // Playback: entries below uMoveCurrent are complete, uMoveCurrent has reached
  // uMoveElapsed of its length, later ones have not started.
  uniform int uMoveCurrent;
  uniform float uMoveElapsed;

  vec4 moveTableTexel(int texel) {
    int row = texel / ${MOVE_TABLE_TEXTURE_WIDTH};
    return texelFetch(uMoveTable, ivec2(texel - row * ${MOVE_TABLE_TEXTURE_WIDTH}, row), 0);
  }

  float winnerEntryCut(int entry, vec2 p, float bottom) {
    vec4 from = moveTableTexel(2 * entry);
    vec4 to = moveTableTexel(2 * entry + 1);
    vec3 tool = uMoveTools[int(from.w)];
    float maxT = entry == uMoveCurrent ? uMoveElapsed : 1.0;
    return winnerCutZ(from.x, from.y, from.z, to.x, to.y, to.z, tool.x, tool.y, tool.z, p.x, p.y, bottom, maxT);
  }

  vec2 winnerEntrySlope(int entry, vec2 p, float bottom) {
    vec4 from = moveTableTexel(2 * entry);
    vec4 to = moveTableTexel(2 * entry + 1);
    vec3 tool = uMoveTools[int(from.w)];
    float maxT = entry == uMoveCurrent ? uMoveElapsed : 1.0;
    return vec2(
      winnerCutSlope(from.x, from.y, from.z, to.x, to.y, to.z, tool.x, tool.y, tool.z, p.x, p.y, bottom, maxT, true),
      winnerCutSlope(from.x, from.y, from.z, to.x, to.y, to.z, tool.x, tool.y, tool.z, p.x, p.y, bottom, maxT, false)
    );
  }

  // The exact height and slope at sheet point p (cellPos is p in cell units).
  // False when a nearby cell's winner is unknown: the caller then keeps the
  // cell-sampled surface.
  bool winnerSurface(vec2 p, vec2 cellPos, float top, float bottom, out float height, out vec2 slope) {
    height = top;
    slope = vec2(0.0);
    ivec2 size = textureSize(uWinners, 0);
    ivec2 low = ivec2(floor(cellPos - 0.5));
    int seen[4];
    int seenCount = 0;
    int best = -1;
    for (int corner = 0; corner < 4; corner += 1) {
      ivec2 cell = low + ivec2(corner & 1, corner >> 1);
      if (cell.x < 0 || cell.y < 0 || cell.x >= size.x || cell.y >= size.y) continue;
      uint winner = texelFetch(uWinners, cell, 0).r;
      if (winner == 0xfffffffeu) return false;
      if (winner == 0xffffffffu) continue;
      int entry = int(winner);
      bool repeated = false;
      for (int k = 0; k < 4; k += 1) {
        if (k < seenCount && seen[k] == entry) repeated = true;
      }
      if (repeated) continue;
      seen[seenCount] = entry;
      seenCount += 1;
      float slot = moveTableTexel(2 * entry).w;
      for (int step = -1; step <= 1; step += 1) {
        int candidate = entry + step;
        if (candidate < 0 || candidate >= uMoveCount || candidate > uMoveCurrent) continue;
        if (step != 0 && moveTableTexel(2 * candidate).w != slot) continue;
        float cut = winnerEntryCut(candidate, p, bottom);
        if (cut < height) {
          height = cut;
          best = candidate;
        }
      }
    }
    if (best >= 0) slope = winnerEntrySlope(best, p, bottom);
    return true;
  }
`
