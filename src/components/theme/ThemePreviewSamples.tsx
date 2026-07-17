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

import type { ThemeValues } from '../../theme/registry'

/**
 * Representative preview states for the guided editor. UI samples read the
 * live CSS custom properties (the edited theme is previewed on the document
 * root), while sketch-canvas samples use the working values directly because
 * canvas colors are not CSS variables.
 */
export function ThemePreviewSamples({ values }: { values: ThemeValues }) {
  return (
    <div className="theme-preview-samples">
      <section className="theme-preview-samples__panel">
        <h4 className="theme-preview-samples__title">Panel & text</h4>
        <p className="theme-preview-samples__text">Primary text on a panel surface.</p>
        <p className="theme-preview-samples__text-dim">Muted guidance text for hints.</p>
      </section>

      <section className="theme-preview-samples__panel">
        <h4 className="theme-preview-samples__title">Controls</h4>
        <div className="theme-preview-samples__row">
          <button type="button" className="btn-primary" tabIndex={-1}>Primary</button>
          <button type="button" className="btn-secondary" tabIndex={-1}>Secondary</button>
          <button type="button" className="btn-secondary" tabIndex={-1} disabled>Disabled</button>
        </div>
        <div className="theme-preview-samples__row">
          <span className="theme-preview-samples__selected">Selected item</span>
          <span className="theme-preview-samples__focus">Focused control</span>
        </div>
      </section>

      <section className="theme-preview-samples__panel">
        <h4 className="theme-preview-samples__title">Messages</h4>
        <p className="theme-preview-samples__positive">Positive: toolpath generated.</p>
        <p className="theme-preview-samples__warning">Warning: shallow pass depth.</p>
        <p className="theme-preview-samples__danger">Danger: clamp collision detected.</p>
      </section>

      <section className="theme-preview-samples__panel">
        <h4 className="theme-preview-samples__title">Sketch canvas</h4>
        <div className="theme-preview-samples__canvas" style={{ background: values['canvas.background'] }}>
          <svg viewBox="0 0 220 84" className="theme-preview-samples__canvas-svg" aria-hidden="true">
            <line x1="0" y1="42" x2="220" y2="42" stroke={values['canvas.gridMajor']} strokeWidth="1" />
            <line x1="110" y1="0" x2="110" y2="84" stroke={values['canvas.gridMinor']} strokeWidth="1" />
            <path d="M14 66 L66 22" stroke={values['role-line']} strokeWidth="2.5" fill="none" />
            <rect x="84" y="18" width="44" height="30" stroke={values['role-region']} strokeWidth="2.5" fill="none" />
            <path d="M146 64 L200 64" stroke={values['role-construction']} strokeWidth="2" strokeDasharray="6 4" fill="none" />
            <path d="M150 20 C 168 42, 186 42, 204 20" stroke={values['canvas.mutedGeometry']} strokeWidth="1.5" fill="none" />
          </svg>
          <span
            className="theme-preview-samples__canvas-label"
            style={{ background: values['canvas.labelBackground'], color: values['canvas.labelText'] }}
          >
            42.5 mm
          </span>
        </div>
        <div className="theme-preview-samples__row theme-preview-samples__row--legend">
          {([
            ['Line', values['role-line']],
            ['Region', values['role-region']],
            ['Constr.', values['role-construction']],
            ['Add', values.add],
            ['Cut', values.cut],
          ] as const).map(([label, color]) => (
            <span key={label} className="theme-preview-samples__chip">
              <span className="theme-preview-samples__chip-dot" style={{ background: color }} />
              {label}
            </span>
          ))}
        </div>
      </section>
    </div>
  )
}
