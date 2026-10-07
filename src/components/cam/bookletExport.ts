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

// The operation booklet export as a sequence of named stages (issue #924).
//
// A heavy operation took long enough to export that the single "Building
// booklet..." line read as nothing happening. Each stage is now reported
// before it starts, and the stages that block the main thread (drawing the
// snapshot, building the PDF) wait for one paint first, so the text the user
// reads is the step actually running.

import type { ToolpathResult } from '../../engine/toolpaths'
import type { NormalizedTool } from '../../engine/toolpaths/types'
import type { Operation, Project } from '../../types/project'
import { formatProgramNumber, projectExportsPerSetup, setupProgramNumber } from '../../engine/gcode/setupPrograms'
import { setupForOperation } from '../../engine/setupOrientation'

export type BookletStage = 'toolpath' | 'snapshot' | 'pdf' | 'saving'

/** The CAM-panel message for each stage. */
export const BOOKLET_STAGE_MESSAGE_KEYS = {
  toolpath: 'cam.booklet.stage.toolpath',
  snapshot: 'cam.booklet.stage.snapshot',
  pdf: 'cam.booklet.stage.pdf',
  saving: 'cam.booklet.stage.saving',
} as const satisfies Record<BookletStage, string>

export interface BookletExportSteps {
  requestToolpath: () => Promise<ToolpathResult | null>
  normalizeTool: () => NormalizedTool | null
  renderSnapshot: (toolpath: ToolpathResult) => Promise<Uint8Array>
  buildPdf: (input: { tool: NormalizedTool | null; toolpath: ToolpathResult; snapshotPng: Uint8Array }) => Promise<Uint8Array>
  /** Resolves with the saved path, or null when the user cancelled the dialog. */
  save: (pdfBytes: Uint8Array) => Promise<string | null>
  /** Lets the stage message paint before a step that holds the main thread. */
  yieldToPaint: () => Promise<void>
}

export type BookletExportOutcome =
  | { status: 'exported'; path: string }
  | { status: 'cancelled' }
  | { status: 'noToolpath' }

export async function runBookletExport(
  steps: BookletExportSteps,
  onStage: (stage: BookletStage) => void,
): Promise<BookletExportOutcome> {
  onStage('toolpath')
  const toolpath = await steps.requestToolpath()
  if (!toolpath) return { status: 'noToolpath' }

  onStage('snapshot')
  await steps.yieldToPaint()
  const snapshotPng = await steps.renderSnapshot(toolpath)

  onStage('pdf')
  await steps.yieldToPaint()
  const pdfBytes = await steps.buildPdf({ tool: steps.normalizeTool(), toolpath, snapshotPng })

  onStage('saving')
  const path = await steps.save(pdfBytes)
  return path ? { status: 'exported', path } : { status: 'cancelled' }
}

/**
 * Resolve after the browser has painted once. Double rAF: the first callback
 * runs before the current paint, the second in the next frame. Falls back to a
 * macrotask where there is no rAF.
 */
export function afterNextPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
      return
    }
    setTimeout(resolve, 0)
  })
}

/**
 * Project and operation names made safe for the saved file name. In a project
 * with more than one setup the operation's setup sits between them, numbered
 * as its program is, so a folder of booklets sorts by setup (issue #946).
 */
export function bookletFileName(project: Project, operation: Operation): string {
  const safe = (name: string, fallback: string): string =>
    name.trim().replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || fallback
  const setup = projectExportsPerSetup(project) ? setupForOperation(project, operation) : null
  const setupPart = setup
    ? `${formatProgramNumber(setupProgramNumber(project, setup.id))}_${safe(setup.name, 'setup')}_`
    : ''
  return `${safe(project.meta.name, 'project')}_${setupPart}${safe(operation.name, 'operation')}_booklet`
}
