# Slice rt6-e: Follow line on Around stops short of a larger neighbouring section, and says so (item 41, safety)

Frank (2026-10-31, `work/bolt-test-01.camj`, 30° V-bit Follow line "Engrave" on a Thread over a Ø0.75 Turn): the start of the thread cuts into the Hex next to it. The Thread starts at 1.5 where the Hex (start 1.0, length 0.5) ends; at 0.122 deep the V-bit is ~0.065 wide at the surface, so its flank reaches ~0.033 into the Hex face. Follow line (`src/engine/toolpaths/carving.ts`, guide loop ~line 392) puts the tool centre on the guide from end to end; it already splits guides around clamp keep-outs (`splitGuideFragmentsOutside`, `clampKeepOutPaths`, with `appendClampBlockedWarnings`) and region masks, but nothing keeps the cutter body off a neighbouring section that is larger than the surface the guide is cut on. Decision (Frank): **trim and warn** — a safety rule, not an option.

- For a Follow line operation on the Around face (round bar, and square bar where Around sheet work is allowed), trim each guide fragment where the cutter body, at its actual cut levels, would enter material outside the guide's own surface that must stay: a Polygon/Hex, a Turn of larger diameter, uncut bar next to a Turn, a placed model band — i.e. any along-position whose material surface is above the guide's surface (its feature Z top in the bar's Top-like frame; resolve neighbours with the existing surface index in `src/store/helpers/rotarySurface.ts` / the rotary frame helpers rather than a new geometry model). Use the real cutter profile: V-bit half-width at the height of the neighbour's surface (`(height above tip) · tan(angle/2)`, capped at the tool radius), flat/ball by radius. Reuse the clamp keep-out split for the trimming so ordering, link moves and lead-ins behave as they do around clamps.
- Warn once per trimmed feature with a new warning code (all locales): which feature, which end or how much, and what it stays clear of, e.g. "Thread: stopped 0.033 in short of Hex at the start so the cutter does not cut into it." A guide trimmed away entirely gets a clear warning that nothing was cut and why.
- Applies to every guide on Around (Thread, Flutes, hand-drawn lines and engravings). Top/Bottom faces and every other operation kind are unchanged; Around output with no conflicting neighbour stays byte-identical.

Tests: the bolt case (Thread next to a Hex, 30° V-bit, 0.122 deep) — trimmed by the computed amount within tolerance and warned; flat endmill trims by its radius; a guide with clear space either side is byte-identical to before; a circumferential line closer than the cutter half-width to a shoulder is removed with the "nothing cut" warning; a larger Turn neighbour and an uncut-bar neighbour both trim. Mutations: ignore the neighbour (no trim); use tool radius for the V-bit instead of its width at that height; drop the warning. Check the simulation of the bolt file no longer removes Hex material at the thread start (state how you checked without a browser, e.g. the swept-cutter test helpers).

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

