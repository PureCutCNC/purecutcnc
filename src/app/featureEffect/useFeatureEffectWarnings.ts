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
 * for the tree's lifetime and returns the feature ids that should show the
 * warning. A result is tagged with the input snapshot it was computed from and
 * displayed only while that snapshot is still current, so moving a covering
 * feature away removes the ⚠ immediately instead of leaving the old verdict on
 * screen while the worker recomputes. The client drops an answer for an edit
 * the user has already superseded, and publishes an empty set when the worker
 * fails.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '../../types/project'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { FeatureEffectClient, type FeatureEffectSnapshot } from './client'
import { buildEffectFeatures } from './effectInput'

const EMPTY: ReadonlySet<string> = new Set<string>()

interface WarningResult {
  snapshot: FeatureEffectSnapshot
  warnings: ReadonlySet<string>
}

export function useFeatureEffectWarnings(
  project: Project,
  features: readonly ResolvedSketchFeature[],
): ReadonlySet<string> {
  // One opaque token per input pair. A result computed from an older token is
  // not the current tree, so it is hidden during render — before the debounce
  // even schedules the newer analysis.
  const snapshot = useMemo<FeatureEffectSnapshot>(
    () => ({ project, features }),
    [project, features],
  )
  const [result, setResult] = useState<WarningResult | null>(null)
  const clientRef = useRef<FeatureEffectClient | null>(null)

  useEffect(() => {
    const client = new FeatureEffectClient({
      onResult: (warnings, resultSnapshot) => setResult({ snapshot: resultSnapshot, warnings }),
    })
    clientRef.current = client
    return () => {
      client.dispose()
      clientRef.current = null
    }
  }, [])

  useEffect(() => {
    clientRef.current?.request(snapshot, () => buildEffectFeatures(project, features))
  }, [project, features, snapshot])

  return result && result.snapshot === snapshot ? result.warnings : EMPTY
}
