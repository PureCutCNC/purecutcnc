# Slice rt4-b: Export G-code finds no machine (item 35) — priority

Frank can't export anything. File (read only, don't commit): `/home/frankp/Projects/purecutcnc/work/thread-on-turn-test-01.camj` — rotary project, round bar along X, inch. `meta.machineDefinitions` holds one custom machine `mach3-copy` "Mach3 (w/rotary)" (rotary about x, own drive), `meta.selectedMachineId: "mach3-copy"`; it passes `validateMachineDefinition`. In the Export G-code dialog the header shows "Mach3 (with rotary)" (a different name: probably the bundled machine), the preview says "Select a machine in project settings to generate G-code preview.", and nothing exports for any operation (move counts are computed). A second custom machine Frank created from Grbl and saved in the project fails the same way. So export doesn't resolve custom machines in this rotary project.

- Find how the dialog header and the export/preview pipeline each resolve the machine (selected id, project `machineDefinitions`, My Machines library, bundled registry `src/machine/registry`, rotary eligibility for an Around setup, the template-rule checks) and why they disagree. Compare with `feat/issue-1112-wave3` (#1125) and `integration/0.6.0` (`git diff` of the export/machine resolution code) to see whether a #1126 slice (e.g. rt2-g's template project creation, rt2-f/rt3-e chuck defaults, F4/r7-4 machine editor Save gating) broke it; say which.
- Fix: export uses the project's selected machine; the header names that machine; a custom machine copied from Mach3 rotary or Grbl in a rotary project exports. When export really can't run, the message says the real reason (missing rotary axis for an Around setup, a failing template line, opposite rotary axis) instead of "select a machine".
- Exported output for bundled machines stays byte-identical (`npm run check:gcode`-style fixtures if any changed path is touched).

Tests: a unit/integration test that loads this project's machine data (copy only the machine definition and a minimal rotary project into the test, not Frank's whole file) and asserts export resolves `mach3-copy` and produces a program for a rotary operation; same for a Grbl copy with a rotary axis; a plain router (no rotary) on an Around setup gives the specific refusal. Mutations: resolve by bundled id only; drop the selected id. Update any e2e spec (`e2e/gcodeExport.smoke.spec.ts`, `e2e/aroundFace.smoke.spec.ts` export cases) that asserts the old message.

Off limits: everything else.
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
