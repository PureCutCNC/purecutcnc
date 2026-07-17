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

import type { SnapMode } from '../../../sketch/snapping'
import { useI18n } from '../../../i18n/i18nContext'
import type { MessageKey } from '../../../i18n/locales/en'
import type { SnapToolbarProps } from './shared'
import { ToolbarActionButton } from './primitives'

const SNAP_MODE_ACTIONS: { mode: SnapMode; icon: string; labelKey: MessageKey }[] = [
  { mode: 'grid', icon: 'snap-grid', labelKey: 'shell.snap.grid' },
  { mode: 'point', icon: 'snap-point', labelKey: 'shell.snap.point' },
  { mode: 'line', icon: 'snap-line', labelKey: 'shell.snap.line' },
  { mode: 'midpoint', icon: 'snap-midpoint', labelKey: 'shell.snap.midpoint' },
  { mode: 'center', icon: 'snap-center', labelKey: 'shell.snap.center' },
  { mode: 'intersection', icon: 'snap-intersection', labelKey: 'shell.snap.intersection' },
  { mode: 'perpendicular', icon: 'snap-perpendicular', labelKey: 'shell.snap.perpendicular' },
]

function SnapActions({
  snapSettings,
  activeSnapMode,
  tooltipSide,
  onToggleSnapEnabled,
  onToggleSnapMode,
}: SnapToolbarProps & {
  tooltipSide?: 'bottom' | 'right'
}) {
  const { t } = useI18n()
  const hasMode = (mode: SnapMode) => snapSettings.modes.includes(mode)

  return (
    <>
      <div className="toolbar-group">
        <ToolbarActionButton
          icon="snap"
          label={snapSettings.enabled ? t('shell.snap.disable') : t('shell.snap.enable')}
          active={snapSettings.enabled}
          tooltipSide={tooltipSide}
          onClick={onToggleSnapEnabled}
        />
        {SNAP_MODE_ACTIONS.map(({ mode, icon, labelKey }) => (
          <ToolbarActionButton
            key={mode}
            icon={icon}
            label={t(labelKey)}
            active={snapSettings.enabled && hasMode(mode)}
            emphasized={snapSettings.enabled && activeSnapMode === mode}
            tooltipSide={tooltipSide}
            onClick={() => onToggleSnapMode(mode)}
          />
        ))}
      </div>
    </>
  )
}

export { SnapActions }
