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
 * What the machine manager must say about the stored library itself (#1119).
 *
 * A library that could not be read is preserved byte-for-byte and refuses every
 * write, but the manager used to look normal: the list was empty and pressing
 * Save or Remove appeared to work. These notices give the state and its reason
 * a place on screen, and deduplicate the reports the store appends on every
 * failed attempt.
 */

import type { MachineLoadDiagnostic } from '../../machine/diagnostics'
import type { MachineLibrarySnapshot } from '../../machine/store'

export type MachineLibraryNotice =
  | {
    severity: 'error'
    /** A known state, translated by the dialog. */
    messageKey: 'dialogs.machineManager.libraryWriteBlocked'
  }
  | {
    severity: 'warning' | 'error'
    /** The diagnostic's own sentence (it already names the reason). */
    message: string
    kind: MachineLoadDiagnostic['kind']
  }

export function machineLibraryNotices(
  snapshot: Pick<MachineLibrarySnapshot, 'writeBlocked' | 'diagnostics'>,
): MachineLibraryNotice[] {
  const notices: MachineLibraryNotice[] = []
  if (snapshot.writeBlocked) {
    notices.push({ severity: 'error', messageKey: 'dialogs.machineManager.libraryWriteBlocked' })
  }
  // A repeated failed write appends the same report each time; one line is
  // enough, and the reason is in the sentence.
  const seen = new Set<string>()
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.severity === 'info' || seen.has(diagnostic.message)) continue
    seen.add(diagnostic.message)
    notices.push({ severity: diagnostic.severity, message: diagnostic.message, kind: diagnostic.kind })
  }
  return notices
}
