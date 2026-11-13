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
 * Reads are defensive but no longer silent (#1119). One corrupt record cannot
 * take down the app, but it is now reported and the envelope is preserved:
 *
 * - a template-invalid definition is structurally valid and is kept; export
 *   refuses it until it is fixed;
 * - a duplicate or bundled-ID record is re-keyed and kept rather than dropped;
 * - an unreadable envelope (bad JSON, a future schema version, an
 *   unrepresentable entry) loads whatever is readable, reports every problem
 *   with its index, and marks the library **write-blocked** so the stored bytes
 *   are never overwritten by a partial in-memory list.
 */

import type { StorageCodec } from '../hooks/useLocalStorageState'
import type { MachineDefinition } from '../engine/gcode/types'
import type { MachineLoadDiagnostic } from './diagnostics'
import {
  allocateMachineId,
  isBundledMachineId,
  machinesFunctionallyEqual,
  validateCustomMachine,
} from './registry'

export const CUSTOM_MACHINES_STORAGE_KEY = 'purecutcnc.machines.customMachines'
export const CUSTOM_MACHINES_SCHEMA_VERSION = 1

interface CustomMachinesEnvelope {
  schemaVersion: typeof CUSTOM_MACHINES_SCHEMA_VERSION
  machines: MachineDefinition[]
}

/** What reading the stored library found, including what could not be read. */
export interface StoredCustomMachines {
  machines: MachineDefinition[]
  diagnostics: MachineLoadDiagnostic[]
  /**
   * True when the stored envelope was not understood losslessly. The caller
   * must keep the stored bytes and refuse every write until it is resolved.
   */
  unreadable: boolean
}

function emptyLibrary(): StoredCustomMachines {
  return { machines: [], diagnostics: [], unreadable: false }
}

function unreadableLibrary(message: string, index?: number): StoredCustomMachines {
  return {
    machines: [],
    diagnostics: [{ severity: 'error', kind: 'machine-library-unreadable', index, message }],
    unreadable: true,
  }
}

/**
 * Parse a stored custom-machine list. Invalid entries, duplicate IDs, and
 * entries claiming a reserved bundled ID are no longer dropped silently
 * (#1119): a template-invalid definition is kept, a duplicate is consolidated
 * with a report, and a colliding or reserved ID is re-keyed and kept. An
 * envelope from a future schema version, or an entry that cannot be read
 * structurally, yields the readable machines plus `unreadable: true` so the
 * caller preserves the stored bytes and blocks writes.
 */
export function sanitizeStoredCustomMachines(raw: unknown): StoredCustomMachines {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return unreadableLibrary('The stored machine library is not an object, so it was left untouched.')
  }
  const envelope = raw as Record<string, unknown>
  if (envelope.schemaVersion !== CUSTOM_MACHINES_SCHEMA_VERSION) {
    return unreadableLibrary(
      `The stored machine library uses schema version ${String(envelope.schemaVersion ?? '(missing)')}, which this build does not understand. It was left untouched.`,
    )
  }
  if (!Array.isArray(envelope.machines)) {
    return unreadableLibrary('The stored machine library has no machine list, so it was left untouched.')
  }

  const machines: MachineDefinition[] = []
  const diagnostics: MachineLoadDiagnostic[] = []
  let unreadable = false
  for (const [index, entry] of envelope.machines.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      unreadable = true
      diagnostics.push({
        severity: 'error',
        kind: 'machine-library-unreadable',
        index,
        message: `Stored machine ${index + 1} is not an object; the library was left untouched.`,
      })
      continue
    }
    const record = entry as Record<string, unknown>
    const rawId = typeof record.id === 'string' ? record.id.trim() : ''
    const rawName = typeof record.name === 'string' ? record.name.trim() : ''
    let candidate: Record<string, unknown> = record
    // A stored record can never shadow a bundled definition, but re-keying it
    // keeps the user's machine instead of dropping it (#1119).
    if (rawId !== '' && isBundledMachineId(rawId)) {
      candidate = { ...record, id: allocateMachineId(rawName || rawId, new Set(machines.map((machine) => machine.id))) }
    }
    const validated = validateCustomMachine(candidate)
    if (validated.error !== undefined) {
      unreadable = true
      diagnostics.push({
        severity: 'error',
        kind: 'machine-library-unreadable',
        index,
        machineId: rawId || undefined,
        machineName: rawName || undefined,
        message: `Stored machine ${index + 1} could not be read (${validated.error}); the library was left untouched.`,
      })
      continue
    }
    const definition = validated.ok
    const existing = machines.find((machine) => machine.id === definition.id)
    if (existing !== undefined) {
      if (machinesFunctionallyEqual(existing, definition)) {
        diagnostics.push({
          severity: 'info',
          kind: 'machine-consolidated',
          index,
          machineId: definition.id,
          machineName: definition.name,
          message: `Stored machine "${definition.name}" appears more than once; the duplicate was merged.`,
        })
        continue
      }
      const rekeyed = validateCustomMachine({
        ...candidate,
        id: allocateMachineId(definition.name, new Set(machines.map((machine) => machine.id))),
      })
      if (rekeyed.error !== undefined) {
        unreadable = true
        diagnostics.push({
          severity: 'error',
          kind: 'machine-library-unreadable',
          index,
          machineId: definition.id,
          machineName: definition.name,
          message: `Stored machine ${index + 1} could not be re-keyed (${rekeyed.error}); the library was left untouched.`,
        })
        continue
      }
      diagnostics.push({
        severity: 'warning',
        kind: 'machine-rekeyed',
        index,
        machineId: definition.id,
        machineName: definition.name,
        nextId: rekeyed.ok.id,
        message: `Stored machine "${definition.name}" was kept as "${rekeyed.ok.id}" because "${definition.id}" is already used.`,
      })
      machines.push(rekeyed.ok)
      continue
    }
    if (definition.id !== rawId) {
      diagnostics.push({
        severity: 'warning',
        kind: 'machine-rekeyed',
        index,
        machineId: rawId || undefined,
        machineName: definition.name,
        nextId: definition.id,
        message: `Stored machine "${definition.name}" was kept as "${definition.id}" because "${rawId}" is a built-in id.`,
      })
    }
    machines.push(definition)
  }
  return { machines, diagnostics, unreadable }
}

export const customMachinesCodec: StorageCodec<MachineDefinition[]> = {
  serialize: (value) => {
    const envelope: CustomMachinesEnvelope = {
      schemaVersion: CUSTOM_MACHINES_SCHEMA_VERSION,
      machines: value,
    }
    return JSON.stringify(envelope)
  },
  deserialize: (raw) => sanitizeStoredCustomMachines(JSON.parse(raw)).machines,
}

/**
 * Read the stored library, reporting what could not be read instead of
 * treating it as empty (#1119). A storage that throws, or bytes that are not
 * JSON, are `unreadable` so the caller preserves them and blocks writes.
 */
export function readStoredCustomMachines(storage: Pick<Storage, 'getItem'> | null): StoredCustomMachines {
  if (!storage) return emptyLibrary()
  let stored: string | null
  try {
    stored = storage.getItem(CUSTOM_MACHINES_STORAGE_KEY)
  } catch {
    return unreadableLibrary('The machine library could not be read from storage, so it was left untouched.')
  }
  if (stored === null) return emptyLibrary()
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return unreadableLibrary('The machine library is not valid JSON, so it was left untouched.')
  }
  return sanitizeStoredCustomMachines(parsed)
}
