---
status: current
authoritative-for: execution ledger for the issue #341 theme-tokenization slices
last-verified: 2026-07-21
---

# Integration Handoff — Complete theme tokenization (issue #341)

> The GitHub issue remains the approved plan and source of truth; this file
> records execution state. Do not store tokens, raw environment values, or
> unredacted provider debug output here.

## Role and stop condition

The integration manager turns approved issue #341 into worktree slices,
independently reviews and verifies each slice, and merges only accepted commits
into the integration branch. Stop when every acceptance criterion in #341 is met
and the build, contrast gate, and e2e smoke are green.

## Integration state

- Integration branch: `ui-color-scheme-redesign-25bc8d`
- Integration worktree: `/Users/frankp/Projects/worktrees/purecutcnc/distracted-shtern-075cc1`
- Base commit: `d04b99077d1f0f399c6ada955911d72c6e6a39d6`
- Approved issue and plan: https://github.com/PureCutCNC/purecutcnc/issues/341
- Manager session: 2026-07-21
- Status: `ready for user review` (all slices merged; awaiting visual sign-off)
- User authorization for credential-backed worker dispatch: recorded 2026-07-21 —
  "you can dispatch deepseek agent when it will help to save on tokens ... run in
  parallel when possible".

## Global rules

- Slices run **concurrently only when their allowed-file sets are provably
  disjoint** (user-authorized deviation from the one-slice-at-a-time default;
  the binding constraint remains that no two agents ever edit the same file).
- Every worker runs in its own task worktree branched from the current
  integration tip, never in the integration checkout.
- The worker may use `bypassPermissions` only through the project launcher in
  explicit implementation mode.
- The manager owns worktree/branch creation, review, merge, cleanup, issue-plan
  updates, browser regression, push, and PR decisions.
- Reject any worker result without exactly one expected task commit, a clean
  task worktree, scoped changes, and truthful required-check results.
- Tear down controlled Chrome before the dev server.

## Colour policy (the contract every slice follows)

`src/theme/tokens.ts` is the single authority for themeable colour. A colour
literal (`#rgb`, `#rrggbb`, `rgb()/rgba()`, `0xRRGGBB`) may appear **only** in:

1. `src/theme/registry.ts` and `src/index.css` — the built-in theme definitions;
2. `src/theme/palette.ts` — canvas/Three palette defaults;
3. the print/export palette module (document output, deliberately
   theme-independent: printed paper has no dark mode);
4. an explicit allowlist for developer-only diagnostics.

Everything else reads a token: `var(--<token>)` in CSS, `palette.*` in canvas and
Three renderers.

Two build guards keep this from drifting back:

1. **`scripts/check-color-literals.ts`** (wired into `npm run build`) fails on any
   colour literal outside the locations above.
2. **`src/theme/editorCoverage.test.ts`** fails when a palette field has no
   `tokens.ts` entry (which would resolve to `undefined` at runtime *and* be
   invisible in the Theme Editor), when a token has no palette field, when the
   dark and light palettes declare different fields, when a token sits in a group
   the editor does not render, when a built-in theme is missing a token value, or
   when **a token is read by nothing** — a dead control the user can edit with no
   effect.

### Deprecating a token

A token that has fallen out of use cannot simply be deleted:
`validateCustomTheme` rejects unknown keys, so removing a released token makes
every custom theme that overrode it fail to import outright.

Mark it instead:

```ts
css('bg', 'surfaces', 'App background', 'Superseded by surface-app; no rule reads var(--bg).')
```

A deprecated token is hidden from the Theme Editor (`editableThemeTokens()`) but
stays a valid key, so old theme files still import. Delete the entry only once no
saved theme can still reference it. The guard also asserts the converse: a token
marked deprecated that is still read fails, so the note cannot go stale.

Translation coverage needs no extra guard: every locale namespace is typed
`Record<keyof typeof <ns>En, string>`, so `tsc` already fails when an English
string has no translation in `de`/`es`/`fr`/`zh-CN`. Localizing the token labels
themselves is tracked separately in issue #343.

## Manager-owned work (not delegated)

| Phase | Scope | Status |
| --- | --- | --- |
| P1 | Light-theme re-tone (warm sepia → cool blueprint) in `index.css` + `registry.ts` + `palette.ts` | done |
| P2 | Token architecture: new semantic families in `tokens.ts`/`palette.ts`/`registry.ts` | done |
| P6 | Regression guard: `scripts/check-color-literals.ts`, wired into `npm run build` | done |
| P7 | Verification: build + contrast gate green, e2e smoke, visual pass | build/contrast green; visual pass pending user |

## Slice ledger

| Slice | Scope | Base commit | Task branch/worktree | Worker status | Manager review | Accepted commit / merge | Required checks | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Centralize print/export colour literals | `a02228c` | `feat/issue-341-print-palette` | `complete` | `accepted` | `cea22b1` → merge `58346e4` | build gate passed | Verified: 46 colours out, 46 in, none lost or invented. Worker reported `COMMIT: none`; manager committed. |
| S2 | CSS literals → `var(--…)` | `9359dbc` | `feat/issue-341-css-tokens` | `complete` | `accepted` | `e3c5997` → merge `b23ca9e` | build gate passed | tablet/dialog/about to zero; layout.css 142→24. Worker reported `COMMIT: none`; manager committed. |
| S3 | Canvas renderers → palette tokens | `9359dbc` | `feat/issue-341-canvas-tokens` | `complete` | `accepted` | `94818b7` → merge `0d23887` | build gate passed | 4 renderers to zero. Silently mapped 10 alpha-variant literals instead of reporting; manager corrected. Worker reported `COMMIT: none`. |
| S4 | 3D/simulation → palette tokens | `3c94c8a` | `feat/issue-341-three-tokens` | `complete` | `accepted` | `24004cb` → merge `52a1bd8` | build gate + colour guard passed | 23 role-named `three.*` tokens; lighting exempted not tokenized. Committed correctly. Surfaced an orange 3D selection highlight the manager then re-coloured. |

## Slice instructions

### S1 — Centralize print/export colour literals

**Goal:** Move every hardcoded colour in the document-output renderers into one
new `printPalette` module, so print colours are named and centralized while
remaining deliberately theme-independent.

**Allowed files:**

- `src/engine/designPrint/printPalette.ts` (new)
- `src/engine/designPrint/svg.ts`
- `src/engine/designPrint/html.ts`
- `src/engine/operationBooklet/pdf.ts`
- `src/components/canvas/operationSnapshot.ts`
- `src/engine/designPrint/INDEX.md` or nearest `INDEX.md` (maintenance rule)

**Forbidden files:**

- `src/theme/**`, `src/index.css`, `src/styles/**`
- `src/components/canvas/**` except `operationSnapshot.ts`
- any locale file under `src/i18n/**`

**Invariants:**

- Rendered output is **visually identical**: every colour keeps its exact value.
  This is a pure extract-and-name refactor, not a re-colour.
- Print colours stay independent of the UI theme — do not import from
  `src/theme/**`.
- Exported function signatures are unchanged.

**Required checks:**

```bash
scripts/build-summary.sh
```

### S2 — CSS literals → `var(--…)`

**Goal:** Replace every remaining colour literal in the stylesheets with the
matching theme token.

**Allowed files:** `src/styles/layout.css`, `src/styles/tablet.css`,
`src/styles/dialog.css`, `src/components/about/about.css`

**Forbidden files:** `src/index.css` (theme definitions), `src/theme/**`, all TS/TSX.

**Invariants:** No visual change beyond colour source; use the closest existing
semantic token; never invent a new `--` name (the manager adds tokens in P2).

### S3 — Canvas renderers → palette tokens

**Goal:** Replace the remaining canvas colour literals with `palette.*` reads.

**Allowed files:** `src/components/canvas/{previewPrimitives,scenePrimitives,
dimensionRendering,draftHelpers,measurements,stlTopViewRenderer,SketchCanvas}.ts(x)`,
`src/sketch/useAxisLock.ts`

**Forbidden files:** `src/theme/**`, `src/index.css`, `src/styles/**`,
`src/engine/**`

**Invariants:** `max-lines` ratchets must not grow; the debug `sourceMarkerColor`
palette stays literal (allowlisted diagnostics).

### S4 — 3D/simulation → palette tokens

**Goal:** Replace `Viewport3D` / `SimulationViewport` colour literals with
Three-palette tokens.

**Allowed files:** `src/components/viewport3d/Viewport3D.tsx`,
`src/components/simulation/SimulationViewport.tsx`

**Forbidden files:** `src/theme/**`, `src/components/canvas/**`, `src/styles/**`

**Invariants:** Toolpath overlay colours must stay consistent with the 2D canvas
and the CSS legend swatches.

## Integration verification

- Accepted commits and merge order: S1 `58346e4` → S3 `0d23887` → S2 `b23ca9e` → S4 `52a1bd8`,
  with manager commits for the light re-tone, token architecture, guard, and final migrations.
- Repository checks: `npm run build` green (docs, lint, colour guard, tsc, 127 test files, vite);
  theme parity and contrast gates green with zero blocking findings.
- Colour literals outside the allowed files: **0** (was 349 at the start of the migration).
- Browser/tablet checks: `npm run test:e2e` — 70 passed, 0 failed. The four
  `appearance.smoke.spec.ts` guards initially failed because they pinned exact light-theme
  colour literals; they now resolve the expected colour from the theme registry, so they keep
  their legibility intent without breaking on a re-tone.
- Visual pass over both themes on a real screen: still owed by the user.
- Known limitations or deferred work: none — #341 defers nothing to a follow-up.

### Lessons for the next delegated effort

- Three of four workers finished with `COMMIT: none` despite completing the work and passing
  the build gate. The S4 prompt added an explicit "you MUST commit and verify with `git log -1`"
  instruction and that worker committed correctly — fold that line into the prompt template.
- Fresh task worktrees have no `node_modules`, so the first build gate dies with exit 127.
  Pre-install after `dispatch-task.sh` creates the worktree, or teach the script to do it.
- "If no token fits, STOP and report it" was ignored by S3, which silently mapped ten
  alpha-variant literals to near-matching tokens. Ask for an explicit unmapped-literal list in
  the completion block rather than relying on `RISKS`.
