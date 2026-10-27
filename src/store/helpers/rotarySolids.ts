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
import { activeFace, activeSetup, aroundUnavailableReason } from './activeFace'
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
  /** The project is not rotary, so there is no Around face to create on. */
  | 'notRotaryProject'
  /** The workspace is not on an Around setup. */
  | 'notAroundFace'
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
    let segments: number
    try {
      segments = rotaryCylinderSegments(input.diameter / 2, units)
    } catch {
      return null
    }
    const params = normalizeTurnCannedParams({
      start: input.start,
      length: input.length,
      diameter: input.diameter,
      segments,
      frame,
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
  if (activeFace(project) !== 'around') return { ok: false, reason: 'notAroundFace' }
  if (aroundUnavailableReason(project) !== null) return { ok: false, reason: 'notOnBar' }
  const stock = project.stock
  if (!isBarStock(stock)) return { ok: false, reason: 'notOnBar' }

  const setup = activeSetup(project)
  if (setup.kind !== 'around') return { ok: false, reason: 'notAroundFace' }
  if (setup.orientation.axis !== stock.axis) return { ok: false, reason: 'setupAxisMismatch' }

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

  const nextProject = syncFeatureTreeProject({
    ...project,
    modelAssets: rebuilt.modelAssets,
    featureDefinitions: rebuilt.featureDefinitions,
    features: [...project.features, instance],
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
