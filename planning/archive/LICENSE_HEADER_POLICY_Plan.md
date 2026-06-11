---
status: Done
created: 2026-06-10
---

# License Header Policy Plan

> Approval: requested directly by the user in-session ("lets add the
> instructions and also add missing headers as part of this change"), riding on
> the same branch as `OPERATION_HINT_SELECT_ALL_Plan.md`.

## Goal

Make the Apache 2.0 file header an explicit, documented rule and bring the
codebase into compliance. Today 141 of 183 `src/**/*.ts(x)` files carry the
header as an undocumented convention; 42 do not, and no instruction file
mentions it.

## Approach

- Add a line to AGENTS.md "Coding Standards": every `src/**/*.ts(x)` file
  starts with the Apache 2.0 license header.
- Prepend the exact existing 15-line header block (uniform across all 141
  files: "Copyright 2026 Franja (Frank) Povazanj") to the 42 files missing it,
  including test files and `.d.ts` files. No other content changes.

## Files affected

- `AGENTS.md` — one new Coding Standards bullet.
- 42 files under `src/` — header block prepended (mechanical; list derivable
  via `grep -rL "Licensed under the Apache License" src --include="*.ts" --include="*.tsx"`).

## Tests

None — comment-only change. `npm run build` (tsc + tests + vite) verifies
nothing breaks.

## Open questions / risks

- None. Header text is byte-identical to the existing convention.

## Out of scope

- Headers for non-TypeScript files (CSS, scripts/, configs).
- A lint rule or CI check enforcing the header (could be a follow-up).
