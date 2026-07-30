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

import { useSyncExternalStore } from 'react'
import { getMachineLibrarySnapshot, subscribe, type MachineLibrarySnapshot } from './store'

/**
 * React binding for the application machine library. The store lives at
 * module level so `bootstrapMachineLibrary()` and project decode share it;
 * components re-render when My Machines changes without any project state
 * being touched.
 *
 * Pair it with the pure `machineSnapshotStatus()` from `./registry` to derive
 * how the project's embedded snapshot relates to the current library.
 */
export function useMachineLibrary(): MachineLibrarySnapshot {
  return useSyncExternalStore(subscribe, getMachineLibrarySnapshot, getMachineLibrarySnapshot)
}
