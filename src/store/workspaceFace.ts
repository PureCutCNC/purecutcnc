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

import type { SetupFace } from '../types/project'
import { useFaceViewStore } from './faceViewStore'
import { aroundUnavailableReason, activeFace, canChangeAuthoringFace, findSetupForFace, isFaceEditInProgress } from './helpers/activeFace'
import { provisionalSetupId } from './helpers/provisionalSetup'
import { useProjectStore } from './projectStore'

/**
 * Put the workspace on `face` (issue #945). The workspace face switch is the
 * one place the UI changes the active setup, and every caller — the header
 * control, a ghost row's "switch to edit" — goes through here, so the rules
 * have one home:
 *
 * - while a feature is being edited, moved or combined the face stays where
 *   it is, or the edit would land on a ghost;
 * - looking at a face is a view choice. A face the project has no setup for
 *   is shown provisionally; the project is not changed until something is
 *   created there (see `helpers/provisionalSetup.ts`).
 *
 * Returns false when the face cannot be shown right now.
 */
export function switchWorkspaceFace(face: SetupFace): boolean {
  const store = useProjectStore.getState()
  if (face === 'around' && aroundUnavailableReason(store.project) !== null) return false
  if (activeFace(store.project) === face) return true
  if (isFaceEditInProgress(store)) return false
  store.setActiveSetup(findSetupForFace(store.project, face)?.id ?? provisionalSetupId(face))
  return activeFace(useProjectStore.getState().project) === face
}

/**
 * Ask for the confirmation that moves features to the other face. Refused
 * while an edit is in progress, for the same reason the switch is: the
 * feature being edited would become a ghost under the edit. Refused too when
 * no requested feature goes through the whole stock (issue #1102 slice L):
 * a blind pocket has no second face to be measured from, so there is nothing
 * to confirm.
 */
export function requestAuthoringFaceChange(featureIds: readonly string[]): boolean {
  const store = useProjectStore.getState()
  if (isFaceEditInProgress(store)) return false
  const project = store.project
  if (activeFace(project) === 'around' || project.features.some((feature) => featureIds.includes(feature.id) && feature.authoringFace === 'around')) return false
  if (!project.features.some((feature) => featureIds.includes(feature.id) && canChangeAuthoringFace(project, feature))) return false
  useFaceViewStore.getState().requestFaceChange(featureIds)
  return true
}
