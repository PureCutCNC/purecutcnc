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
 * Machining-setup bookkeeping (issue #944): the strict decoder for the
 * `setups` a file carries, and the reconciler that keeps a project's setups,
 * its operations' `setupId` and the active setup consistent.
 *
 * Membership has one authority and order has one authority:
 *
 * - an operation belongs to the setup its `setupId` names;
 * - operations are cut in `Project.operations` order.
 *
 * `MachiningSetup.operationIds` is the per-setup view of those two facts and
 * is rewritten from them, so reordering, adding or deleting operations never
 * has to know setups exist.
 */

import { defaultTopSetup } from '../../types/project'
import type {
  MachiningSetup,
  Operation,
  Point,
  Project,
  RegistrationReference,
  RegistrationTarget,
  SetupFace,
  SetupOrientation,
} from '../../types/project'
import { isSupportedSetupOrientation } from '../../engine/setupOrientation'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decodePoint(value: unknown): Point | null {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y)
    ? { x: value.x as number, y: value.y as number }
    : null
}

function decodeRegistrationTarget(value: unknown): RegistrationTarget | null {
  if (!isRecord(value)) return null
  if (value.type === 'feature') {
    return typeof value.featureId === 'string' && value.featureId.length > 0
      ? { type: 'feature', featureId: value.featureId }
      : null
  }
  if (value.type === 'point') {
    const point = decodePoint(value.point)
    return point ? { type: 'point', point } : null
  }
  if (value.type === 'edge') {
    const start = decodePoint(value.start)
    const end = decodePoint(value.end)
    return start && end ? { type: 'edge', start, end } : null
  }
  return null
}

function decodeRegistration(setupId: string, value: unknown): RegistrationReference[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`Project setup ${setupId} has invalid registration references.`)
  const seen = new Set<string>()
  return value.map((raw): RegistrationReference => {
    const target = isRecord(raw) ? decodeRegistrationTarget(raw.target) : null
    if (!isRecord(raw)
      || typeof raw.id !== 'string' || raw.id.length === 0 || seen.has(raw.id)
      || (raw.kind !== 'dowel' && raw.kind !== 'fence' && raw.kind !== 'corner')
      || !target) {
      throw new Error(`Project setup ${setupId} has an invalid registration reference.`)
    }
    seen.add(raw.id)
    return { id: raw.id, kind: raw.kind, target }
  })
}

/** True for the two values a feature's `authoringFace` may hold. */
export function isSetupFace(value: unknown): value is SetupFace {
  return value === 'top' || value === 'bottom'
}

/**
 * Validate the `setups` a file carries. Returns null when the file has none —
 * the caller then migrates it to a single Top setup. A setup this build
 * cannot honour is an error rather than a fallback: a setup turned to an
 * angle we do not understand must not quietly load as Top and cut the wrong
 * face.
 */
export function decodeSetups(value: unknown): MachiningSetup[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) throw new Error('Failed to load project: invalid setups.')
  if (value.length === 0) return null
  const seen = new Set<string>()
  return value.map((raw): MachiningSetup => {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || typeof raw.name !== 'string') {
      throw new Error('Project setup has an invalid identity or name.')
    }
    if (seen.has(raw.id)) throw new Error(`Project setup ${raw.id} is defined more than once.`)
    seen.add(raw.id)
    const orientation = raw.orientation
    if (!isRecord(orientation) || !isSupportedSetupOrientation(orientation as unknown as SetupOrientation)) {
      throw new Error(`Project setup ${raw.id} has an orientation this version cannot machine. Only Top (0°) and Bottom (180° about X or Y) are supported.`)
    }
    if (raw.indexing !== 'manual') {
      throw new Error(`Project setup ${raw.id} has an indexing mode this version cannot machine.`)
    }
    if (raw.notes !== undefined && typeof raw.notes !== 'string') {
      throw new Error(`Project setup ${raw.id} has invalid notes.`)
    }
    if (raw.operationIds !== undefined
      && (!Array.isArray(raw.operationIds) || !raw.operationIds.every((id) => typeof id === 'string'))) {
      throw new Error(`Project setup ${raw.id} has invalid operation ids.`)
    }
    return {
      id: raw.id,
      name: raw.name,
      orientation: {
        axis: orientation.axis as SetupOrientation['axis'],
        // Normalises -0 to 0; the check above admits nothing but 0 and 180.
        angleDeg: orientation.angleDeg === 180 ? 180 : 0,
      },
      indexing: 'manual',
      registration: decodeRegistration(raw.id, raw.registration),
      notes: typeof raw.notes === 'string' ? raw.notes : '',
      operationIds: raw.operationIds === undefined ? [] : [...raw.operationIds as string[]],
    }
  })
}

/**
 * Refuse a file whose operation names a setup the file does not define. Only
 * a *missing* `setupId` is migrated; a dangling one would have to be guessed.
 */
export function assertOperationSetupsExist(operations: readonly Operation[], setups: readonly MachiningSetup[]): void {
  const setupIds = new Set(setups.map((setup) => setup.id))
  for (const operation of operations) {
    if (operation.setupId !== undefined && !setupIds.has(operation.setupId)) {
      throw new Error(`Project operation ${operation.id || '(unnamed)'} references a missing setup.`)
    }
  }
}

/**
 * The first setup turned exactly this way, if there is one. Used to place an
 * operation imported from another project, whose setup ids mean nothing here.
 * There is deliberately no fallback: a caller that finds none must add a
 * setup with this turn, never put the operation on another face.
 */
export function findSetupWithTurn(
  setups: readonly MachiningSetup[],
  orientation: SetupOrientation,
): MachiningSetup | undefined {
  return setups.find((setup) => (
    setup.orientation.angleDeg === orientation.angleDeg
    // The axis of a 0° turn says nothing; for any other it is part of the turn.
    && (orientation.angleDeg === 0 || setup.orientation.axis === orientation.axis)
  ))
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/**
 * Bring a project's setups into their invariant:
 *
 * - there is at least one setup — a project with none gets one Top setup;
 * - `activeSetupId` names a setup;
 * - every operation's `setupId` names a setup. One that names none joins the
 *   setup that already lists it, else the active setup — which is how every
 *   operation of a pre-setup file lands in the migrated Top setup, and how an
 *   operation created without one joins the setup the workspace is on;
 * - each setup's `operationIds` is exactly its operations in project order;
 * - a registration reference to a deleted feature is dropped.
 *
 * Idempotent, and returns the same object when nothing needed changing, so
 * it is safe to run after every store change.
 */
export function syncProjectSetups(project: Project): Project {
  const currentSetups: readonly MachiningSetup[] | undefined = project.setups
  const setups = currentSetups && currentSetups.length > 0 ? currentSetups : [defaultTopSetup()]
  const setupIds = new Set(setups.map((setup) => setup.id))
  const activeSetupId = setupIds.has(project.activeSetupId) ? project.activeSetupId : setups[0].id

  const listedIn = new Map<string, string>()
  for (const setup of setups) {
    for (const operationId of setup.operationIds) {
      if (!listedIn.has(operationId)) listedIn.set(operationId, setup.id)
    }
  }

  let operationsChanged = false
  const members = new Map<string, string[]>(setups.map((setup) => [setup.id, []]))
  const operations = project.operations.map((operation) => {
    const setupId = operation.setupId !== undefined && setupIds.has(operation.setupId)
      ? operation.setupId
      : listedIn.get(operation.id) ?? activeSetupId
    members.get(setupId)?.push(operation.id)
    if (setupId === operation.setupId) return operation
    operationsChanged = true
    return { ...operation, setupId }
  })

  // This runs after every store change, so the feature ids are only gathered
  // when some setup actually references a feature.
  let featureIds: Set<string> | null = null
  const featureExists = (id: string): boolean => {
    featureIds ??= new Set(project.features.map((feature) => feature.id))
    return featureIds.has(id)
  }
  let setupsChanged = setups !== currentSetups
  const nextSetups = setups.map((setup) => {
    const operationIds = members.get(setup.id) ?? []
    const registration = setup.registration.filter((reference) => (
      reference.target.type !== 'feature' || featureExists(reference.target.featureId)
    ))
    if (sameIds(operationIds, setup.operationIds) && registration.length === setup.registration.length) {
      return setup
    }
    setupsChanged = true
    return { ...setup, operationIds, registration }
  })

  if (!operationsChanged && !setupsChanged && activeSetupId === project.activeSetupId) return project
  return {
    ...project,
    operations: operationsChanged ? operations : project.operations,
    setups: setupsChanged ? nextSetups : project.setups,
    activeSetupId,
  }
}
