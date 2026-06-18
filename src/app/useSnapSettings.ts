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

import { useState } from 'react'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { DEFAULT_SNAP_SETTINGS, normalizeSnapSettings, type SnapMode, type SnapSettings } from '../sketch/snapping'

const SNAP_SETTINGS_STORAGE_KEY = 'camcam.snapSettings'

// Snap settings persist as JSON, run through normalizeSnapSettings on read so a
// stored value from an older schema is upgraded; a parse failure falls back to
// DEFAULT_SNAP_SETTINGS via the hook's deserialize-error handling.
const SNAP_SETTINGS_CODEC = {
  serialize: (settings: SnapSettings): string => JSON.stringify(settings),
  deserialize: (raw: string): SnapSettings => normalizeSnapSettings(JSON.parse(raw)),
}

export function toggleSnapEnabled(settings: SnapSettings): SnapSettings {
  return { ...settings, enabled: !settings.enabled }
}

export function toggleSnapMode(settings: SnapSettings, mode: SnapMode): SnapSettings {
  const modes = settings.modes.includes(mode)
    ? settings.modes.filter((entry) => entry !== mode)
    : [...settings.modes, mode]
  return { ...settings, modes }
}

export function useSnapSettings(): {
  snapSettings: SnapSettings
  activeSnapMode: SnapMode | null
  setActiveSnapMode: (mode: SnapMode | null) => void
  onToggleSnapEnabled: () => void
  onToggleSnapMode: (mode: SnapMode) => void
} {
  const [activeSnapMode, setActiveSnapMode] = useState<SnapMode | null>(null)
  const [snapSettings, setSnapSettings] = useLocalStorageState<SnapSettings>(
    SNAP_SETTINGS_STORAGE_KEY,
    DEFAULT_SNAP_SETTINGS,
    { codec: SNAP_SETTINGS_CODEC },
  )

  function handleToggleSnapEnabled() {
    setSnapSettings(toggleSnapEnabled)
  }

  function handleToggleSnapMode(mode: SnapMode) {
    setSnapSettings((previous) => toggleSnapMode(previous, mode))
  }

  return {
    snapSettings,
    activeSnapMode,
    setActiveSnapMode,
    onToggleSnapEnabled: handleToggleSnapEnabled,
    onToggleSnapMode: handleToggleSnapMode,
  }
}
