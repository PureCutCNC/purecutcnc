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
 * The provisional setup (issue #945): how the workspace looks at a stock face
 * the project has no setup for, without changing the project.
 *
 * Looking is `activeSetupId` naming a provisional id. Nothing else is stored:
 * `Project.setups` stays exactly the document, so a project that was only
 * looked at has no undo entry, is not dirty, and saves and exports as it did
 * (a file never carries the id — saving normalises it back to a real setup).
 * The setup becomes real, in the same undo step as the edit that needs it,
 * when the first content is created on that face: a feature drawn there, an
 * operation added there, or one of the setup's own properties edited.
 */

import { orientationForFace, setupFace } from '../../engine/setupOrientation'
import { uniqueName } from '../../import'
import type { MachiningSetup, Project, SetupFace } from '../../types/project'
import { nextUniqueGeneratedId } from './ids'
import { syncProjectSetups } from './setups'

const PROVISIONAL_SETUPS: Readonly<Record<SetupFace, MachiningSetup>> = {
  top: {
    id: 'provisional-top',
    name: 'Top',
    orientation: orientationForFace('top', 'x'),
    indexing: 'manual',
    registration: [],
    notes: '',
    operationIds: [],
  },
  bottom: {
    id: 'provisional-bottom',
    name: 'Bottom',
    orientation: orientationForFace('bottom', 'x'),
    indexing: 'manual',
    registration: [],
    notes: '',
    operationIds: [],
  },
}

/** The id `activeSetupId` holds while the workspace looks at `face` without a setup for it. */
export function provisionalSetupId(face: SetupFace): string {
  return PROVISIONAL_SETUPS[face].id
}

/**
 * The setup the workspace is on when `activeSetupId` names none of the
 * project's own: the default setup for the face being looked at, or undefined
 * when the id is simply unknown. Always the same object for a face, so a
 * store selector returning it stays stable.
 */
export function provisionalSetupFor(
  project: Pick<Project, 'setups' | 'activeSetupId'>,
): MachiningSetup | undefined {
  if (project.setups.some((setup) => setup.id === project.activeSetupId)) return undefined
  return Object.values(PROVISIONAL_SETUPS).find((setup) => setup.id === project.activeSetupId)
}

/** True while the workspace looks at a face the project has no setup for. */
export function isProvisionalSetupActive(project: Pick<Project, 'setups' | 'activeSetupId'>): boolean {
  return provisionalSetupFor(project) !== undefined
}

/**
 * Make the provisional setup the workspace is on a real one, keeping the
 * workspace on it. Returns the project unchanged, with `id` as given, when
 * `id` is not the provisional setup in view.
 */
export function realizeProvisionalSetup(
  project: Project,
  id: string = project.activeSetupId,
): { project: Project; id: string } {
  const provisional = provisionalSetupFor(project)
  if (!provisional || provisional.id !== id) return { project, id }
  const realId = nextUniqueGeneratedId(project, 'su')
  const setup: MachiningSetup = {
    ...provisional,
    id: realId,
    name: uniqueName(provisional.name, project.setups.map((entry) => entry.name)),
    orientation: { ...provisional.orientation },
    registration: [],
    operationIds: [],
  }
  return {
    project: { ...project, setups: [...project.setups, setup], activeSetupId: realId },
    id: realId,
  }
}

/** True when `next` differs from `previous` in more than the face being looked at. */
function isProjectEdit(previous: Project, next: Project): boolean {
  const before = previous as unknown as Record<string, unknown>
  const after = next as unknown as Record<string, unknown>
  return Object.keys(after).some((key) => key !== 'activeSetupId' && after[key] !== before[key])
}

/**
 * Whether the project holds content for the provisional face: a feature
 * drawn on it, or an operation that would join the setup in view.
 */
function hasContentFor(project: Project, provisional: MachiningSetup): boolean {
  const face = setupFace(provisional)
  if (project.features.some((feature) => (feature.authoringFace ?? 'top') === face)) return true
  const setupIds = new Set(project.setups.map((setup) => setup.id))
  const listed = new Set(project.setups.flatMap((setup) => setup.operationIds))
  return project.operations.some((operation) => (
    !(operation.setupId !== undefined && setupIds.has(operation.setupId)) && !listed.has(operation.id)
  ))
}

/**
 * {@link syncProjectSetups} for a project the store is about to hold, where
 * `activeSetupId` may name a provisional setup. `previous` is the project the
 * write started from.
 *
 * - A setup for the face in view arrived some other way (a redo, an explicit
 *   create): the workspace moves onto it.
 * - The write is an edit and the face in view now has content: the setup
 *   becomes real within that same write, so one undo removes both.
 * - Otherwise the project is reconciled as the document it is and the
 *   workspace stays on the face in view.
 *
 * Returns `next` itself when nothing needed changing.
 */
export function syncWorkspaceSetups(previous: Project, next: Project): Project {
  const provisional = provisionalSetupFor(next)
  if (!provisional) return syncProjectSetups(next)
  const face = setupFace(provisional)
  const real = next.setups.find((setup) => setupFace(setup) === face)
  if (real) return syncProjectSetups({ ...next, activeSetupId: real.id })
  if (isProjectEdit(previous, next) && hasContentFor(next, provisional)) {
    return syncProjectSetups(realizeProvisionalSetup(next).project)
  }
  const synced = syncProjectSetups(next)
  return synced.operations === next.operations && synced.setups === next.setups
    ? next
    : { ...synced, activeSetupId: provisional.id }
}

/**
 * Put a restored snapshot on the face the workspace is looking at. The
 * snapshot keeps the setup in view when it has it, takes another setup for
 * that face when it does not, and is looked at provisionally when it has
 * none — so undoing the edit that made a setup real leaves the workspace
 * where it is instead of turning the stock back over.
 */
export function keepWorkspaceFace(restored: Project, current: Project): Project {
  if (restored.setups.some((setup) => setup.id === current.activeSetupId)) {
    return restored.activeSetupId === current.activeSetupId
      ? restored
      : { ...restored, activeSetupId: current.activeSetupId }
  }
  const active = current.setups.find((setup) => setup.id === current.activeSetupId) ?? provisionalSetupFor(current)
  if (!active) return restored
  const face = setupFace(active)
  const sameFace = restored.setups.find((setup) => setupFace(setup) === face)
  const activeSetupId = sameFace?.id ?? provisionalSetupId(face)
  return restored.activeSetupId === activeSetupId ? restored : { ...restored, activeSetupId }
}
