# Slice rt4-d: false "Some selected target features are missing" on a Flutes target (item 34)

File (read only, don't commit): `/home/frankp/Projects/purecutcnc/work/thread-on-turn-test-01.camj`. Operation `Engrave 3` (`op0017`, follow_line, Around setup `su0006`) targets Flutes `f0015` (definition `f-0016`: canned flutes, start 3, length 2, count 4, twist 1, depth 0.1875, over Turn `f0002`'s span 1–5). The operation DOES generate its toolpath, but its Properties show "Some selected target features are missing"; "Use current selection" doesn't clear it. Engrave / Engrave 2 on Thread and Thread 2 in the same file show no warning.

- Find the check that raises this warning (grep the locale text and its warning code) and how it resolves target ids, versus how toolpath generation resolves them (`src/engine/toolpaths/generateOperation.ts`, setup target helpers). It probably resolves canned Flutes differently (expanded/child ids, an unknown canned kind, or a Turn-adjusted surface).
- Make the check resolve targets exactly as generation does (share the resolver if possible). A target that exists and generates must not be reported missing; a target that's really gone still is.
- If a target exists but yields no geometry, say that instead of "missing" (a separate, accurate message).

Tests: Engrave on Flutes and on Thread, on a Turn and on plain bar stock: no missing warning; a deleted target: warning; a target with no geometry: the new message. Mutation: resolve canned Flutes by the old path.

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

