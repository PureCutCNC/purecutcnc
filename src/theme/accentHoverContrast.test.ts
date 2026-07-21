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
 * Accent-button hover-contrast guard.
 *
 * A modifier such as `.btn--primary` is a single class (specificity 0,1,0), but
 * the base hover `.btn:hover` is a class plus a pseudo-class (0,2,0). The base
 * therefore WINS on hover: the accent background is replaced by whatever the
 * base hover paints, while `color: var(--on-accent)` survives from the modifier.
 *
 * When the base hover paints a pale surface that lands as light text on a light
 * background — invisible in the light theme, and easy to miss because the same
 * token is nearly transparent in the dark theme, where it still looks fine.
 *
 * So: any `--modifier` that sets `color: var(--on-accent)` must re-assert its own
 * `background` in its own `:hover` rule whenever the base has a background-painting
 * hover.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

interface Rule {
  selector: string
  body: string
}

function parseRules(css: string): Rule[] {
  const rules: Rule[] = []
  // Strip comments and at-rule braces so nested blocks do not confuse the split.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const chunk of stripped.split('}')) {
    const open = chunk.lastIndexOf('{')
    if (open === -1) continue
    const selector = chunk.slice(0, open).split('\n').map((line) => line.trim()).filter(Boolean).join(' ').trim()
    const body = chunk.slice(open + 1)
    if (selector !== '' && !selector.startsWith('@')) rules.push({ selector, body })
  }
  return rules
}

const layoutCss = readFileSync(fileURLToPath(new URL('../styles/layout.css', import.meta.url)), 'utf8')
const rules = parseRules(layoutCss)

function setsBackground(selector: string): boolean {
  return rules.some((rule) => rule.selector === selector && /(^|[\s;])background(-color)?\s*:/.test(rule.body))
}

const checked: string[] = []

for (const rule of rules) {
  // A single-class modifier selector that paints text with the on-accent token.
  if (!/^\.[a-z0-9_-]+--[a-z0-9-]+$/i.test(rule.selector)) continue
  if (!rule.body.includes('var(--on-accent)')) continue

  const base = rule.selector.slice(0, rule.selector.lastIndexOf('--'))
  if (!setsBackground(`${base}:hover`)) continue

  checked.push(rule.selector)
  assert(
    setsBackground(`${rule.selector}:hover`),
    `${base}:hover (specificity 0,2,0) overrides the background of ${rule.selector} (0,1,0), `
    + `but ${rule.selector} keeps color: var(--on-accent). On hover that paints on-accent text `
    + `over the base hover surface — unreadable in the light theme. `
    + `Give ${rule.selector}:hover its own background (see .feat-btn--primary:hover).`,
  )
}

console.log(`accentHoverContrast tests passed (${checked.length} accent modifier(s) verified)`)
