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

/** Depth-colour legend overlay shown on the sketch canvas. */
export function DepthLegend({ onToggleDepthLegend }: { onToggleDepthLegend?: () => void }) {
  return (
    <div className="sketch-depth-legend">
      <div className="sketch-depth-legend__header">
        <span>Feature Colors</span>
        <button
          className="sketch-depth-legend__toggle tree-action-btn"
          type="button"
          onClick={onToggleDepthLegend}
          aria-label="Collapse feature color legend"
          title="Collapse legend"
        >
          ▾
        </button>
      </div>
      <div className="sketch-depth-legend__items">
        <div className="sketch-depth-legend__item">
          <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--subtract-shallow" />
          <span>Subtract shallow</span>
        </div>
        <div className="sketch-depth-legend__item">
          <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--subtract-deep" />
          <span>Subtract deep</span>
        </div>
        <div className="sketch-depth-legend__item">
          <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--add" />
          <span>Add feature</span>
        </div>
        <div className="sketch-depth-legend__item">
          <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--region" />
          <span>Region</span>
        </div>
        <div className="sketch-depth-legend__item">
          <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--imported-model" />
          <span>Imported model</span>
        </div>
        <div className="sketch-depth-legend__item">
          <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--selected" />
          <span>Selected</span>
        </div>
      </div>
    </div>
  )
}
