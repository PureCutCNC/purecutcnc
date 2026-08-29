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
 * Appends every element of `source` onto `target`, in order.
 *
 * This exists because `target.push(...source)` passes one *argument* per
 * element, so it dies with `RangeError: Maximum call stack size exceeded` once
 * the source outgrows the engine's argument limit — 124,413 elements measured
 * on node v26.0.0 at the default stack size, and stack-size dependent rather
 * than a fixed constant. Toolpath generation routinely builds arrays past that:
 * one trochoidal Edge Route fragment on a 60 x 40 in guide emits 203,232 cut
 * moves, well inside the operation point budget and well past the limit, and the
 * spread threw instead of producing a path (issue #668).
 *
 * Order and object identity are preserved, so emitted output is unchanged.
 * `Iterable` rather than an array because callers pass Map iterators and lazily
 * filtered lists as well as plain arrays.
 */
export function appendAll<T>(target: T[], source: Iterable<T>): T[] {
  for (const item of source) {
    target.push(item)
  }
  return target
}
