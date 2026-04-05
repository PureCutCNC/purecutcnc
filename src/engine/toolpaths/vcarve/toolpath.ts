import type { ToolpathMove, ToolpathPoint } from '../types'
import { pushRapidAndPlunge, retractToSafe } from '../pocket'
import { radiusToDepth } from './depth'
import type { SkeletonBranchPoint } from './types'

function branchPointToToolpathPoint(point: SkeletonBranchPoint, topZ: number, slope: number, maxDepth: number): ToolpathPoint {
  const depth = radiusToDepth(point.radius, slope, maxDepth)
  return {
    x: point.x,
    y: point.y,
    z: topZ - depth,
  }
}

export function radiusBranchesToToolpathMoves(
  branches: SkeletonBranchPoint[][],
  topZ: number,
  slope: number,
  maxDepth: number,
  safeZ: number,
): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  let currentPosition: ToolpathPoint | null = null

  for (const branch of branches) {
    if (branch.length === 0) {
      continue
    }
    const toolpathPoints = branch
      .map((point) => branchPointToToolpathPoint(point, topZ, slope, maxDepth))
      .filter((point) => Number.isFinite(point.z))

    if (toolpathPoints.length === 0) {
      continue
    }

    const safePosition = retractToSafe(moves, currentPosition, safeZ)
    currentPosition = pushRapidAndPlunge(moves, safePosition, toolpathPoints[0], safeZ)
    if (toolpathPoints.length === 1) {
      currentPosition = retractToSafe(moves, toolpathPoints[0], safeZ)
      continue
    }
    for (let index = 0; index < toolpathPoints.length - 1; index += 1) {
      moves.push({
        kind: 'cut',
        from: toolpathPoints[index],
        to: toolpathPoints[index + 1],
      })
    }
    currentPosition = toolpathPoints[toolpathPoints.length - 1]
    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  return moves
}
