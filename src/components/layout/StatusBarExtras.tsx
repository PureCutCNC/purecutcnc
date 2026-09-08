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

/**
 * What the status bar shows beyond its own visibility toggles.
 *
 * Generation status and controls used to live here too; they moved into the CAM
 * panel's header gear (issue #675), where the operations they describe are
 * actually visible.
 */

export interface StatusBarExtrasProps {
  showDepthLegend: boolean
  onExpandDepthLegend: () => void
}

export function StatusBarExtras({ showDepthLegend, onExpandDepthLegend }: StatusBarExtrasProps) {
  return (
    <>
      {showDepthLegend && (
<button
      className="statusbar-depth-legend"
      type="button"
      onClick={onExpandDepthLegend}
      title="Expand feature color legend"
      aria-label="Expand feature color legend"
    >
      <span className="statusbar-depth-legend__label">Feature Colors</span>
      <span className="statusbar-depth-legend__swatches" aria-hidden="true">
        <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--subtract-shallow" />
        <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--subtract-deep" />
        <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--add" />
        <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--region" />
        <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--imported-model" />
        <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--selected" />
      </span>
    </button>
      )}
    </>
  )
}
