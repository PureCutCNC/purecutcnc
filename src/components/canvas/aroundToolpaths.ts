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
 * Which toolpaths the Sketch preview draws, and in which coordinates
 * (issue #395 slice D2).
 *
 * A flat face and the Around sheet share no plane: an operation's passes are
 * drawn only while the workspace is on the setup that cuts them. An Around
 * operation's stored toolpath is wrapped — every point on the bar's centreline
 * with its rotary angle — so it is unwrapped back onto the sheet before it is
 * drawn, exactly as `engine/aroundFrame.ts` defines the inverse.
 *
 * A square blank is unwrapped through the same nominal reference cylinder
 * (#1016 C2-U1V): its tool path is generated against the real blank but drawn
 * on the sheet the frame maps, so the angle, the true pivot and the tool tips
 * all come back unchanged.
 */

import { aroundFrame, unwrapToolpath } from '../../engine/aroundFrame'
import type { AroundFrame } from '../../engine/aroundFrame'
import { activeFace } from '../../store/helpers/activeFace'
import { setupFace } from '../../engine/setupOrientation'
import { isBarStock } from '../../types/barStock'
import type { MachiningSetup, Operation, Project } from '../../types/project'
import type { ToolpathResult } from '../../engine/toolpaths/types'

/**
 * The toolpath as the active face draws it, or null when it belongs to another
 * face. An Around toolpath comes back on the sheet.
 *
 * Only Around is filtered against the flat faces: a wrapped path would draw as
 * a single line along the bar's centreline on Top or Bottom, and the sheet
 * shares no plane with either. Top and Bottom keep drawing each other's paths,
 * muted, as they did before (issue #947).
 */
export function toolpathForActiveFace(project: Project, toolpath: ToolpathResult): ToolpathResult | null {
  const operation = project.operations.find((entry) => entry.id === toolpath.operationId)
  if (!operation) return toolpath
  const setup = setupOfOperation(project, operation)
  if (!setup) return toolpath
  const face = setupFace(setup)
  if (face === 'around') {
    if (activeFace(project) !== 'around') return null
    // An Around operation needs a bar to be unwrapped against; without one the
    // project is refused elsewhere, and drawing the wrapped path would be a lie.
    if (!isBarStock(project.stock)) return toolpath
    return unwrapForDisplay(toolpath, aroundFrame(project.stock))
  }
  return activeFace(project) === 'around' ? null : toolpath
}

/** The operation's setup, or null when it names none that exists. */
function setupOfOperation(
  project: Pick<Project, 'setups'>,
  operation: Pick<Operation, 'id' | 'setupId'>,
): MachiningSetup | null {
  if (operation.setupId === undefined) return project.setups[0] ?? null
  return project.setups.find((setup) => setup.id === operation.setupId) ?? null
}

/**
 * The unwrapped result is cached by the wrapped one: both renderers (Canvas
 * and GPU) key their per-toolpath caches on object identity, so producing a
 * fresh object every frame would rebuild every buffer every frame. The frame
 * signature catches a stock the wrapped path was not produced against — on a
 * square blank the nominal radius and circumference are what move a point, so
 * they are part of the key.
 */
const unwrapCache = new WeakMap<ToolpathResult, { frame: string; result: ToolpathResult }>()

function unwrapForDisplay(toolpath: ToolpathResult, frame: AroundFrame): ToolpathResult {
  const signature = `${frame.axis}:${frame.zero}:${frame.sheetStart}:${frame.circumference}:${frame.centre}:${frame.radius}`
  const cached = unwrapCache.get(toolpath)
  if (cached && cached.frame === signature) return cached.result
  const result = unwrapToolpath(toolpath, frame)
  unwrapCache.set(toolpath, { frame: signature, result })
  return result
}
