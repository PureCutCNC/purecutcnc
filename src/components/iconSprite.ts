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
 * Pure assembly logic for the icon sprite. Each editable per-icon SVG under
 * `src/assets/icons/<name>.svg` is parsed into a `<symbol>` and the symbols are
 * concatenated into `public/icons.svg`.
 *
 * Kept free of any Node/filesystem imports so it can be unit-tested directly
 * (see iconSprite.test.ts). The filesystem glue lives in
 * `scripts/build-icon-sprite.ts`.
 *
 * Output contract (consumed by this app's Icon.tsx via external `<use>` and by
 * purecutcnc.github.io's guide loader via fetch+inline): the sprite root carries
 * NO `display:none`. That attribute is correct for an external `<use>` target
 * (never rendered) but breaks the guide's inline loader, which injects the whole
 * sprite into the DOM and relies on the symbols staying live as `<use>` targets.
 * One file therefore serves both consumers. See issue #176.
 */

export interface ParsedIcon {
  /** Sprite `<symbol id>` — derived from the source filename. */
  id: string
  /** viewBox copied from the source `<svg>` (defaults to `0 0 24 24`). */
  viewBox: string
  /** Inner markup of the source `<svg>` (paths/shapes), cruft stripped. */
  inner: string
}

const DEFAULT_VIEWBOX = '0 0 24 24'

/**
 * Editor cruft (Inkscape/Illustrator) that must not leak into the sprite.
 * Conservative on purpose: `<defs>` is preserved because colour icons may keep
 * gradients/filters there.
 */
const CRUFT_PATTERNS: RegExp[] = [
  /<\?xml[\s\S]*?\?>/g, // XML declaration
  /<!DOCTYPE[\s\S]*?>/gi, // doctype
  /<!--[\s\S]*?-->/g, // comments
  /<metadata[\s\S]*?<\/metadata>/gi, // Inkscape metadata block
  /<sodipodi:namedview[\s\S]*?<\/sodipodi:namedview>/gi, // paired namedview
  /<sodipodi:namedview[\s\S]*?\/>/gi, // self-closing namedview
]

/**
 * Parse one standalone source SVG into the pieces needed for a `<symbol>`.
 * Throws if the input has no `<svg>…</svg>` root so a malformed source file
 * fails the build loudly rather than emitting a silently-empty symbol.
 */
export function parseIconSvg(id: string, raw: string): ParsedIcon {
  let cleaned = raw
  for (const pattern of CRUFT_PATTERNS) {
    cleaned = cleaned.replace(pattern, '')
  }

  const open = cleaned.match(/<svg\b[^>]*>/i)
  const closeIndex = cleaned.lastIndexOf('</svg>')
  if (!open || closeIndex === -1) {
    throw new Error(`icon "${id}": source is not a valid <svg>…</svg> document`)
  }

  const viewBoxMatch = open[0].match(/\bviewBox\s*=\s*["']([^"']+)["']/i)
  const viewBox = viewBoxMatch ? viewBoxMatch[1].trim() : DEFAULT_VIEWBOX

  const innerStart = (open.index ?? 0) + open[0].length
  const inner = cleaned.slice(innerStart, closeIndex).trim()

  return { id, viewBox, inner }
}

/** Indent every non-empty line of `block` by `pad` spaces. */
function indent(block: string, pad: string): string {
  return block
    .split('\n')
    .map((line) => (line.trim() ? pad + line.trim() : ''))
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * Assemble parsed icons into the final sprite string. Icons are emitted in the
 * order given; callers sort by id for a stable, diff-friendly output.
 */
export function assembleSprite(icons: ParsedIcon[]): string {
  const symbols = icons
    .map(
      (icon) =>
        `  <symbol id="${icon.id}" viewBox="${icon.viewBox}">\n` +
        `${indent(icon.inner, '    ')}\n` +
        `  </symbol>`,
    )
    .join('\n')

  // NOTE: deliberately no `style="display:none"` — see file header / issue #176.
  return `<svg xmlns="http://www.w3.org/2000/svg">\n${symbols}\n</svg>\n`
}
