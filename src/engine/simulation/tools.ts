export function cutterSurfaceZ(
  toolType: 'flat_endmill',
  toolRadius: number,
  toolCenterZ: number,
  radialDistance: number,
): number | null {
  if (toolType !== 'flat_endmill') {
    return null
  }

  return radialDistance <= toolRadius + 1e-9 ? toolCenterZ : null
}
