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
import { getDefinitionId } from './featureDefinitions'
import { defaultSetupForFace, provisionalSetupFor } from './provisionalSetup'
import { resolvedProjectFeatures } from './resolveFeatures'
import type { ResolvedSketchFeature } from './resolveFeatures'
import type { PendingAddTool, ProjectStore, SelectionState } from '../types'

type FaceProject = Pick<Project, 'setups' | 'activeSetupId'>

/**
 * The setup the workspace is on. A project always has one — but it is not
 * always one of `project.setups`: while the workspace looks at a face the
 * project has no setup for, this is that face's provisional setup (see
 * `provisionalSetup.ts`), which becomes a real one with the first content
 * created there.
 */
export function activeSetup(project: FaceProject): MachiningSetup {
  return project.setups.find((setup) => setup.id === project.activeSetupId)
    ?? provisionalSetupFor(project)
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
 * Whether the workspace shows both faces: the project has a Bottom setup or
 * a feature drawn on Bottom, or the Bottom face is being looked at. A
 * Top-only project seen from Top answers false, and the workspace then shows
 * no face layers, ghosts or face chips at all.
 */
export function projectUsesBothFaces(project: Pick<Project, 'setups' | 'activeSetupId' | 'features'>): boolean {
  return project.setups.some((setup) => setupFace(setup) === 'bottom')
    || project.features.some((feature) => feature.authoringFace === 'bottom')
    || activeFace(project) === 'bottom'
}

/**
 * True once a shape being drawn has a point on the canvas. An armed tool with
 * nothing placed yet belongs to no face; a half-drawn outline does, because
 * its points were picked in that face's view.
 */
function placementUnderWay(pendingAdd: PendingAddTool | null): boolean {
  if (!pendingAdd) return false
  if ('anchor' in pendingAdd) return pendingAdd.anchor !== null
  if ('points' in pendingAdd) return pendingAdd.points.length > 0
  return pendingAdd.shape === 'composite' && pendingAdd.start !== null
}

/**
 * True while a feature is being drawn, edited, moved or combined. That work
 * belongs to the face it started on: changing the workspace face, or a
 * feature's authoring face, is refused until it is finished or cancelled, so
 * it can never complete on a ghost or with an outline picked in two views.
 */
export function isFaceEditInProgress(state: Pick<
  ProjectStore,
  | 'selection'
  | 'pendingAdd'
  | 'pendingMove'
  | 'pendingTransform'
  | 'pendingOffset'
  | 'pendingShapeAction'
  | 'pendingFeatureDistribution'
  | 'pendingNest'
  | 'pendingTextLayout'
>): boolean {
  return state.selection.mode === 'sketch_edit'
    || placementUnderWay(state.pendingAdd)
    || state.pendingMove !== null
    || state.pendingTransform !== null
    || state.pendingOffset !== null
    || state.pendingShapeAction !== null
    || state.pendingFeatureDistribution !== null
    || state.pendingNest !== null
    || state.pendingTextLayout !== null
}

/**
 * The ghost rule, resolved once for a project: true for a feature authored on
 * the face the workspace is not on. A feature that names no face is on Top.
 * Every "is this a ghost" question in the app is this predicate.
 */
export function ghostPredicate(project: FaceProject): (feature: { authoringFace?: SetupFace }) => boolean {
  const face = activeFace(project)
  return (feature) => (feature.authoringFace ?? 'top') !== face
}

/** True for a feature authored on the face the workspace is not on. */
export function isGhostFeature(project: FaceProject, feature: { authoringFace?: SetupFace }): boolean {
  return ghostPredicate(project)(feature)
}

/**
 * How many linked copies of these features' shapes are authored on a face
 * other than `face`. A linked copy is the same shape wherever it sits, the
 * other face included: editing one changes all of them. The ghost guard
 * keeps a ghost from being picked or moved; it does not unlink a shared
 * shape, so wherever a shape can be edited or a copy moved across, the UI
 * says how many copies on the other face go with it.
 */
export function linkedCopiesOffFace(
  project: Pick<Project, 'features'>,
  featureIds: readonly string[],
  face: SetupFace,
): number {
  const ids = new Set(featureIds)
  const definitions = new Set<string>()
  for (const feature of project.features) {
    if (ids.has(feature.id)) definitions.add(getDefinitionId(feature))
  }
  if (definitions.size === 0) return 0
  return project.features.filter((feature) => (
    !ids.has(feature.id)
    && (feature.authoringFace ?? 'top') !== face
    && definitions.has(getDefinitionId(feature))
  )).length
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
  const isGhost = ghostPredicate(project)
  return features.some(isGhost) ? features.filter((feature) => !isGhost(feature)) : features
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
  const isGhost = ghostPredicate(project)
  const ids = new Set<string>()
  for (const feature of project.features) {
    if (isGhost(feature)) ids.add(feature.id)
  }
  return ids
}

/**
 * The features a shape newly drawn on the active face is judged against —
 * which solid it sits in, which surface a Line lands on. Those authored on
 * this face, and those from the other face whose span reaches it: a base
 * that fills the stock is material on both faces, but a pocket cut part-way
 * in from Top is not there at all when the stock is seen from Bottom.
 * Returns the input array itself when nothing is left out, so a Top-only
 * project takes exactly the path it always did.
 */
export function featuresAtActiveFace<T extends Pick<SketchFeature, 'z_top' | 'z_bottom'> & { authoringFace?: SetupFace }>(
  project: Pick<Project, 'setups' | 'activeSetupId' | 'stock' | 'dimensions'>,
  features: readonly T[],
): readonly T[] {
  const face = activeFace(project)
  const isGhost = ghostPredicate(project)
  const epsilon = 1e-9
  const atFace = (feature: T): boolean => {
    if (!isGhost(feature)) return true
    const span = resolveStockSpan(project, feature)
    if (!span) return false
    return face === 'top' ? span.z_top >= project.stock.thickness - epsilon : span.z_bottom <= epsilon
  }
  return features.every(atFace) ? features : features.filter(atFace)
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
  return flipAxisMirror(setup, project.stock, anchor)
}

/**
 * The mirror that carries anchored artwork from one face to the other: the
 * Bottom setup's, whichever face is in view. It is its own inverse, so the
 * same map puts the mirror on a text run that goes to Bottom and takes it
 * off one that comes back to Top.
 */
export function crossFaceArtworkMirror(
  project: Pick<Project, 'setups' | 'activeSetupId' | 'stock'>,
  anchor: Point,
): (point: Point) => Point {
  const active = activeSetup(project)
  const bottom = setupFace(active) === 'bottom'
    ? active
    : findSetupForFace(project, 'bottom') ?? defaultSetupForFace('bottom')
  return flipAxisMirror(bottom, project.stock, anchor)
}

/** A setup's own XY mirror, re-centred on `anchor` so the anchor stays put. */
function flipAxisMirror(setup: MachiningSetup, stock: Stock, anchor: Point): (point: Point) => Point {
  const frame = setupFrame(setup.orientation, stock)
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
  return mirror ? affineMatrixOf(mirror) : null
}

/** {@link crossFaceArtworkMirror} as a matrix to compose onto an instance transform. */
export function crossFaceArtworkTransform(
  project: Pick<Project, 'setups' | 'activeSetupId' | 'stock'>,
  anchor: Point,
): Matrix2D {
  return affineMatrixOf(crossFaceArtworkMirror(project, anchor))
}

/** The matrix of an affine point map, read off where it sends the origin and the unit axes. */
function affineMatrixOf(map: (point: Point) => Point): Matrix2D {
  const origin = map({ x: 0, y: 0 })
  const unitX = map({ x: 1, y: 0 })
  const unitY = map({ x: 0, y: 1 })
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

/**
 * Which stock axes the active setup's turn reverses, read off the #944
 * transform, or null on Top where none is.
 */
function reversedStockAxes(
  project: Pick<Project, 'setups' | 'activeSetupId' | 'stock'>,
): Record<'x' | 'y' | 'z', boolean> | null {
  const setup = activeSetup(project)
  if (setupFace(setup) === 'top') return null
  const frame = setupFrame(setup.orientation, project.stock)
  const origin = canonicalToSetupPoint({ x: 0, y: 0, z: 0 }, frame)
  return {
    x: canonicalToSetupPoint({ x: 1, y: 0, z: 0 }, frame).x < origin.x,
    y: canonicalToSetupPoint({ x: 0, y: 1, z: 0 }, frame).y < origin.y,
    z: canonicalToSetupPoint({ x: 0, y: 0, z: 1 }, frame).z < origin.z,
  }
}

/**
 * How a signed distance along a stock axis reads on the face the workspace
 * is on (issue #945): a grid's Spacing X / Spacing Y. Like the angles, the
 * stored value stays in stock space and is converted at the UI boundary, so
 * a positive step goes the same way on screen on Bottom as it does on Top.
 * Each map is its own inverse.
 */
export interface FaceOffsets {
  x: (distance: number) => number
  y: (distance: number) => number
}

/** Top, and anything stored: distances read as they are. */
export const STOCK_OFFSETS: FaceOffsets = {
  x: (distance) => distance,
  y: (distance) => distance,
}

/** The signed-distance maps for the active setup: an axis the turn reverses changes sign. */
export function faceOffsets(project: Pick<Project, 'setups' | 'activeSetupId' | 'stock'>): FaceOffsets {
  const reversed = reversedStockAxes(project)
  if (!reversed) return STOCK_OFFSETS
  return {
    x: (distance) => withoutNegativeZero(reversed.x ? -distance : distance),
    y: (distance) => withoutNegativeZero(reversed.y ? -distance : distance),
  }
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
  const reversed = reversedStockAxes(project)
  if (!reversed) return STOCK_ANGLES
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
