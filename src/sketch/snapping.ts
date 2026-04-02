export type SnapMode =
  | 'grid'
  | 'point'
  | 'line'
  | 'midpoint'
  | 'center'
  | 'perpendicular'

export interface SnapSettings {
  enabled: boolean
  modes: SnapMode[]
  pixelRadius: number
}

export const SNAP_SETTINGS_STORAGE_KEY = 'camcam.snapSettings'

export const ALL_SNAP_MODES: SnapMode[] = [
  'grid',
  'point',
  'line',
  'midpoint',
  'center',
  'perpendicular',
]

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  enabled: true,
  modes: ['grid', 'point', 'line', 'midpoint', 'center'],
  pixelRadius: 14,
}

export function normalizeSnapSettings(input: unknown): SnapSettings {
  if (!input || typeof input !== 'object') {
    return DEFAULT_SNAP_SETTINGS
  }

  const candidate = input as Partial<SnapSettings>
  const enabled = candidate.enabled !== false
  const pixelRadius =
    typeof candidate.pixelRadius === 'number' && Number.isFinite(candidate.pixelRadius)
      ? Math.max(6, Math.min(32, candidate.pixelRadius))
      : DEFAULT_SNAP_SETTINGS.pixelRadius
  const modes = Array.isArray(candidate.modes)
    ? candidate.modes.filter((mode): mode is SnapMode => ALL_SNAP_MODES.includes(mode as SnapMode))
    : DEFAULT_SNAP_SETTINGS.modes

  return {
    enabled,
    pixelRadius,
    modes: modes.length > 0 ? Array.from(new Set(modes)) : [],
  }
}
