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
 * The bolt-shaped rotary fixture for #1155's cache slice (rn-b): a Ø20 mm bar
 * along X, a Ø4 Turn over along 10..50, and a 4 mm across-flats Hex standing on
 * the bar over along 10..20, all built in code by the canned-solid planner
 * (`planRotarySolid`, the same planner the dialogs use) — no fixture file.
 *
 * Why these numbers and not rn-a's bolt (Ø10 Turn, 15 across-flats Hex, Ø4
 * tool): the footprint this slice replaces was the target's own box grown by
 * two tool diameters, and on a Ø10 Turn in a Ø20 bar with a Ø4 tool that grown
 * box already spans the whole bar (and more). The distinction the footprint has
 * to make — a neighbour across the bar that the target's box misses — then
 * cannot be seen at all. A narrow Turn with a small tool is the case the handoff
 * names ("a narrow imported target"), and it is the case where the old box
 * leaves a real hole: the Hex moved across the bar is material the around
 * operation must not cut, and the old footprint reports the cached path valid.
 *
 * The Hex is placed inside the blank by the planner (centred on the bar axis)
 * and moved afterwards by its instance transform, which is the same 2D
 * placement an imported model carries.
 */

import { defaultTool, newProject, roundStock } from '../types/project'
import type { Operation, Project } from '../types/project'
import type { SelectionState } from '../store/types'
import { defaultOperationForTarget } from '../store/helpers/operationDefaults'
import { planRotarySolid } from '../store/helpers/rotarySolids'

/** The planner's selection argument, unused by the canned-solid path. */
const EMPTY_SELECTION = {
  mode: 'feature', selectedFeatureId: null, selectedFeatureIds: [], selectedTabIds: [],
  selectedClampIds: [], selectedNode: null, hoveredFeatureId: null, sketchEditTool: null,
  activeControl: null, groupFolderId: null,
} as unknown as SelectionState

export const BOLT_BAR_DIAMETER = 20
export const BOLT_BAR_LENGTH = 60
export const BOLT_TURN_START = 10
export const BOLT_TURN_LENGTH = 40
export const BOLT_TURN_DIAMETER = 4
export const BOLT_HEX_START = 10
export const BOLT_HEX_LENGTH = 10
export const BOLT_HEX_ACROSS_FLATS = 4
export const BOLT_TOOL_DIAMETER = 0.5
export const BOLT_STEPOVER_RATIO = 0.5
export const BOLT_STEPDOWN = 2
export const BOLT_TOOL_ID = 'bolt-flat'

export interface RotaryBoltFixture {
  readonly project: Project
  readonly turnId: string
  readonly hexId: string
}

export interface RotaryBoltOptions {
  /** Across-the-bar offset applied to the Hex after planning, mm. */
  readonly hexAcross?: number
  /** Leave the Hex out entirely, for a no-neighbour baseline. */
  readonly withoutHex?: boolean
  /**
   * A second Turn, wholly outside the first one's along span, standing on the
   * bare bar. Added at planning time so it is part of both snapshots.
   */
  readonly farTurnStart?: number
}

/**
 * The bolt project, with the Around setup active and one Ø0.5 flat endmill.
 * `features` holds the Turn (index 0) and then the Hex, so a caller can update
 * either row immutably the way the store does.
 */
export function rotaryBoltFixture(options: RotaryBoltOptions = {}): RotaryBoltFixture {
  const base = newProject('rn-b rotary bolt', 'mm')
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 40
  base.stock = roundStock(BOLT_BAR_DIAMETER, BOLT_BAR_LENGTH, 'x')
  base.tools = [{
    ...defaultTool('mm', 1), id: BOLT_TOOL_ID, name: 'Flat 0.5', type: 'flat_endmill',
    diameter: BOLT_TOOL_DIAMETER, defaultStepover: BOLT_STEPOVER_RATIO, defaultStepdown: BOLT_STEPDOWN,
  }]
  base.setups.push({
    ...base.setups[0], id: 'around', name: 'Around', kind: 'around',
    orientation: { axis: 'x', angleDeg: 0 },
  })
  base.activeSetupId = 'around'

  const turn = planRotarySolid(base, EMPTY_SELECTION, {
    kind: 'turn', start: BOLT_TURN_START, length: BOLT_TURN_LENGTH, diameter: BOLT_TURN_DIAMETER,
  })
  if (!turn.ok) throw new Error(`the bolt's Turn must plan: ${turn.reason}`)
  const turnId = turn.created.featureId

  let project = turn.project
  let hexId = ''
  if (!options.withoutHex) {
    const hex = planRotarySolid(project, EMPTY_SELECTION, {
      kind: 'polygon', start: BOLT_HEX_START, length: BOLT_HEX_LENGTH, sides: 6,
      acrossFlats: BOLT_HEX_ACROSS_FLATS, rotationDeg: 0,
    })
    if (!hex.ok) throw new Error(`the bolt's Hex must plan: ${hex.reason}`)
    project = hex.project
    hexId = hex.created.featureId
    if (options.hexAcross !== undefined) project = translateAcrossBar(project, hexId, options.hexAcross)
  }

  if (options.farTurnStart !== undefined) {
    const far = planRotarySolid(project, EMPTY_SELECTION, {
      kind: 'turn', start: options.farTurnStart, length: 4, diameter: BOLT_TURN_DIAMETER,
    })
    if (!far.ok) throw new Error(`the far Turn must plan: ${far.reason}`)
    project = far.project
  }

  return { project, turnId, hexId }
}

/**
 * The same project with one feature translated across the bar — the placement
 * direction, the transform's `f` term for a bar along X. Immutable, exactly as
 * the store rewrites a row.
 */
export function translateAcrossBar(project: Project, featureId: string, delta: number): Project {
  return {
    ...project,
    features: project.features.map((feature) => (feature.id === featureId
      ? { ...feature, transform: { ...feature.transform, f: feature.transform.f + delta } }
      : feature)),
  }
}

/** A rotary rough or finish on `featureIds` in the Around setup. */
export function rotaryBoltOperation(
  project: Project,
  featureIds: readonly string[],
  kind: 'rotary_rough' | 'rotary_finish',
): Operation {
  return {
    ...defaultOperationForTarget(
      project, kind, kind === 'rotary_rough' ? 'rough' : 'finish',
      { source: 'features', featureIds: [...featureIds] }, project.operations.length + 1,
    ),
    setupId: 'around',
    toolRef: BOLT_TOOL_ID,
    stepover: BOLT_STEPOVER_RATIO,
    stepdown: BOLT_STEPDOWN,
    stockToLeaveRadial: kind === 'rotary_rough' ? 0.4 : 0,
  }
}
