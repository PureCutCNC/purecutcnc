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
 * Thin translation wrapper for the unregistered `cam` catalog module. The
 * manager registers the module at merge time; until then this wrapper queries
 * the store and falls back to the English cam catalog so the build and tests
 * stay green.
 */

import { translate as _tr } from '../../i18n/store'
import { camEn } from '../../i18n/locales/en/cam'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cam module unregistered; manager widens at merge
const EN_FALLBACK: Record<string, string> = camEn as any

const PLACEHOLDER = /\{(\w+)\}/g

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(PLACEHOLDER, (_match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : _match,
  )
}

/** Translate a cam key, falling back to the English cam catalog when the store doesn't have it yet. */
export const camT = (key: string, params?: Record<string, string | number>): string => {
  // Try the store first; it throws (template is undefined) when the key
  // hasn't been registered yet — catch and fall back to the catalog.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cam module unregistered; manager widens at merge
    const fromStore = (_tr as any)(key, params)
    if (fromStore !== undefined && fromStore !== key) return fromStore
  } catch {
    // Expected: key not in the store yet; use fallback below.
  }
  const template = EN_FALLBACK[key]
  if (template !== undefined) return interpolate(template, params)
  // Last resort: return the key so mistranslations are visible rather than blank
  return key
}
