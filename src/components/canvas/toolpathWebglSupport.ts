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
 * One WebGL2 availability rule for the toolpath renderer and its suggestion.
 *
 * The toolpath overlay is only faster than Canvas on an accelerated context;
 * on a software rasteriser (CI's SwiftShader, or a browser with hardware
 * acceleration disabled) it is the slowest renderer, so the overlay asks for
 * `failIfMajorPerformanceCaveat` and treats a refused request exactly like a
 * missing WebGL2. The 3D viewport and simulation keep their own context.
 */

/** Requested only when a real GPU is expected. */
export const TOOLPATH_WEBGL_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: false,
  premultipliedAlpha: true,
}

/**
 * Dev-only test seam (issue #1087). E2E specs that assert the GPU path set it
 * before the app loads; production builds reduce `development` to `false`, so
 * the flag is read only in development.
 */
export const ALLOW_SOFTWARE_WEBGL_FLAG = '__pcTestAllowSoftwareWebgl'

/** The dev switch is honoured only when `development` is a compile-time `true`. */
export function allowSoftwareWebgl(development: boolean): boolean {
  if (!development) return false
  return (globalThis as Record<string, unknown>)[ALLOW_SOFTWARE_WEBGL_FLAG] === true
}

/** Strict (hardware-only) unless the dev switch explicitly opens it. */
export function toolpathWebglContextOptions(allowSoftware: boolean): WebGLContextAttributes {
  return { ...TOOLPATH_WEBGL_ATTRIBUTES, failIfMajorPerformanceCaveat: !allowSoftware }
}

/** Narrow canvas contract so the request is testable without a browser. */
export interface Webgl2RequestableCanvas {
  getContext(id: 'webgl2', options: WebGLContextAttributes): WebGL2RenderingContext | null
}

/** The renderer's only way to acquire its context. Null means "use Canvas". */
export function requestToolpathWebglContext(
  canvas: Webgl2RequestableCanvas,
  allowSoftware: boolean,
): WebGL2RenderingContext | null {
  return canvas.getContext('webgl2', toolpathWebglContextOptions(allowSoftware))
}

/**
 * Acquire the overlay context from the app's compile-time `import.meta.env.DEV`
 * so the production bundle passes `false` and the test flag is never consulted.
 */
export function acquireToolpathWebgl(
  canvas: Webgl2RequestableCanvas,
  development: boolean,
): WebGL2RenderingContext | null {
  return requestToolpathWebglContext(canvas, allowSoftwareWebgl(development))
}

const probes = new Map<boolean, boolean>()

/**
 * Whether the GPU suggestion may be offered. Probes once per mode with the
 * same strict request the renderer makes, then releases the context, so the
 * app never advertises or claims a GPU that will only fall back to Canvas.
 */
export function hardwareToolpathWebglAvailable(allowSoftware: boolean): boolean {
  const cached = probes.get(allowSoftware)
  if (cached !== undefined) return cached
  if (typeof document === 'undefined') return false
  let context: WebGL2RenderingContext | null = null
  try {
    context = requestToolpathWebglContext(document.createElement('canvas'), allowSoftware)
  } catch {
    // A browser that refuses to even attempt the request is not a GPU host.
  }
  if (!context) {
    probes.set(allowSoftware, false)
    return false
  }
  context.getExtension('WEBGL_lose_context')?.loseContext()
  probes.set(allowSoftware, true)
  return true
}
