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
 * Message-catalog contract: flat dot-namespaced keys, `{placeholder}`
 * interpolation, and explicit plural-variant keys (`….one` / `….other`)
 * selected via `Intl.PluralRules`.
 *
 * English is the canonical catalog — every key exists there — and every other
 * locale (built-in or custom) is an overlay resolved against it per key, so a
 * missing translation renders English rather than a blank. Values are plain
 * strings; numbers passed as params are inserted verbatim (no locale digit
 * reformatting) to keep engineering output deterministic.
 */

export type MessageParams = Record<string, string | number>

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g

/**
 * Replace `{name}` tokens with `params[name]`. Unknown tokens are left as-is
 * (never dropped) so a mistranslated placeholder stays visible instead of
 * silently eating text.
 */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

/** Sorted unique `{placeholder}` names in a template — the parity contract. */
export function placeholderNames(template: string): string[] {
  const names = new Set<string>()
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    names.add(match[1])
  }
  return [...names].sort()
}

/**
 * True when a translation preserves exactly the placeholders of its source
 * template. Used by the built-in-locale parity test and the custom-language
 * editor's per-key save gate.
 */
export function placeholdersMatch(source: string, translation: string): boolean {
  const sourceNames = placeholderNames(source)
  const translationNames = placeholderNames(translation)
  return (
    sourceNames.length === translationNames.length
    && sourceNames.every((name, index) => name === translationNames[index])
  )
}

const pluralRulesCache = new Map<string, Intl.PluralRules>()

/**
 * The plural bucket for `count` under a BCP-47 tag, collapsed to the two
 * variants the catalogs carry: `'one'` or `'other'`. Languages whose rules
 * produce `few`/`many` (none shipped today) fall into `'other'`; adding such a
 * locale means widening the variant set, not changing call sites.
 * An invalid tag falls back to English rules.
 */
export function pluralVariant(languageTag: string, count: number): 'one' | 'other' {
  let rules = pluralRulesCache.get(languageTag)
  if (!rules) {
    try {
      rules = new Intl.PluralRules(languageTag)
    } catch {
      rules = new Intl.PluralRules('en')
    }
    pluralRulesCache.set(languageTag, rules)
  }
  return rules.select(count) === 'one' ? 'one' : 'other'
}
