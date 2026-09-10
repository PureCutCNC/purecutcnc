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

import { useCallback, useMemo, useState } from 'react'
import type { ToolpathResult } from '../engine/toolpaths/types'
import type { Operation } from '../types/project'
import { toolpathLevels } from './toolpathLevels'

interface Selection {
  operationId: string | null
  toolpath: ToolpathResult | null
  level: number | null
}

/**
 * View-only selection scoped to the exact generated result. A changed
 * operation/result derives All immediately, avoiding an effect-driven reset.
 */
export function useToolpathLevelSelection(operation: Operation | null, toolpath: ToolpathResult | null) {
  const operationId = operation?.id ?? null
  const [selection, setSelection] = useState<Selection>({ operationId: null, toolpath: null, level: null })
  const levels = useMemo(() => toolpath ? toolpathLevels(toolpath, operation) : [], [operation, toolpath])
  const level = selection.operationId === operationId && selection.toolpath === toolpath
    ? selection.level
    : null
  const setLevel = useCallback((nextLevel: number | null) => {
    setSelection({ operationId, toolpath, level: nextLevel })
  }, [operationId, toolpath])

  return { level, levels, setLevel }
}
