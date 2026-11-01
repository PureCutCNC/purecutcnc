# Slice rt7-d: one line for Thread and Flutes in Properties (Frank, round 7)

Frank (2026-10-31, screenshot of a Thread's Properties) asked to merge two lines into one:
- under **Shape**: "Thread · 1-start · pitch 0.2 · length 2" (`cannedSummary`, `src/components/feature-tree/PropertiesPanel.tsx` ~line 1533/1747)
- under **Instance**: "Depth 0.122 in below Turn (Ø 0.75 in, surface at Z 1.125) · set in Edit thread…" (`CannedZSourceLine.tsx`, `zSource.threadSurface` / `zSource.thread`, and the same for flutes)

What to build:
- For Thread and Flutes, show **one** line in the Shape section, where the summary is now. It is the summary followed by the depth and the surface clause of the **selected instance**, for example "Thread · 1-start · pitch 0.2 · length 2 · depth 0.122 in below Turn (Ø 0.75 in, surface at Z 1.125)". Without a surface (no Turn under it), it reads "… · depth 0.122 in" plus whatever the current no-surface text says about the surface.
- Drop "· set in Edit thread…/flutes…": the Edit button sits right under the line.
- Remove the separate line from the Instance section for Thread and Flutes. If rt7-b (already merged in your base) has left no kind using `CannedZSourceLine`, remove the component and its now-unused keys. Otherwise keep it only for what still uses it.
- The depth and surface values and their computation are unchanged; only where and how they are shown changes.
- Locale keys: new or changed keys in `en` and every other locale under `src/i18n/locales/`, real translations, same position as `en`. Remove the keys that become unused. Run `npm run check:i18n`.

Tests: Thread on a Turn shows the single merged line with summary, depth and surface, and the Instance section has no Z-source line. Flutes the same. A Thread with no Turn under it shows the summary plus the depth. Other canned kinds' summaries are unchanged. Mutations: render the old Instance line again (the test fails); drop the surface clause from the merged line (the test fails). Update `src/components/feature-tree/cannedZRange.test.ts` and any `e2e/` spec that asserts either old line (grep "set in Edit", "surface at Z", "pitch") without weakening it, and list the specs in RISKS.

Off limits: everything else.

## Rules

- You work in your own worktree, based on the rt7-c branch. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider. Put anything that needs a decision in RISKS.
- `gh` may be blocked in your sandbox.
- Leave edits uncommitted and report `COMMIT: none`. Do not touch `scripts/issue-1112-rt7-a-bolt.camj`.
- Tests must bite: break the code on purpose, confirm a test fails, then restore from a `cp` backup (never `git checkout`).
- React tests run with `NODE_OPTIONS=--no-experimental-global-navigator`. You cannot run a browser.
- Run and report with exit codes: `npm run build:gates`, `npm run check:i18n`, each changed test file.
- Report: changes per file; tests; mutations; commands with exit codes; RISKS.
