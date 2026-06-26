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

import type { MachineDefinition } from '../../engine/gcode/types'
import { validateMachineDefinition } from '../../engine/gcode/types'

/**
 * Focused-form representation of a MachineDefinition. Only the fields most
 * commonly edited by hobbyists appear here; everything else stays in the
 * Advanced (raw JSON) editor.
 */
export interface MachineFormData {
  name: string
  fileExtension: string
  mmCommand: string
  inchCommand: string
  header: string
  footer: string
  operationHeader: string
  toolChangeCommands: string
  floodOnCommand: string
  mistOnCommand: string
  coolantOffCommand: string
}

/** Split a string[] into a multi-line text (one entry per line). */
export function joinLines(lines: string[]): string {
  return lines.join('\n')
}

/** Split a multi-line text into a string[] (one line per entry). */
export function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
}

/** Extract focused form fields from a full MachineDefinition. */
export function toFormData(def: MachineDefinition): MachineFormData {
  return {
    name: def.name,
    fileExtension: def.fileExtension,
    mmCommand: def.units.mmCommand ?? '',
    inchCommand: def.units.inchCommand ?? '',
    header: joinLines(def.program.header),
    footer: joinLines(def.program.footer),
    operationHeader: joinLines(def.program.operationHeader),
    toolChangeCommands: joinLines(def.toolChange.commands),
    floodOnCommand: def.coolant?.floodOnCommand ?? '',
    mistOnCommand: def.coolant?.mistOnCommand ?? '',
    coolantOffCommand: def.coolant?.coolantOffCommand ?? '',
  }
}

/**
 * Merge focused form edits onto a full MachineDefinition, leaving all
 * non-form fields untouched.
 */
export function mergeFormData(
  def: MachineDefinition,
  form: MachineFormData,
): MachineDefinition {
  return {
    ...def,
    name: form.name,
    fileExtension: form.fileExtension,
    units: {
      ...def.units,
      mmCommand: form.mmCommand || null,
      inchCommand: form.inchCommand || null,
    },
    program: {
      ...def.program,
      header: splitLines(form.header),
      footer: splitLines(form.footer),
      operationHeader: splitLines(form.operationHeader),
    },
    toolChange: {
      ...def.toolChange,
      commands: splitLines(form.toolChangeCommands),
    },
    coolant: def.coolant
      ? {
          ...def.coolant,
          floodOnCommand: form.floodOnCommand,
          mistOnCommand: form.mistOnCommand,
          coolantOffCommand: form.coolantOffCommand,
        }
      : null,
  }
}

/**
 * Validate a MachineDefinition through Zod, returning the parsed definition
 * or a user-friendly error message. Returns `{ok: definition}` or
 * `{error: "..."}` — never throws.
 */
export function validateDef(
  data: unknown,
): { ok: MachineDefinition; error?: undefined } | { ok?: undefined; error: string } {
  try {
    const def = validateMachineDefinition(data)
    return { ok: def }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err)
    return { error: formatZodMessage(message) }
  }
}

/**
 * Try to make a Zod error message more user-friendly by unwrapping nested
 * issue arrays and stripping internal paths.
 */
function formatZodMessage(message: string): string {
  // Zod messages typically contain JSON-encoded issue arrays. Extract the
  // first useful sentence or return the raw message.
  const trimmed = message.trim()

  // Detect JSON-encoded issues array at the start.
  const issuesMatch = trimmed.match(/^\[[\s\S]*?\]/)
  if (!issuesMatch) {
    return trimmed
  }

  try {
    const issues: Array<{ message?: string; path?: Array<string | number> }> =
      JSON.parse(issuesMatch[0])
    if (!Array.isArray(issues) || issues.length === 0) {
      return trimmed
    }

    const first = issues[0]
    const path = first.path?.join('.') ?? ''
    const msg = first.message ?? 'Unknown validation error'
    return path ? `${msg} (at ${path})` : msg
  } catch {
    return trimmed
  }
}
