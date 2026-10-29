# Slice rt2-a: small fixes (items 11, 12, 13, 14, 15)

11. **Panel collapse handle.** In the centre panel's tab bar the right-panel collapse handle (») sits left of the face control (`FaceSwitch`, placed by slice F3). Put » at the far right edge with the face control just left of it. Keyboard order follows the visual order: tabs → face control → ». Update `e2e/setupFaces.smoke.spec.ts` (the tab-order assertion added in F3/G3).
12. **Gear bore: first value doesn't refresh.** A gear with zero bore shows the bore field blank. Typing the first value doesn't update the previewed shape; later edits do. Cause is likely the zero-bore blur guard in `src/components/canvas/GearParameterPanel.tsx` (added in r3-1) treating blank → value as the untouched case. Blank → valid value must update the preview at once, both while creating and in the Edit panel. Keep the earlier rules: untouched zero bore stays valid, a cleared bore that was non-zero is refused with an error.
13. **Chuck presets: size only.** `src/store/helpers/roundWorkholding.ts` labels presets `BISON 3204 · 4"`. Show only the size (`3"`, `4"`, `5"`, `6"`, `8"`) wherever the label appears or is translated. Keep ids, dimensions, and the catalogue source in the code comment.
14. **Around: new canned shapes default to Subtract.** A gear created on the Around face came out as Add. On Around the bar is already solid, so a new canned outline shape created there (gear, ellipse, slot, n-gon, rounded/chamfered rect) must default to Subtract, by the same rule hand-drawn features use there (find it: `src/store/helpers/operationDefaults.ts` / `featureRoles.ts`). Round and square bars. Top/Bottom defaults unchanged.
15. **Turn icon.** The Turn icon (a rounded square) reads as a rounded rectangle. Draw a new one: side view of a turned part, a dash-dot centreline across with a profile mirrored above and below it, wide section on the left, curved neck, narrower section on the right. Same stroke, size and style as the other canned-shape icons (same sprite source; `npm run sync-icons`). Distinct from Polygon's hexagon and the rounded/chamfered rect at 16 and 24 px. Used everywhere Turn's icon appears.

Tests: 12 (blank → value updates preview, create and edit), 13 (labels), 14 (default per kind on Around, round and square; Top unchanged). 11 and 15 via the e2e spec / sprite build.

Off limits: `RotarySolidDialog.tsx`, `RotaryPatternDialog.tsx`, `CanvasCreationPanel.tsx`, `CannedShapeEditPanel.tsx` beyond item 12 (slice rt2-b), `faceOverlay.ts` (rt2-d), `CreationActions.tsx` (rt2-c), simulation engine (rt2-e).
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
