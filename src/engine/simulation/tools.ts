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
