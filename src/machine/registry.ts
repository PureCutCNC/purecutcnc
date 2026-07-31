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
 * Application machine registry. Bundled definitions are code-owned and always
 * come from the current build; custom definitions ("My Machines") are
 * user-owned application preferences validated against the same schema.
 *
 * A `.camj` project never stores this library — it embeds only the single
 * definition selected for that project (see `machineSnapshotStatus`), so a
 * library edit or an application upgrade can never silently change a
 * project's exported G-code.
 *
 * Mirrors `src/theme/registry.ts` and `src/i18n/registry.ts`.
 */

import { BUNDLED_DEFINITIONS } from '../engine/gcode/definitions'
import { MachineDefinitionSchema, type MachineDefinition } from '../engine/gcode/types'

export const MACHINE_NAME_MAX_LENGTH = 60

/** Bundled machine IDs are reserved: a custom definition can never claim one. */
export function bundledMachineIds(): Set<string> {
  return new Set(BUNDLED_DEFINITIONS.map((definition) => definition.id))
}

export function isBundledMachineId(id: string): boolean {
  return BUNDLED_DEFINITIONS.some((definition) => definition.id === id)
}

/** Fresh copies of the build's bundled definitions, always `builtin: true`. */
export function bundledMachines(): MachineDefinition[] {
  return BUNDLED_DEFINITIONS.map((definition) => ({ ...structuredClone(definition), builtin: true }))
}

export function getBundledMachine(id: string): MachineDefinition | undefined {
  return bundledMachines().find((definition) => definition.id === id)
}

export type MachineValidationResult =
  | { ok: MachineDefinition, error?: undefined }
  | { ok?: undefined, error: string }

/**
 * Validate untrusted custom-machine data (storage, import, editor). The
 * `builtin` flag is always forced to `false` — ownership is decided here, not
 * by the incoming payload — and bundled IDs are rejected so a stored record
 * can never shadow a definition the build owns.
 */
export function validateCustomMachine(input: unknown): MachineValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'Machine definition must be a JSON object.' }
  }
  const parsed = MachineDefinitionSchema.safeParse({ ...(input as Record<string, unknown>), builtin: false })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.')
    return { error: path ? `${path}: ${issue.message}` : (issue?.message ?? 'Invalid machine definition.') }
  }
  const definition = parsed.data
  const id = definition.id.trim()
  if (id === '') {
    return { error: 'Machine definition is missing a valid "id".' }
  }
  if (isBundledMachineId(id)) {
    return { error: `"${id}" is a built-in machine ID and cannot be used by a custom machine.` }
  }
  const name = definition.name.trim()
  if (name === '') {
    return { error: 'Machine definition is missing a display "name".' }
  }
  if (name.length > MACHINE_NAME_MAX_LENGTH) {
    return { error: `Machine name is longer than ${MACHINE_NAME_MAX_LENGTH} characters.` }
  }
  return { ok: { ...definition, id, name, builtin: false } }
}

/**
 * Canonical form of the fields that actually drive G-code output. `builtin`
 * is ownership metadata, not machine behavior, so it is excluded — otherwise
 * a project snapshot would always look "different" from its library twin.
 */
function functionalFields(definition: MachineDefinition): Omit<MachineDefinition, 'builtin'> {
  const { builtin: _builtin, ...rest } = definition
  return rest
}

/**
 * Stable comparison key for a definition, ignoring storage metadata. Input is
 * re-validated so schema defaults are filled in and two definitions that
 * differ only in omitted-vs-defaulted fields compare equal.
 */
export function machineFingerprint(definition: MachineDefinition): string {
  const parsed = MachineDefinitionSchema.safeParse(definition)
  return JSON.stringify(functionalFields(parsed.success ? parsed.data : definition))
}

/** True when two definitions would produce identical G-code behavior. */
export function machinesFunctionallyEqual(a: MachineDefinition, b: MachineDefinition): boolean {
  return machineFingerprint(a) === machineFingerprint(b)
}

/**
 * The top-level definition fields that differ between two definitions, for
 * showing the user *what* an available update would change before they accept
 * it. Storage metadata (`builtin`) is excluded, as in the fingerprint.
 */
export function machineFieldDifferences(a: MachineDefinition, b: MachineDefinition): string[] {
  const left = functionalFields(a) as Record<string, unknown>
  const right = functionalFields(b) as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys]
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .sort()
}

/** Turn a machine name into a URL-safe ID slug (lowercase, hyphens). */
export function slugFromMachineName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
}

/**
 * Allocate a machine ID that collides with neither `existingIds` nor a
 * reserved bundled ID.
 */
export function allocateMachineId(name: string, existingIds: ReadonlySet<string>): string {
  const base = slugFromMachineName(name) || 'custom-machine'
  const taken = (candidate: string) => existingIds.has(candidate) || isBundledMachineId(candidate)
  let candidate = base
  let n = 2
  while (taken(candidate)) {
    candidate = `${base}-${n}`
    n += 1
  }
  return candidate
}

/** A unique "Name (copy)"/"Name (copy 2)" style name for a duplicate. */
export function duplicateMachineName(sourceName: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map((entry) => entry.toLowerCase()))
  const base = `${sourceName} (copy)`.slice(0, MACHINE_NAME_MAX_LENGTH)
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`
    const candidate = `${sourceName} (copy)`.slice(0, MACHINE_NAME_MAX_LENGTH - suffix.length) + suffix
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * Duplicate any definition (bundled or custom) into a new editable custom
 * definition with a fresh, collision-safe ID.
 */
export function duplicateMachineAsCustom(
  source: MachineDefinition,
  existing: readonly MachineDefinition[],
): MachineDefinition {
  const name = duplicateMachineName(source.name, existing.map((definition) => definition.name))
  const id = allocateMachineId(name, new Set(existing.map((definition) => definition.id)))
  return MachineDefinitionSchema.parse({ ...structuredClone(source), id, name, builtin: false })
}

/**
 * The complete library a picker shows: the build's bundled definitions first,
 * then My Machines in insertion order.
 */
export function combineMachineLibrary(customMachines: readonly MachineDefinition[]): MachineDefinition[] {
  return [...bundledMachines(), ...customMachines.map((definition) => structuredClone(definition))]
}

export function findMachine(
  library: readonly MachineDefinition[],
  id: string | null | undefined,
): MachineDefinition | null {
  if (!id) return null
  return library.find((definition) => definition.id === id) ?? null
}

/**
 * How a project's embedded snapshot relates to the current application
 * library. `update-available` is advisory only — replacing the snapshot is
 * always an explicit user action.
 */
export type MachineSnapshotStatus =
  | { kind: 'none', library?: undefined }
  | { kind: 'in-sync', library: MachineDefinition }
  | { kind: 'update-available', library: MachineDefinition }
  | { kind: 'not-in-library', library?: undefined }

export function machineSnapshotStatus(
  embedded: MachineDefinition | null,
  library: readonly MachineDefinition[],
): MachineSnapshotStatus {
  if (!embedded) return { kind: 'none' }
  const match = findMachine(library, embedded.id)
  if (!match) return { kind: 'not-in-library' }
  return machinesFunctionallyEqual(embedded, match)
    ? { kind: 'in-sync', library: match }
    : { kind: 'update-available', library: match }
}

/**
 * Parse an exported machine JSON file. The on-disk shape is a bare
 * `MachineDefinition` (what "Export machine" has always written), so files
 * exported by older builds keep importing. An imported machine always
 * receives a collision-safe ID against the current library.
 */
export function parseMachineImport(
  json: string,
  existing: readonly MachineDefinition[],
): MachineValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { error: 'Not a valid JSON file.' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Machine file must contain a JSON object.' }
  }
  const record = parsed as Record<string, unknown>
  const rawId = typeof record.id === 'string' ? record.id.trim() : ''
  const rawName = typeof record.name === 'string' ? record.name.trim() : ''
  // A bundled ID is reserved, so re-key the import rather than rejecting an
  // otherwise valid file outright — re-exporting a built-in and importing it
  // back is the documented way to start from a bundled definition.
  const id = rawId !== '' && !isBundledMachineId(rawId)
    ? rawId
    : allocateMachineId(rawName || rawId, new Set(existing.map((entry) => entry.id)))
  const validated = validateCustomMachine({ ...record, id })
  if (validated.error !== undefined) return validated
  return { ok: withCollisionSafeId(validated.ok, existing) }
}

/** Serialize a definition for "Export machine" (bare definition JSON). */
export function serializeMachineExport(definition: MachineDefinition): string {
  const { builtin: _builtin, ...exported } = definition
  return JSON.stringify(exported, null, 2)
}

/**
 * Give a definition an ID that is free in `existing` (and not reserved by a
 * bundled machine), keeping its own ID when that ID is already free.
 */
export function withCollisionSafeId(
  definition: MachineDefinition,
  existing: readonly MachineDefinition[],
): MachineDefinition {
  const existingIds = new Set(existing.map((entry) => entry.id))
  if (definition.id !== '' && !existingIds.has(definition.id) && !isBundledMachineId(definition.id)) {
    return definition
  }
  return { ...definition, id: allocateMachineId(definition.name || definition.id, existingIds) }
}

/**
 * Fold candidate definitions (legacy project libraries) into an existing
 * custom list: semantically identical entries are skipped, and an entry whose
 * ID collides with a different definition is re-keyed instead of overwriting.
 */
export function mergeCustomMachineList(
  existing: readonly MachineDefinition[],
  candidates: readonly MachineDefinition[],
): { machines: MachineDefinition[], added: MachineDefinition[] } {
  const machines = [...existing]
  const added: MachineDefinition[] = []
  for (const candidate of candidates) {
    const validated = validateCustomMachine(candidate)
    if (validated.error !== undefined) continue
    if (machines.some((entry) => machinesFunctionallyEqual(entry, validated.ok))) continue
    const stored = withCollisionSafeId(validated.ok, machines)
    machines.push(stored)
    added.push(stored)
  }
  return { machines, added }
}
