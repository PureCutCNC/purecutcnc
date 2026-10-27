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
 * Framework-agnostic application machine library: the build's bundled
 * definitions plus the persistent **My Machines** list, with subscribe/notify
 * for React (`useMachineLibrary()` uses `useSyncExternalStore`) and
 * module-level accessors for the non-React call sites (project decode).
 *
 * Library mutations are application preferences: they never touch the project
 * store, never dirty a project, and never enter project undo history. A
 * project only ever holds its own embedded snapshot.
 *
 * Mirrors `src/i18n/store.ts`.
 */

import { writeToStorage } from '../hooks/useLocalStorageState'
import type { MachineDefinition } from '../engine/gcode/types'
import type { MachineLoadDiagnostic } from './diagnostics'
import {
  combineMachineLibrary,
  mergeCustomMachineList,
  validateCustomMachine,
  withCollisionSafeId,
  type MachineValidationResult,
} from './registry'
import {
  CUSTOM_MACHINES_STORAGE_KEY,
  customMachinesCodec,
  readStoredCustomMachines,
} from './storage'

export interface MachineLibrarySnapshot {
  /** User-owned definitions, in insertion order. */
  customMachines: readonly MachineDefinition[]
  /** Bundled definitions from the current build, then My Machines. */
  library: readonly MachineDefinition[]
  /**
   * What reading or merging the library reported (#1119): consolidated
   * duplicates, re-keyed records, and unreadable envelopes. The machine
   * manager shows these instead of letting a record vanish silently.
   */
  diagnostics: readonly MachineLoadDiagnostic[]
  /**
   * True when the stored envelope could not be read losslessly. Every write is
   * refused while it is set, so the original bytes are preserved.
   */
  writeBlocked: boolean
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function buildSnapshot(
  customMachines: readonly MachineDefinition[],
  diagnostics: readonly MachineLoadDiagnostic[] = [],
  writeBlocked = false,
): MachineLibrarySnapshot {
  return { customMachines, library: combineMachineLibrary(customMachines), diagnostics, writeBlocked }
}

let storageRef: StorageLike | null = null
let snapshot: MachineLibrarySnapshot = buildSnapshot([])
let libraryDiagnostics: readonly MachineLoadDiagnostic[] = []
let libraryWriteBlocked = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function commit(
  customMachines: readonly MachineDefinition[],
  diagnostics: readonly MachineLoadDiagnostic[] = [],
): boolean {
  if (libraryWriteBlocked) return false
  writeToStorage(storageRef, CUSTOM_MACHINES_STORAGE_KEY, [...customMachines], customMachinesCodec)
  if (diagnostics.length > 0) libraryDiagnostics = [...libraryDiagnostics, ...diagnostics]
  snapshot = buildSnapshot(customMachines, libraryDiagnostics, libraryWriteBlocked)
  notify()
  return true
}

/** A library that cannot be read is preserved unchanged; writes are refused. */
function blockedWriteError(): MachineValidationResult {
  return {
    error: 'The stored machine library could not be read, so it is preserved unchanged and new library changes cannot be saved until the problem is resolved.',
  }
}

/**
 * Initialize from persisted preferences (called by `bootstrapMachineLibrary()`
 * before React renders; tests pass a fake storage or null). Unreadable or
 * invalid records are skipped, never fatal.
 */
export function initMachineLibrary(storage: StorageLike | null): void {
  storageRef = storage
  const stored = readStoredCustomMachines(storage)
  libraryWriteBlocked = stored.unreadable
  libraryDiagnostics = stored.diagnostics
  snapshot = buildSnapshot(stored.machines, stored.diagnostics, stored.unreadable)
  notify()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getMachineLibrarySnapshot(): MachineLibrarySnapshot {
  return snapshot
}

/**
 * Add or replace a custom machine. An existing ID updates in place (keeping
 * list order); a new definition is appended with a collision-safe ID. Returns
 * the definition as stored, or the validation error.
 */
export function saveCustomMachine(definition: MachineDefinition): MachineValidationResult {
  if (libraryWriteBlocked) return blockedWriteError()
  const validated = validateCustomMachine(definition)
  if (validated.error !== undefined) return validated

  const index = snapshot.customMachines.findIndex((entry) => entry.id === validated.ok.id)
  if (index === -1) {
    const stored = withCollisionSafeId(validated.ok, snapshot.customMachines)
    commit([...snapshot.customMachines, stored])
    return { ok: stored }
  }
  const customMachines = snapshot.customMachines.map((entry) => (
    entry.id === validated.ok.id ? validated.ok : entry
  ))
  commit(customMachines)
  return { ok: validated.ok }
}

/**
 * Delete a custom machine. Projects that embed a snapshot of it keep working
 * — the embedded copy is authoritative, so removal only affects the library.
 */
export function deleteCustomMachine(id: string): void {
  if (libraryWriteBlocked) return
  if (!snapshot.customMachines.some((entry) => entry.id === id)) return
  commit(snapshot.customMachines.filter((entry) => entry.id !== id))
}

/**
 * Fold definitions rescued from a legacy project library into My Machines.
 * Semantically identical entries are skipped and ID collisions are re-keyed,
 * so opening the same legacy project twice adds nothing the second time.
 * Returns the definitions that were actually added.
 */
export function mergeCustomMachines(
  candidates: readonly MachineDefinition[],
): { added: MachineDefinition[], diagnostics: MachineLoadDiagnostic[] } {
  if (candidates.length === 0) return { added: [], diagnostics: [] }
  if (libraryWriteBlocked) {
    return {
      added: [],
      diagnostics: [{
        severity: 'error',
        kind: 'machine-library-blocked',
        message: 'A machine from this project was not added to My Machines because the stored library could not be read and is preserved unchanged.',
      }],
    }
  }
  const { machines, added, diagnostics } = mergeCustomMachineList(snapshot.customMachines, candidates)
  if (added.length === 0) {
    if (diagnostics.length > 0) {
      libraryDiagnostics = [...libraryDiagnostics, ...diagnostics]
      snapshot = buildSnapshot(snapshot.customMachines, libraryDiagnostics, libraryWriteBlocked)
      notify()
    }
    return { added, diagnostics }
  }
  commit(machines, diagnostics)
  return { added, diagnostics }
}

/** Test seam: reset module state between unit tests. */
export function resetMachineLibraryForTests(): void {
  storageRef = null
  libraryDiagnostics = []
  libraryWriteBlocked = false
  snapshot = buildSnapshot([])
  listeners.clear()
}
