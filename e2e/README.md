# e2e — Browser Smoke (Playwright)

Thin, repeatable browser smoke run before manual testing sessions.
Covers DOM render + menu→action wiring. Does NOT assert geometry, pixels, or
WebGL canvas contents — those are owned by the `npm test` store-level suites.

## Prerequisites

- `npm run build` must pass first (the smoke tests against the production bundle
  served by `vite preview`).
- The app boots in plain Chromium without Tauri (verified in STEP 0 of the
  implementation handoff).

## How to run

```bash
npm run test:e2e
```

This starts a `vite preview` server on port 4199 (if one isn't already running)
and runs the single spec in this directory.

## Explicit non-goals

- No geometry/coordinate/segment-kind assertions (store suites own that).
- No screenshot/pixel diffing; no WebGL canvas-content assertions.
- No Tauri native file-dialog flows — project state is seeded via the guarded
  `window.__pcTest` dev seam.
- No CI integration.

## Tauri boot caveat

The app runs in plain Chromium because the platform detection in
`src/platform/index.ts` falls back to the browser platform when
`window.__TAURI_INTERNALS__` is absent.  If a future change adds Tauri IPC
calls at boot time that are not guarded by `isDesktop`, the smoke will break.
Fix the guard — don't mock Tauri.
