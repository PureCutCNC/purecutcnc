# e2e — Browser Smoke (Playwright)

Thin, repeatable browser smoke run before manual testing sessions and in PR CI.
Covers DOM render + menu→action wiring. Does **NOT** assert geometry or
WebGL canvas contents — those are owned by `npm test`. One deliberate
exception: `feedColours.smoke.spec.ts` samples 2D canvas pixels, because
the feed-colour ramp (issue #498) is a rendering contract that only pixels
can prove.

## Quick start

```bash
npm run test:e2e
```

Starts a `vite dev` server on port 1420 (if one isn't running) and
discovers all `e2e/*.spec.ts` files. The fixture auto-navigates to the
app, waits for the canvas, and fails the test on **any** `console.error`
or uncaught page error.

From an isolated worktree, use a different port and an owned server so the
browser cannot silently exercise another checkout:

```bash
PURECUT_E2E_ISOLATED=1 PURECUT_E2E_PORT=1431 npm run test:e2e
```

## CI gate

Pull requests run three logical E2E lanes on separate runners. Each runner
keeps the safe CI configuration of two workers with per-file parallelism
disabled, so the split reduces elapsed time without increasing browser or Vite
load inside a runner:

| Lane | Command | Specs |
|------|---------|-------|
| Settings | `npm run test:e2e:settings` | appearance, units, languages, language manager, theme manager |
| Project input | `npm run test:e2e:project-input` | feature references, import geometry, creation targets |
| Workflow UI | `npm run test:e2e:workflow-ui` | CAM operations, G-code export, motion debug, overlap selection, viewport views |

The aggregate `e2e` check succeeds only when every lane succeeds, preserving
the required PR gate. Each failed lane uploads its own Playwright report and
test results. `npm run test:e2e` remains the full local-suite command.

## Scaffolding (read before writing a test)

| File | Role |
|------|------|
| `fixtures.ts` | Playwright `test` extension. Every spec imports `test` / `expect` from **here**, not `@playwright/test`. Provides `app` (booted page + error guard) and `ui` (selector module). |
| `selectors.ts` | **Single source of truth** for DOM selectors. Logical name → `Locator`. When the UI moves a class, update it **here** — every spec picks it up. |
| `helpers.ts` | Generic primitives: `seedProject`, `getProject`, `getHoveredFeatureId`, `getPendingMove`, `completePendingMove`, `openRowContextMenu`, `clickMenuItem`, `rowByName`, `featureRowCount`, `assertNoConsoleErrors`. Domain-agnostic. |
| `featureReferences.helpers.ts` | FR-specific helpers (e.g. `seedLinkedProject`). Built on the generic primitives. A new feature area gets its own `<area>.helpers.ts`. |
| `camOperations.helpers.ts` | CAM-specific fixture helpers for operation workflow smoke tests. |
| `gcodeExport.helpers.ts` | Export-dialog fixture: tool + two toolpath-producing operations + bundled GRBL machine selected. |
| `machineLibrary.helpers.ts` | Machine-library fixture: a minimal project with a configurable machine section, a complete stand-in `MachineDefinition`, and an `embeddedMachine` store reader. |

Current smoke targets:

- `appearance.smoke.spec.ts` — Dark/Light/System switching, persistence, system-media response, project-state isolation, and tablet touch targets.
- `featureReferences.smoke.spec.ts` — linked-feature tree badges, context menu wiring, properties grouping, and load round-trip.
- `camOperations.smoke.spec.ts` — feature-row quick operation wiring into CAM operation state.
- `creationTargets.smoke.spec.ts` — dedicated Line creation target wiring, active drawing badge, and landscape-tablet availability.
- `gcodeExport.smoke.spec.ts` — Export G-code dialog operation checklist: per-operation entry point, default set, none-selected disabled state.
- `importGeometry.smoke.spec.ts` — real-user import flow: dialog open/close, button state, file upload via hidden input, SVG/DXF mode selection with classification summary verification (Auto/Paths/Solid regions), real Import button, project-role verification through existing `getProject` seam, and landscape tablet layout. Synthetic inline fixtures only.
- `modelOrientation.smoke.spec.ts` — post-import 3D orientation for imported models (issue #241): real STL import, 90° quick-rotate committing a rigid Z band and a re-projected silhouette, non-deforming lift, and reset to import orientation.
- `machineLibrary.smoke.spec.ts` — application machine library (issue #403): My Machines persistence across projects and restarts, one-snapshot embedding on selection, the non-blocking update warning (keep vs. explicit update), and library deletion leaving a project's embedded machine usable.
- `overlapFeatureSelection.smoke.spec.ts` — direct selection for clear outline clicks, ambiguous-overlap picker wiring, candidate hover/focus previews, non-topmost selection, boxed scroll behavior, next-action dismissal, and landscape-tablet availability.

## Adding a test

The canonical shape for a new feature-area smoke:

1. **One spec file** per feature area: `e2e/<feature>.smoke.spec.ts`
2. **Import `test` / `expect` from `./fixtures`** (never `@playwright/test`)
3. **All selectors via `ui`** (the `selectors.ts` module)
4. **Seed via `seedProject`** (or an area helper that wraps it)
5. **Drive wiring via real clicks** through helpers (`openRowContextMenu`, `clickMenuItem`)
6. **Assert via the DOM** — never canvas contents, never geometry values
7. **Console-error guard is automatic** (from the fixture — no per-test boilerplate)
8. **Area-specific selectors** that don't yet exist in `selectors.ts` are added there; everything else is handled by the existing scaffolding.

User-facing UI or workflow changes should add or extend an e2e smoke when the
behavior depends on rendered DOM, menu wiring, dialogs, or browser-only boot
paths. If store/unit coverage is enough, call that out in the PR description so
the omission is intentional.

### Worked example — hypothetical "CAM operations" smoke

```ts
// e2e/camOperations.smoke.spec.ts
import { test, expect } from './fixtures'
import { seedProject, rowByName, openRowContextMenu, clickMenuItem } from './helpers'

test('pocket operation appears in context menu', async ({ app, ui }) => {
  await seedProject(app.page, CAM_FIXTURE_JSON)         // defined in camOperations.helpers.ts
  const row = rowByName(app.page, 'Pocket Feature')
  const menu = await openRowContextMenu(app.page, row)
  await expect(ui.contextMenu.item(menu, 'Pocket')).toBeVisible()
  await clickMenuItem(menu, 'Pocket')
  // … assert DOM reacts: operation tree entry, properties panel, etc.
})
```

**That's it.** No harness-internal changes, no duplicate boot/guard logic,
no raw selectors. The fixture + helpers absorb everything.

## Tauri boot caveat

The app runs in plain Chromium because `src/platform/index.ts` falls back
to the browser platform when `window.__TAURI_INTERNALS__` is absent. If a
future change adds Tauri IPC calls at boot time that are not guarded by
`isDesktop`, the smoke will break. Fix the guard — don't mock Tauri.

## Explicit non-goals

- No geometry/coordinate/segment-kind assertions (store suites own that).
- No screenshot/pixel diffing; no WebGL canvas-content assertions.
- No Tauri native file-dialog flows — project state is seeded via the
  guarded `window.__pcTest` dev seam.
