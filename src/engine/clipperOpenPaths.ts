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

// Typed seam for clipper-lib's open-path API.
//
// The library's local ambient declaration (`src/types/clipper-lib.d.ts`) types
// only the closed-path surface: the `Clipper` instance exposes `AddPaths`
// (plural, closed) but not the single-path open-path overload `AddPath`, and the
// `Clipper` static omits `OpenPathsFromPolyTree`. Both exist at runtime. Rather
// than scatter `as any` casts across call sites, the two undeclared operations
// are reached here through one documented cast each, confined to this module.

import ClipperLib from 'clipper-lib'
import type { ClipperPath } from './toolpaths/types'

type ClipperInstance = InstanceType<typeof ClipperLib.Clipper>
type PolyTreeInstance = InstanceType<typeof ClipperLib.PolyTree>

/** Add `path` as an *open* subject path (clipper-lib `AddPath(path, ptSubject, false)`). */
export function addOpenSubject(clipper: ClipperInstance, path: ClipperPath): void {
  // `AddPath` (the open-path overload) is not in clipper-lib.d.ts; cast to the
  // single method we need.
  const open = clipper as unknown as {
    AddPath(path: ClipperPath, polyType: number, closed: boolean): boolean
  }
  open.AddPath(path, ClipperLib.PolyType.ptSubject, false)
}

/** Extract the open result paths from a solved PolyTree. */
export function openPathsFromPolyTree(tree: PolyTreeInstance): ClipperPath[] {
  // `OpenPathsFromPolyTree` is a static helper absent from clipper-lib.d.ts.
  const withOpen = ClipperLib.Clipper as unknown as {
    OpenPathsFromPolyTree(tree: PolyTreeInstance): ClipperPath[]
  }
  return withOpen.OpenPathsFromPolyTree(tree)
}
