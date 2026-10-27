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
 * The feature tree's "no effect" warnings (issue #1112 N, decision 12).
 *
 * The analysis runs in a worker after edits settle; this hook owns the client
 * for the tree's lifetime and returns the latest feature ids that should show
 * the warning. The previous set stays while a newer analysis is pending, and
 * the client drops any answer for an edit the user has already superseded.
 */

import { useEffect, useRef, useState } from 'react'
import type { Project } from '../../types/project'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { FeatureEffectClient } from './client'
import { buildEffectFeatures } from './effectInput'

const EMPTY: ReadonlySet<string> = new Set<string>()

export function useFeatureEffectWarnings(
  project: Project,
  features: readonly ResolvedSketchFeature[],
): ReadonlySet<string> {
  const [warnings, setWarnings] = useState<ReadonlySet<string>>(EMPTY)
  const clientRef = useRef<FeatureEffectClient | null>(null)

  useEffect(() => {
    const client = new FeatureEffectClient({ onResult: setWarnings })
    clientRef.current = client
    return () => {
      client.dispose()
      clientRef.current = null
    }
  }, [])

  useEffect(() => {
    clientRef.current?.request(() => buildEffectFeatures(project, features))
  }, [project, features])

  return warnings
}
