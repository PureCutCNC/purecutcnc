# INDEX — src/theme/

Application-local appearance preferences. Theme state is deliberately separate from the `.camj` project store, so changing appearance never dirties a project or changes saved files. Custom themes live in namespaced local storage and resolve against immutable built-in definitions.

- `tokens.ts` — the allowlisted, typed set of editable semantic theme roles (CSS custom properties + canvas + Three.js colors), grouped for the guided editor. The single authority on what a custom theme may override.
- `color.ts` — color parsing/normalization (hex + rgb()/rgba() only), WCAG contrast math with alpha compositing, and perceptual ΔE distance.
- `registry.ts` — versioned theme registry: complete built-in Dark/Light definitions (CSS values mirrored from `index.css`, enforced by test), custom-theme schema validation, base+override resolution, duplication, and the versioned import/export envelope.
- `selection.ts` — theme selection model (fixed theme or System light/dark pair), storage keys, legacy `dark|light|system` migration, and custom-theme list persistence.
- `contrast.ts` — critical-pair contrast checks and semantic-separation warnings; failing blockers prevent a custom theme from becoming active.
- `theme.ts` — legacy preference types/codec, system-scheme helper, and root application (`data-theme`, `color-scheme`, inline token overrides).
- `bootstrap.ts` — applies the persisted selection (including custom overrides) before React renders to avoid a theme flash.
- `ThemeProvider.tsx` — React provider: selection + custom theme persistence, system listener, preview state, resolved palette, and legacy-key write-back.
- `themeContext.ts` — context contract and `useTheme()` consumer hook, separated for Fast Refresh.
- `palette.ts` — typed 2D canvas and Three.js palette shapes plus the built-in color values consumed by the registry.
- `*.test.ts` — coverage for color math, registry/schema/import, selection/migration, contrast gating, and root application (including the CSS ↔ registry sync test).
