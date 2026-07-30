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
 * Persistence for the **My Machines** custom library. Custom machines are
 * application preferences, so they live in namespaced, versioned local
 * storage and never in `.camj` project data — saving a machine must not
 * dirty the current project or enter its undo history.
 *
 * Reads are defensive in the same way as `src/theme/selection.ts` and
 * `src/i18n/selection.ts`: one corrupt record is dropped individually rather
 * than taking down the whole machine library (or the app boot).
 */

import type { StorageCodec } from '../hooks/useLocalStorageState'
import type { MachineDefinition } from '../engine/gcode/types'
import { isBundledMachineId, validateCustomMachine } from './registry'

export const CUSTOM_MACHINES_STORAGE_KEY = 'purecutcnc.machines.customMachines'
export const CUSTOM_MACHINES_SCHEMA_VERSION = 1

interface CustomMachinesEnvelope {
  schemaVersion: typeof CUSTOM_MACHINES_SCHEMA_VERSION
  machines: MachineDefinition[]
}

/**
 * Parse a stored custom-machine list. Invalid entries, duplicate IDs, and
 * entries claiming a reserved bundled ID are dropped individually. An
 * envelope from a future schema version yields an empty list rather than a
 * partially-understood library.
 */
export function sanitizeStoredCustomMachines(raw: unknown): MachineDefinition[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
  const envelope = raw as Record<string, unknown>
  if (envelope.schemaVersion !== CUSTOM_MACHINES_SCHEMA_VERSION) return []
  if (!Array.isArray(envelope.machines)) return []

  const machines: MachineDefinition[] = []
  const seen = new Set<string>()
  for (const entry of envelope.machines) {
    const validated = validateCustomMachine(entry)
    if (validated.error !== undefined) continue
    if (seen.has(validated.ok.id) || isBundledMachineId(validated.ok.id)) continue
    seen.add(validated.ok.id)
    machines.push(validated.ok)
  }
  return machines
}

export const customMachinesCodec: StorageCodec<MachineDefinition[]> = {
  serialize: (value) => {
    const envelope: CustomMachinesEnvelope = {
      schemaVersion: CUSTOM_MACHINES_SCHEMA_VERSION,
      machines: value,
    }
    return JSON.stringify(envelope)
  },
  deserialize: (raw) => sanitizeStoredCustomMachines(JSON.parse(raw)),
}

export function readStoredCustomMachines(storage: Pick<Storage, 'getItem'> | null): MachineDefinition[] {
  if (!storage) return []
  try {
    const stored = storage.getItem(CUSTOM_MACHINES_STORAGE_KEY)
    if (stored === null) return []
    return customMachinesCodec.deserialize(stored)
  } catch {
    return []
  }
}
