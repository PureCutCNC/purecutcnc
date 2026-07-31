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
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function buildSnapshot(customMachines: readonly MachineDefinition[]): MachineLibrarySnapshot {
  return { customMachines, library: combineMachineLibrary(customMachines) }
}

let storageRef: StorageLike | null = null
let snapshot: MachineLibrarySnapshot = buildSnapshot([])
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function commit(customMachines: readonly MachineDefinition[]): void {
  writeToStorage(storageRef, CUSTOM_MACHINES_STORAGE_KEY, [...customMachines], customMachinesCodec)
  snapshot = buildSnapshot(customMachines)
  notify()
}

/**
 * Initialize from persisted preferences (called by `bootstrapMachineLibrary()`
 * before React renders; tests pass a fake storage or null). Unreadable or
 * invalid records are skipped, never fatal.
 */
export function initMachineLibrary(storage: StorageLike | null): void {
  storageRef = storage
  snapshot = buildSnapshot(readStoredCustomMachines(storage))
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
  if (!snapshot.customMachines.some((entry) => entry.id === id)) return
  commit(snapshot.customMachines.filter((entry) => entry.id !== id))
}

/**
 * Fold definitions rescued from a legacy project library into My Machines.
 * Semantically identical entries are skipped and ID collisions are re-keyed,
 * so opening the same legacy project twice adds nothing the second time.
 * Returns the definitions that were actually added.
 */
export function mergeCustomMachines(candidates: readonly MachineDefinition[]): MachineDefinition[] {
  if (candidates.length === 0) return []
  const { machines, added } = mergeCustomMachineList(snapshot.customMachines, candidates)
  if (added.length === 0) return []
  commit(machines)
  return added
}

/** Test seam: reset module state between unit tests. */
export function resetMachineLibraryForTests(): void {
  storageRef = null
  snapshot = buildSnapshot([])
  listeners.clear()
}
