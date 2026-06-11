---
status: Done   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-11
---

# Lint Gate Scope Plan

## Goal

Make `npm run lint` a meaningful app/source quality gate. Today `eslint .` reports 179 problems, of which 84 come from one-off diagnostic scripts in `scripts/` (`debug-*`, `trace-*`, `analyze-*`, `quick-*`, …) that are not maintained source. After this change, the default lint command covers only supported app/source files, so its output is actionable.

## Approach

Option B from `work/lint-cleanup-agent-tasks-2026-06-11.md` — make the command scope explicit in `package.json` rather than hiding `scripts/` via config ignores:

- `lint`: `eslint src vite.config.ts scripts/run-tests.ts scripts/lib`
  - `src` + `vite.config.ts` are the supported source surface.
  - `scripts/run-tests.ts` stays in the gate because it is the `npm test` runner (build-critical, currently lint-clean).
  - `scripts/lib` holds shared script helpers (`svg-path.js`); it is JS so the current TS-only config skips it, but listing it keeps intent explicit if it ever gains TS files. *(Drop this argument if ESLint warns about unmatched files — see risk below.)*
- `lint:scripts` (new, optional): `eslint scripts` — for anyone who wants to lint the diagnostic scripts on demand.
- No change to `eslint.config.js` rules or ignores; behavior of the linted files is untouched.
- Docs: update the `npm run lint` line in `AGENTS.md` (Build & Verify) to state that the default gate covers `src` + supported build/test scripts only, and that `scripts/` diagnostics are excluded (use `lint:scripts`).

Not chosen: Option A (`globalIgnores(['scripts/**'])`) — it would silently skip `scripts/run-tests.ts` too and make `eslint scripts` impossible without config gymnastics.

## Files affected

- `package.json` — change `lint` script scope; add `lint:scripts`
- `AGENTS.md` — one-line doc update for the lint command semantics
- `INDEX.md` — note on `scripts/` entry that diagnostics are outside the default lint gate (one line)

## Tests

No engine code touched; no unit tests needed. Verification is command-level:

```bash
npm run lint          # must report 0 scripts/ findings (95 src problems remain — expected)
npm run lint:scripts  # still reports the 84 diagnostic-script problems
npm run build         # must pass
git diff --check
```

## Open questions / risks

- `eslint <file.js>` with a TS-only flat config can emit a "file ignored because no matching configuration" warning. If `scripts/lib` (JS) triggers that, it will be dropped from the `lint` arguments and noted in the doc line instead.
- `npm run lint` will still exit non-zero (95 `src` problems) until Task 2/3 land — that is expected and documented.

## Out of scope

- Fixing any `src` lint failures (Task 2 / Task 3).
- Cleaning or deleting diagnostic scripts.
- Adding lint to CI.
