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

import { useCallback, useState } from 'react'
import { revealOperationFace } from '../store/workspaceFace'

/**
 * The selected operation, and the one way it changes (issue #1112 F3).
 *
 * An operation is cut in the setup it belongs to, so selecting one that sits
 * on another face puts the workspace on that face first — the same call the
 * tree's face heading makes. That is what lets the header face control be the
 * simulation's only setup choice: selecting a Bottom operation switches the
 * face to Bottom, and the simulation follows it. A selection that arrives
 * while an edit is in progress keeps the face where it is, exactly as a face
 * heading click does.
 *
 * The selection itself stays cheap and app-local: every route that selects an
 * operation — the CAM panel's rows and its add/duplicate/rest actions, the
 * feature tree's quick operations — goes through this callback.
 */
export function useOperationSelection(): {
  selectedOperationId: string | null
  selectOperation: (operationId: string | null) => void
} {
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null)
  const selectOperation = useCallback((operationId: string | null) => {
    if (operationId !== null) revealOperationFace(operationId)
    setSelectedOperationId(operationId)
  }, [])
  return { selectedOperationId, selectOperation }
}
