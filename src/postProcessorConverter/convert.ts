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

import type { MachineDefinition } from '../engine/gcode/types'
import type { ConversionReport, SourceFormatId } from './types'
import { buildMachineDefinition } from './draft'
import { ADAPTERS, detectAdapterByExtension, getAdapter } from './adapters/index'

export interface ConvertOptions {
  /** A specific format id, or 'auto' (default) to detect from the file extension. */
  format?: SourceFormatId | 'auto'
  name?: string
  vendor?: string
}

export interface ConvertResult {
  definition: MachineDefinition
  report: ConversionReport
}

/** Turns a filename (or any free-text name) into a URL-safe id slug. Kept
 *  local rather than imported from src/store: this module is a standalone
 *  CLI (issue #402) and shouldn't couple to the app's store layer for one
 *  trivial string transform. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'converted-machine'
  )
}

function baseNameWithoutExtension(filePath: string): string {
  const withoutDir = filePath.replace(/^.*[/\\]/, '')
  return withoutDir.replace(/\.[^.]+$/, '')
}

const SUPPORTED_EXTENSIONS = ADAPTERS.flatMap((a) => a.fileExtensions)

/**
 * Converts one vendor post-processor file's text into a validated
 * MachineDefinition plus its full conversion report. Never touches the
 * filesystem — callers (the CLI, tests) own reading the source and writing
 * results, so this stays trivially testable and reusable (e.g. by a future
 * in-app importer, which the issue explicitly scopes as "a later concern"
 * but shouldn't be blocked by this function living only inside the CLI).
 */
export function convertPostProcessor(fileText: string, filePath: string, options: ConvertOptions = {}): ConvertResult {
  const explicitFormat = options.format && options.format !== 'auto' ? options.format : undefined
  const adapter = explicitFormat ? getAdapter(explicitFormat) : detectAdapterByExtension(filePath)
  if (!adapter) {
    throw new Error(
      `Could not determine the source format for "${filePath}" from its extension. Supported extensions: ${SUPPORTED_EXTENSIONS.join(', ')}. Pass --format explicitly to override.`,
    )
  }

  const { overrides, findings, notes = [] } = adapter.convert(fileText, filePath)
  const name = options.name ?? baseNameWithoutExtension(filePath)
  const definition = buildMachineDefinition(overrides, {
    id: slugify(name),
    name,
    description: `Converted from ${baseNameWithoutExtension(filePath)} (${adapter.label}) by PureCutCNC's post-processor converter. Review the accompanying conversion report before use — see PROJECT.md's CNC safety contract.`,
    ...(options.vendor ? { vendor: options.vendor } : {}),
  })

  const report: ConversionReport = {
    sourceFormat: adapter.id,
    sourceFormatLabel: adapter.label,
    sourceFile: filePath,
    staticAnalysisOnly: adapter.staticAnalysisOnly,
    findings,
    notes,
  }

  return { definition, report }
}
