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
 * Canned Thread and Flutes on the Around face (issue #1016 C1 slice A).
 *
 * Both are ordinary geometry: a named folder of open `line` features and one
 * ordinary Engrave (`follow_line`) operation, created in one undo step. The
 * input numbers are not stored — only the existing line/folder/operation/tool
 * shapes are persisted, so once created they behave like anything drawn by
 * hand. No project format, post-processor or generator change.
 *
 * Geometry is built on the unrolled Around sheet from the frozen frame
 * (`engine/aroundFrame.ts`, `engine/rotaryFrame.ts`):
 *
 * - `along` is the bar's project axis, and `start` is a distance from the
 *   stock's minimum along coordinate, so the requested geometry lies between
 *   `start` and `start + length` measured from the bar's start. Nothing is
 *   clipped when that reaches past a bar end — the cut runs off it.
 * - `across` runs from `frame.zero`, the bar's centreline (the top of the bar,
 *   a = 0). It is never reduced modulo the circumference: one turn is
 *   `frame.circumference` and a multi-turn line keeps counting.
 * - A thread with `n` starts advances `lead = n * pitch` along the bar per full
 *   turn, and its `n` lines start evenly `C / n` apart across. A flute line
 *   spans `twist * C` across over the requested length, `count` of them evenly
 *   `C / count` apart. A thread is right-hand unless `direction` is `left`; a flute's positive `twist` is right-hand and `0` is straight.
 *
 * Handedness is the frozen rotary sign, not a screen convention. The physical
 * frame is project X and Z, with physical Y = −project Y (the project frame is
 * Y-down; export inverts it). For a bar along X the along direction is
 * physical +X and `across` is physical −Y; for a bar along Y the along
 * direction is physical −Y and `across` is physical +X. Working the frozen
 * angle `a = 360·(across − zero)/C` and the material point
 * `(across, up) = (r·sin a, r·cos a)` into a right-handed helix triple product
 * gives `da/d(along) > 0` on X and `< 0` on Y — the same physical right-hand
 * thread needs the opposite sheet slope on the two axes, because swapping
 * which project axis is "across" is a reflection. `rotaryHandedness` is that
 * sign, and `rotaryPatterns.test.ts` re-derives it from the physical points
 * instead of trusting this constant.
 */

import type { StateCreator } from 'zustand'
import {
  getStockBounds,
  inferFeatureKind,
  isRoundStock,
} from '../../types/project'
import type {
  FeatureDefinition,
  FeatureFolder,
  FeatureInstance,
  Operation,
  OperationTarget,
  Point,
  Project,
  SketchProfile,
  Tool,
} from '../../types/project'
import type { ToolLibraryEntry } from '../../toolLibrary'
import { isToolCompatibleWithOperation } from '../../toolPolicy'
import { aroundFrame } from '../../engine/aroundFrame'
import { targetAllowedInSetup } from '../../engine/setupTargets'
import { convertLength, convertToolUnits } from '../../utils/units'
import { uniqueName } from '../../import'
import { activeFace, activeSetup, aroundSketchAuthoringAvailable, aroundUnavailableReason } from './activeFace'
import { createDefinitionForFeature, createFeatureInstance } from './featureDefinitions'
import { nextUniqueGeneratedId } from './ids'
import { cloneProject, normalizeFeatureZRange, syncFeatureTreeProject } from './normalize'
import { defaultOperationForTarget, isOperationTargetValid } from './operationDefaults'
import type { ProjectStore } from '../types'

/** Depth of a 60° thread as a fraction of its pitch (the UI default). */
export const THREAD_DEPTH_PER_PITCH = 0.61

// ---------------------------------------------------------------------------
// Public input / result (frozen for slice B, the dialogs)
// ---------------------------------------------------------------------------

export interface ThreadPatternInput {
  kind: 'thread'
  /** Distance from the stock's minimum along coordinate, project units. */
  start: number
  /** Length along the bar, project units. */
  length: number
  /** Physical pitch in project units; the inch dialog converts TPI first. */
  pitch: number
  /** Number of starts; defaults to 1. Lead is `starts * pitch`. */
  starts?: number
  /** Thread hand; `left` reverses the physical helix. Omitted is right. */
  direction?: 'right' | 'left'
  /** Depth below the bar surface, project units. */
  depth: number
}

export interface FlutesPatternInput {
  kind: 'flutes'
  start: number
  length: number
  count: number
  /** Turns of twist over the requested length; `0` is straight. */
  twist: number
  depth: number
  /** An existing project tool the flute is cut with. */
  toolRef: string
}

export type RotaryPatternInput = ThreadPatternInput | FlutesPatternInput

export type RotaryPatternRefusal =
  /** Around cannot be entered: not rotary, no round bar, no rotary machine, axis mismatch. */
  | 'aroundUnavailable'
  /** Around is available but the workspace is not on it. */
  | 'aroundNotActive'
  | 'invalidStart'
  | 'invalidLength'
  | 'invalidDepth'
  | 'invalidPitch'
  | 'invalidStarts'
  | 'invalidCount'
  | 'invalidTwist'
  /** Depth reaches or passes the bar's centreline. */
  | 'depthReachesCentreline'
  /** A thread found no compatible V-bit and none could be imported. */
  | 'noVBitTool'
  | 'toolNotFound'
  | 'toolIncompatible'
  /** The generated geometry could not be handed to a valid Engrave target. */
  | 'targetNotAllowed'

export interface RotaryPatternCreated {
  ok: true
  folderId: string
  /** Created line feature ids, in start/flute order. */
  featureIds: string[]
  operationId: string
}

export interface RotaryPatternRefused {
  ok: false
  reason: RotaryPatternRefusal
  /** For `aroundUnavailable`, which Around precondition failed. */
  detail?: string
}

export type RotaryPatternResult = RotaryPatternCreated | RotaryPatternRefused

// ---------------------------------------------------------------------------
// Sheet frame and lines
// ---------------------------------------------------------------------------

/**
 * The Around sheet facts a pattern is built from. `zero` is
 * `aroundFrame.zero` (the bar's centreline / top line, issue #1026), never the
 * sheet's lower edge; `alongOrigin` is the stock's minimum along coordinate.
 */
export interface RotaryPatternFrame {
  axis: 'x' | 'y'
  zero: number
  circumference: number
  radius: number
  alongOrigin: number
}

/** The pattern frame for a round bar, or null when the stock is not a bar. */
export function rotaryPatternFrame(project: Pick<Project, 'stock'>): RotaryPatternFrame | null {
  if (!isRoundStock(project.stock)) return null
  const frame = aroundFrame(project.stock)
  const bounds = getStockBounds(project.stock)
  return {
    axis: frame.axis,
    zero: frame.zero,
    circumference: frame.circumference,
    radius: frame.radius,
    alongOrigin: frame.axis === 'x' ? bounds.minX : bounds.minY,
  }
}

/** `+1` or `-1`: the across direction a right-hand helix takes on this bar axis. */
export function rotaryHandedness(axis: 'x' | 'y'): 1 | -1 {
  return axis === 'x' ? 1 : -1
}

/** A straight line on the unrolled sheet: along the bar, across from the zero line. */
export interface RotarySheetLine {
  alongStart: number
  alongEnd: number
  acrossStart: number
  acrossEnd: number
}

/** The sheet point at an along/across coordinate: `along` is the bar's project axis. */
export function rotarySheetPoint(frame: Pick<RotaryPatternFrame, 'axis'>, along: number, across: number): Point {
  return frame.axis === 'x' ? { x: along, y: across } : { x: across, y: along }
}

export type RotaryPatternLinesResult =
  | { ok: true; lines: RotarySheetLine[] }
  | RotaryPatternRefused

/**
 * The sheet lines a Thread or Flutes input asks for. Pure: it validates the
 * numbers and the depth against the bar radius, and derives the geometry. It
 * knows nothing about tools, the store or the workspace face.
 */
export function buildRotaryPatternLines(
  frame: RotaryPatternFrame,
  input: RotaryPatternInput,
): RotaryPatternLinesResult {
  if (!Number.isFinite(input.start)) return { ok: false, reason: 'invalidStart' }
  if (!Number.isFinite(input.length) || input.length <= 0) return { ok: false, reason: 'invalidLength' }
  if (!Number.isFinite(input.depth) || input.depth <= 0) return { ok: false, reason: 'invalidDepth' }
  // Strictly above the centreline: the bar's surface is at `thickness`, its
  // centreline at `radius`, so a depth reaching the radius is refused.
  if (input.depth >= frame.radius) return { ok: false, reason: 'depthReachesCentreline' }

  const alongStart = frame.alongOrigin + input.start
  const alongEnd = alongStart + input.length

  if (input.kind === 'thread') {
    const starts = input.starts ?? 1
    if (!Number.isInteger(starts) || starts < 1) return { ok: false, reason: 'invalidStarts' }
    if (!Number.isFinite(input.pitch) || input.pitch <= 0) return { ok: false, reason: 'invalidPitch' }
    const lead = starts * input.pitch
    const hand = input.direction === 'left' ? -1 : 1
    const acrossPerAlong = (hand * rotaryHandedness(frame.axis) * frame.circumference) / lead
    const lines = Array.from({ length: starts }, (_, index) => {
      const acrossStart = frame.zero + (index * frame.circumference) / starts
      return {
        alongStart,
        alongEnd,
        acrossStart,
        acrossEnd: acrossStart + (alongEnd - alongStart) * acrossPerAlong,
      }
    })
    return { ok: true, lines }
  }

  if (!Number.isInteger(input.count) || input.count < 1) return { ok: false, reason: 'invalidCount' }
  if (!Number.isFinite(input.twist)) return { ok: false, reason: 'invalidTwist' }
  const lines = Array.from({ length: input.count }, (_, index) => {
    const acrossStart = frame.zero + (index * frame.circumference) / input.count
    return {
      alongStart,
      alongEnd,
      acrossStart,
      acrossEnd: acrossStart + rotaryHandedness(frame.axis) * input.twist * frame.circumference,
    }
  })
  return { ok: true, lines }
}

// ---------------------------------------------------------------------------
// Tool resolution
// ---------------------------------------------------------------------------

/**
 * A tool's diameter as one physical length in millimetres. A record's
 * `diameter` is in its own `units`, so records written in different units
 * cannot be ranked until they share a unit (issue #1016 C1 slice A4). The
 * conversion is the same one `convertToolUnits` uses; a same-unit comparison
 * is untouched (the factor is 1).
 */
function physicalDiameterMm(tool: Pick<Tool, 'diameter' | 'units'>): number {
  return convertLength(tool.diameter, tool.units, 'mm')
}

/**
 * The project's V-bits, smallest physical diameter first. Ties (including the
 * same physical size written in two units) keep the project's tool order, so
 * the choice is deterministic. The saved records are never reordered: the
 * input array is copied before sorting.
 */
function vBits(tools: readonly Tool[]): Tool[] {
  return tools
    .filter((tool) => tool.type === 'v_bit')
    .slice()
    .sort((a, b) => physicalDiameterMm(a) - physicalDiameterMm(b))
}

/**
 * A V-bit for a thread: the smallest one the project already has, else the
 * smallest bundled-library entry (preferring one written in the project's
 * units), converted and minted with a fresh id in the same undo step. Null
 * when neither exists, so the caller can refuse atomically.
 */
function resolveThreadTool(
  project: Project,
  libraryTools: readonly ToolLibraryEntry[],
): { tool: Tool; add: boolean } | null {
  const existing = vBits(project.tools)[0]
  if (existing) return { tool: existing, add: false }

  const entries = libraryTools.filter((entry) => entry.type === 'v_bit')
  if (entries.length === 0) return null
  const native = entries.filter((entry) => entry.units === project.meta.units)
  const pool = native.length > 0 ? native : entries
  const entry = pool.reduce((best, candidate) => (
    physicalDiameterMm(candidate) < physicalDiameterMm(best) ? candidate : best
  ))
  const { key: _key, ...template } = entry
  void _key
  const { id: _id, ...converted } = convertToolUnits({ ...template, id: '__library__' }, project.meta.units)
  void _id
  return { tool: { ...converted, id: nextUniqueGeneratedId(project, 't') }, add: true }
}

function resolveFluteTool(project: Project, toolRef: string): Tool | RotaryPatternRefused {
  const tool = project.tools.find((candidate) => candidate.id === toolRef)
  if (!tool) return { ok: false, reason: 'toolNotFound' }
  if (!isToolCompatibleWithOperation(tool, 'follow_line')) return { ok: false, reason: 'toolIncompatible' }
  return tool
}

// ---------------------------------------------------------------------------
// Store action
// ---------------------------------------------------------------------------

interface RotaryPatternCreation {
  ok: true
  project: Project
  selection: ProjectStore['selection']
  created: RotaryPatternCreated
}

type RotaryPatternPlan = RotaryPatternCreation | RotaryPatternRefused

/** Everything the action needs, computed against a project without mutating it. */
function planRotaryPattern(
  project: Project,
  selection: ProjectStore['selection'],
  input: RotaryPatternInput,
  libraryTools: readonly ToolLibraryEntry[],
): RotaryPatternPlan {
  // Thread and Flutes are hand-drawn sheet geometry, so they stay round-bar
  // authoring (issue #1016 C2-U1) even though the Around face itself is
  // workflow-available on a square blank. The refusal keeps the C1 reason
  // strings: `needsRoundBar` for either a block or a square, the project-type
  // reason otherwise.
  if (!aroundSketchAuthoringAvailable(project)) {
    return { ok: false, reason: 'aroundUnavailable', detail: aroundUnavailableReason(project) ?? 'needsRoundBar' }
  }
  if (activeFace(project) !== 'around') return { ok: false, reason: 'aroundNotActive' }

  const frame = rotaryPatternFrame(project)
  if (!frame) return { ok: false, reason: 'aroundUnavailable', detail: 'needsRoundBar' }
  const built = buildRotaryPatternLines(frame, input)
  if (!built.ok) return built

  let tool: Tool
  let toolToAdd: Tool | null = null
  if (input.kind === 'thread') {
    const resolved = resolveThreadTool(project, libraryTools)
    if (!resolved) return { ok: false, reason: 'noVBitTool' }
    tool = resolved.tool
    toolToAdd = resolved.add ? resolved.tool : null
  } else {
    const resolved = resolveFluteTool(project, input.toolRef)
    if ('ok' in resolved) return resolved
    tool = resolved
  }
  const toolRef = tool.id
  // `defaultOperationForTarget` seeds the operation's feed, plunge feed and
  // stepdown straight from the tool record — correct for `addOperation`, whose
  // picker only ever offers tools already in project units, but a Thread or
  // Flutes cutter is an *existing* record that may have been imported or
  // authored in the other unit (issue #1016). Seed from a throwaway copy
  // converted into project units so the operation lands in the project's scale;
  // the stored tool record, its id and the reference above are untouched.
  const defaultsTool = tool.units === project.meta.units ? tool : convertToolUnits(tool, project.meta.units)

  const thickness = project.stock.thickness
  const folderId = nextUniqueGeneratedId(project, 'fd')
  const folderName = uniqueName(
    input.kind === 'thread' ? 'Thread' : 'Flutes',
    project.featureFolders.map((entry) => entry.name),
  )
  const folder: FeatureFolder = { id: folderId, name: folderName, collapsed: false, section: 'features' }

  const definitions: Record<string, FeatureDefinition> = {}
  const instances: FeatureInstance[] = []
  const createdNames: string[] = []
  built.lines.forEach((line, index) => {
    const from = rotarySheetPoint(frame, line.alongStart, line.acrossStart)
    const to = rotarySheetPoint(frame, line.alongEnd, line.acrossEnd)
    const profile: SketchProfile = { start: from, segments: [{ type: 'line', to }], closed: false }
    const name = uniqueName(
      input.kind === 'thread' ? `${folderName} Start ${index + 1}` : `${folderName} Flute ${index + 1}`,
      [...project.features.map((feature) => feature.name), ...createdNames],
    )
    createdNames.push(name)
    const draft = normalizeFeatureZRange({
      id: nextUniqueGeneratedId(project, 'f'),
      name,
      kind: inferFeatureKind(profile),
      folderId,
      sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
      operation: 'line',
      authoringFace: 'around',
      // Around stores Top-like heights: the surface is `thickness`, the
      // centreline `thickness / 2`. Depth is measured down from the surface.
      z_top: thickness,
      z_bottom: thickness - input.depth,
      visible: true,
      locked: false,
    })
    const minted = createDefinitionForFeature(project, draft)
    definitions[minted.definitionId] = minted.definition
    instances.push(createFeatureInstance(draft, minted.definitionId))
  })

  const target: OperationTarget = { source: 'features', featureIds: instances.map((instance) => instance.id) }
  const operationId = nextUniqueGeneratedId(project, 'op')
  const template = defaultOperationForTarget(project, 'follow_line', 'rough', target, project.operations.length, {
    tool: defaultsTool,
    toolRef,
  })
  const operation: Operation = {
    ...template,
    id: operationId,
    name: uniqueName(`${folderName} Engrave`, project.operations.map((entry) => entry.name)),
    // A 'rough' Engrave takes the depth in stepdown passes; 'finish' would cut
    // it in a single pass regardless of stepdown.
    pass: 'rough',
    showToolpath: true,
    // A provisional Around setup is named here and made real by the store's
    // setup reconciler in this same write.
    setupId: activeSetup(project).id,
    target,
    toolRef,
    carveDepth: input.depth,
    maxCarveDepth: input.depth,
    stepdown: template.stepdown > 0 ? template.stepdown : input.depth,
  }

  const nextProject = syncFeatureTreeProject({
    ...project,
    tools: toolToAdd ? [...project.tools, toolToAdd] : project.tools,
    featureFolders: [...project.featureFolders, folder],
    features: [...project.features, ...instances],
    featureDefinitions: { ...project.featureDefinitions, ...definitions },
    featureTree: [...project.featureTree, { type: 'folder', folderId }],
    operations: [...project.operations, operation],
    meta: { ...project.meta, modified: new Date().toISOString() },
  })

  if (!isOperationTargetValid(nextProject, 'follow_line', target)
    || !targetAllowedInSetup(nextProject, target, nextProject.activeSetupId, 'follow_line')) {
    return { ok: false, reason: 'targetNotAllowed' }
  }

  const featureIds = instances.map((instance) => instance.id)
  return {
    ok: true,
    project: nextProject,
    selection: {
      ...selection,
      selectedFeatureId: featureIds[0],
      selectedFeatureIds: featureIds,
      selectedNode: { type: 'folder', folderId },
      mode: 'feature',
      activeControl: null,
      groupFolderId: null,
    },
    created: { ok: true, folderId, featureIds, operationId },
  }
}

/**
 * The store action. One history transition creates the folder, every line and
 * the Engrave operation (plus any imported V-bit). A refusal changes nothing:
 * no folder, no feature, no history entry.
 */
export function createAddRotaryPatternAction(
  set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
): ProjectStore['addRotaryPattern'] {
  return (input, libraryTools) => {
    const state = get()
    const planned = planRotaryPattern(state.project, state.selection, input, libraryTools ?? [])
    if (!planned.ok) return planned
    set((current) => ({
      project: planned.project,
      selection: planned.selection,
      history: {
        past: [...current.history.past, cloneProject(current.project)].slice(-100),
        future: [],
        transactionStart: null,
      },
    }))
    return planned.created
  }
}
