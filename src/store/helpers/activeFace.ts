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
 * The workspace face (issue #945): which stock face the active setup turns
 * up, and what that means for features. A feature authored on the other face
 * is a *ghost* — visible for reference, never an edit target — and everything
 * that decides "can this be picked, snapped to or changed here" asks this
 * module rather than comparing faces itself.
 */

import {
  canonicalToSetupPoint,
  depthFromFace,
  setupFace,
  setupFrame,
  setupOriginInCanonical,
  setupToCanonicalPoint,
} from '../../engine/setupOrientation'
import { defaultTopSetup } from '../../types/project'
import type {
  DimensionRef,
  MachineOrigin,
  MachiningSetup,
  Matrix2D,
  Point,
  Project,
  SetupFace,
  SketchFeature,
  Stock,
} from '../../types/project'
import { resolvedProjectFeatures } from './resolveFeatures'
import type { ResolvedSketchFeature } from './resolveFeatures'
import type { SelectionState } from '../types'

type FaceProject = Pick<Project, 'setups' | 'activeSetupId'>

/** The setup the workspace is on. A project always has one. */
export function activeSetup(project: FaceProject): MachiningSetup {
  return project.setups.find((setup) => setup.id === project.activeSetupId)
    ?? project.setups[0]
    ?? defaultTopSetup()
}

/** The stock face the workspace is drawing on. */
export function activeFace(project: FaceProject): SetupFace {
  return setupFace(activeSetup(project))
}

/** The first setup that turns `face` up, if the project has one. */
export function findSetupForFace(project: Pick<Project, 'setups'>, face: SetupFace): MachiningSetup | undefined {
  return project.setups.find((setup) => setupFace(setup) === face)
}

/**
 * Whether the project works on both faces: it has a Bottom setup, or a
 * feature drawn on Bottom. A Top-only project answers false, and the
 * workspace then shows no face layers, ghosts or face chips at all.
 */
export function projectUsesBothFaces(project: Pick<Project, 'setups' | 'features'>): boolean {
  return project.setups.some((setup) => setupFace(setup) === 'bottom')
    || project.features.some((feature) => feature.authoringFace === 'bottom')
}

/** True for a feature authored on the face the workspace is not on. */
export function isGhostFeature(project: FaceProject, feature: { authoringFace?: SetupFace }): boolean {
  return (feature.authoringFace ?? 'top') !== activeFace(project)
}

/**
 * The features that can be picked, snapped to and edited on the active face.
 * Returns the input array itself when nothing is a ghost, so a Top-only
 * project takes exactly the path it always did.
 */
export function editableFeatures<T extends { authoringFace?: SetupFace }>(
  project: FaceProject,
  features: readonly T[],
): readonly T[] {
  const face = activeFace(project)
  return features.some((feature) => (feature.authoringFace ?? 'top') !== face)
    ? features.filter((feature) => (feature.authoringFace ?? 'top') === face)
    : features
}

/**
 * The project's world-space features minus the ghosts: what hit-testing,
 * snapping and every other edit interaction on the sketch may see.
 */
export function editableProjectFeatures(project: Project): readonly ResolvedSketchFeature[] {
  return editableFeatures(project, resolvedProjectFeatures(project))
}

/** Ids of the project's ghost features, empty for a Top-only project. */
export function ghostFeatureIds(project: Pick<Project, 'setups' | 'activeSetupId' | 'features'>): Set<string> {
  const face = activeFace(project)
  const ids = new Set<string>()
  for (const feature of project.features) {
    if (feature.authoringFace !== face) ids.add(feature.id)
  }
  return ids
}

/**
 * The Z span a freshly drawn feature gets, given the height a Top feature
 * would start at. Drawing tools reason as if the face in front of them were
 * the top of the stock; this carries that span into stock space, so a new
 * Bottom feature opens at the bottom face instead of the top one.
 */
export function newFeatureSpan(
  project: Pick<Project, 'setups' | 'activeSetupId' | 'stock'>,
  faceLocalTopZ: number,
): { z_top: number; z_bottom: number } {
  return activeFace(project) === 'top'
    ? { z_top: faceLocalTopZ, z_bottom: 0 }
    : { z_top: project.stock.thickness, z_bottom: project.stock.thickness - faceLocalTopZ }
}

/**
 * The mirror that makes anchored artwork — text, whose letterforms have a
 * reading direction — read correctly on the active face. On Top there is
 * none (null). On Bottom the view is the stock turned over, so the artwork
 * is mirrored across the flip axis through `anchor`; the turned view mirrors
 * it back, once, and it reads the right way round from below. A text run
 * carries it as its instance transform, so a curved run — whose frame is
 * re-derived from the bent template — keeps it too.
 */
export function faceArtworkMirror(
  project: Pick<Project, 'setups' | 'activeSetupId' | 'stock'>,
  anchor: Point,
): ((point: Point) => Point) | null {
  const setup = activeSetup(project)
  if (setupFace(setup) === 'top') return null
  const frame = setupFrame(setup.orientation, project.stock)
  // The turn's own XY mirror, re-centred on the anchor so the anchor stays put.
  const turnedAnchor = setupToCanonicalPoint({ x: anchor.x, y: anchor.y, z: 0 }, frame)
  const dx = anchor.x - turnedAnchor.x
  const dy = anchor.y - turnedAnchor.y
  return (point) => {
    const turned = setupToCanonicalPoint({ x: point.x, y: point.y, z: 0 }, frame)
    return { x: turned.x + dx, y: turned.y + dy }
  }
}

/**
 * Where the shared machine origin sits in stock space for the active setup.
 * `Project.origin` is placed relative to the face that is up, so on screen it
 * stays where it was; in stock space it is mirrored with the stock.
 */
export function activeOriginInStock(
  project: Pick<Project, 'origin' | 'setups' | 'activeSetupId' | 'stock'>,
): MachineOrigin {
  const setup = activeSetup(project)
  if (setupFace(setup) === 'top') return project.origin
  const point = setupOriginInCanonical(project.origin, setupFrame(setup.orientation, project.stock))
  return { ...project.origin, x: point.x, y: point.y }
}

/**
 * A stock-space point picked on the active face, as the XY to store in
 * `Project.origin`: the inverse of {@link activeOriginInStock}.
 */
export function originPlacementFromStock(
  project: Pick<Project, 'setups' | 'activeSetupId' | 'stock'>,
  point: Point,
): Point {
  const setup = activeSetup(project)
  if (setupFace(setup) === 'top') return point
  const local = canonicalToSetupPoint({ x: point.x, y: point.y, z: 0 }, setupFrame(setup.orientation, project.stock))
  return { x: local.x, y: local.y }
}

/** {@link faceArtworkMirror} as an instance transform, or null on Top. */
export function faceArtworkTransform(
  project: Pick<Project, 'setups' | 'activeSetupId' | 'stock'>,
  anchor: Point,
): Matrix2D | null {
  const mirror = faceArtworkMirror(project, anchor)
  if (!mirror) return null
  const origin = mirror({ x: 0, y: 0 })
  const unitX = mirror({ x: 1, y: 0 })
  const unitY = mirror({ x: 0, y: 1 })
  return {
    a: unitX.x - origin.x,
    b: unitX.y - origin.y,
    c: unitY.x - origin.x,
    d: unitY.y - origin.y,
    e: origin.x,
    f: origin.y,
  }
}

/**
 * True for a cut that goes right through the stock, so either setup can make
 * it: a subtract whose span reaches both faces. Material that merely fills
 * the stock's height is not "through", and an unresolvable span (a dangling
 * dimension reference) answers false.
 */
export function isThroughFeature(
  project: Pick<Project, 'stock' | 'dimensions'>,
  feature: Pick<SketchFeature, 'z_top' | 'z_bottom' | 'operation'>,
): boolean {
  if (feature.operation !== 'subtract') return false
  const span = resolveStockSpan(project, feature)
  if (!span) return false
  const depth = depthFromFace(span, 'top', project.stock)
  const epsilon = 1e-9
  return depth.start <= epsilon && depth.end >= project.stock.thickness - epsilon
}

// ── Face-local angles ─────────────────────────────────────────

/**
 * How an angle reads on the face the workspace is on (issue #945). Stored
 * angles stay in stock space; a typed or displayed angle is converted here, at
 * the UI boundary, so that on Bottom a positive angle turns the same way on
 * screen as it does on Top.
 *
 * Every map is its own inverse — the same call takes a stored angle to the
 * field and a typed angle back to storage — so "applied twice" is a no-op and
 * shows up at once as an unconverted value.
 */
export interface FaceAngles {
  /** A direction, in degrees from +X: a line's heading, an orientation. */
  direction: (degrees: number) => number
  /** A turn about an in-plane point: a rotation amount, a sweep. */
  turn: (degrees: number) => number
  /** A 3D rotation about a stock axis, for the model orientation fields. */
  axisTurn: (axis: 'x' | 'y' | 'z', degrees: number) => number
}

function withoutNegativeZero(value: number): number {
  return value === 0 ? 0 : value
}

/** Top, and anything stored: angles read as they are. */
export const STOCK_ANGLES: FaceAngles = {
  direction: (degrees) => degrees,
  turn: (degrees) => degrees,
  axisTurn: (_axis, degrees) => degrees,
}

/**
 * The angle maps for the active setup, read off the #944 transform: which
 * stock axes the turn reverses. The arithmetic is exact (a sign, or 180° less
 * the angle), so a typed 30 is stored as -30, not as a rounded neighbour.
 */
export function faceAngles(project: Pick<Project, 'setups' | 'activeSetupId' | 'stock'>): FaceAngles {
  const setup = activeSetup(project)
  if (setupFace(setup) === 'top') return STOCK_ANGLES
  const frame = setupFrame(setup.orientation, project.stock)
  const origin = canonicalToSetupPoint({ x: 0, y: 0, z: 0 }, frame)
  const reversed = {
    x: canonicalToSetupPoint({ x: 1, y: 0, z: 0 }, frame).x < origin.x,
    y: canonicalToSetupPoint({ x: 0, y: 1, z: 0 }, frame).y < origin.y,
    z: canonicalToSetupPoint({ x: 0, y: 0, z: 1 }, frame).z < origin.z,
  }
  // Seen from above the turned stock is a mirror, so in-plane turns reverse
  // whenever exactly one of X and Y does.
  const handedness = reversed.x !== reversed.y ? -1 : 1
  return {
    direction: (degrees) => {
      const flippedY = reversed.y ? -degrees : degrees
      const flipped = reversed.x ? 180 - flippedY : flippedY
      // Keep the (-180, 180] range the fields already show.
      const wrapped = flipped > 180 ? flipped - 360 : flipped <= -180 ? flipped + 360 : flipped
      return withoutNegativeZero(wrapped)
    },
    turn: (degrees) => withoutNegativeZero(handedness * degrees),
    // The setup-local frame is the stock frame turned as a rigid body, so a
    // rotation about a stock axis keeps its sense about that axis only where
    // the axis itself still points the same way.
    axisTurn: (axis, degrees) => withoutNegativeZero(reversed[axis] ? -degrees : degrees),
  }
}

/** A Z range as heights above the table with the stock flipped, bottom face up. */
export interface FlippedZRange {
  top: number
  bottom: number
}

/**
 * A stock span as a Bottom setup presents it: the stock turned over, Z still
 * measured up from the table, so the bottom face is at `thickness` and a
 * Bottom feature reads the way the same feature reads on Top. Derived from
 * the #944 depth view — a height is the thickness less the depth from the
 * bottom face — and, like it, never stored.
 */
export function flippedZRange(span: { z_top: number; z_bottom: number }, stock: Pick<Stock, 'thickness'>): FlippedZRange {
  const depth = depthFromFace(span, 'bottom', stock)
  return { top: stock.thickness - depth.start, bottom: stock.thickness - depth.end }
}

function resolveZ(project: Pick<Project, 'dimensions'>, value: DimensionRef): number | null {
  const resolved = typeof value === 'number' ? value : project.dimensions[value]?.value
  return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : null
}

/** A feature's stock-space span with dimension references resolved, or null when one dangles. */
export function resolveStockSpan(
  project: Pick<Project, 'dimensions'>,
  feature: Pick<SketchFeature, 'z_top' | 'z_bottom'>,
): { z_top: number; z_bottom: number } | null {
  const top = resolveZ(project, feature.z_top)
  const bottom = resolveZ(project, feature.z_bottom)
  return top === null || bottom === null ? null : { z_top: top, z_bottom: bottom }
}

/**
 * A selection with every ghost feature removed. Ghosts are reference
 * geometry: because they can never be selected, no selection-driven edit —
 * move, delete, sketch edit, a property change — can reach one. Returns the
 * same object when there was nothing to remove.
 */
export function dropGhostSelection(
  project: Pick<Project, 'setups' | 'activeSetupId' | 'features'>,
  selection: SelectionState,
): SelectionState {
  if (selection.selectedFeatureIds.length === 0 && selection.hoveredFeatureId === null) return selection
  const ghosts = ghostFeatureIds(project)
  if (ghosts.size === 0) return selection
  const kept = selection.selectedFeatureIds.filter((id) => !ghosts.has(id))
  const hoveredFeatureId = selection.hoveredFeatureId !== null && ghosts.has(selection.hoveredFeatureId)
    ? null
    : selection.hoveredFeatureId
  if (kept.length === selection.selectedFeatureIds.length && hoveredFeatureId === selection.hoveredFeatureId) {
    return selection
  }
  const primaryId = selection.selectedFeatureId === null || !ghosts.has(selection.selectedFeatureId)
    ? selection.selectedFeatureId
    : kept.at(-1) ?? null
  const keepsEdit = selection.mode === 'sketch_edit' && primaryId !== null && primaryId === selection.selectedFeatureId
  return {
    ...selection,
    selectedFeatureIds: kept,
    selectedFeatureId: primaryId,
    selectedNode: selection.selectedNode?.type === 'feature'
      ? (primaryId ? { type: 'feature', featureId: primaryId } : null)
      : selection.selectedNode,
    hoveredFeatureId,
    mode: keepsEdit ? selection.mode : 'feature',
    sketchEditTool: keepsEdit ? selection.sketchEditTool : null,
    activeControl: keepsEdit ? selection.activeControl : null,
    groupFolderId: kept.length > 0 ? selection.groupFolderId : null,
  }
}
