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
 * The one Clipper integer scale factor (10,000 counts per project unit).
 *
 * It lives in its own module so a pure analysis can use the internal scale
 * without importing `toolpaths/geometry.ts`: that barrel reaches `utils/units`
 * and then `cannedShapes`, which pulls Three.js into a worker that only needs
 * Clipper. Geometry re-exports it, so every existing import is unchanged.
 */
export const DEFAULT_CLIPPER_SCALE = 10_000
