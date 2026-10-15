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
 * Ordinary generated solids on the Around face (issue #1016 C2-B): a polygon
 * prism cut from a round bar, and the round finished target of a square-to-round
 * job cut from a real square blank.
 *
 * Both are **ordinary geometry**: one imported-model feature (`operation:
 * 'model'`) holding the generated mesh, plus one ordinary rotary rough and one
 * ordinary rotary finish operation targeting it, created in a single undo step.
 * The input numbers are not stored — only the existing folder / definition /
 * instance / asset / operation shapes are persisted, exactly as C1's
 * dialog-established thread lines are ordinary lines. No project format,
 * post-processor or generator change.
 *
 * The model is authored on **Top** because that is what the persisted-model
 * load pipeline accepts (`loadSTLTransformedGeometry` returns null for an
 * Around-authored model), while its operations live in the active Around setup.
 * Its `z_bottom`/`z_top` are the emitted mesh's own Z bounds, so the loader's Z
 * fit is the identity and the mesh is never stretched; its XY sketch profile
 * and silhouette are the mesh's own absolute plan bounds with an identity
 * instance transform. The mesh itself is built in absolute stock coordinates
 * (`buildRotaryPolygonPrism` / `buildRotaryCylinder`), so no second placement
 * transform is applied.
 *
 * ## What this module deliberately does not do
 *
 * - It does not use `aroundUnavailableReason`: that guard still reports a
 *   square blank as `needsRoundBar` while the square authoring/output paths are
 *   being completed, so it would refuse every square-to-round creation. The
 *   contract here is checked explicitly — rotary project, bar stock of the
 *   right shape, an active Around setup whose axis matches the bar.
 * - It does not widen `targetAllowedInSetup` / `isOperationTargetValid`, and it
 *   does not touch the square-stock engine paths. A square-to-round creation
 *   lands as an ordinary model and operations; generation then refuses it at
 *   the engine's own round-bar guards (`generateRotaryOperation`,
 *   `setupGenerationBlock`), which remain the engine slice's to extend.
 * - It never writes round stock. The real square blank stays exactly as it was
 *   and the generated cylinder is only the finished round target inside it.
 * - It does not chain `addFeature` (which refuses a model on Around) or
 *   `addOperation`; everything lands in one `set` and one history step.
 */

import type { StateCreator } from 'zustand'
import { getStockBounds, isRoundStock, rectProfile } from '../../types/project'
import { isSquareStock } from '../../types/barStock'
import type {
  BarStock,
  FeatureFolder,
  Operation,
  OperationTarget,
  Point,
  Project,
  SketchFeature,
  Tool,
} from '../../types/project'
import { isToolCompatibleWithOperation } from '../../toolPolicy'
import { buildRotaryPolygonPrism } from '../../engine/rotaryPrism'
import { buildRotaryCylinder } from '../../engine/rotaryCylinder'
import { serializeImportedMesh } from '../../engine/importedMesh'
import type { ImportedTriangleMesh } from '../../engine/importedMesh'
import { targetAllowedInSetup } from '../../engine/setupTargets'
import { convertLength, convertToolUnits } from '../../utils/units'
import type { Units } from '../../utils/units'
import { uniqueName } from '../../import'
import { activeFace, activeSetup } from './activeFace'
import { createDefinitionForFeature, createFeatureInstance } from './featureDefinitions'
import { nextUniqueGeneratedId } from './ids'
import { normalizeImportedModelStorage } from './modelAssets'
import { cloneProject, normalizeFeatureZRange, syncFeatureTreeProject } from './normalize'
import { defaultOperationForTarget, isOperationTargetValid } from './operationDefaults'
import { projectType } from './projectType'
import type { ProjectStore } from '../types'

/** Most polygon sides the generator accepts, matching `buildRotaryPolygonPrism`. */
const MAX_POLYGON_SIDES = 64

/**
 * Numeric slack for the along-extent test, matching the engine builders: a
 * value written at a stock bound can read back a few Float32 ulps off it.
 */
const TOLERANCE = 1e-4

// ---------------------------------------------------------------------------
// Public input / result (frozen for the UI slice)
// ---------------------------------------------------------------------------

export interface RotaryPolygonSolidInput {
  kind: 'polygon'
  /** Number of polygon sides. Integer 3..64; 6 is the hex-bolt head. */
  sides: number
  /** Twice the polygon's apothem (across-flats), project units. */
  acrossFlats: number
  /**
   * Start position along the bar, **absolute stock coordinates** and strictly
   * below `alongEnd` numerically even on a Y bar (the UI maps start/length from
   * the bar's maximum Y).
   */
  alongStart: number
  /** End position along the bar, absolute stock coordinates. */
  alongEnd: number
  /** Rotation about the bar's axis in degrees. Finite; default 0 (one flat up). */
  rotationDeg?: number
  /** An existing project tool the solid is machined with. */
  toolRef: string
}

export interface RotarySquareToRoundInput {
  kind: 'square-to-round'
  /** Finished round diameter inside the square blank, project units. */
  diameter: number
  /** Start position along the blank, absolute stock coordinates. */
  alongStart: number
  /** End position along the blank, absolute stock coordinates. */
  alongEnd: number
  /** An existing project tool the solid is machined with. */
  toolRef: string
}

export type RotarySolidInput = RotaryPolygonSolidInput | RotarySquareToRoundInput

export type RotarySolidRefusal =
  /** The project is not rotary, so there is no Around face to create on. */
  | 'notRotaryProject'
  /** The workspace is not on an Around setup. */
  | 'notAroundFace'
  /** The active Around setup turns about the other bar axis. */
  | 'setupAxisMismatch'
  /**
   * Square-to-round on a *provisional* Around setup. The store's reconciler
   * only realises that setup when the project's type and stock allow it, and
   * it still refuses a square blank, so the write would be discarded silently;
   * the plan refuses instead of reporting a creation that did not happen.
   */
  | 'provisionalAroundUnsupported'
  /** A polygon needs a round bar. */
  | 'needsRoundBar'
  /** Square-to-round needs a square blank. */
  | 'needsSquareBar'
  | 'invalidAlongRange'
  | 'invalidSides'
  | 'invalidAcrossFlats'
  | 'invalidRotation'
  | 'invalidDiameter'
  /** The finished diameter is larger than the blank's side. */
  | 'diameterExceedsBlank'
  /** The polygon's across-corners reaches past the bar. */
  | 'polygonExceedsBar'
  | 'toolNotFound'
  | 'toolIncompatible'
  /** A supported cutter whose diameter or seeded defaults are not usable. */
  | 'invalidTool'
  /** The emitted mesh cannot be represented in Float32 coordinates. */
  | 'geometryNotRepresentable'
  /** The generated model could not be handed to a valid rotary target. */
  | 'targetNotAllowed'

export interface RotarySolidCreated {
  ok: true
  /** The features folder holding the generated model. */
  folderId: string
  /** The one generated model feature, targeted by both operations. */
  featureId: string
  roughOperationId: string
  finishOperationId: string
}

export interface RotarySolidRefused {
  ok: false
  reason: RotarySolidRefusal
  /** Free-text context for a refusal (which default, which builder error). */
  detail?: string
}

export type RotarySolidResult = RotarySolidCreated | RotarySolidRefused

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * The operation-seeding numerics a tool must carry *after* the conversion into
 * the project's units. The raw record is not enough: a value finite in its own
 * units can overflow the project's unit on conversion (a 0.25 in cutter with a
 * `defaultFeed` of `Number.MAX_VALUE` converts to `Infinity` mm), and the
 * created operations read the converted copy — so a raw-only check would commit
 * two operations with an infinite feed. The check runs on the exact converted
 * object the operations are seeded from, before any state or operation exists.
 *
 * A cutter's diameter must be a finite positive physical size. Every default the
 * two operations are seeded from (feed, plunge feed, stepdown, stepover) must be
 * a finite positive length, and rpm a finite non-negative speed; `0` stays
 * allowed for rpm (no spindle) but not for a feed or a depth of cut.
 */
function convertedToolRefusal(converted: Tool): RotarySolidRefused | null {
  // The record is in its own units, so the physical size is asked in
  // millimetres — a 0.25 in cutter is a real 6.35 mm cutter in an mm project.
  const physicalDiameter = convertLength(converted.diameter, converted.units, 'mm')
  if (!Number.isFinite(physicalDiameter) || !(physicalDiameter > 0)) {
    return { ok: false, reason: 'invalidTool', detail: 'diameter' }
  }
  const feedsAndDepths = [converted.defaultFeed, converted.defaultPlungeFeed, converted.defaultStepdown, converted.defaultStepover]
  if (!feedsAndDepths.every((value) => Number.isFinite(value) && value > 0)) {
    return { ok: false, reason: 'invalidTool', detail: 'defaults' }
  }
  if (!Number.isFinite(converted.defaultRpm) || converted.defaultRpm < 0) {
    return { ok: false, reason: 'invalidTool', detail: 'defaults' }
  }
  return null
}

function toolRefusal(tool: Tool | undefined, projectUnits: Units): RotarySolidRefused | null {
  if (!tool) return { ok: false, reason: 'toolNotFound' }
  if (!isToolCompatibleWithOperation(tool, 'rotary_rough')) {
    return { ok: false, reason: 'toolIncompatible', detail: tool.type }
  }
  return convertedToolRefusal(tool.units === projectUnits ? tool : convertToolUnits(tool, projectUnits))
}

function alongRangeRefusal(
  axis: 'x' | 'y',
  alongStart: number,
  alongEnd: number,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
): RotarySolidRefused | null {
  if (!Number.isFinite(alongStart) || !Number.isFinite(alongEnd)) {
    return { ok: false, reason: 'invalidAlongRange', detail: 'notFinite' }
  }
  if (!(alongEnd > alongStart)) {
    return { ok: false, reason: 'invalidAlongRange', detail: 'notAscending' }
  }
  const min = axis === 'x' ? bounds.minX : bounds.minY
  const max = axis === 'x' ? bounds.maxX : bounds.maxY
  if (alongStart < min - TOLERANCE || alongEnd > max + TOLERANCE) {
    return { ok: false, reason: 'invalidAlongRange', detail: `outside ${min}..${max}` }
  }
  return null
}

function polygonFolderBase(sides: number): string {
  return sides === 6 ? 'Hex' : `Polygon ${sides}`
}

/**
 * Build the feature's plan sketch from the emitted mesh: the rectangle of its
 * own absolute XY extent, closed, plus the same outline as its silhouette. The
 * model carries an identity instance transform, so this is already in project
 * coordinates and nothing is applied twice.
 */
function modelPlanArtifacts(mesh: ImportedTriangleMesh): { profile: SketchFeature['sketch']['profile']; silhouettePaths: Point[][] } {
  const { minX, minY, maxX, maxY } = mesh.bounds
  return {
    profile: rectProfile(minX, minY, maxX - minX, maxY - minY),
    silhouettePaths: [[
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ]],
  }
}

// ---------------------------------------------------------------------------
// Store action
// ---------------------------------------------------------------------------

/**
 * The bar this input needs, or the typed refusal: a polygon is cut from a round
 * bar, square-to-round from a square blank. Returns the narrowed stock so the
 * rest of the plan reads `axis`, `thickness` and the bounds without a cast.
 */
function barForInput(project: Project, input: RotarySolidInput): BarStock | RotarySolidRefused {
  if (input.kind === 'polygon') {
    return isRoundStock(project.stock) ? project.stock : { ok: false, reason: 'needsRoundBar' }
  }
  return isSquareStock(project.stock) ? project.stock : { ok: false, reason: 'needsSquareBar' }
}

/**
 * Validate one input's own dimensions and build its mesh in stock coordinates,
 * or refuse. The builder's `RangeError` (Float32 collapse, an unbounded
 * tessellation) is reported as `geometryNotRepresentable` rather than escaping
 * the action.
 */
function buildSolidMesh(
  project: Project,
  stock: BarStock,
  input: RotarySolidInput,
): ImportedTriangleMesh | RotarySolidRefused {
  if (input.kind === 'polygon') {
    if (!isRoundStock(stock)) return { ok: false, reason: 'needsRoundBar' }
    if (!Number.isInteger(input.sides) || input.sides < 3 || input.sides > MAX_POLYGON_SIDES) {
      return { ok: false, reason: 'invalidSides', detail: String(input.sides) }
    }
    if (!Number.isFinite(input.acrossFlats) || input.acrossFlats <= 0) {
      return { ok: false, reason: 'invalidAcrossFlats', detail: String(input.acrossFlats) }
    }
    if (input.rotationDeg !== undefined && !Number.isFinite(input.rotationDeg)) {
      return { ok: false, reason: 'invalidRotation', detail: String(input.rotationDeg) }
    }
    const acrossCorners = input.acrossFlats / Math.cos(Math.PI / input.sides)
    if (acrossCorners > stock.thickness + TOLERANCE) {
      return { ok: false, reason: 'polygonExceedsBar', detail: `${acrossCorners} > ${stock.thickness}` }
    }
    try {
      return buildRotaryPolygonPrism(stock, {
        sides: input.sides,
        acrossFlats: input.acrossFlats,
        alongStart: input.alongStart,
        alongEnd: input.alongEnd,
        rotationDeg: input.rotationDeg,
      })
    } catch (error) {
      return { ok: false, reason: 'geometryNotRepresentable', detail: errorText(error) }
    }
  }

  if (!isSquareStock(stock)) return { ok: false, reason: 'needsSquareBar' }
  if (!Number.isFinite(input.diameter) || input.diameter <= 0) {
    return { ok: false, reason: 'invalidDiameter', detail: String(input.diameter) }
  }
  // The finished round target must fit inside the real blank.
  if (input.diameter > stock.thickness + TOLERANCE) {
    return { ok: false, reason: 'diameterExceedsBlank', detail: `${input.diameter} > ${stock.thickness}` }
  }
  try {
    return buildRotaryCylinder(stock, {
      diameter: input.diameter,
      alongStart: input.alongStart,
      alongEnd: input.alongEnd,
    }, project.meta.units)
  } catch (error) {
    return { ok: false, reason: 'geometryNotRepresentable', detail: errorText(error) }
  }
}

interface RotarySolidCreation {
  ok: true
  project: Project
  selection: ProjectStore['selection']
  created: RotarySolidCreated
}

export type RotarySolidPlan = RotarySolidCreation | RotarySolidRefused

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

  const stock = barForInput(project, input)
  if ('ok' in stock) return stock

  const setup = activeSetup(project)
  if (setup.kind !== 'around') return { ok: false, reason: 'notAroundFace' }
  if (setup.orientation.axis !== stock.axis) return { ok: false, reason: 'setupAxisMismatch' }
  // The store's setup reconciler realises a provisional Around setup in the
  // same write, but only where the project's type and stock allow it — and it
  // still answers `needsRoundBar` for a square blank. There the write would be
  // discarded without an error, so a plan that would report success for a
  // creation that never lands is refused up front. A round bar keeps the
  // provisional path (the reconciler realises it); the square blank needs a
  // real Around setup until the UI/engine slices widen that path.
  if (isSquareStock(stock) && !project.setups.some((entry) => entry.id === setup.id)) {
    return { ok: false, reason: 'provisionalAroundUnsupported' }
  }

  const tool = project.tools.find((candidate) => candidate.id === input.toolRef)
  const toolProblem = toolRefusal(tool, project.meta.units)
  if (toolProblem) return toolProblem
  const cutter = tool as Tool

  const bounds = getStockBounds(stock)
  const rangeProblem = alongRangeRefusal(stock.axis, input.alongStart, input.alongEnd, bounds)
  if (rangeProblem) return rangeProblem

  const built = buildSolidMesh(project, stock, input)
  if ('ok' in built) return built
  const mesh = built

  const meshBounds = mesh.bounds
  const featureId = nextUniqueGeneratedId(project, 'f')
  const folderId = nextUniqueGeneratedId(project, 'fd')
  const folderBase = input.kind === 'polygon' ? polygonFolderBase(input.sides) : 'Square to round'
  const folderName = uniqueName(folderBase, project.featureFolders.map((entry) => entry.name))
  const featureName = uniqueName(`${folderName} Model`, project.features.map((entry) => entry.name))
  const { profile, silhouettePaths } = modelPlanArtifacts(mesh)

  const folder: FeatureFolder = { id: folderId, name: folderName, collapsed: false, section: 'features' }

  // `normalizeImportedModelStorage` moves the serialized mesh into the project's
  // asset map and leaves the definition holding only its `meshAssetId` — the
  // same storage seam an imported model uses, so pruning on save and reload
  // behave identically.
  const modelAssets = { ...project.modelAssets }
  const draft = normalizeFeatureZRange({
    id: featureId,
    name: featureName,
    kind: 'stl',
    stl: {
      format: 'stl',
      mesh: serializeImportedMesh(mesh, 'stl'),
      scale: 1,
      axisSwap: 'none',
      silhouettePaths,
    },
    folderId,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'model',
    // Required by the persisted-model load pipeline; the operations still cut
    // it from the Around setup they are placed in.
    authoringFace: 'top',
    // The loader fits raw mesh Z into this band. Equal bounds make it identity.
    z_top: meshBounds.maxZ,
    z_bottom: meshBounds.minZ,
    visible: true,
    locked: false,
  })
  const safeDraft: SketchFeature = {
    ...draft,
    stl: normalizeImportedModelStorage(featureId, draft.stl, modelAssets) ?? null,
  }
  const minted = createDefinitionForFeature(project, safeDraft)
  const instance = createFeatureInstance(safeDraft, minted.definitionId)

  const withFeature = syncFeatureTreeProject({
    ...project,
    modelAssets,
    featureFolders: [...project.featureFolders, folder],
    features: [...project.features, instance],
    featureDefinitions: { ...project.featureDefinitions, [minted.definitionId]: minted.definition },
  })

  const target: OperationTarget = { source: 'features', featureIds: [featureId] }
  // A cutter record imported or authored in the other unit seeds the operation
  // from a throwaway copy converted into the project's units, so feeds and
  // stepdowns land in the project's scale; the stored tool, its id, units and
  // values are untouched.
  const defaultsTool = cutter.units === project.meta.units ? cutter : convertToolUnits(cutter, project.meta.units)

  const roughId = nextUniqueGeneratedId(withFeature, 'op')
  const roughTemplate = defaultOperationForTarget(
    withFeature, 'rotary_rough', 'rough', target, withFeature.operations.length, { tool: defaultsTool, toolRef: cutter.id })
  const rough: Operation = { ...roughTemplate, id: roughId, setupId: setup.id, target, toolRef: cutter.id }

  const withRough: Project = { ...withFeature, operations: [...withFeature.operations, rough] }
  const finishId = nextUniqueGeneratedId(withRough, 'op')
  const finishTemplate = defaultOperationForTarget(
    withRough, 'rotary_finish', 'finish', target, withRough.operations.length, { tool: defaultsTool, toolRef: cutter.id })
  const finish: Operation = { ...finishTemplate, id: finishId, setupId: setup.id, target, toolRef: cutter.id }

  const nextProject = syncFeatureTreeProject({
    ...withRough,
    operations: [...withRough.operations, finish],
    meta: { ...project.meta, modified: new Date().toISOString() },
  })

  if (!isOperationTargetValid(nextProject, 'rotary_rough', target)
    || !isOperationTargetValid(nextProject, 'rotary_finish', target)
    || !targetAllowedInSetup(nextProject, target, nextProject.activeSetupId, 'rotary_rough')
    || !targetAllowedInSetup(nextProject, target, nextProject.activeSetupId, 'rotary_finish')) {
    return { ok: false, reason: 'targetNotAllowed' }
  }

  return {
    ok: true,
    project: nextProject,
    // The model is authored on Top while the workspace is on Around, so it is a
    // ghost there and cannot be selected; the new folder is the stable handle
    // the write leaves selected.
    selection: {
      ...selection,
      selectedFeatureId: null,
      selectedFeatureIds: [],
      selectedNode: { type: 'folder', folderId },
      mode: 'feature',
      activeControl: null,
      groupFolderId: null,
    },
    created: { ok: true, folderId, featureId, roughOperationId: roughId, finishOperationId: finishId },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The store action. One history transition creates the folder, the generated
 * model feature (with its mesh asset and definition) and the two rotary
 * operations. A refusal changes nothing: no folder, no feature, no asset, no
 * operation, no history entry, no selection change and no dirtiness.
 *
 * An already-open history transaction is preserved: the creation joins it like
 * any other edit and the transaction's own commit takes the one snapshot, so a
 * transaction that also changed the grid, a tool or anything else undoes as one
 * step. Standalone creation still records its own single step.
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
