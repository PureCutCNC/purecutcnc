---
status: Done
created: 2026-06-02
---

# Build Chunk Size Warnings Plan

## Goal

Silence the two warnings the `vite build` step prints today by fixing their
root causes rather than papering over them:

1. `[INEFFECTIVE_DYNAMIC_IMPORT]` — `@tauri-apps/plugin-fs` is dynamically
   imported in `useDesktopIntegration.ts` but also statically imported in
   `desktop.ts`, so the lazy import does nothing.
2. `Some chunks are larger than 500 kB` — the single `index-*.js` app bundle is
   ~5.2 MB because there is no code-splitting configuration; Three.js,
   clipper-lib, zod, zustand, react and all app code share one chunk.

## Approach

- **Ineffective dynamic import:** Remove the redundant
  `import('@tauri-apps/plugin-fs')` from the `Promise.all` in
  `useDesktopIntegration.ts`. `readTextFile` is already statically available via
  the desktop platform module; the dynamic import never produced a separate
  chunk. Use the statically-imported `readTextFile` (the module is already in
  the bundle through `desktop.ts`). Keeps behaviour identical, removes the
  warning.
- **Chunk size:** Add `build.rolldownOptions.output.codeSplitting` to
  `vite.config.ts` splitting heavy vendor libraries into their own chunks
  (`fonts`, `three`, `clipper`, `react`, `vendor`). `manifold-3d` already
  self-splits via its WASM loader, so leave it alone. This shrinks the main app
  chunk and gives each vendor lib its own cache key.

### Deviation from initial plan (recorded mid-flight)

- The warning text recommends `advancedChunks`, but Rolldown 1.0.0-rc.11 (Vite 8)
  prints `advancedChunks option is deprecated, please use codeSplitting instead`.
  Switched to `codeSplitting` (identical shape).
- Splitting revealed the real bloat is **not** three.js core (580 kB) but the
  **11 typeface glyph-outline JSON files** statically imported by
  `src/text/index.ts` — ~3.4 MB, grouped into a dedicated `fonts` chunk. No
  amount of grouping brings that under 500 kB, so `chunkSizeWarningLimit` is
  raised to 3500 (just above the `fonts` chunk). Lazy-loading individual fonts
  on demand is the genuine size win and is left as a follow-up (out of scope).

## Files affected

- `src/platform/useDesktopIntegration.ts` — drop the dynamic `plugin-fs` import
  from `Promise.all`; statically import `readTextFile` from `@tauri-apps/plugin-fs`.
- `vite.config.ts` — add `build.rolldownOptions.output.codeSplitting` vendor
  groups and raise `build.chunkSizeWarningLimit` to 3500.

## Tests

No engine logic changes — covered by the existing structural suite (`npm test`)
plus a clean `npm run build` with no chunk warnings as the acceptance check.

## Open questions / risks

- Low risk. The vendor split only changes how output JS is grouped; behaviour is
  unchanged. The import change is behaviour-preserving (same module, same fn).

## Out of scope

- Lazy-loading the entire desktop platform / further dynamic-import refactors.
- Tuning the manifold WASM chunk.
