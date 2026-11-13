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

import { create } from 'zustand'

/** Transient canvas intent; the chosen point itself belongs to the project/history. */
export const usePlasmaStartPointPick = create<{
  request: { operationId: string; projectKey: number } | null
  begin: (operationId: string, projectKey: number) => void
  cancel: () => void
}>((set) => ({
  request: null,
  begin: (operationId, projectKey) => set({ request: { operationId, projectKey } }),
  cancel: () => set({ request: null }),
}))
