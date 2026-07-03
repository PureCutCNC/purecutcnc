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

export interface WebglContextGuardHandlers {
  onLost: () => void
  onRestored: () => void
}

/**
 * Watch a renderer's canvas for WebGL context loss/restore and forward the
 * transitions to app-level handlers (pause playback, show/hide an overlay).
 *
 * three's WebGLRenderer already handles the GL side: it preventDefault()s the
 * lost event (which is what allows the browser to restore the context at all),
 * no-ops render() while lost, and rebuilds its GL state on restore — GPU
 * resources re-upload lazily from retained CPU-side data. This guard exists
 * only for the app-state side that three can't know about.
 *
 * Returns a detach function for effect cleanup.
 */
export function attachWebglContextGuard(
  canvas: HTMLCanvasElement,
  handlers: WebglContextGuardHandlers,
): () => void {
  const handleLost = () => handlers.onLost()
  const handleRestored = () => handlers.onRestored()
  canvas.addEventListener('webglcontextlost', handleLost)
  canvas.addEventListener('webglcontextrestored', handleRestored)
  return () => {
    canvas.removeEventListener('webglcontextlost', handleLost)
    canvas.removeEventListener('webglcontextrestored', handleRestored)
  }
}
