# Slice rt6-c: show which surface a Thread/Flutes is cut from, and always follow it (item 39, extended)

Frank (2026-10-31): "I am still not sure if I can verify that the thread floats on top of turn and it changes if I change turn diameter." The behaviour exists but nothing shows it: `src/store/helpers/rotarySurface.ts` resolves the surface under a Thread/Flutes band (`rotaryPatternSurface`, kinds `bar`, `turn`, `model`, `twoDiameters`, `step`, `taper`) and `syncRotaryPatternSurfaces` (~line 714, run on every store write via `syncRotaryPatternSurfaceProject` in `projectStore.ts`) moves a following row's Z span when a Turn changes. But it keeps a span that no longer matches the derived one as an "explicit override" (one the user typed in the Properties Z range), and such a Thread silently stops following. rt6-a (already on this branch) hid that Z range for Thread/Flutes/Turn/Polygon and added a read-only line in Properties.

- **Show the surface** in rt6-a's read-only line for Thread/Flutes: the depth and what it is measured from, with that surface's diameter, e.g. "Depth 1.20 mm below Turn 1 (Ø 30.00 mm) · set in Edit Thread…", "Depth 1.20 mm below the bar (Ø 40.00 mm) · …". For the warned kinds (`model`, `twoDiameters`, `step`, `taper`) it says it is measured from the bar, matching the existing warning text (reuse `rotaryPatternSurfaceWarning` wording/keys where possible). Turn/Polygon's line is unchanged.
- **Name the surface's Z** (Frank, 2026-10-31): Around features store Z as a height from the bottom of the bar (axis at half the bar thickness, bar surface at the thickness), so a Ø0.75 Turn on a 1.5" bar has its surface at Z 1.125. Add "surface at Z …" wherever a surface is described, in that same frame, formatted like other lengths: the Thread/Flutes line ("Depth 0.122 in below Turn 1 (Ø 0.75 in, surface at Z 1.125) · set in Edit Thread…", the bar case "below the bar (Ø 1.5 in, surface at Z 1.5)"), and the Turn's and Polygon's Properties line (Frank's screenshot shows the Turn summary "Turn · start 1.5 · length 6 · Ø0.75"; add "· surface at Z 1.125"; Polygon: its flats' Z, i.e. axis + across-flats/2, labelled as flats). Compute it from the same values the resolver uses, not a second formula.
- **Always follow:** drop the override rule. Every Thread/Flutes span is the derived one; a span that differs is rewritten to it, both on a write and when a project is loaded (route the load path through the same sync if it isn't already). An unchanged span stays byte-identical (no history churn). Format stays 3.3; say in RISKS that an old file with a hand-typed Thread Z now gets the derived depth on load.
- All locales, real translations.

Tests: unit — a Turn diameter change moves a following Thread's span; a row with a hand-typed (mismatching) span is now rewritten on write and on load; an unchanged project stays reference-equal. Mutation: restore the override rule. Unit: the Turn line's Z equals axis + Ø/2 on a round bar and on a square bar. e2e (not the "CAM and interaction" lane): place a Turn, put a Thread on it, change the Turn's diameter through Edit Turn…, and check the Thread's and the Turn's Properties lines show the new Ø and surface Z and its stored span moved by the radius change; then undo restores both.

Off limits: everything else.

## Rules for every slice (issue #1112, PR #1126, Frank's test round 6)

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

