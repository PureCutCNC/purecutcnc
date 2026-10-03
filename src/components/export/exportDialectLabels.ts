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

import { resolveOutputDialect } from '../../engine/gcode/types'
import type { MachineDefinition, OutputDialect } from '../../engine/gcode/types'
import type { MessageKey } from '../../i18n/locales/en'

/**
 * The export wording that names the program's language (issue #953). A
 * ShopBot machine does not export G-code and its tool change is `C9`, not
 * `M6`, so these labels follow the machine's output dialect.
 */
export interface ExportDialectLabels {
  /** Export dialog title. */
  title: MessageKey
  /** The "emit tool changes" option, which names the command it writes. */
  emitToolChanges: MessageKey
  /** The exported layer in the exported-motion debug view. */
  exportedLayer: MessageKey
}

// A record over every dialect, so adding one without its wording does not compile.
const LABELS: Record<OutputDialect, ExportDialectLabels> = {
  gcode: {
    title: 'dialogs.export.title',
    emitToolChanges: 'dialogs.export.emitToolChanges',
    exportedLayer: 'dialogs.motionDebug.layerExported',
  },
  opensbp: {
    title: 'dialogs.export.titleOpensbp',
    emitToolChanges: 'dialogs.export.emitToolChangesOpensbp',
    exportedLayer: 'dialogs.motionDebug.layerExportedOpensbp',
  },
}

/** Labels for the machine being exported for; G-code wording when none is selected. */
export function exportDialectLabels(definition: MachineDefinition | null): ExportDialectLabels {
  return LABELS[definition ? resolveOutputDialect(definition) : 'gcode']
}
