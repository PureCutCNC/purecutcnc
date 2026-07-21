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
- Status: `slice in progress`
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
Three renderers. Phase 6 adds a build check that fails on any literal outside
those locations.

## Manager-owned work (not delegated)

| Phase | Scope | Status |
| --- | --- | --- |
| P1 | Light-theme re-tone (warm sepia → cool blueprint) in `index.css` + `registry.ts` + `palette.ts` | in progress |
| P2 | Token architecture: new semantic families in `tokens.ts`/`palette.ts`/`registry.ts` | in progress |
| P6 | Regression guard: build check + allowlist | not started |
| P7 | Verification: build, contrast gate, e2e smoke, visual pass | not started |

## Slice ledger

| Slice | Scope | Base commit | Task branch/worktree | Worker status | Manager review | Accepted commit / merge | Required checks | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Centralize print/export colour literals | `d04b990` | `feat/issue-341-print-palette` | `dispatched` | `pending` | `-` | `scripts/build-summary.sh` | Independent of P2 |
| S2 | CSS literals → `var(--…)` | `-` | `feat/issue-341-css-tokens` | `not started` | `pending` | `-` | `scripts/build-summary.sh` | Needs P1+P2 |
| S3 | Canvas renderers → palette tokens | `-` | `feat/issue-341-canvas-tokens` | `not started` | `pending` | `-` | `scripts/build-summary.sh` | Needs P2 |
| S4 | 3D/simulation → palette tokens | `-` | `feat/issue-341-three-tokens` | `not started` | `pending` | `-` | `scripts/build-summary.sh` | Needs P2 |

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

- Accepted commits and merge order: `<pending>`
- Repository checks: `<pending>`
- Browser/tablet checks: `<pending>`
- Known limitations or deferred work: none — #341 defers nothing to a follow-up.
