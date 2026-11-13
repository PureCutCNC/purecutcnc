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

import assert from 'node:assert/strict'
import {
  ALLOW_SOFTWARE_WEBGL_FLAG, acquireToolpathWebgl, allowSoftwareWebgl, toolpathWebglContextOptions,
  type Webgl2RequestableCanvas,
} from './toolpathWebglSupport'

const granted = {} as WebGL2RenderingContext

/** Records the one request the renderer makes and answers it. */
function canvasReturning(context: WebGL2RenderingContext | null) {
  const requests: Array<{ id: string; options: WebGLContextAttributes }> = []
  const canvas: Webgl2RequestableCanvas = {
    getContext(id, options) {
      requests.push({ id, options })
      return context
    },
  }
  return { canvas, requests }
}

const flag = globalThis as Record<string, unknown>
const restore = flag[ALLOW_SOFTWARE_WEBGL_FLAG]

try {
  // The overlay never asks for a plain context: a software rasteriser is
  // slower than Canvas, so it must be refused rather than accepted (issue #1087).
  for (const development of [false, true]) {
    delete flag[ALLOW_SOFTWARE_WEBGL_FLAG]
    const { canvas, requests } = canvasReturning(granted)
    assert.equal(acquireToolpathWebgl(canvas, development), granted)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].id, 'webgl2')
    assert.equal(requests[0].options.failIfMajorPerformanceCaveat, true)
    assert.equal(requests[0].options.alpha, true)
    assert.equal(requests[0].options.antialias, false)
    assert.equal(requests[0].options.premultipliedAlpha, true)
  }
  assert.equal(toolpathWebglContextOptions(false).failIfMajorPerformanceCaveat, true)

  // A refused strict request yields null. The renderer turns that into the
  // existing throw that the sketch hook reports as `canvas-fallback`, so Canvas
  // draws the toolpaths and the "GPU unavailable" notice is shown.
  const refused = canvasReturning(null)
  assert.equal(acquireToolpathWebgl(refused.canvas, false), null)
  assert.equal(refused.requests[0].options.failIfMajorPerformanceCaveat, true)
  assert.equal(toolpathWebglContextOptions(false).failIfMajorPerformanceCaveat, true)

  // The dev-only test switch asks for plain (software-allowed) WebGL2 so GPU
  // specs still exercise the GPU path on CI's SwiftShader.
  flag[ALLOW_SOFTWARE_WEBGL_FLAG] = true
  const switched = canvasReturning(granted)
  assert.equal(acquireToolpathWebgl(switched.canvas, true), granted)
  assert.equal(switched.requests[0].options.failIfMajorPerformanceCaveat, false)
  assert.equal(switched.requests[0].options.alpha, true)
  assert.equal(switched.requests[0].options.antialias, false)
  assert.equal(switched.requests[0].options.premultipliedAlpha, true)

  // Production (`development === false`) ignores the switch even if the flag is
  // present: it is unreachable unless import.meta.env.DEV folded to true.
  assert.equal(allowSoftwareWebgl(false), false)
  const production = canvasReturning(granted)
  assert.equal(acquireToolpathWebgl(production.canvas, false), granted)
  assert.equal(production.requests[0].options.failIfMajorPerformanceCaveat, true)

  // The switch is off when absent or not exactly true.
  for (const value of [undefined, false, 'true', 1, {}]) {
    flag[ALLOW_SOFTWARE_WEBGL_FLAG] = value
    assert.equal(allowSoftwareWebgl(true), false)
  }
  flag[ALLOW_SOFTWARE_WEBGL_FLAG] = true
  assert.equal(allowSoftwareWebgl(true), true)
} finally {
  if (restore === undefined) delete flag[ALLOW_SOFTWARE_WEBGL_FLAG]
  else flag[ALLOW_SOFTWARE_WEBGL_FLAG] = restore
}

console.log('toolpathWebglSupport tests passed')
