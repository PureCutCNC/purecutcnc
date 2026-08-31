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

import type { FeedColourLegendStep, ToolpathVisibility } from './toolpathVisibility'
import { feedLegendStepLabels } from './toolpathVisibility'
import { useI18n } from '../i18n/i18nContext'
import type { MessageKey } from '../i18n/locales/en'
import { useTheme } from '../theme/themeContext'
import { canvasFeedColour } from '../theme/palette'
import { Icon } from './Icon'
import { ToolpathRendererControl } from './ToolpathRendererControl'
import type { ToolpathRendererControl as RendererControl } from './canvas/toolpathRendererPreference'

interface ToolpathVisibilityPanelProps {
  visibility: ToolpathVisibility
  onChange: (visibility: ToolpathVisibility) => void
  className?: string
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  /**
   * The feed-colour toggle's auto default for the selected operation (on when
   * its pocketFeedReduction is 'engagement'). Used only while the
   * visibility object carries no explicit `feedColours` value.
   */
  feedColoursDefault?: boolean
  /**
   * The feed-colour legend rungs — the distinct (scale, step) pairs emitted by
   * the toolpaths currently in the preview, precomputed and cached by the
   * caller (issue #535). Empty/absent hides the legend; the old per-operation
   * `slotFeedPercent` ladder is gone because it advertised rungs no visible
   * toolpath emits (and missed rungs other operations did emit).
   */
  legendSteps?: ReadonlyArray<FeedColourLegendStep>
  /** Present only in the sketch; the 3D renderer has no backend selector. */
  renderer?: RendererControl
}

const ITEMS: Array<{ key: keyof ToolpathVisibility; labelKey: MessageKey; swatch: string }> = [
  { key: 'cuts', labelKey: 'appShell.toolpath.cuts', swatch: 'viewport-toolpath-vis__swatch--cuts' },
  { key: 'leadIns', labelKey: 'appShell.toolpath.leadIns', swatch: 'viewport-toolpath-vis__swatch--lead-ins' },
  { key: 'rapids', labelKey: 'appShell.toolpath.rapids', swatch: 'viewport-toolpath-vis__swatch--rapids' },
  { key: 'plunges', labelKey: 'appShell.toolpath.plunges', swatch: 'viewport-toolpath-vis__swatch--plunges' },
  { key: 'retractions', labelKey: 'appShell.toolpath.retractions', swatch: 'viewport-toolpath-vis__swatch--retractions' },
  { key: 'directions', labelKey: 'appShell.toolpath.directions', swatch: 'viewport-toolpath-vis__swatch--directions' },
  // Feed colours share the coral cuts swatch — step 0 of the ramp IS toolpathCut.
  { key: 'feedColours', labelKey: 'appShell.toolpath.feedColours', swatch: 'viewport-toolpath-vis__swatch--cuts' },
]

export function ToolpathVisibilityPanel({ visibility, onChange, className, expanded, onExpandedChange, feedColoursDefault, legendSteps, renderer }: ToolpathVisibilityPanelProps) {
  const { t } = useI18n()
  const { palette } = useTheme()

  // The feed-colour toggle is tri-state at the data level: undefined defers
  // to the per-selection default, so display that default.
  const feedColoursOn = visibility.feedColours ?? feedColoursDefault ?? false
  // Only rungs the view actually paints, and only while feed colours are on —
  // an off toggle means no feed colouring exists to explain (issue #535).
  // A single full-feed rung means nothing is scaled, so there is no legend.
  const showLegend = expanded
    && feedColoursOn
    && (legendSteps?.some((entry) => entry.step > 0) ?? false)
  // Whole percents unless two distinct rungs would round to the same label —
  // then one decimal for every label so the swatches stay tellable apart.
  const legendLabels = showLegend && legendSteps ? feedLegendStepLabels(legendSteps.map((entry) => entry.scale)) : []

  return (
    <div className={`viewport-toolpath-vis${expanded ? ' viewport-toolpath-vis--expanded' : ''}${className ? ` ${className}` : ''}`}>
      <button
        className="viewport-toolpath-vis__label"
        type="button"
        aria-label={t('appShell.toolpath.show')}
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
      >
        <Icon id="gcode" />
      </button>
      {expanded ? (
        ITEMS.map(({ key, labelKey, swatch }) => {
          const selected = key === 'feedColours'
            ? feedColoursOn
            : visibility[key]
          return (
            <button
              key={key}
              className={`viewport-toolpath-vis__item ${selected ? 'viewport-toolpath-vis__item--selected' : ''}`}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange({ ...visibility, [key]: !selected })}
            >
              <span
                className={`viewport-toolpath-vis__swatch ${swatch}`}
                style={key === 'feedColours'
                  ? { background: `linear-gradient(90deg, ${palette.canvas.toolpathCut} 0%, ${palette.canvas.toolpathCutSlow} 100%)` }
                  : undefined}
              />
              {t(labelKey)}
            </button>
          )
        })
      ) : null}
      {expanded && renderer ? <ToolpathRendererControl renderer={renderer} /> : null}
      {showLegend && legendSteps ? (
        <div
          className="viewport-toolpath-vis__legend"
          aria-label={t('appShell.toolpath.feedLegend')}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 10px 6px' }}
        >
          {legendSteps.map(({ scale, step }, index) => (
            <span
              key={`${scale}:${step}`}
              className="viewport-toolpath-vis__legend-step"
              title={legendLabels[index]}
              style={{ display: 'flex', alignItems: 'center', gap: '3px' }}
            >
              <span className="viewport-toolpath-vis__swatch" style={{ background: canvasFeedColour(step, palette.canvas) }} />
              <span style={{ fontSize: '10px', lineHeight: 1 }}>{legendLabels[index]}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
