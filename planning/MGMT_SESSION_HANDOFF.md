# Handoff — Core-Arch Refactor "management session" (P6 DONE → P7 next)

> Written 2026-06-17 by the outgoing (Claude) mgmt session for the incoming **Codex-led** mgmt session.
> Read `AGENTS.md` + `ARCHITECTURE.md` first, then `planning/CORE_STATE_CANVAS_REFACTOR_Plan.md`.

## Your role
You are the **management / review / merge / cleanup** session for an approved, in-progress
architecture refactor of **PureCutCNC** (Vite + React + TS + Zustand). You do **NOT** write phase
code yourself: the user runs an **external coding agent** (Claude CLI / Codex) inside a per-round
**worktree**, then reports back. You then **review the actual diff → merge into the cumulative branch
→ build → lint → browser+tablet regress → update the ledger → push → clean up the worktree**, then
set up the next round and write the next agent prompt. (If the user prefers, you MAY implement a round
yourself in the round worktree — but you must STILL run the full review battery + build + lint + browser
regression before merging, exactly as if an external agent wrote it. Never merge unreviewed code.)

## The plan & ledger (authoritative)
- **`planning/CORE_STATE_CANVAS_REFACTOR_Plan.md`** (status: In progress). The top has a **Phase status
  ledger** — one row per phase, each holding a round-by-round running log. **Append a bullet every
  round.** Phase DoD is near the bottom. The ledger is the source of truth; trust it over this handoff
  if they disagree.

## Execution model (unchanged across the whole effort)
- ONE cumulative branch **`feat/core-arch-simplification`** off `main`. **Nothing hits `main`** until the
  entire effort ships as a single release.
- **Management worktree = `/Users/frankp/Projects/worktrees/purecutcnc/musing-lewin-fcef00`** (on
  `feat/core-arch-simplification`, has real `node_modules`). Run ALL management commands / builds /
  merges / dev-server from here. A fresh session may spawn elsewhere — always target
  `musing-lewin-fcef00` explicitly with absolute paths (the shell cwd can reset between commands).
- Each round = its own worktree off the cumulative tip, implemented externally, merged back by you with
  `git merge --no-ff`. **Re-push after every merge** (the user's Mac is flaky and wants backups).

## Current git state (VERIFY FIRST)
- Run: `git -C /Users/frankp/Projects/worktrees/purecutcnc/musing-lewin-fcef00 log --oneline -5` and
  `git worktree list`.
- **Cumulative tip ≈ `a559e7f`** (P6 guard round) **+ the P6-done/handoff bookkeeping commit on top**
  (the outgoing session committed "mark P6 done + add this handoff"). Confirm `git status` is clean and
  local == `origin/feat/core-arch-simplification`.
- **No round in flight. No `core-arch/*` worktree exists.**
- Ignore unrelated worktrees (`compassionate-cray-9d915a`, `feat-dxf-arc-simplification`,
  `pocket-offset-inner-first`, `zen-cerf-16e53a`, `lucid-morse-0b839a`, `friendly-napier-75b387`).

## Progress so far — P0–P6 COMPLETE (all merged + verified on the cumulative branch)
- **P0–P5 done** (see ledger): P0 stale-plan archive; P1 `useLocalStorageState`/`useOutsideDismiss`;
  P2 App.tsx 1457→506; P3 shared `src/commands/*`; P4 Toolbar split 1673→166; **P5 store-slicing**
  `projectStore.ts` 7040→363 (composition root, `ProjectStore` interface frozen, `max-lines` guard on
  `src/store/**`).
- **P6 (SketchCanvas hooks) ✅ DONE — `SketchCanvas.tsx` 6167 → 3809.** Every interaction state machine
  extracted into its own `src/components/canvas/use*.ts` (behavior-preserving, one machine/round,
  desktop+tablet verified): R1 `useDimensionEditWorkflow`, R2 `useConstraintWorkflow`, R3
  `useFilletWorkflow`, R4 `useMoveWorkflow`, R5 `useTransformExactWorkflow`, R6 `useOffsetWorkflow`,
  R7 `useCreationWorkflow`, R8 `useCanvasKeyboard`, R9 `useSnapPreview`, R10 `useCanvasContextMenu`,
  R11 `useClickPlacement` (handleClick ~498L verbatim), R12 `usePointerGestures` (pan/zoom/node-drag/
  marquee core ~1100L). Then a config-only **guard round** added `src/components/canvas/**` `max-lines`
  to `eslint.config.js` (hooks **1200**, `SketchCanvas.tsx` **3800**).
  - **Revised DoD (user-approved):** `<600` was **not** pursued — the shell legitimately retains the
    `draw` renderer (~787L) + JSX (~1216L) + imperative handle, which are NOT interaction machines. DoD
    = all interaction machines in their own hooks + guard ratcheted at the achieved size.
  - **R12 quirks worth knowing if you touch the gesture core:** the 11 gesture refs stay **shell-owned**
    (shared with click/context-menu + `clearTransientCanvasState`); `stopPan`/`stopNodeDrag` are kept as
    shell functions (passed via ctx + re-exported from `usePointerGestures`) to break the
    `useCanvasContextMenu` ↔ `usePointerGestures` cycle; `usePointerGestures` carries **4 necessary
    `// eslint-disable-next-line react-hooks/immutability`** directives on verbatim ref-mutations through
    ctx instances (verified: stripping them → 4 lint errors; behavior-neutral).

## P6 convention (the pattern every extraction round followed — reuse it for P7 panels)
The shell keeps broadly-shared refs/values (`canvasRef`, `drawRef`, `projectRef`, the view transform,
store selectors/actions, the picking store-state, and now the gesture refs) and passes each extracted
hook exactly what it needs via **one typed `ctx`**. Each hook **owns only its own machine's state/refs**
and **returns** what the shell's JSX/pointer/keyboard handlers reference. Hooks never reach into the
store independently (store actions arrive via ctx). State-mirror refs are assigned via `useLayoutEffect`,
never at render. Each hook: Apache license header with COPYRIGHT on **line 2**; exports a typed `XxxCtx`
+ a return interface + `useXxx`. **`SketchCanvasProps`/`SketchCanvasHandle` are a FROZEN public
contract.** Module-level helpers are imported directly; shell-local helpers shared across the shell are
passed via ctx. Verbatim moves only — verify with a token fingerprint (`if`/`else`/`.current` counts)
and, for big moves, a normalized `diff` of the function body old-vs-new.

## NEXT PHASE — P7 (Workflow-panel migration) — medium risk, **tablet-sensitive**
- **Goal (plan §"Phase 7"):** move the remaining ad-hoc canvas banners (copy-count input, placement
  hints, apply/cancel) onto the shared **`CanvasWorkflowPanel` / `useCanvasWorkflowPanel`** so desktop
  and tablet share ONE apply/cancel + focus-handoff path. DoD: "remaining canvas banners use
  `CanvasWorkflowPanel`; focus handoff verified both form factors." **Tablet verification required.**
- **Already on the shared panel** (do NOT re-migrate): `cutWorkflowPanel`, `joinWorkflowPanel`,
  `editWorkflowPanel`, `tapeWorkflowPanel`, `dimensionWorkflowPanel`, `dimensionDeleteWorkflowPanel`
  (wired ~lines 488–532 of `SketchCanvas.tsx`), plus the move/transform/offset/creation/constraint
  panels each workflow hook already builds via `useCanvasWorkflowPanel`.
- **Immediate next action:** SURVEY `SketchCanvas.tsx` for the remaining ad-hoc banner JSX that is NOT
  yet a `CanvasWorkflowPanel` (grep for inline banner/overlay/input JSX in the return; e.g. the
  copy-count input + placement-hint overlays). Group them into small, behavior-preserving rounds (likely
  far fewer/smaller than P6). **Consult the user** on the round breakdown before writing prompts, then
  drive the same per-round loop. P7 is the LAST refactor phase (Phase 8 is opportunistic inlining folded
  into whatever touches it — not a standalone phase).

## The per-round REVIEW BATTERY (run from the round's worktree, before merging)
1. `git status --short` clean + `git log --oneline <base>..HEAD` shows the round's commit(s). **If empty
   or files show `??`/` M` → the agent forgot to commit** (see gotcha) — do NOT merge; have the user get
   the agent to commit (one commit), or get explicit authorization, first.
2. `git diff --stat <base>..HEAD` — only the expected files (`SketchCanvas.tsx` + the touched banner
   component(s); for P7, `eslint.config.js` should NOT appear).
3. Frozen interface: the `SketchCanvasProps` / `SketchCanvasHandle` interfaces show no `+`/`-` lines.
4. Scope-boundary: machines/panels out of scope are untouched.
5. Move-completeness: migrated banners have no leftover ad-hoc definitions in the shell.
6. Hygiene: license header line 2; `grep -cE ': any\b|as any\b|eslint-disable'` == 0 for new code
   (carry pre-existing/load-bearing directives verbatim — do not gratuitously add new ones; if a move
   genuinely requires one, VERIFY it's necessary by stripping it and re-linting).

## MERGE + VERIFY recipe (from the mgmt worktree `musing-lewin-fcef00`)
1. `git merge --no-ff core-arch/<branch> -m "Merge P7 Round N: …"`.
2. `npm run build` — runs tsc + license-header check + **all 47 test files** + vite (does NOT run
   eslint). Benign "Not manifold" ManifoldError lines in test output are an expected in-test fallback
   log; green = `run-tests: all 47 executed test files passed`.
3. `npm run lint` SEPARATELY. **One PRE-EXISTING warning is expected and left as-is:** an unused
   `react-hooks/exhaustive-deps` directive in `SketchCanvas.tsx` (currently ~line **1776**; the line
   shifts only when edits happen above it). Zero NEW warnings, 0 errors. The `max-lines` guards now active
   on `src/components/canvas/**` (hooks 1200, SketchCanvas.tsx 3800) — a migration that grows the shell
   past 3800 effective lines will ERROR; keep P7 net-neutral-or-smaller on the shell.
4. **Browser + tablet regress** the round's surface. Load the **Badge** example (or a fresh project).
   Canvas pointer drags/hit-tests are NOT reliably scriptable — verify the runtime WIRING (panel renders
   / apply+cancel fire / focus handoff / keyboard dispatches / 0 console errors) in BOTH desktop
   (`1600x1000x2`) and tablet (`1366x1024x2,touch,landscape` + reload; the `.statusbar-shell-mode` element
   reads "tablet"), and lean on tsc + the 47 unit tests for behavior. One benign `goatcounter … localhost`
   warning is fine; `getImageData willReadFrequently` warnings are test-harness artifacts. For P7
   specifically: confirm each migrated panel's apply/cancel + the focus returns to the canvas, on both
   form factors.
5. Append the P7 ledger bullet; `git commit` the ledger; `git push`.
6. Clean up: `git -C <wt> status --short` empty; `git merge-base --is-ancestor <lastCommit>
   feat/core-arch-simplification`; `git worktree remove <wt>`; `git branch -D core-arch/<branch>`.
7. Set up the next round's worktree off the new tip + symlink node_modules, then write the agent prompt
   (model-agnostic, same guardrails) **inside a fenced code block** for copy/paste.

## Dev server + browser regression (you own the dev server)
- From `musing-lewin-fcef00`: clear `lsof -ti tcp:1420 | xargs kill 2>/dev/null`; start `npm run dev`
  **in the background**; wait via `curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null
  -w "HTTP %{http_code}\n" http://localhost:1420/`. (The dev-server background task exits 143 when you
  kill it — EXPECTED, not a failure.)
- **Browser driver — TOOLING NOTE for Codex:** the outgoing Claude session drove Chrome via the
  **chrome-devtools MCP** (`mcp__chrome-devtools__*`: new_page/emulate/navigate_page/evaluate_script/
  list_console_messages). If your runtime lacks that MCP, use whatever browser-automation you DO have
  (Playwright, a headless-Chrome script, etc.) to: load `http://localhost:1420/`, click the "Badge"
  example button, set the two viewports, dispatch synthetic events, and read `console` for errors. The
  store is NOT on `window` — drive via the UI only. Useful scriptable signals discovered during P6:
  pan/zoom ARE scriptable (wheel event + pointer drag change the 2D canvas; hash `getContext('2d')
  .getImageData(...)` before/after to detect view changes); `event.defaultPrevented` proves a handler
  ran (e.g. `onContextMenu`/`onWheel`); synthetic `PointerEvent`s with fake `pointerId`s throw a benign
  `setPointerCapture: No active pointer` — stub `Element.prototype.setPointerCapture` to a no-op for the
  test. On TABLET the left tree/toolbar rows render off-screen (negative x), so click them by dispatching
  the event on the DOM element via script rather than coordinate-clicking.
- **CRITICAL — after EVERY regression, KILL the controlled Chrome process BEFORE killing the dev
  server.** Leaving the heavy WebGL page running wedges WindowServer/AppleGPU and freezes/restarts the
  user's Mac (confirmed from crash logs). Order: kill the controlled-Chrome process (for chrome-devtools
  MCP: `pkill -f "user-data-dir=/Users/frankp/.cache/chrome-devtools-mcp/chrome-profile"`) → THEN
  `lsof -ti tcp:1420 | xargs kill`. See memory `feedback_close_browser_after_test`.

## Critical conventions & gotchas
- **AGENT-FORGOT-TO-COMMIT:** the agent's "single commit" report may be aspirational — the worktree can
  have the work UNCOMMITTED. The round commit is the agent's job, not yours (`feedback_no_commit_without_ask`).
  Review the working-tree diff + run build/lint, then ask the user to have the agent commit (one commit)
  or to explicitly authorize you, before merging.
- **Behavior-preserving moves only**; one machine/panel per round; typed `ctx` in, typed return out;
  never duplicate a body. `SketchCanvasProps`/`Handle` frozen.
- **You only commit:** mgmt bookkeeping (ledger, this handoff, the eslint guard) + verified `--no-ff`
  merges. **No `Co-Authored-By` / no "Generated with" footers** (repo rule). Don't commit beyond that
  without the user's ask.
- **Build vs lint:** build runs tsc+header+tests+vite but NOT eslint — run `npm run lint` separately.
  Always `npm run build` from the correct root before committing (`feedback_build_before_commit`).
- **Worktrees:** symlink node_modules from main into each new worktree:
  `ln -s /Users/frankp/Projects/purecutcnc/node_modules <wt>/node_modules`. **Never `rm -rf` a
  worktree's node_modules.** Confirm clean + `git merge-base --is-ancestor` before `git worktree remove`;
  `git branch -D` after. Base path: `/Users/frankp/Projects/worktrees/purecutcnc/`. **Edit only files
  under the active worktree.**
- Honor `feedback_no_premature_archive`: leave the plan In progress until the user does final acceptance
  of the WHOLE effort; nothing ships to `main` until the whole effort is done.
- A `cbm-code-discovery-gate` hook may block the Read tool on code files — retry once, or read via
  `git show <ref>:<path>` / `sed -n` / `grep`. Reading/editing plan `.md` works (retry once if blocked).

## Memories (auto-loaded; honor them): `project_core_arch_refactor` (updated through P6 done),
`feedback_close_browser_after_test`, `feedback_no_commit_without_ask`, `feedback_worktree_remove_check_first`,
`feedback_build_before_commit`, `feedback_no_coauthor`, `feedback_worktree_edits`,
`feedback_worktree_node_modules`, `feedback_no_premature_archive`, `feedback_no_preview`,
`feedback_work_folder_untracked` (keep handoff context in TRACKED files like this one, not `work/`).

## Immediate next action for the incoming (Codex) mgmt session
1. Verify git state (tip ≈ `a559e7f` + bookkeeping commit; clean; pushed; no round in flight).
2. **Survey P7:** grep `SketchCanvas.tsx`'s JSX return for ad-hoc banners/overlays NOT yet on
   `CanvasWorkflowPanel` (copy-count input, placement hints, apply/cancel). Map them and the focus
   handoff.
3. **Consult the user** on the P7 round breakdown, then drive the per-round loop (worktree → agent
   prompt → review battery → merge → build+lint → desktop+tablet regress → ledger → push → cleanup).
4. P7 is the final refactor phase. When it's done and user-accepted, the whole effort is ready to ship to
   `main` as one release (the user makes that call).
