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

import { orientationForFace } from '../engine/setupOrientation'
import type { SetupFace } from '../types/project'
import { findSetupForFace } from './helpers/activeFace'
import { useProjectStore } from './projectStore'

/**
 * Put the workspace on `face` (issue #945). The workspace face switch is the
 * one place the UI changes the active setup. A project that has never been
 * machined from below gets its Bottom setup here, flipped about X — a real,
 * undoable edit; the switch itself stays a view choice. The setup's own
 * properties (flip axis, registration, notes) are edited in the CAM panel.
 * Returns false when the face cannot be shown.
 */
export function switchWorkspaceFace(face: SetupFace): boolean {
  const store = useProjectStore.getState()
  const setupId = findSetupForFace(store.project, face)?.id
    ?? store.createSetup({ orientation: orientationForFace(face, 'x') })
  if (!setupId) return false
  useProjectStore.getState().setActiveSetup(setupId)
  return true
}
