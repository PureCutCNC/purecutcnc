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
 * Structured machine diagnostics for project load and the machine library
 * (#1119).
 *
 * Every path that used to drop a machine silently now either keeps it or says
 * what it did: a template-invalid definition is retained and reported, an
 * unselected definition rescued into My Machines is reported, a colliding id
 * that had to be re-keyed is reported, and a file whose machine list cannot be
 * understood is refused atomically with an indexed diagnostic. The messages are
 * data for the UI (slice C) — the load-warning string is built from them rather
 * than duplicating the wording.
 */

import type { MachineTemplateDiagnostic } from '../engine/gcode/templateRules'

export type MachineLoadDiagnosticKind =
  /** The selected definition still breaks a template rule; it was kept and export is blocked. */
  | 'machine-retained-invalid'
  /** A definition the file carried was moved into My Machines. */
  | 'machine-moved-to-library'
  /** A definition kept under a new id because its id was reserved or already taken. */
  | 'machine-rekeyed'
  /** A duplicate definition was folded into the one already kept. */
  | 'machine-consolidated'
  /** The file selected a machine it does not carry (or carries only structurally invalid). */
  | 'machine-selection-unresolved'
  /** An entry could not be read at all; a project load that would lose it is refused. */
  | 'machine-structural-error'
  /** The stored library envelope is unreadable or holds a structurally invalid entry. */
  | 'machine-library-unreadable'
  /** A library write was refused because the stored envelope is preserved unchanged. */
  | 'machine-library-blocked'
  /** A library write failed at the storage layer (quota, disabled storage). */
  | 'machine-library-write-failed'
  /** An unselected machine stayed in the project because its rescue did not become durable. */
  | 'machine-kept-in-project'

export interface MachineLoadDiagnostic {
  severity: 'info' | 'warning' | 'error'
  kind: MachineLoadDiagnosticKind
  /** One sentence, already suitable for the load-warning surface. */
  message: string
  /** Position in the file's or library's machine list, when the diagnostic is about one entry. */
  index?: number
  /** The id the definition had in the file. */
  machineId?: string
  machineName?: string
  /** The id the definition was kept under after rescue or re-keying. */
  nextId?: string
  /** The template diagnostics behind a retained-invalid report. */
  templateDiagnostics?: MachineTemplateDiagnostic[]
}

/**
 * A project load that cannot be performed losslessly. Thrown before any state
 * is replaced, so the original bytes and the current project stay untouched.
 */
export class MachineLoadError extends Error {
  readonly diagnostics: MachineLoadDiagnostic[]

  constructor(diagnostics: MachineLoadDiagnostic[]) {
    super(diagnostics[0]?.message ?? 'The project machine definition could not be read.')
    this.name = 'MachineLoadError'
    this.diagnostics = diagnostics
  }
}

/** Join diagnostics into the existing one-string load-warning surface. */
export function machineLoadWarning(diagnostics: readonly MachineLoadDiagnostic[]): string | null {
  const messages = diagnostics
    .filter((diagnostic) => diagnostic.severity !== 'info')
    .map((diagnostic) => diagnostic.message)
  return messages.length > 0 ? messages.join('\n\n') : null
}
