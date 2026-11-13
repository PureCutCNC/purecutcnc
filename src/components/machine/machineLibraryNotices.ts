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
 *
 * Every notice is a catalog key and its parameters, never a sentence built by
 * the machine layer: the manager translates it in the active language. The key
 * comes from `machineDiagnosticMessage`, the same mapper the open-time load
 * alert uses.
 */

import { machineDiagnosticMessage } from '../../i18n/machineDiagnosticText'
import type { MessageParams } from '../../i18n/catalog'
import type { MessageKey } from '../../i18n/locales/en'
import type { MachineLibrarySnapshot } from '../../machine/store'

export interface MachineLibraryNotice {
  severity: 'error' | 'warning'
  /** Catalog key resolved by the dialog in the active language. */
  messageKey: MessageKey
  params?: MessageParams
}

export function machineLibraryNotices(
  snapshot: Pick<MachineLibrarySnapshot, 'writeBlocked' | 'diagnostics'>,
): MachineLibraryNotice[] {
  const notices: MachineLibraryNotice[] = []
  if (snapshot.writeBlocked) {
    notices.push({ severity: 'error', messageKey: 'dialogs.machineManager.libraryWriteBlocked' })
  }
  // A repeated failed write appends the same report each time; one line is
  // enough. Deduplicate on the rendered message, not the English data sentence.
  const seen = new Set<string>()
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.severity === 'info') continue
    const message = machineDiagnosticMessage(diagnostic)
    const key = `${message.key}:${JSON.stringify(message.params ?? {})}`
    if (seen.has(key)) continue
    seen.add(key)
    notices.push({
      severity: diagnostic.severity,
      messageKey: message.key,
      params: message.params,
    })
  }
  return notices
}
