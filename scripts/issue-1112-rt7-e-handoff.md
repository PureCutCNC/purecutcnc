# Slice rt7-e: no 3D orientation section for generated rotary models (Frank, round 7)

Frank (2026-10-31) asked whether to keep "3D orientation" for the rotary canned models, then approved hiding it. `src/components/feature-tree/PropertiesPanel.tsx` (~line 1836) renders `ModelOrientationSection` for every `operation === 'model'` feature with a mesh. That includes generated canned models (Turn, Polygon/Hex), which are stored as models. Rotate X/Y/Z would tip them off the bar axis. Turning about the bar axis is already the Polygon editor's Rotation field. Regenerating from parameters would undo or fight a manual rotation.

- Do not render the 3D orientation section for any canned (generated) model: `isCannedShape`, or the canned registry's model kinds. Imported models (STL/STEP/…) keep it exactly as now, including lift and reset.
- Check the other ways to reach these rotation actions for a canned model (context menu, toolbar, keyboard, any `rotateModel`/orientation action in the store), and refuse or hide them the same way. List what you found and what you changed in RISKS.
- If the `zFromParameters` prop of `ModelOrientationSection` (added in rt6-a for canned models) becomes unused, remove it and its branches.
- Remove any locale keys that become unused (all locales). No other text changes.

Tests: a Turn and a Hex show no 3D orientation section. An imported model still shows it with Rotate X/Y/Z, lift and reset. Any other rotation path you found is refused for a canned model. Mutation: render the section for canned models again, and the test fails. Update any `e2e/` spec that asserts the section on a canned model (grep "3D orientation", `ModelOrientationSection`, rotate) and list it in RISKS.

Off limits: everything else.

## Rules

- You work in your own worktree, based on the rt7-d branch. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider. Put anything that needs a decision in RISKS.
- `gh` may be blocked in your sandbox.
- Leave edits uncommitted and report `COMMIT: none`. Do not touch `scripts/issue-1112-rt7-a-bolt.camj`.
- Tests must bite: break the code on purpose, confirm a test fails, then restore from a `cp` backup (never `git checkout`).
- React tests run with `NODE_OPTIONS=--no-experimental-global-navigator`. You cannot run a browser.
- Run and report with exit codes: `npm run build:gates`, `npm run check:i18n` if locales changed, each changed test file.
- Report: changes per file; tests; mutation; commands with exit codes; RISKS.
