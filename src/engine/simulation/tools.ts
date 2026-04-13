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

import type { ToolType } from '../../types/project'

export function cutterSurfaceZ(
  toolType: ToolType,
  toolRadius: number,
  toolCenterZ: number,
  radialDistance: number,
  vBitAngle: number | null = null,
): number | null {
  if (radialDistance > toolRadius + 1e-9) {
    return null
  }

  switch (toolType) {
    case 'flat_endmill':
      return toolCenterZ
    case 'ball_endmill': {
      const clampedDistance = Math.max(0, Math.min(toolRadius, radialDistance))
      const dz = toolRadius - Math.sqrt(Math.max(0, toolRadius * toolRadius - clampedDistance * clampedDistance))
      return toolCenterZ + dz
    }
    case 'v_bit': {
      const includedAngle = Math.max(1, Math.min(179, vBitAngle ?? 60))
      const halfAngleRadians = (includedAngle * Math.PI) / 360
      const slope = Math.tan(halfAngleRadians)
      if (slope <= 1e-9) {
        return toolCenterZ
      }
      return toolCenterZ + radialDistance / slope
    }
    case 'drill':
      return toolCenterZ
  }
}
