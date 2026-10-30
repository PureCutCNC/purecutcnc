# Slice rt4-a: tablet pass for the #1112 UI (Frank: "are we making sure tablet UI/UX is not behind?")

Frank hasn't tested on a tablet yet. Add tablet coverage for the new and changed UI of PR #1126 so problems surface before he does. You cannot run a browser: write the specs carefully against the real DOM (read the components), the manager runs them and sends failures back.

**Setup:** follow the existing tablet pattern in the specs (`test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true })` in `e2e/aroundFace.smoke.spec.ts:468`; `1024×768` in `e2e/setupCam.smoke.spec.ts:458`). Cover landscape 1180×820 and portrait 820×1180. Use `page.tap`/`locator.tap` where the app supports touch; don't rely on hover. Reuse the repo's fixtures and seeding helpers (`e2e/selectors.ts`, existing project builders). Put the tests in a new `e2e/tablet1112.smoke.spec.ts` and add it to the matching lane in `package.json` (`test:e2e:*` lists; `npm run check:e2e-lanes` must pass).

**Surfaces to cover** (round and square bar rotary project unless noted):
1. Turn and Polygon creation and edit panels (canvas panels from rt2-b), including the Turn profile dropdown, its empty-list hint and the explanation picture; Thread/Flutes panels already have tablet tests, extend only if they miss the panel fitting check.
2. Feature context menu on a canned shape and on an other-face model (long-press or the touch entry point the app uses): Edit {shape}…, Expand to features, wrapped reasons.
3. The operation's "What it cuts" Cuts list (rows with icon, name, ×).
4. The header face control and the » panel handle at the right end of the tab bar.
5. Simulation toolbar with the ⓘ fresh-stock info button (project with more than one setup).
6. Chuck properties (size, jaws, range) on a bar.
7. Turn/Polygon dashed outlines on Top, and selecting one by tap.

**Checks for each surface:** (a) every interactive control in it is at least 44×44 CSS px (boundingBox), (b) the panel/menu/dialog lies fully inside the viewport (no horizontal overflow, not cut off at the bottom; scrolling inside the panel is fine if it scrolls), (c) its main action works by tap only, (d) a screenshot to `work/tablet-shots/<surface>-<landscape|portrait>.png` (`work/` is gitignored; do not commit screenshots).

**Fixes:** if reading the CSS/components shows a control that is clearly under 44 px on tablet, hover-only, or a fixed width that can't fit 820 px, fix it in the component's CSS using the app's existing tablet breakpoints/tokens, and list each fix. Don't redesign anything; desktop must look the same.

Report: each surface × orientation with what the spec asserts, each CSS fix, and RISKS (assumptions about selectors or touch entry points the manager should check first when running).

Off limits: feature behaviour and engine code.
## Rules for every slice (issue #1112, PR #1126, tablet pass)

- You work in your own worktree, based on the previous slice's branch. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider: if something here is wrong or needs a decision, say so in RISKS and do the closest correct thing.
- `gh` may be blocked in your sandbox; everything you need is here.
- Leave edits uncommitted and report `COMMIT: none`; the dispatcher commits.
- Project format stays 3.3 (additive optional fields only, migration keys on missing fields). Exported programs and toolpaths stay byte-identical unless the item says otherwise.
- Locale changes: every new or changed key in `en` and in every other locale folder under `src/i18n/locales/`, same position as `en`, real translations. No other existing value changes. Run `npm run check:i18n`.
- Tests must bite: for each behaviour, break the code on purpose, confirm a test fails, restore from a `cp` backup (never `git checkout`). Report each mutation and whether it was caught.
- React/browser-global unit tests must pass with `NODE_OPTIONS=--no-experimental-global-navigator`.
- You cannot run a browser. Update any `e2e/` spec that asserts what you change (grep labels, selectors, test ids) without weakening assertions, and list it in RISKS.
- Run and report with exit codes: `npm run build:gates`, each changed or new test file directly, `npm run check:i18n` if locales changed.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
