# Editing icons

Icons are **SVG-first**: each file in this folder is the editable source of truth for one icon. The build assembles them into the `public/icons.svg` sprite. (Reworked in [issue #176](https://github.com/PureCutCNC/purecutcnc/issues/176); `src/assets/icons.camj` is no longer the icon source.)

## Where icons live

- **Source:** `src/assets/icons/<name>.svg` — one standalone SVG per icon. Open and edit these directly in Inkscape, Illustrator, or any vector editor. They have a real `viewBox` and **no `display:none`**, so they render normally in an editor.
- **Generated sprite:** `public/icons.svg` — do **not** edit by hand; it is regenerated from this folder.
- The filename maps to the sprite symbol id: `view-top.svg` → `<symbol id="view-top">`, used as `<Icon id="view-top" />`.

## Adding or editing an icon

1. Create/edit `src/assets/icons/<name>.svg` (kebab-case filename = the icon id).
2. Run `npm run sync-icons` to regenerate `public/icons.svg`. (This also runs first in `npm run build`.)
3. Verify visually in the dev-only gallery: run `npm run dev` and open `#icons` (e.g. `http://localhost:5173/#icons`).

## Sizing conventions

- **viewBox:** `0 0 24 24`. Keep artwork on the 24×24 grid.
- **Stroke width:** monochrome outline icons use a **1.5** baseline. That stroke is applied by the consumer (`Icon.tsx`), not baked into the sprite — see below — so leave strokes unset on monochrome icons to stay consistent.
- Use `stroke-linecap="round"` / `stroke-linejoin="round"` style artwork to match the existing set.

## Monochrome vs colour

There are two kinds of icon, and `Icon.tsx` decides how to paint each via the `fullColor` prop:

- **Monochrome (default).** Leave fills/strokes unset on the icon's elements. `Icon.tsx` renders the sprite with `fill="none" stroke="currentColor" strokeWidth="1.5"`, so the icon inherits the surrounding text colour. This is how every existing icon works — `<Icon id="rect" />`.
- **Colour / filled.** Set paint (`fill="#…"`, `stroke="#…"`, gradients in `<defs>`) **on the icon's elements**, then render with `<Icon id="logo" fullColor />`. `fullColor` drops the forced `fill`/`stroke` so your own paint controls the rendering.

> ⚠️ **Put paint on the elements, not the root `<svg>`.** The generator strips the outer `<svg>` wrapper when building the sprite, so presentation attributes on the root (e.g. `fill="…"` on `<svg>`) are **not** carried into the symbol. Paint set on `<path>`/`<rect>`/etc. survives.

The seeded monochrome files keep `fill="none" stroke="currentColor" stroke-width="1.5"` on their **root** `<svg>` purely so they render as visible outlines in an editor. Those root attributes are dropped from the sprite, so the icon still inherits the consumer's stroke at render time — editing them changes only the editor preview.

## Editing in Inkscape / Illustrator

The files are plain standalone SVGs — just open and edit. When saving:

- Prefer a **plain / optimized SVG** export over "Inkscape SVG" to avoid editor cruft. The generator strips XML declarations, doctypes, comments, `<metadata>`, and `<sodipodi:namedview>`, but keeping files clean keeps the sprite small.
- Keep the `viewBox` at `0 0 24 24` (the generator copies whatever `viewBox` the file has into the symbol).

## Regenerating the sprite

- `npm run sync-icons` → assembles `public/icons.svg` from this folder (generator: `scripts/build-icon-sprite.ts`, pure logic in `src/components/iconSprite.ts`, unit-tested by `iconSprite.test.ts`).
- `npm run build` runs it first, so a broken source SVG fails the build.

## Cross-repo note (purecutcnc.github.io)

`public/icons.svg` is also consumed by the **purecutcnc.github.io** site:

- The **app** loads it as an external `<use>` target (the sprite is never inserted into the DOM).
- The **guide** (`guide/icons-loader.js`) fetches it and injects it inline, then `<use>`s the symbols.

The generated sprite carries **no `display:none`** specifically so one file works for both consumers (a `display:none` root breaks the guide's inline loader). The sprite reaches github.io by a **manual copy before each release** — no `display:none` stripping is needed anymore. Monochrome icons render identically in both repos; for colour icons to show in the guide, the guide pages' forced `stroke`/`fill` would need the same opt-out (optional, not required here).

## Legacy

These per-icon SVGs replaced the original `src/assets/icons.camj` CAD-profile source, which (with its camj-based scripts) was removed in issue #176. The migration history — including the one-time `seed-icons-from-camj.js` seeder that produced this folder — lives in git. The SVGs in this folder are now the **sole** source of truth for icons.
