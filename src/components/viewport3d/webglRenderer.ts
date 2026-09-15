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

/**
 * WebGL state of a 3D view (the 3D preview and the simulation viewport).
 *
 * - `unavailable`: the browser refused a WebGL2 context at startup (GPU
 *   process disabled, GPU denylist, hardware acceleration off). The scene is
 *   never built and a fallback message replaces it.
 * - `context-lost`: the browser revoked a working context (GPU memory
 *   pressure, driver reset). three restores its GL state when the browser
 *   hands the context back; until then the view shows an overlay.
 */
export type WebglStatus = 'ok' | 'unavailable' | 'context-lost'

/**
 * Create a 3D view's renderer, or null when the browser cannot provide a
 * WebGL2 context. three r163+ throws from the constructor in that case, and a
 * throw escaping a mount effect takes the whole app down through the error
 * boundary — including the 2D workspace, which never needed WebGL (issue #786).
 */
export function createViewportRenderer(viewName: string): THREE.WebGLRenderer | null {
  try {
    return new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
  } catch (error) {
    console.error(`${viewName}: WebGL2 context creation failed`, error)
    return null
  }
}
