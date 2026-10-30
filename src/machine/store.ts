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

/**
 * Persist and adopt a new custom list. Returns false when the write did not
 * reach storage; in that case the in-memory snapshot is **not** changed either,
 * so a caller cannot mistake a list that will vanish on reload for a durable
 * one (#1119).
 */
function commit(
  customMachines: readonly MachineDefinition[],
  diagnostics: readonly MachineLoadDiagnostic[] = [],
): boolean {
  if (libraryWriteBlocked) return false
  const written = writeToStorage(storageRef, CUSTOM_MACHINES_STORAGE_KEY, [...customMachines], customMachinesCodec)
  if (!written) return false
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

/** A write that failed at the storage layer (quota, disabled storage). */
function storageWriteFailedDiagnostic(): MachineLoadDiagnostic {
  return {
    severity: 'error',
    kind: 'machine-library-write-failed',
    message: 'The machine library could not be written to browser storage, so the change was not saved. The library is unchanged from before the attempt.',
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
    if (!commit([...snapshot.customMachines, stored])) {
      return { error: storageWriteFailedDiagnostic().message }
    }
    return { ok: stored }
  }
  const customMachines = snapshot.customMachines.map((entry) => (
    entry.id === validated.ok.id ? validated.ok : entry
  ))
  if (!commit(customMachines)) return { error: storageWriteFailedDiagnostic().message }
  return { ok: validated.ok }
}

/** What a delete did, in a shape the UI can display without guessing. */
export interface MachineDeleteResult {
  ok: boolean
  /** True only when a record was actually removed from the library. */
  removed: boolean
  /** Why it did not happen, when `ok` is false. */
  error?: string
  /** The structured reason, for the machine manager (slice C). */
  diagnostic?: MachineLoadDiagnostic
}

/**
 * Delete a custom machine. Projects that embed a snapshot of it keep working
 * — the embedded copy is authoritative, so removal only affects the library.
 *
 * A refused write is reported, never silently treated as a successful delete
 * (#1119): the UI must not tell the user a machine is gone when it is not.
 */
export function deleteCustomMachine(id: string): MachineDeleteResult {
  if (libraryWriteBlocked) {
    const diagnostic: MachineLoadDiagnostic = {
      severity: 'error',
      kind: 'machine-library-blocked',
      machineId: id,
      message: `"${id}" was not deleted because the stored machine library could not be read and is preserved unchanged.`,
    }
    return { ok: false, removed: false, error: diagnostic.message, diagnostic }
  }
  if (!snapshot.customMachines.some((entry) => entry.id === id)) {
    return { ok: true, removed: false }
  }
  if (!commit(snapshot.customMachines.filter((entry) => entry.id !== id))) {
    const diagnostic = storageWriteFailedDiagnostic()
    return { ok: false, removed: false, error: diagnostic.message, diagnostic }
  }
  return { ok: true, removed: true }
}

/** What a library merge did, including whether the result will survive a reload. */
export interface MachineMergeResult {
  added: MachineDefinition[]
  diagnostics: MachineLoadDiagnostic[]
  /**
   * True when every candidate is now durably in My Machines — added, or
   * already present functionally identically. False when the library was
   * write-blocked, storage refused the write, or an entry was rejected.
   */
  durable: boolean
}

/**
 * Fold definitions rescued from a legacy project library into My Machines.
 * Semantically identical entries are skipped and ID collisions are re-keyed,
 * so opening the same legacy project twice adds nothing the second time.
 * Returns the definitions that were actually added, and whether the result is
 * durable: a caller may only compact the source away on `durable` (#1119).
 */
export function mergeCustomMachines(
  candidates: readonly MachineDefinition[],
): MachineMergeResult {
  if (candidates.length === 0) return { added: [], diagnostics: [], durable: true }
  if (libraryWriteBlocked) {
    return {
      added: [],
      diagnostics: [{
        severity: 'error',
        kind: 'machine-library-blocked',
        message: 'A machine from this project was not added to My Machines because the stored library could not be read and is preserved unchanged.',
      }],
      durable: false,
    }
  }
  const { machines, added, diagnostics } = mergeCustomMachineList(snapshot.customMachines, candidates)
  const rejected = diagnostics.some((diagnostic) => diagnostic.severity === 'error')
  if (added.length === 0) {
    if (diagnostics.length > 0) {
      libraryDiagnostics = [...libraryDiagnostics, ...diagnostics]
      snapshot = buildSnapshot(snapshot.customMachines, libraryDiagnostics, libraryWriteBlocked)
      notify()
    }
    return { added, diagnostics, durable: !rejected }
  }
  if (!commit(machines, diagnostics)) {
    return {
      added: [],
      diagnostics: [...diagnostics, storageWriteFailedDiagnostic()],
      durable: false,
    }
  }
  return { added, diagnostics, durable: !rejected }
}

/**
 * The rescue seam the project store hands to `normalizeProject`: compacting
 * any unselected machine is allowed only when this reports `durable`.
 */
export function rescueMachinesToLibrary(
  definitions: readonly MachineDefinition[],
): { durable: boolean, diagnostics: MachineLoadDiagnostic[] } {
  const result = mergeCustomMachines(definitions)
  return { durable: result.durable, diagnostics: result.diagnostics }
}

/** Test seam: reset module state between unit tests. */
export function resetMachineLibraryForTests(): void {
  storageRef = null
  libraryDiagnostics = []
  libraryWriteBlocked = false
  snapshot = buildSnapshot([])
  listeners.clear()
}
