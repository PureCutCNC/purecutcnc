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

import { useMemo } from 'react'
import {
  classifyImportShapes,
  importDxfString,
  importSvgString,
  type ClassifiedShape,
  type ClassificationResult,
  type ImportGeometryMode,
  type ImportedShape,
  type ImportSourceType,
} from '../../import'
import type { Units } from '../../utils/units'

export interface UseImportGeometryAnalysisInput {
  sourceType: ImportSourceType | undefined
  fileText: string | undefined
  fileName: string
  sourceUnits: Units | ''
  targetUnits: Units
  joinTolerance: number
  allowCrossLayerJoins: boolean
  /** The current selected-layers Set. Pass the Set reference itself so
   *  changes are detected even when the size stays the same. */
  selectedLayers: Set<string>
  geometryMode: ImportGeometryMode
  sourceUnitScale: number
  hasDxfLayers: boolean
}

export interface UseImportGeometryAnalysisOutput {
  cachedShapes: ImportedShape[] | null
  /** Parse warnings (empty array when there are none). */
  parseWarnings: string[]
  /** Concise parse error message, or null when the last parse succeeded. */
  parseError: string | null
  classification: {
    classified: ClassifiedShape[]
    result: ClassificationResult
  } | null
}

interface ParseCache {
  shapes: ImportedShape[] | null
  warnings: string[]
  error: string | null
}

const EMPTY_PARSE: ParseCache = { shapes: null, warnings: [], error: null }

/**
 * Owns SVG/DXF parse caching and mode classification for the import dialog.
 *
 * Parsing reruns only when file text or source-level parse inputs change
 * (units, tolerance, cross-layer setting, selected layers). A mode-only
 * change reclassifies cached shapes without reparsing.
 *
 * The `selectedLayers` Set reference is used directly in the dependency
 * array — not just `.size` — so switching between two layers with the same
 * count triggers a fresh parse.
 */
export function useImportGeometryAnalysis(
  input: UseImportGeometryAnalysisInput,
): UseImportGeometryAnalysisOutput {
  const {
    sourceType,
    fileText,
    fileName,
    sourceUnits,
    targetUnits,
    joinTolerance,
    allowCrossLayerJoins,
    selectedLayers,
    geometryMode,
    sourceUnitScale,
    hasDxfLayers,
  } = input

  const isSvgDxf = sourceType === 'svg' || sourceType === 'dxf'

  // ── parse (memoised — synchronous, pure computation) ──────────────────
  const parseCache: ParseCache = useMemo(() => {
    if (!isSvgDxf || !fileText || !sourceUnits) {
      return EMPTY_PARSE
    }

    try {
      if (sourceType === 'svg') {
        const result = importSvgString(fileText, {
          fileName,
          targetUnits,
          sourceUnits,
          sourceUnitScale,
        })
        return { shapes: result.shapes, warnings: result.warnings, error: null }
      }

      const layerFilter = hasDxfLayers ? [...selectedLayers] : null
      const result = importDxfString(fileText, {
        fileName,
        targetUnits,
        sourceUnits,
        sourceUnitScale,
        joinTolerance:
          Number.isFinite(joinTolerance) && joinTolerance >= 0
            ? joinTolerance
            : undefined,
        allowCrossLayerJoins,
        layerFilter,
      })
      return { shapes: result.shapes, warnings: result.warnings, error: null }
    } catch (err) {
      return {
        shapes: null,
        warnings: [],
        error:
          err instanceof Error
            ? err.message
            : 'Failed to parse geometry file.',
      }
    }
  }, [
    isSvgDxf,
    fileText,
    sourceUnits,
    sourceType,
    joinTolerance,
    allowCrossLayerJoins,
    selectedLayers,
    targetUnits,
    hasDxfLayers,
    fileName,
    sourceUnitScale,
  ])

  const cachedShapes = parseCache.shapes
  const parseWarnings = parseCache.warnings
  const parseError = parseCache.error

  // ── classification (memoised — mode-only changes never reparse) ──────
  const classification = useMemo(() => {
    if (
      !cachedShapes ||
      !sourceType ||
      (sourceType !== 'svg' && sourceType !== 'dxf')
    ) {
      return null
    }
    return classifyImportShapes(cachedShapes, geometryMode, sourceType)
  }, [cachedShapes, geometryMode, sourceType])

  return {
    cachedShapes,
    parseWarnings,
    parseError,
    classification,
  }
}
