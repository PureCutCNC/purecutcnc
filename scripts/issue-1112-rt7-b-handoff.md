# Slice rt7-b: no Z-source line for a Turn or a Polygon/Hex (Frank, round 7)

Frank (2026-10-31): in a Turn's properties, the line "Diameter 0.75 in · set in Edit turn…" (`featureTree.properties.canned.zSource.turn`, built in `src/cannedShapes/zSource.ts` ~line 93) repeats what the Turn's own description line already shows, since rt6-c added the diameter and "surface at Z". He said: "I don't think we need to show this again for turn", then "same for the hex": the Polygon/Hex line "Across flats {value} · set in Edit polygon…" (`zSource.polygon`, ~line 97) goes too.

- Show no Z-source line for a Turn or a Polygon/Hex. Thread and Flutes keep theirs unchanged.
- Remove the now-unused `zSource.turn` and `zSource.polygon` keys from `en` and every other locale under `src/i18n/locales/`, and any type or registry entry that names it. No other locale value changes.
- Update `src/components/feature-tree/cannedZRange.test.ts` (and any other test or `e2e/` spec that asserts the Turn line) so it asserts the line is **absent** for a Turn and a Polygon/Hex and still present for Thread and Flutes.
- Mutations: show the Turn line again, then the Polygon line again; each absence test must fail.

Off limits: everything else, including the Turn's and Polygon's own description lines.

## Rules

- You work in your own worktree, based on the rt7-a branch. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider. Put anything that needs a decision in RISKS.
- `gh` may be blocked in your sandbox.
- Leave edits uncommitted and report `COMMIT: none`. Do not touch `scripts/issue-1112-rt7-a-bolt.camj`.
- Tests must bite: break the code on purpose, confirm a test fails, then restore from a `cp` backup (never `git checkout`).
- React tests run with `NODE_OPTIONS=--no-experimental-global-navigator`. You cannot run a browser; list in RISKS any `e2e/` spec you change.
- Run and report with exit codes: `npm run build:gates`, `npm run check:i18n`, each changed test file.
- Report: changes per file; tests; mutation; commands with exit codes; RISKS.
