# #1102 slice J — Face switch that does not look like tabs (Frank's test, item 3)

Frank, testing the branch: "top/bottom selection on top looks a lot like another set of tabs (like sketch/...). that looks confusing. maybe we render them in a different way so they do not look like tabs (maybe remove border lines?). also 'flipped about ...' should be next to bottom, and hide button moved next to it to the right."

Files: `src/components/layout/FaceSwitch.tsx`, the face-switch rules at the top of `src/styles/face.css` (`.face-switch*`, ~lines 20–175, including the tablet overrides), `appShell.face.*` keys only if you need one (you probably don't).

Today, in the desktop workspace header, the switch sits right of the Sketch / 3D view / Simulation tabs: a bordered group of segments (Top, Bottom, Around), each with an icon and label. The active one gets a coloured underline/border, so it reads as a second row of tabs. Then come the "Other side" eye button (`face-switch__ghost`) and, on Bottom, the "Flipped about X" chip (`face-switch__chip`, which can shrink to its icon on narrow headers; keep that behaviour and its `min-width: 34px`).

## Build
1. **Look like a toggle, not tabs.** No outer border around the group and no per-segment borders or underlines. Make it a compact segmented pill: a soft rounded background track (a token such as `var(--surface-translucent)` or a `color-mix` of `--line`), segments with rounded corners, and the active segment as a filled pill tinted with its face colour (top → `--accent`, bottom → `--face-bottom`, around → `--role-region`, the same colours the segments use today). Inactive segments are plain text-dim with a subtle hover. Keep the icon + label, sizes and the 44 px touch targets on tablet shells (`[data-shell-mode='tablet'|'tablet-compact']` rules). Keep `aria-pressed`, the busy-disabled state and every title/aria-label as they are. Vertically centre it in the header. It must not touch the header's bottom line the way the tabs do.
2. **Order:** segments, then the flip chip directly after them, then the Other side eye button to its right. Today the eye comes before the chip. Keep the chip's and the eye's own styles, but give them the same height as the pill so the row lines up.
3. Nothing else changes: same components, same props, same shrink rules (`.face-switch` keeps `flex-shrink: 1; min-width: 0`, segments `flex-shrink: 0`).
4. Test: extend `src/components/layout/faceSwitchExtras.test.ts` only if you add logic. This slice is mostly CSS, so say so in the report rather than inventing a test. Name the CSS selectors you changed.

## Checks
tsc, eslint on `FaceSwitch.tsx`, `npx tsx src/components/layout/faceSwitchExtras.test.ts`, the i18n check if you touched locales. The manager takes screenshots at 1440, 1280 and tablet 1024.

## Rules for every #1102 slice

Issue #1102 (approved by Frank; these follow-up slices come from his hands-on test of the branch, 2026-10-24): UI-only cleanup of the setup and CAM panels before 0.6.0 ships. Hobby scope: no new options, each item removes, hides, shrinks or moves an existing control. No change to toolpaths, G-code, machine profiles or the project file format; a saved project opens and exports exactly as before. Read `INDEX.md`, `AGENTS.md` (Coding Standards), then the files named below on this branch (it is based on `integration/0.6.0`, which differs from `main`).

- **Off limits:** every file not named in your slice. Slices A–G of #1102 are already merged into this branch; read their code as it is now. Other slices running at the same time: I (`CAMPanel.tsx`, `App.tsx`, `CamSetupSectionView.tsx`, `src/components/cam/` helpers), J (`FaceSwitch.tsx`, `FaceBanner.tsx`, the face-switch block of `src/styles/face.css`), K (`NewProjectDialog.tsx`, the new-project block of `src/styles/dialog.css`). Shared files you may edit only in the block that belongs to your slice: `src/styles/face.css`, `src/styles/layout.css`, `src/styles/dialog.css`, and the locale modules.
- **Do not touch `e2e/**`.** The manager runs and fixes the browser specs. In the report, list every user-visible label, aria-label, title or class you changed, removed or renamed, so the manager can update the specs.
- **Keep accessible names stable where the issue does not change them** (aria-labels used by tests and screen readers), even when the visible text gets shorter.
- **Locales:** five packs, `src/i18n/locales/{en,de,fr,es,zh-CN}/`. Add each new key to all five, in the same position as in `en`, with a real translation (see `src/i18n/GLOSSARY.md`). Remove each key your change leaves unused from all five. Never change an existing value you did not mean to change. Run `npx tsx scripts/check-i18n-format.ts`.
- **New files** get the Apache license header copied from a neighbouring file. No `any`. No `process.` or `globalThis`.
- **Tests must bite.** Put every rule (what shows when) in a small pure function next to the component, with a `*.test.ts` using `node:assert/strict` like `src/components/cam/setupTargetHints.test.ts`. Run each mutation listed below by hand: back up with `cp`, break the line, run the test, confirm it fails, restore. Report each one.
- **This laptop is shared.** Do NOT run `npm test`, `npm run build`, `build:gates` or any Playwright/e2e command. Run only: `npx tsc -p tsconfig.app.json --noEmit`, `npx eslint <the files you changed>`, `npx tsx <each test file you added or changed, plus existing tests of the files you changed>`, and the i18n check. Give their exit codes.
- Leave the edits uncommitted; the dispatcher commits them.

## Report format
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, per item what you built, the locale keys added and removed, the labels / aria-labels / classes changed for the e2e specs, each mutation and whether it was caught, commands with exit codes, `RISKS` (anything you were unsure of or left out).
