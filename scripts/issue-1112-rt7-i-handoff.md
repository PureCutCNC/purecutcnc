# Slice rt7-i: one edit action in SHAPE, Make unique in INSTANCE, one edit entry in the context menu (Frank, round 7)

Frank (2026-10-31): "for the canned features we added 'Edit ...' in the SHAPE section in the properties, which is good. however for the other regular features 'Edit sketch' is down at the bottom of the properties out of the sections. also make unique is under SHAPE and it really belongs to the INSTANCE. so, can we keep edit sketch or edit polygon (etc) (only one of them) in the shape section. move make unique under INSTANCE. and leave delete feature at the bottom out of the sections. and on the context menu we also show only one of the edit options."

Single-feature Properties are in `src/components/feature-tree/PropertiesPanel.tsx`: the SHAPE `DisclosureSection` (~line 1600), "Make unique" (~line 1829, inside SHAPE), the INSTANCE section (~line 1851), and "Edit sketch" with Delete in the action row at the bottom (search `featureTree.properties.stock.editSketch` near the single-feature delete). The context menu is `src/components/feature-tree/FeatureContextMenu.tsx` (the canned "Edit {shape}…" entry, ~line 520, and "Edit sketch" right after it). rt7-c has already changed the canned entry's enablement, so keep that rule.

What to build, for a single selected feature:
- **SHAPE section** has exactly one edit action at the place the canned "Edit {shape}…" button is now: "Edit {shape}…" for a canned shape, "Edit sketch" for every other feature. Same action, same disabled rules and reasons as today (locked, other face, …). "Edit sketch" no longer appears in the bottom row.
- **Make unique** moves into the **INSTANCE** section, with unchanged behaviour and visibility (only when the shape is shared).
- **Delete** stays at the bottom, outside the sections, alone.
- **Context menu:** show only one edit entry. A canned shape shows "Edit {shape}…" and no "Edit sketch" (today it shows a disabled "Edit sketch"); every other feature shows "Edit sketch" only. Applies to the normal menu and to the ghost (other-face) menu where an edit entry appears there.
- Multi-selection, folder, stock and other panels keep their own layouts. If one of them has the same pattern, list it in RISKS and do not change it.

Tests: a plain feature shows "Edit sketch" inside SHAPE and not in the bottom row. A canned shape shows "Edit {shape}…" in SHAPE and no "Edit sketch" anywhere. Make unique renders inside INSTANCE for a shared shape. Delete is the only bottom action. The context menu shows one edit entry for each kind. Mutations: render "Edit sketch" in the bottom row again; render the disabled "Edit sketch" for a canned shape in the menu; each must fail a test. Update every `e2e/` spec that finds these buttons by position or section (grep "Edit sketch", "Make unique", `makeUnique`, `editSketch`, `feat-btn--delete`) without weakening it, and list them in RISKS.

Off limits: everything else, including labels and the actions themselves.

## Rules

- You work in your own worktree, based on the rt7-h branch. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider. Put anything that needs a decision in RISKS.
- `gh` may be blocked in your sandbox.
- Leave edits uncommitted and report `COMMIT: none`. Do not touch `scripts/issue-1112-rt7-a-bolt.camj`.
- Tests must bite: break the code on purpose, confirm a test fails, then restore from a `cp` backup (never `git checkout`).
- React tests run with `NODE_OPTIONS=--no-experimental-global-navigator`. You cannot run a browser.
- Run and report with exit codes: `npm run build:gates`, each changed test file.
- Report: changes per file; tests; mutations; commands with exit codes; RISKS.
