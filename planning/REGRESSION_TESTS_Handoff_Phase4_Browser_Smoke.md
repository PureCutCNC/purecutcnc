# Regression Tests — Phase 4 Handoff: Browser Smoke (Playwright)

Implementation handoff. Read `AGENTS.md`, root `planning/INDEX.md`, and
`planning/REGRESSION_TESTS_Plan.md` first (this implements its **Phase 4**). Follow
Plan → confirm scope → Implement. You own ONLY this slice's worktree; finish with ONE simple commit
and a report. Do not merge, open a PR, or modify other worktrees.

## What this is (and is NOT)

A **thin, repeatable browser smoke** the user runs *before* each manual testing session, so a broken
UI wiring path is caught in ~30–60s instead of by hand. It covers the **one layer the store-level
`npx tsx` suites structurally cannot reach**: that the rendered DOM and the menu→action wiring are
actually intact. Two recent UI bugs lived exactly here and stayed green through tsc + every test:
- the **blank linked badge** (icon didn't exist + CSS missing), and
- the **feature-tree row overflow** (badge fell into a 2nd grid row, pushing the action buttons down).

It is **NOT**:
- a geometry checker — `resolveProfile`/transform correctness is owned by the store-level suites
  (Phases 1–3); assert **no** coordinate/radius/segment values here.
- a pixel/screenshot diff — the WebGL viewport is opaque to the DOM and pixel diffing is GPU-flaky.
  Assert DOM presence/visibility/text and dialog events only, never canvas contents.
- part of `npm test` / the build gate — it needs a running server + Chromium. It's a separate,
  locally-run `npm run test:e2e`.

## Branch / base / worktree

- Integration branch: `feature-references-v2` (use the current tip of `origin/feature-references-v2`).
- Slice branch: **`regression-tests-phase4-browser-smoke`**
- Worktree: `/Users/frankp/Projects/worktrees/purecutcnc/regression-tests-phase4-browser-smoke`
- Setup (no `npm install` for app deps — symlink the existing `node_modules`):
  ```bash
  git -C /Users/frankp/Projects/purecutcnc worktree add \
    /Users/frankp/Projects/worktrees/purecutcnc/regression-tests-phase4-browser-smoke \
    -b regression-tests-phase4-browser-smoke origin/feature-references-v2
  cd /Users/frankp/Projects/worktrees/purecutcnc/regression-tests-phase4-browser-smoke
  ln -s /Users/frankp/Projects/purecutcnc/node_modules node_modules
  ```
- Playwright itself is a **new devDependency** (greenfield — not yet in `package.json`). Add
  `@playwright/test`, then `npx playwright install chromium` (browser binary only). Keep the version
  pinned and note it in the report.

## STEP 0 — Feasibility gate (do this FIRST; it can abort the slice)

This app targets **Tauri**. Before building anything, prove the app **boots in a plain Chromium with
no Tauri runtime**:
1. `npm run build` then `npm run preview` (serves the production build, default vite preview port) — or
   `npm run dev` (:1420). Open the URL in plain Chromium (not Tauri).
2. Watch for boot failure: the app has a boot watchdog (`window.__pcBootWatchdog` in `src/main.tsx`)
   and may hard-fail or hang if `@tauri-apps/api` IPC calls throw at startup.
3. If it boots and renders the canvas + feature tree → proceed.
4. If it does **not** boot without Tauri: apply the **minimal** stub needed (e.g. a small guarded
   `window.__TAURI_INTERNALS__`/IPC shim injected via Playwright `addInitScript`, NOT product code).
   If boot needs anything beyond a small init-script shim — heavy IPC mocking, native-only modules —
   **STOP and report**. Do not build a brittle harness; a manual checklist is the fallback and that's
   an acceptable outcome of this gate.

Decide the server strategy from what works: prefer Playwright's `webServer` config launching
`npm run preview` (tests the real production bundle) and reusing an already-running server if present.

## STEP 1 — Test-seam (minimal, dev/test-guarded)

DOM-drive everything you can. But the **WebGL canvas is opaque** and drawing shapes by click-drag on it
is flaky, so seed/read project state through a **minimal, guarded** window seam rather than the canvas:

- Add to `src/main.tsx` (or a tiny `src/devTestHook.ts` it imports), guarded so it is a **no-op in
  production** (`if (import.meta.env.DEV || a Playwright-set flag) { ... }`), following the existing
  `window.__pcBootWatchdog` precedent:
  - `window.__pcTest = { getProject(): Project, loadProject(json: string): void }`
    — `getProject` returns the live store project; `loadProject` routes through the real
    `openProjectFromText` (the same universal load entry file-open/examples use).
- This is the **only** product-code change permitted, and it must be inert in prod builds. Verify with
  `npm run build` that tsc stays green and the hook is gated (no `__pcTest` on a prod bundle).
- Everything else — tree rows, badges, context menu, properties panel, selection, dialogs — is asserted
  through the **real DOM** so the smoke genuinely exercises wiring.

Useful real selectors/classes already in the code (verify, don't assume): `.tree-linked-badge`,
`.tree-label-wrap`, `.tree-row`, the feature-tree container, the context menu, the Properties panel's
SHAPE vs INSTANCE groups, `Icon id="link"` → `/icons.svg#link`. Add `data-testid` hooks **only where a
stable selector doesn't already exist**, and keep them minimal.

## STEP 2 — The smoke (`e2e/featureReferences.smoke.spec.ts`)

One spec, sequential, ~10–15 assertions. Seed via `__pcTest.loadProject`, assert via DOM, exercise
wiring via real clicks. Fail the whole run on **any** `console.error` or uncaught page error
(register a listener in `beforeEach`).

1. **Boots clean.** App loads; the canvas element and feature-tree container are present; zero console
   errors during boot.
2. **Linked badge renders on the right rows.** Seed a project with a linked pair + one independent copy
   + one made-unique instance. Assert: correct number of tree rows; `.tree-linked-badge` is **visible**
   (not zero-size / not a blank box — assert bounding box > 0 and the `#link` glyph resolves) on exactly
   the linked rows and absent on the independent/unique rows.
3. **Row layout intact.** On a badged row, assert the row is single-line — the action buttons sit on the
   same row as the label (bounding-box y within tolerance), guarding the e97130b overflow regression.
4. **Make Unique unwires the link.** Right-click a linked feature → assert the context menu shows
   **Make Unique** + **Select Linked Instances** grouped at the **top** (and only because it's linked).
   Click Make Unique → the badge on that row clears reactively.
5. **Select Linked.** Right-click a linked feature → Select Linked Instances → assert the selection
   count/highlight matches the sibling set.
6. **Copy = reference by default.** Trigger the real duplicate path (the Copy action / its pending-move
   completion) → a new tree row appears carrying the linked badge (shares the definition).
7. **Edit Sketch enters/exits.** Trigger Edit Sketch on a feature → assert sketch-edit mode UI appears
   (Save/Cancel affordance present) → Cancel → back to normal mode, no console error.
8. **Properties grouping.** Select a linked feature → Properties panel shows the SHAPE (definition) vs
   INSTANCE groups.
9. **Save→load round-trip.** `__pcTest.getProject()` → `__pcTest.loadProject(JSON.stringify(p))` →
   assert the tree repopulates and the linked badges return (DOM-level; geometry equivalence is already
   covered by the store-level lifecycle suite — do not re-assert it here).
10. **Newer-version warning.** `loadProject` a project whose `version` is newer than
    `LATEST_PROJECT_VERSION` (`2.0`) → assert the forward-compat warning fires (Playwright
    `page.on('dialog')` for the `window.alert`) and the app still loads.

## Build it to extend (REQUIRED — this is a foundation, not a one-off)

The FR smoke is the **first** consumer of this harness; coverage will grow as features are added, so the
scaffolding must make a new test a few composed lines, not a fresh derivation. Adding a smoke for a
future feature area (e.g. a new CAM operation, a new tool) must NOT require touching harness internals.
Deliver these reusable pieces and build the FR spec **on top of them** (proving the pattern):

- **A Playwright fixture** (`e2e/fixtures.ts`) extending `test` so every spec gets a booted `app` page
  with: the **console-error guard installed automatically** (fail on any `console.error`/page error),
  the `__pcTest` seam ready, and the helpers injected. A new spec is then just
  `test('...', async ({ app, ui }) => { ... })` — no per-spec boot/guard boilerplate.
- **A single selectors module** (`e2e/selectors.ts`) — logical name → selector/role, the **one place**
  UI churn is absorbed. Specs never inline raw selectors.
- **A generic helpers module** (`e2e/helpers.ts`, NOT FR-specific): `seedProject(json)` /
  `getProject()` (via `__pcTest`), `treeRows()`, `openRowContextMenu(row)`, `clickMenuItem(label)`,
  `expectNoConsoleErrors()`, etc. FR-specific assertions (e.g. `expectLinkedBadge`) may live in the FR
  spec or a thin `e2e/featureReferences.helpers.ts`, but the primitives stay generic and reusable.
- **`e2e/README.md` with an "Adding a test" recipe**: the canonical shape — seed state via `__pcTest`,
  drive wiring via real clicks through the selectors module, assert via the DOM helpers, console-error
  guard is automatic; one spec file per feature area (auto-discovered). Plus: how to run
  (`npm run test:e2e`), the Tauri-boot caveat from STEP 0, and the explicit non-goals (no geometry, no
  pixels). Include a 5-line worked example of slotting in a hypothetical future smoke using only the
  fixture + helpers.

## Wiring it up

- `package.json`: add `@playwright/test` (dev), and a script `"test:e2e": "playwright test"`. Do **not**
  add e2e to the `test` or `build` scripts — the headless `npm test` gate must stay browser-free.
- `playwright.config.ts`: chromium only; `testDir: 'e2e'`; `webServer` launching `npm run preview` (or
  `dev`) with `reuseExistingServer: true`; a sensible timeout; `forbidOnly` off.
- `.gitignore`: add `test-results/`, `playwright-report/`, `/playwright/.cache/` if not already ignored.

## Out of scope
- No geometry/coordinate/segment-kind assertions (store suites own that).
- No screenshot/pixel diffing; no WebGL canvas-content assertions.
- No Tauri native file-dialog flows (open/save dialogs) — use the `__pcTest` seam instead.
- No CI integration (just a locally-runnable script). No changes to `src/store/*` or other product code
  beyond the single guarded `__pcTest` hook. Don't touch other worktrees.

## Acceptance criteria
- `npm run test:e2e` runs the smoke green locally against the built app; the run fails loudly on any
  console error.
- **Extensible by construction:** the FR spec is built on the shared fixture + selectors + helpers, and
  a new feature-area smoke can be added as a single spec file using only those (no harness-internal or
  selector-module changes beyond adding the new area's logical selectors). The README's "Adding a test"
  recipe + worked example demonstrate it.
- The `__pcTest` hook is present only under the dev/test guard and a `npm run build` prod bundle does
  not expose it; `npm run build` (tsc -b + `npm test` + vite) stays green.
- The smoke asserts through the **real DOM + real menu/action wiring** (seed via the hook is fine;
  assertions are not).
- If STEP 0 fails (app can't boot headless without heavy mocking): no harness is built; the report
  states that clearly and proposes the manual-checklist fallback. **That is an acceptable outcome.**
- If any assertion reveals a real product bug, leave it failing/`.skip`-documented and **report it** —
  do not work around it.
- `planning/REGRESSION_TESTS_Plan.md` Phase 4 + nearest `INDEX.md` updated to reflect what shipped.

## Final report (report back to management; do NOT merge)
```
Branch:
Worktree:
Commit(s):
STEP 0 result:   (booted headless? any stub needed? or aborted — why)
Files changed:
Playwright version pinned:
Smoke assertions implemented:   (list)
__pcTest hook:   (location + guard mechanism + prod-inert proof)
Any real bugs surfaced:   (list, with the failing assertion — do not fix)
Verification run:   (npm run test:e2e result + npm run build)
Known gaps / deferred:
```
