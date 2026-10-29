# Slice rt2-g: a new project takes the template's project type (item 24)

Frank: "on the new project, if I choose a rotary project as a template, then the new project should be also rotary and import the chuck and stock definition".

- In the New project dialog (`src/components/project/NewProjectDialog.tsx`, `newProjectStock.ts`, `src/store/helpers/projectTypeApply.ts` `projectWithProjectType`), when the chosen template is a rotary project (bar stock), the new project's type is rotary (not the dialog's current/default type), and it takes the template's stock (shape round/square, diameter or side, length, axis, units) and its chuck/workholding definition (size, jaw count, clamping range, placement). Find where a template's type and stock are dropped or overwritten today and fix that.
- The dialog shows the type that will be used (rotary, locked to the template's) so the user isn't surprised; if the dialog lets the user change type with a template selected, say in the report what happens and keep it consistent with #1046 (project type fixed at creation).
- Same rule for every project type (Frank): a plasma template creates a plasma project, a milling template a milling project, each with the template's stock and machine-related setup (for plasma: its stock sheet and plasma machine settings as the template has them). Only the blank template uses the dialog's chosen type.

Tests: rotary round and square templates (mm and inch) produce a rotary project with equal stock and chuck; plasma and milling templates produce their own type with equal stock; the blank template uses the dialog's type. Mutation: force the dialog's default type; drop the chuck.

Off limits: everything the other rt2 slices changed, except where this item requires it.
## Rules for every slice (issue #1112, PR #1126, Frank's test round 2)

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
