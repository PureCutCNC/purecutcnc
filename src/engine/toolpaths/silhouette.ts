/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { Point } from '../../types/project'

const DEFAULT_MIN_RELATIVE_SILHOUETTE_AREA = 1e-5

function polygonArea(points: Point[]): number {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return area / 2
}

export function significantSilhouettePaths(
  paths: Point[][],
  minRelativeArea = DEFAULT_MIN_RELATIVE_SILHOUETTE_AREA,
): Point[][] {
  const candidates = paths
    .filter((path) => path.length >= 3)
    .map((path) => ({
      path,
      area: Math.abs(polygonArea(path)),
    }))
    .filter((entry) => entry.area > 0)

  if (candidates.length === 0) return []

  const maxArea = Math.max(...candidates.map((entry) => entry.area))
  const minArea = maxArea * minRelativeArea
  return candidates
    .filter((entry) => entry.area >= minArea)
    .map((entry) => entry.path)
}
