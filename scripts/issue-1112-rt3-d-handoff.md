# Slice rt3-d: drawer consistency, Hex icon, Subtract default on bars (items 31, 32, 33)

31. **Unavailable entries greyed out, not hidden.** Frank likes item 22's disabled entries with a reason. Where Turn and Polygon can't be created (e.g. the Top/Bottom drawer of a milling or plasma project with block stock), show them disabled with a short reason, e.g. "Needs a bar in a rotary project" (all locales). Apply the same rule to every other drawer entry that is hidden rather than disabled today; list each one changed and why.
32. **Hex/Polygon model icon.** It uses the same icon as the regular-polygon outline shape. Draw its own icon in the style of the new Turn icon (item 15, same sprite source): side view of a hexagonal bar section on the dash-dot centreline, flat edges visible, reading as a solid around the axis. Distinct from the n-gon outline, Turn and rounded/chamfered rect at 16 and 24 px. `npm run sync-icons`.
33. **New features on bar stock default to Subtract, on every face.** A gear added as the first feature on a square bar's Top face came out as Add. A bar is already solid, so a new closed feature on any face (Top, Bottom, Around) of bar stock, round or square, defaults to Subtract, hand-drawn or canned. Item 14 covered Around on round bars only; generalise that rule (`src/store/helpers/operationDefaults.ts` / `featureRoles.ts`). Block stock unchanged.

Tests: drawer state per project type and stock; default operation per face × bar shape × feature kind (block unchanged). Mutations: hide instead of disable; Add on a square bar's Top.

Off limits: Cuts list/tree (rt3-a), simulation (rt3-b), 3D view (rt3-c), `roundWorkholding.ts` (rt3-e).
## Rules for every slice (issue #1112, PR #1126, Frank's test round 3)

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
