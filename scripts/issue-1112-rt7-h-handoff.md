# Slice rt7-h: plain-text notes in Properties, plus a "Canned feature" label (Frank, round 7)

Frank (2026-10-31, screenshot of a Hex's Properties): "we should not use that orange colour for the messages? that is associated with 'AI slop' and I don't want it to trigger some discussions I don't want to be part of. maybe we can have just text and add 'Canned feature' somewhere there (maybe as a label?)"

The orange is `.properties-linked-face-note` (`src/styles/face.css` ~line 504): a 2px `border-left` in `var(--face-bottom)` with padding. It started as the note for a feature linked to the other face and has been reused for every Properties note: the canned shape summary (`data-testid="canned-shape-summary"` / `canned-shape-unknown`), the canned Z-source line (`CannedZSourceLine.tsx`, if rt7-b/rt7-d left it), the text summary (`text-summary`), the text-path refresh note (`text-path-source-missing`), and the linked-other-face note (`linked-other-face-note`).

What to build:
- Every one of these notes becomes **plain text**: no coloured bar, no callout box. Use the panel's normal secondary-text styling (an existing muted-text token, no new colour), the same size and line height, and enough spacing to read as its own line. Check the 3D/Around/Bottom variants use no other orange bar.
- A canned shape's Shape section gets a small **"Canned feature"** label right before the summary line. Use the existing chip/badge style the panel already uses for small labels (for example the style of "AROUND" next to Authoring face), in a neutral colour, not orange. One label per canned shape, on every canned kind (rotary and flat: ellipse, slot, n-gon, Turn, Polygon, Thread, Flutes, …).
- The purple "GENERATED" box below stays as is.
- The new label text goes in `en` and every other locale under `src/i18n/locales/`, with real translations (de "Vorlagen-Element" or better, fr, es, zh-CN). Run `npm run check:i18n`.
- If `.properties-linked-face-note` has no other user, rename it to something that says what it is now (for example `.properties-note`) and update every use. Otherwise keep the name and change its style.

Tests: each of the five notes renders without the orange bar (assert the class or style, not a colour literal, if the repo's color-literal check forbids those). The "Canned feature" label is present for a canned shape and absent for a plain feature. Mutation: put the border back (the test fails). Update any `e2e/` spec that selects the old class and list it in RISKS. `npm run check:colors` must pass.

Off limits: everything else, including the GENERATED box and the notes' wording.

## Rules

- You work in your own worktree, based on the rt7-g branch. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider. Put anything that needs a decision in RISKS.
- `gh` may be blocked in your sandbox.
- Leave edits uncommitted and report `COMMIT: none`. Do not touch `scripts/issue-1112-rt7-a-bolt.camj`.
- Tests must bite: break the code on purpose, confirm a test fails, then restore from a `cp` backup (never `git checkout`).
- React tests run with `NODE_OPTIONS=--no-experimental-global-navigator`. You cannot run a browser.
- Run and report with exit codes: `npm run build:gates`, `npm run check:i18n`, `npm run check:colors`, each changed test file.
- Report: changes per file; tests; mutation; commands with exit codes; RISKS.
