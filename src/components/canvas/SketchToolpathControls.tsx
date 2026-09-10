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

import { ToolpathVisibilityPanel } from '../ToolpathVisibilityPanel'
import { pocketSlotFeedPercent } from '../../theme/palette'
import { feedColourLegendSteps, toolpathHasEngagementTelemetry, type ToolpathVisibility } from '../toolpathVisibility'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { Project } from '../../types/project'
import type { ToolpathRendererControl } from './toolpathRendererPreference'

interface SketchToolpathControlsProps {
  project: Project
  toolpaths: readonly ToolpathResult[]
  selectedOperationId: string | null
  visibility?: ToolpathVisibility
  onVisibilityChange?: (visibility: ToolpathVisibility) => void
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  renderer: ToolpathRendererControl
  level: number | null
  levelValues: readonly number[]
  onLevelChange?: (level: number | null) => void
}

/** Floating 2D controls, kept out of the canvas interaction shell. */
export function SketchToolpathControls({
  project, toolpaths, selectedOperationId, visibility, onVisibilityChange,
  expanded, onExpandedChange, renderer, level, levelValues, onLevelChange,
}: SketchToolpathControlsProps) {
  const selectedToolpath = toolpaths.find((toolpath) => toolpath.operationId === selectedOperationId) ?? null
  const legendSteps = selectedToolpath === null ? [] : feedColourLegendSteps(selectedToolpath, (() => {
    const percent = pocketSlotFeedPercent(project.operations.find((operation) => operation.id === selectedOperationId))
    return percent === null ? 1 : percent / 100
  })())

  if (!toolpaths.some((toolpath) => toolpath.moves.length > 0) || !visibility || !onVisibilityChange || expanded === undefined || !onExpandedChange) {
    return null
  }

  return (
    <ToolpathVisibilityPanel
      visibility={visibility}
      onChange={onVisibilityChange}
      className="sketch-toolpath-vis"
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      feedColoursDefault={toolpaths.some((toolpath) => toolpath.operationId === selectedOperationId && toolpathHasEngagementTelemetry(toolpath))}
      legendSteps={legendSteps}
      renderer={renderer}
      levelValues={levelValues}
      selectedLevel={level}
      onLevelChange={onLevelChange}
      units={project.meta.units}
    />
  )
}
