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
 * Turn and Polygon as canned models on the Around face (issue #1112 slice G).
 *
 * Each is **one canned model** — no folder and no operation, exactly like the
 * imported model it behaves as (decision 2). Its parameters generate the mesh,
 * the mesh is stored in `Project.modelAssets` and referenced from
 * `definition.stl`, so CSG, the surface toolpaths, the 3D preview, Simulation
 * and export consume it through the paths they already use. Changing the
 * parameters rebuilds that mesh, and every linked copy follows.
 *
 * A Turn is the finished cylinder over the requested band: on a square blank it
 * is the old Square to round target, on a round bar the same cylinder inside the
 * bar. A Polygon is a regular prism of the requested across-flats size. Both
 * start and length are measured from the **chuck end**, the same as
 * Thread/Flutes (decision 4).
 *
 * Old projects are untouched: an existing rotary-solid folder stays a folder,
 * a model and its operations. This module no longer creates that shape, and
 * nothing migrates what is already stored.
 */

import type { StateCreator } from 'zustand'
import { isBarStock } from '../../types/barStock'
import type {
  CannedShapeData,
  CannedShapeParams,
  FeatureInstance,
  Project,
  SketchFeature,
} from '../../types/project'
import { rotaryCylinderSegments } from '../../engine/rotaryCylinder'
import { activeSetup, aroundUnavailableReason } from './activeFace'
import { resolveFeatureInstance, resolvedProjectFeatures } from './resolveFeatures'
import { getFeatureGeometryProfiles } from '../../text'
import { sampleProfilePoints } from '../../types/project'
import type {
  TurnCannedProfile,
  TurnProfileProblem,
} from '../../cannedShapes/generators/turnProfile'
import {
  checkPickedContour,
  turnProfileBand,
  turnProfileProblem,
} from '../../cannedShapes/generators/turnProfile'
import { cannedShapeFrame, generateCannedShapeMesh } from '../../cannedShapes'
import { rebuildCannedShapeModelDefinitions } from '../../cannedShapes/model'
import {
  POLYGON_CANNED_KIND,
  TURN_CANNED_KIND,
} from '../../cannedShapes/generators/kinds'
import { normalizePolygonCannedParams, MAX_POLYGON_SIDES } from '../../cannedShapes/generators/polygon'
import { normalizeTurnCannedParams } from '../../cannedShapes/generators/turn'
import {
  ROTARY_SOLID_TOLERANCE,
  rotarySolidBandProblem,
  rotarySolidFrame,
  type RotarySolidFrame,
} from '../../cannedShapes/generators/rotarySolidParams'
import { uniqueName } from '../../import'
import { createDefinitionForFeature, createFeatureInstance } from './featureDefinitions'
import { nextUniqueGeneratedId } from './ids'
import { cloneProject, syncFeatureTreeProject } from './normalize'
import { syncRotaryPatternSurfaces } from './rotarySurface'
import { projectType } from './projectType'
import type { ProjectStore } from '../types'

// ---------------------------------------------------------------------------
// Public input / result (frozen for the dialog)
// ---------------------------------------------------------------------------

export interface RotaryTurnSolidInput {
  kind: 'turn'
  /** Distance from the chuck end, project units. */
  start: number
  /** Length along the bar, project units. */
  length: number
  /** Finished diameter, project units. At most the bar diameter or blank side. */
  diameter: number
  /** A copied side profile, revolved about the bar axis instead of a cylinder. */
  profile?: TurnCannedProfile | null
}

export interface RotaryPolygonSolidInput {
  kind: 'polygon'
  start: number
  length: number
  /** Number of polygon sides. Integer 3..64; 6 is the hex-bolt head. */
  sides: number
  /** Twice the polygon's apothem (across-flats), project units. */
  acrossFlats: number
  /** Rotation about the bar's axis in degrees. Finite; default 0 (one flat up). */
  rotationDeg?: number
}

export type RotarySolidInput = RotaryTurnSolidInput | RotaryPolygonSolidInput

export type RotarySolidRefusal =
  /** The project is not rotary, so there is no bar to turn. */
  | 'notRotaryProject'
  /** The active Around setup turns about the other bar axis. */
  | 'setupAxisMismatch'
  /** The stock is not a bar (round or square). */
  | 'notOnBar'
  | 'invalidStart'
  | 'invalidLength'
  /** Start and length do not fit inside the bar. */
  | 'invalidAlongRange'
  | 'invalidSides'
  | 'invalidAcrossFlats'
  | 'invalidRotation'
  | 'invalidDiameter'
  /** The finished diameter is larger than the bar or blank. */
  | 'diameterExceedsStock'
  /** The polygon's across-corners reaches past the bar or blank. */
  | 'polygonExceedsStock'
  /** The emitted mesh cannot be represented in Float32 coordinates. */
  | 'geometryNotRepresentable'
  /** The generated model could not be minted or stored. */
  | 'creationFailed'
  /** The picked outline has no usable points. */
  | 'profileEmpty'
  /** The picked outline has points on both sides of the bar axis. */
  | 'profileCrossesAxis'
  /** An open outline reverses along the bar, so it is not a turning profile. */
  | 'profileDoublesBack'
  /** A feature with several outlines cannot be one Turn profile. */
  | 'profileMultipleOutlines'
  /** The outline reaches past the bar's surface. */
  | 'profileExceedsStock'
  /** The outline reaches past the bar's ends. */
  | 'profileOutOfBar'
  /** The remembered source feature no longer exists. */
  | 'profileMissingSource'
  /** The remembered source is not a drawn outline (a model or sheet drawing). */
  | 'profileUnsupportedSource'

export interface RotarySolidCreated {
  ok: true
  /** The one generated model feature. */
  featureId: string
}

export interface RotarySolidRefused {
  ok: false
  reason: RotarySolidRefusal
  /** Free-text context for a refusal (which check, which builder error). */
  detail?: string
}

export type RotarySolidResult = RotarySolidCreated | RotarySolidRefused

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * The stored canned data for one input against `frame`, or `null` when the
 * generator would refuse it. One function builds it for creation and for an
 * edit, so the two paths can never drift.
 */
export function rotarySolidCannedData(
  frame: RotarySolidFrame,
  input: RotarySolidInput,
  units: Project['meta']['units'],
): CannedShapeData | null {
  if (input.kind === 'turn') {
    const profile = input.profile ?? null
    const band = profile ? turnProfileBand(frame, profile) : null
    const diameter = band?.diameter ?? input.diameter
    let segments: number
    try {
      segments = rotaryCylinderSegments(diameter / 2, units)
    } catch {
      return null
    }
    const params = normalizeTurnCannedParams({
      start: band?.start ?? input.start,
      length: band?.length ?? input.length,
      diameter,
      segments,
      frame,
      ...(profile ? { profile } : {}),
    } as unknown as CannedShapeParams)
    return params ? { kind: TURN_CANNED_KIND, params } : null
  }
  const params = normalizePolygonCannedParams({
    start: input.start,
    length: input.length,
    sides: input.sides,
    acrossFlats: input.acrossFlats,
    rotation: input.rotationDeg ?? 0,
    frame,
  } as unknown as CannedShapeParams)
  return params ? { kind: POLYGON_CANNED_KIND, params } : null
}

/**
 * The input's own numeric problem, before any geometry is built. The store is
 * the authority; the dialog runs the same checks so Create can be disabled with
 * the reason before a write is attempted.
 */
export function rotarySolidInputProblem(
  frame: RotarySolidFrame,
  input: RotarySolidInput,
): RotarySolidRefusal | null {
  if (input.kind === 'turn' && input.profile) {
    // The profile is the geometry, so it carries its own extent and stock
    // checks; the start/length/diameter fields are derived from it.
    return turnProfileProblem(input.profile, frame)
  }

  const band = rotarySolidBandProblem(frame, input.start, input.length)
  if (band === 'start') return 'invalidStart'
  if (band === 'length') return 'invalidLength'
  if (band === 'range') return 'invalidAlongRange'

  if (input.kind === 'turn') {
    if (!Number.isFinite(input.diameter) || input.diameter <= 0) return 'invalidDiameter'
    if (input.diameter > frame.thickness + ROTARY_SOLID_TOLERANCE) return 'diameterExceedsStock'
    return null
  }

  if (!Number.isInteger(input.sides) || input.sides < 3 || input.sides > MAX_POLYGON_SIDES) {
    return 'invalidSides'
  }
  if (!Number.isFinite(input.acrossFlats) || input.acrossFlats <= 0) return 'invalidAcrossFlats'
  const acrossCorners = input.acrossFlats / Math.cos(Math.PI / input.sides)
  if (acrossCorners > frame.thickness + ROTARY_SOLID_TOLERANCE) return 'polygonExceedsStock'
  if (!Number.isFinite(input.rotationDeg ?? 0)) return 'invalidRotation'
  return null
}

// ---------------------------------------------------------------------------
// Turn profile pick / refresh (decision 11)
// ---------------------------------------------------------------------------

/** One copied profile plus the dialog numbers it stands for. */
export type TurnProfilePick =
  | {
      ok: true
      profile: TurnCannedProfile
      /** Start from the chuck end, project units. */
      start: number
      /** Along the bar, project units. */
      length: number
      /** Twice the profile's largest radius, project units. */
      diameter: number
    }
  | { ok: false; reason: RotarySolidRefusal; detail?: string }

/** Why Refresh is unavailable, when it is. */
export type TurnProfileRefreshReason =
  | 'no-profile'
  | 'profileMissingSource'
  | 'profileUnsupportedSource'
  | TurnProfileProblem

export type TurnProfileRefreshState =
  | { canRefresh: true; profile: TurnCannedProfile; sourceName: string }
  | { canRefresh: false; reason: TurnProfileRefreshReason; sourceName?: string }

/**
 * Copy a drawn outline into the Turn. The returned profile is a plain list of
 * `(along, radius)` points in the Turn's stored bar frame, so the copy never
 * reads the source again after this call. Only `Refresh` calls this a second
 * time.
 *
 * `signed` points decide the crossing refusal before the sign is folded away:
 * a profile with points on both sides of the centreline would revolve into a
 * solid that runs through the bar.
 */
export function turnProfileFromFeature(
  project: Project,
  frame: RotarySolidFrame,
  sourceFeatureId: string,
): TurnProfilePick {
  const source = resolveFeatureInstance(project, sourceFeatureId)
  if (!source) return { ok: false, reason: 'profileMissingSource' }
  if (source.kind === 'stl' || source.operation === 'model') {
    return { ok: false, reason: 'profileUnsupportedSource' }
  }
  // An Around feature stores the unrolled sheet's coordinates, which are not a
  // side view of the bar; a profile must be drawn on Top or Bottom.
  if ((source.authoringFace ?? 'top') === 'around') {
    return { ok: false, reason: 'profileUnsupportedSource' }
  }
  const outlines = getFeatureGeometryProfiles(source).filter((profile) => profile.segments.length > 0)
  if (outlines.length === 0) return { ok: false, reason: 'profileEmpty' }
  if (outlines.length > 1) return { ok: false, reason: 'profileMultipleOutlines' }

  const outline = outlines[0]
  if (!outline) return { ok: false, reason: 'profileEmpty' }
  const sampled = sampleProfilePoints(outline)
  if (sampled.length < 2) return { ok: false, reason: 'profileEmpty' }

  const signed = sampled.map((point) => ({
    along: frame.axis === 'x' ? point.x : point.y,
    radius: frame.axis === 'x' ? frame.acrossCentre - point.y : point.x - frame.acrossCentre,
  }))
  const problem = checkPickedContour(signed, outline.closed, frame)
  if (problem) return { ok: false, reason: problem }

  const profile: TurnCannedProfile = {
    sourceFeatureId,
    sourceName: source.name,
    contours: [{
      closed: outline.closed,
      points: signed.map((point) => ({
        along: point.along,
        radius: Math.abs(point.radius) <= 1e-9 ? 0 : Math.abs(point.radius),
      })),
    }],
  }
  const band = turnProfileBand(frame, profile)
  return { ok: true, profile, ...band }
}

/**
 * Whether the dialog's **Refresh** action is available, and the source's
 * display name. A profile whose source was deleted stays revolved exactly as
 * copied; Refresh is refused with the reason instead of silently doing
 * nothing (the same rule as text on a path).
 */
export function turnProfileRefreshState(
  project: Project,
  frame: RotarySolidFrame,
  profile: TurnCannedProfile | null | undefined,
): TurnProfileRefreshState {
  if (!profile) return { canRefresh: false, reason: 'no-profile' }
  const picked = turnProfileFromFeature(project, frame, profile.sourceFeatureId)
  if (picked.ok) {
    return { canRefresh: true, profile: picked.profile, sourceName: picked.profile.sourceName ?? '' }
  }
  return {
    canRefresh: false,
    reason: refreshRefusal(picked.reason),
    sourceName: profile.sourceName,
  }
}

/** The picker's refusal narrowed to the reasons Refresh can report. */
function refreshRefusal(reason: RotarySolidRefusal): TurnProfileRefreshReason {
  switch (reason) {
    case 'profileEmpty':
    case 'profileCrossesAxis':
    case 'profileDoublesBack':
    case 'profileMultipleOutlines':
    case 'profileExceedsStock':
    case 'profileOutOfBar':
    case 'profileMissingSource':
    case 'profileUnsupportedSource':
      return reason
    default:
      return 'profileEmpty'
  }
}

/** The drawn features the Turn dialog may pick a profile from. */
export function turnProfileCandidates(project: Project): Array<{ id: string; name: string }> {
  return resolvedProjectFeatures(project)
    .filter((feature) => {
      if (feature.kind === 'stl' || feature.operation === 'model') return false
      if ((feature.authoringFace ?? 'top') === 'around') return false
      return getFeatureGeometryProfiles(feature).some((profile) => profile.segments.length > 0)
    })
    .map((feature) => ({ id: feature.id, name: feature.name }))
}

// ---------------------------------------------------------------------------
// Store action
// ---------------------------------------------------------------------------

interface RotarySolidCreation {
  ok: true
  project: Project
  selection: ProjectStore['selection']
  created: RotarySolidCreated
}

export type RotarySolidPlan = RotarySolidCreation | RotarySolidRefused

/** A name for the generated model: Turn, or Hex / Polygon N. */
function modelName(project: Project, input: RotarySolidInput): string {
  const base = input.kind === 'turn'
    ? 'Turn'
    : input.sides === 6 ? 'Hex' : `Polygon ${input.sides}`
  return uniqueName(base, [
    ...project.features.map((feature) => feature.name),
    ...project.featureFolders.map((folder) => folder.name),
  ])
}

/**
 * Everything the action needs, computed against a project without mutating it.
 * The pure half of the flow: a caller can plan a creation, inspect it, and
 * discard it with nothing changed.
 */
export function planRotarySolid(
  project: Project,
  selection: ProjectStore['selection'],
  input: RotarySolidInput,
): RotarySolidPlan {
  if (projectType(project) !== 'rotary') return { ok: false, reason: 'notRotaryProject' }
  // Turn and Polygon belong to the bar, not to a face (issue #1112 rt2-b item
  // 20): the model made from Top or Bottom is the same canned model on the same
  // bar, so creating it there is allowed on round and square bar stock alike.
  // Everything the model stores is derived from the stock, never from the
  // active setup, which is why no face check is needed here any more. A block
  // still has no bar to turn and is refused below.
  if (aroundUnavailableReason(project) !== null) return { ok: false, reason: 'notOnBar' }
  const stock = project.stock
  if (!isBarStock(stock)) return { ok: false, reason: 'notOnBar' }

  // Only an Around setup carries a bar axis of its own to disagree with the
  // stock; the flat faces' orientation is the Bottom flip axis, not the bar.
  const setup = activeSetup(project)
  if (setup.kind === 'around' && setup.orientation.axis !== stock.axis) {
    return { ok: false, reason: 'setupAxisMismatch' }
  }

  const frame = rotarySolidFrame(project)
  if (!frame) return { ok: false, reason: 'notOnBar' }
  const problem = rotarySolidInputProblem(frame, input)
  if (problem) return { ok: false, reason: problem }

  const canned = rotarySolidCannedData(frame, input, project.meta.units)
  if (!canned) return { ok: false, reason: 'creationFailed' }
  const mesh = generateCannedShapeMesh(canned)
  const frameProfile = cannedShapeFrame(canned)
  if (!mesh || !frameProfile) return { ok: false, reason: 'geometryNotRepresentable' }

  const featureId = nextUniqueGeneratedId(project, 'f')
  const draft: SketchFeature = {
    id: featureId,
    name: modelName(project, input),
    kind: 'stl',
    canned,
    stl: null,
    folderId: null,
    sketch: {
      profile: frameProfile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    // Authored on Top because that is the face the persisted-model load
    // pipeline accepts; a canned model is selectable on every face and its
    // rotary operations live in the active Around setup.
    authoringFace: 'top',
    // Placeholder span; the rebuilt mesh below provides the real one.
    z_top: 0,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  const minted = createDefinitionForFeature(project, draft)
  const rebuilt = rebuildCannedShapeModelDefinitions(
    { ...project, featureDefinitions: { ...project.featureDefinitions, [minted.definitionId]: minted.definition } },
    new Set([minted.definitionId]),
  )
  const model = rebuilt.models.get(minted.definitionId)
  if (!model) return { ok: false, reason: 'geometryNotRepresentable' }
  const bounds = model.asset.bounds
  const instance: FeatureInstance = createFeatureInstance(
    { ...draft, z_bottom: bounds.minZ, z_top: bounds.maxZ },
    minted.definitionId,
  )

  // A new Turn becomes the surface for any Thread/Flutes it covers, exactly as
  // a diameter edit does (decision 10). The sync reads the updated features and
  // definitions, so the new row is already visible to the resolver.
  const withTurn = {
    ...project,
    modelAssets: rebuilt.modelAssets,
    featureDefinitions: rebuilt.featureDefinitions,
    features: [...project.features, instance],
  }
  const synced = syncRotaryPatternSurfaces(
    withTurn,
    withTurn.features,
    withTurn.featureDefinitions,
    project,
  )
  const nextProject = syncFeatureTreeProject({
    ...withTurn,
    features: synced,
    featureTree: [...project.featureTree, { type: 'feature', featureId }],
    meta: { ...project.meta, modified: new Date().toISOString() },
  })

  return {
    ok: true,
    project: nextProject,
    selection: {
      ...selection,
      selectedFeatureId: featureId,
      selectedFeatureIds: [featureId],
      selectedNode: { type: 'feature', featureId },
      mode: 'feature',
      activeControl: null,
      groupFolderId: null,
    },
    created: { ok: true, featureId },
  }
}

/**
 * The store action. One history transition creates the one canned model with
 * its mesh asset and definition. A refusal changes nothing: no feature, no
 * asset, no history entry, no selection change and no dirtiness.
 *
 * An already-open history transaction is preserved: the creation joins it like
 * any other edit and the transaction's own commit takes the one snapshot.
 */
export function createAddRotarySolidAction(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
): ProjectStore['addRotarySolid'] {
  return (input) => {
    const state = get()
    const planned = planRotarySolid(state.project, state.selection, input)
    if (!planned.ok) return planned
    set((current) => {
      const applied = { project: planned.project, selection: planned.selection }
      if (current.history.transactionStart) {
        return applied
      }
      return {
        ...applied,
        history: {
          past: [...current.history.past, cloneProject(current.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    })
    return planned.created
  }
}
