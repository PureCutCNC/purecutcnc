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
 * Toolpaths in a Bottom (mirrored) sketch view — the two defects the review
 * of PR #978 reproduced (issue #945):
 *
 * - a toolpath vanished as soon as the view was not symmetric about the flip
 *   line, because it was culled against the unreflected viewport;
 * - the GPU renderer's foreground overlay kept the Top view's last frame on
 *   screen over the Bottom view, and the renderer never reported that Canvas
 *   had taken over.
 *
 * Mutations these assertions were checked against:
 * - `canvasDisplayViewport` ignoring the mirror → "is drawn" fails for both
 *   axes;
 * - `renderSketchToolpaths` handing `drawToolpath` the view without its
 *   mirror (the original code) → the same;
 * - culling switched off for a mirrored view → "is culled" fails;
 * - the foreground cleared only on the GPU path (the original code) → "the
 *   Top overlay is cleared" fails;
 * - no report from the mirrored branch → "Canvas is reported" fails.
 *
 * Run with: npx tsx src/components/canvas/renderSketchToolpaths.test.ts
 */

import type { ToolpathResult } from '../../engine/toolpaths/types'
import { newProject } from '../../types/project'
import type { ToolpathVisibility } from '../toolpathVisibility'
import { renderSketchToolpaths } from './renderSketchToolpaths'
import type { SketchToolpathSurface } from './useSketchToolpathRenderer'
import type { ViewTransform } from './viewTransform'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

interface DrawnSegment { fromX: number; fromY: number; toX: number; toY: number }

/**
 * A 2D context that applies `translate` / `scale` the way a canvas does and
 * records every stroked segment in canvas pixels — where it lands on screen.
 */
function screenContext(width: number, height: number) {
  const segments: DrawnSegment[] = []
  const cleared: Array<{ width: number; height: number }> = []
  let transform = { a: 1, d: 1, e: 0, f: 0 }
  const stack: Array<typeof transform> = []
  const toScreen = (x: number, y: number) => ({ x: transform.a * x + transform.e, y: transform.d * y + transform.f })
  const ctx = {
    canvas: { width, height },
    save: () => { stack.push({ ...transform }) },
    restore: () => { transform = stack.pop() ?? transform },
    translate: (x: number, y: number) => { transform = { ...transform, e: transform.e + transform.a * x, f: transform.f + transform.d * y } },
    scale: (x: number, y: number) => { transform = { ...transform, a: transform.a * x, d: transform.d * y } },
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: (x: number, y: number) => {
      const point = toScreen(x, y)
      segments.push({ fromX: point.x, fromY: point.y, toX: Number.NaN, toY: Number.NaN })
    },
    lineTo: (x: number, y: number) => {
      const point = toScreen(x, y)
      const last = segments[segments.length - 1]
      if (last) { last.toX = point.x; last.toY = point.y }
    },
    stroke: () => undefined,
    fill: () => undefined,
    setLineDash: () => undefined,
    clearRect: (_x: number, _y: number, w: number, h: number) => { cleared.push({ width: w, height: h }) },
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, segments, cleared }
}

const CUTS_ONLY: ToolpathVisibility = { cuts: true, leadIns: false, rapids: false, plunges: false, retractions: false, directions: false }
const project = newProject()

function cut(operationId: string, from: { x: number; y: number }, to: { x: number; y: number }): ToolpathResult {
  return {
    operationId,
    moves: [{ kind: 'cut', from: { ...from, z: 0 }, to: { ...to, z: 0 } }],
    warnings: [],
    bounds: null,
  }
}

function drawn(segments: readonly DrawnSegment[], expected: DrawnSegment): boolean {
  return segments.some((segment) => (
    Math.abs(segment.fromX - expected.fromX) < 1e-9 && Math.abs(segment.fromY - expected.fromY) < 1e-9
    && Math.abs(segment.toX - expected.toX) < 1e-9 && Math.abs(segment.toY - expected.toY) < 1e-9
  ))
}

// ── Culling follows the mirror ────────────────────────────────

// The reviewer's case: on a 40-pixel canvas a segment at 80 → 90, reflected
// about 100, belongs at 20 → 10. The view is nowhere near symmetric about
// the flip line, so the unreflected viewport (0 → 40) does not contain it.
for (const axis of ['x', 'y'] as const) {
  const along = (value: number, across: number) => (axis === 'x' ? { x: value, y: across } : { x: across, y: value })
  const vt: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0, ...(axis === 'x' ? { mirrorX: 100 } : { mirrorY: 100 }) }
  const onScreen = cut('on-screen', along(80, 20), along(90, 20))
  // Reflected to 90 → 80: well outside the 40-pixel canvas and its margin.
  const offScreen = cut('off-screen', along(10, 20), along(20, 20))

  const { ctx, segments } = screenContext(40, 40)
  renderSketchToolpaths(null, ctx, project, [onScreen, offScreen], null, null, vt, CUTS_ONLY, false)
  const expected = axis === 'x'
    ? { fromX: 20, fromY: 20, toX: 10, toY: 20 }
    : { fromX: 20, fromY: 20, toX: 20, toY: 10 }
  assert(
    drawn(segments, expected),
    `mirror ${axis}: a toolpath inside the mirrored view is drawn where it belongs (got ${JSON.stringify(segments)})`,
  )
  assert(segments.length === 1, `mirror ${axis}: a toolpath outside the mirrored view is culled`)

  // The unmirrored control: the same canvas shows 0 → 40 of the world as is.
  const plain = screenContext(40, 40)
  renderSketchToolpaths(null, plain.ctx, project, [onScreen, offScreen], null, null, { scale: 1, offsetX: 0, offsetY: 0 }, CUTS_ONLY, false)
  assert(
    plain.segments.length === 1 && drawn(plain.segments, axis === 'x'
      ? { fromX: 10, fromY: 20, toX: 20, toY: 20 }
      : { fromX: 20, fromY: 10, toX: 20, toY: 20 }),
    `mirror ${axis}: the unmirrored view still culls in world space`,
  )
}

// Panned and zoomed, both axes mirrored at once: the segment lands where
// `worldToCanvas` puts it.
{
  const vt: ViewTransform = { scale: 2, offsetX: -30, offsetY: 15, mirrorX: 120, mirrorY: 60 }
  const { ctx, segments } = screenContext(200, 100)
  renderSketchToolpaths(null, ctx, project, [cut('a', { x: 40, y: 30 }, { x: 50, y: 20 })], null, null, vt, CUTS_ONLY, false)
  assert(
    drawn(segments, { fromX: -30 + (120 - 40) * 2, fromY: 15 + (60 - 30) * 2, toX: -30 + (120 - 50) * 2, toY: 15 + (60 - 20) * 2 }),
    'a panned, zoomed, doubly mirrored view draws the toolpath where the view puts it',
  )
}

// ── The GPU overlay does not outlive the Top view ─────────────

{
  const base = screenContext(320, 200)
  const foreground = screenContext(300, 150)
  const gpuCanvas = { hidden: false }
  // Read through a call: the renderer writes this behind the type checker's back.
  const gpuHidden = (): boolean => gpuCanvas.hidden
  const reports: boolean[] = []
  const surface: SketchToolpathSurface = {
    gpu: { canvas: gpuCanvas, render: () => true } as unknown as SketchToolpathSurface['gpu'],
    foreground: foreground.ctx,
    failed: false,
    report: (active) => { reports.push(active) },
  }
  const toolpaths = [cut('a', { x: 10, y: 10 }, { x: 20, y: 10 })]

  // Top: the GPU draws, and the caller draws the rest of the frame on the foreground.
  const topTarget = renderSketchToolpaths(surface, base.ctx, project, toolpaths, null, null, { scale: 1, offsetX: 0, offsetY: 0 }, CUTS_ONLY, false)
  assert(topTarget === foreground.ctx, 'on Top the frame continues on the GPU foreground')
  assert(!gpuHidden() && reports.at(-1) === true, 'and the GPU renderer is reported active')
  assert(foreground.ctx.canvas.width === 320 && foreground.ctx.canvas.height === 200, 'the foreground matches the sketch canvas')

  // Bottom: Canvas takes over. The Top overlay must not stay on screen.
  foreground.cleared.length = 0
  const bottomTarget = renderSketchToolpaths(surface, base.ctx, project, toolpaths, null, null, { scale: 1, offsetX: 0, offsetY: 0, mirrorY: 200 }, CUTS_ONLY, false)
  assert(bottomTarget === base.ctx, 'on Bottom the frame is drawn on the sketch canvas')
  assert(
    foreground.cleared.some((rect) => rect.width === 320 && rect.height === 200),
    'the Top overlay is cleared when the view turns to Bottom',
  )
  assert(gpuHidden(), 'the GPU layer is hidden on Bottom')
  assert(reports.at(-1) === false, 'Canvas is reported as the active renderer on Bottom')
  assert(base.segments.length === 1, 'and the toolpath is drawn by Canvas')

  // Back on Top the GPU renderer is reported again.
  renderSketchToolpaths(surface, base.ctx, project, toolpaths, null, null, { scale: 1, offsetX: 0, offsetY: 0 }, CUTS_ONLY, false)
  assert(!gpuHidden() && reports.at(-1) === true, 'back on Top the GPU renderer is active again')
}

console.log('renderSketchToolpaths tests passed')
