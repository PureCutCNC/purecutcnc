# AGENTS.md — PureCutCNC

## What This Is

PureCutCNC is a browser-based 2.5D CAD/CAM application for CNC hobbyists. It collapses CAD sketching and CAM operation definition into a single workflow. Built with Vite + React + TypeScript, state managed by Zustand, with a Tauri wrapper for desktop builds. Read [`PROJECT.md`](PROJECT.md) for the product contract and safety boundaries.

## Code Map (read first)

Start every session by reading [`INDEX.md`](INDEX.md) at the repo root. It maps the codebase folder-by-folder and points to per-folder `INDEX.md` files for deeper detail. When you work inside a folder that has an `INDEX.md`, read it before exploring files there. Prefer the index over grepping blind.

**Maintenance rule:** when you add, rename, remove, or significantly change the purpose of a file, update the nearest `INDEX.md` in the same commit. If you create a new folder with non-trivial content, add an `INDEX.md` there and link it from the parent index.

## Codebase memory (MCP)

If the `codebase-memory-mcp` server is connected, prefer its graph tools (`search_graph`, `get_architecture`, `trace_path`, `get_code_snippet`, `search_code`) over blind grep for structural questions; fall back to Grep/Glob/Read for text content.

**Every tool takes a `project` argument that is the project *name*, not a filesystem path.** Call `list_projects` first and pass back the exact `name` it returns (the repo path with `/` replaced by `-`, e.g. `Users-frankp-Projects-purecutcnc`). Passing a path yields `{"error":"project not found or not indexed"}` — a wrong-argument error, not a broken server; retry with the name. If the repo isn't listed yet, run `index_repository` once. If calls repeatedly fail with `Connection closed`, the local graph cache is bloated with stale project graphs — prune it and retry.

## Workflow: Issue → Plan → Approve → Implement → PR

**Every task follows this loop, and every task gets an issue.** The only steps a change may skip are 2 and 3 (Plan and Approve), and only when the **Fast lane** below says so — nothing else here is optional. The plan can be tiny if the task is tiny; the point is that intent is written down, agreed, and traceable. Tasks are tracked on the GitHub Project board ([PureCutCNC project #1](https://github.com/orgs/PureCutCNC/projects/1)), **not** in checked-in plan files.

1. **Issue.** Open a GitHub issue for the work (`gh issue create`). Add it to the Project board, set the area label and Size, and set Status to `Backlog` (or `Ready` once planned).
2. **Plan.** Before changing any code, write the plan **in the issue** — in the body, or a follow-up comment if it grows. Do not create a `planning/*_Plan.md` file; the issue is the plan's home. **Fast lane: skipped — check below before you write a plan.**
3. **Approve.** Share the issue with the user and **wait for an explicit "approved" (or equivalent) signal**. Do not start implementation before approval. If the user asks for changes, edit the issue and re-confirm. On approval, set Status to `Ready`. **Fast lane: skipped — do not ask.**
4. **Implement.** Branch (`<type>/issue-<NN>-<slug>`), set the board Status to `In progress`, and implement against the plan in the issue. If the plan changes mid-flight, edit the issue so it stays the source of truth.
5. **PR when done.** When work is complete and the build is green, open the PR with `Closes #NN` in the description. Move Status to `In review`. The PR is created at the **end** as the delivery — it is not where the plan lives.
6. **Merge.** Merging auto-closes the issue and moves the card to `Done`.

Abandoned work: close the issue with a short reason; the board moves it to `Done`/closed. No file cleanup needed.

### Fast lane (waives steps 2–3 only)

A change that provably cannot affect machine output, saved projects, or the gates themselves may skip **Plan** and **Approve**. Nothing else changes: still an issue first (the branch name needs its number), still a branch, still green `npm run build`, still a PR with `Closes #NN`, still the board. Every rule in **Build & Verify**, **Git & Branching**, and **Coding Standards** applies unchanged — license header, no `any`, unit tests for engine fixes, e2e when rendered DOM / menu wiring / dialog behavior changes.

Eligibility is mechanical, never a judgment call. The two halves are answerable at different times.

**Before you write anything — protected paths.** You already know which files you will edit. If any is protected, it is the full lane; decided, no script needed. However small the diff: machine output and safety (`src/engine/toolpaths/**`, `src/engine/gcode/**`, `src/machine/**`, `src/utils/units.ts`), the `.camj` format and its migrations (`src/types/project.ts`, `src/store/helpers/projectFormat.ts`, `src/import/camj.ts`), the frozen `ProjectStore` contract (`src/store/types.ts`), and the process/gate machinery itself (`AGENTS.md`, `PROJECT.md`, `ARCHITECTURE.md`, `.github/**`, `.claude/**`, the gate scripts under `scripts/`, `package.json`, `tsconfig*.json`, `eslint.config.js`). [`scripts/check-fast-lane.sh`](scripts/check-fast-lane.sh) owns the authoritative list — add to it whenever a new gate lands.

**After implementing, before you commit — size.** This needs a real diff, so it cannot be answered earlier. The script re-checks the paths too, so a file set that grew mid-implementation is still caught here:

```bash
npm run check:fast-lane
```

It measures against `git merge-base origin/main HEAD` and passes at ≤ 3 changed files and ≤ 25 changed lines (added + deleted). Test files (`**/*.test.ts(x)`, `e2e/**`) are exempt from both counts — never trim a test to fit the budget. Generated output (`public/icons.svg`, `package-lock.json`) is counted; if regenerating it blows the budget, take the full lane.

Green → skip Plan and Approve. Red → full lane: write the plan into the issue and wait for approval.

**Do not ask whether you may use the fast lane.** A green check is the authorization. Asking reintroduces exactly the round-trip the lane exists to remove.

**Label the PR `fast-lane`.** The `fast-lane-guard` CI job ([`.github/workflows/fast-lane-guard.yml`](.github/workflows/fast-lane-guard.yml)) re-runs the check on every labeled PR, so a labeled PR that does not meet the criteria cannot merge.

**Growing past the criteria converts the change to the full lane.** The check failing is the decision, not the author's read of it: stop before the next commit, write the plan into the issue, wait for explicit approval, drop the label. Never split a change across PRs to stay under the budget.

**Audit, monthly.** Every merged PR since the last audit must have either the `fast-lane` label or an approval on its issue predating the branch's first commit — a PR with neither is a process escape.

```bash
gh pr list --state merged --limit 50 --json number,title,labels,mergedAt
```

Re-run the eligibility check against each labeled PR's merge base. If fast-lane PRs exceed a third of the window, the criteria are being stretched — tighten them.

## The Backlog Contract

The workflow above governs how work *enters*. This section governs how it
*leaves* — because without it the tracker fills with unranked cards faster than
they can ever be worked. It has happened twice: a root `TODO.md` grew until it
was migrated wholesale into 27 issues (#185–#211) in one sitting, and those sat
unranked for nine weeks. Converting a list into cards does not convert it into
decisions.

Five rules. Four are enforced by
[`.github/workflows/backlog-hygiene.yml`](.github/workflows/backlog-hygiene.yml)
(logic in [`scripts/backlog-hygiene.ts`](scripts/backlog-hygiene.ts)), so they
hold whether or not anyone is paying attention.

### R1 — Every open issue carries a Priority

Priority is GitHub's **native organization issue field**, not a project field.
It lives on the issue itself, so it shows on the issue page, survives outside
the board, and is filterable straight from the issues list. The project board
projects the same field, so the board and the issue can never disagree.

| Priority | Meaning | Cap |
| --- | --- | --- |
| `Urgent` | Broken, blocking, or actively in progress | 5 |
| `High` | Committed to the current release cycle | 10 |
| `Medium` | Real and accepted, but unscheduled | uncapped; decays |
| `Low` | Kept only while someone is actively arguing for it | uncapped; decays |

`Medium` and `Low` both decay. There is deliberately no permanent "Someday"
tier — that bucket is where backlogs go to rot. Anything that cannot be argued
to at least `Medium` today should be closed today; closed is not deleted, and
closed issues stay searchable and reopenable forever.

The caps are the point, not decoration: more than five `Urgent` means nothing is
urgent, more than ten `High` means nothing is committed. Anything without a
Priority is labelled `needs-priority` automatically.

### R2 — Decay: 60 days quiet, 14 days' notice, then closed

An open issue that is **not** `Urgent` or `High` — i.e. `Medium`, `Low`, or
unprioritized — and has had **no activity for 60 days** gets a `stale` label and
a comment. If nothing happens in the next **14 days**, it is closed as *not
planned*. Any comment, edit, label, or priority change resets the clock.

Keeping something alive costs one sentence. That is the design: the sentence
*is* the act of valuing it.

Never decays — external reports (R3), `Urgent`/`High`, anything with an
assignee, anything past `Backlog` on the board, and `pinned`.

The bet this rule makes is that **closing a speculative item costs nothing,
because the ones that matter come back with better evidence than the original
filing**. That is not a hope; it is the observed behaviour of this tracker.
#196's polish list contained `[ ] Non-rectangular tabs`, untouched from
2026-06-25. On 2026-08-02 an outside user filed #414 — smooth tabs — with a
working branch and a screenshot.

### R3 — External reports are marked automatically and never decay

Any issue opened by someone whose `author_association` is not
`OWNER`/`MEMBER`/`COLLABORATOR` is labelled `external-report` on arrival.

This is the most valuable rule here because it requires no discipline at all.
Roughly 6% of this repo's issues come from outside, they are the highest-signal
ones, and before this label they were visually identical to our own speculation.
The digest tracks any that have gone 14 days without a reply.

### R4 — One weekly digest that cannot itself become clutter

The workflow **rewrites the body** of the single issue labelled
`backlog-digest`; it never comments, so it never grows. It reports counts per
Priority, cap breaches, unranked issues, external reports awaiting a reply, and
— importantly — **what will go stale in the next 14 days**, so a rescue is
always possible before the warning, not after.

### R5 — Intake: do not file speculative scope as an issue

Open an issue only for work that is:

1. a defect, or
2. externally requested, or
3. something you intend to start this cycle.

Ideas that are none of these do not get a card. This is the only rule with no
mechanical enforcement — R2 is its backstop. Speculative issues filed anyway
decay in 74 days without anyone lifting a finger.

### Operating notes

- Both the 60/14 windows and the caps are constants at the top of
  `scripts/backlog-hygiene.ts`. Change them there, not by hand-editing issues.
- The script **defaults to a dry run**. `npx tsx scripts/backlog-hygiene.ts`
  prints exactly what would change; `--apply` mutates.
- The run needs no special token. Priority is read from the native issue field,
  which the default Actions `GITHUB_TOKEN` can see. Board `Status` is optional
  enrichment worth one extra decay exemption ("someone is already on it"); if
  the token cannot read Projects v2 the script logs that and continues.
- Carried over from the #374 audit, which was itself buried before it could be
  acted on: **when a finding cites code, cite symbol names plus the commit SHA
  it was verified against, and treat line numbers as a hint.** Every single
  `file:line` reference in that audit had gone stale, and two files had moved
  directory.

## Build & Verify

```bash
npm run docs:check     # Active-doc links, planning metadata, and agent entrypoints.
npm run build          # Full build (docs + lint + icons + tsc + tests + vite). Run this before committing.
npm test               # Run the structural test suite (every src/**/*.test.ts via tsx)
npm run test:e2e       # Playwright browser smoke (PR CI gate; starts its own Vite dev server)
npm run dev            # Vite dev server (do NOT start this unless asked — the user runs it themselves)
npm run lint           # ESLint over supported source only: src, vite.config.ts, and build/test scripts
npm run lint:scripts   # Optional: lint the one-off diagnostic scripts in scripts/ (not a quality gate)
npm run sync-icons     # Regenerate public/icons.svg from src/assets/icons/*.svg
```

Always run `npm run build` from the project root to verify changes compile before committing. `npm run lint` and `npm test` run automatically as part of the build, so a lint failure or failing structural test will fail the build. Do not start the dev/preview server unless asked; `npm run test:e2e` owns its temporary dev server when you intentionally run the browser smoke.

`npm run test:e2e` is a separate PR CI gate, not part of `npm run build`. User-facing UI or workflow changes should add or extend an `e2e/*.smoke.spec.ts` test when the behavior depends on rendered DOM, menu wiring, dialogs, or browser-only boot paths. If lower-level structural tests are sufficient, say so in the PR description so the lack of e2e coverage is deliberate.

**A new spec must join a CI lane.** CI runs e2e as a parallel matrix over the `test:e2e:*` scripts in `package.json`, which name their spec files explicitly — a spec in no lane is never run by CI. Adding the file is not enough, and the omission is silent: Playwright discovers it locally, so the author sees green while CI stays green because the spec is not there to fail. Six specs drifted out this way before it was noticed, two of them red for weeks (#528). `npm run check:e2e-lanes` runs as part of `npm run build` and fails on a spec that belongs to no lane, a lane entry naming a file that does not exist, or a spec claimed by two lanes.

**A known-failing test is annotated, never deleted or left out of a lane.** Both annotations take the test declaration — `test.fixme('title', fn)` — because a bare `test.fixme()` is a *scope* modifier that silently disables every test in the enclosing `describe`. Use `test.fail()` only when the failure is genuinely deterministic: it reports "expected to fail, but passed" the moment the test succeeds, which is a useful prompt to remove the annotation but a false alarm if the test is merely flaky. When in doubt use `test.fixme()`, and prove determinism before choosing `test.fail()` — a failure that depends on `--workers` is a flake, not a deterministic failure. Either way the annotation carries its issue number in a comment so it stays greppable and cannot decay into an anonymous permanent skip.

### Performance assertions compare against invariant work, never against a millisecond constant

`build` is a required status check, so any timing assertion that drifts blocks merges for everyone. Three issues have now been spent here (#383, #386, #508). Each of the first two fixed the *units* and left the *shape* of the assertion alone, and each decayed within weeks. The rule below is the third answer; read the whole of it before writing a timing assertion.

**No absolute millisecond budget survives.** Not in wall clock, and not in CPU time either:

- Wall clock counts time the process spends descheduled while `scripts/run-tests.ts` runs its pool (`min(10, cores - 2)`), so it moves with unrelated load. This is what #383/#386 diagnosed, correctly.
- `process.cpuUsage()` fixes only that. It measures **time on CPU, not work done**, so it still moves with the effective clock rate — turbo limits, thermal throttling, SMT sibling contention. Measured for #508 on `classifier.test.ts`, against this project's own test pool: wall clock 569ms → 942ms, CPU time 156ms → 325ms (**2.1x**), while a ratio against invariant work moved 1.16x. An allocation-free reference loop inflated 1.6x in lockstep over the same runs, which rules out GC as the cause.

The earlier claim in this section that CPU time "is NOT contention dependent" was wrong, and both budgets written under it had already drifted past their recorded baselines before anyone noticed.

**So: measure the guarded work against the same code path on a fixture that provably cannot benefit from the optimization being guarded, and assert the ratio.** Both halves then share machine, clock rate, allocator and microarchitecture, so only the optimization itself moves the number. Use `cpuRatio` from [`src/test/cpuRatio.ts`](src/test/cpuRatio.ts); it takes the **minimum** across repetitions, since contention and GC can only ever add cost.

Finding the invariant half is the design work, and it is usually a fixture, not a code change — never add a test-only toggle to production code for this, because if the toggle breaks the ratio silently collapses to 1 and the test passes while measuring nothing. Two worked examples:

| test | guards | subject | invariant reference |
|---|---|---|---|
| `classifier.test.ts` | bbox reject gating pairwise nesting | 2,980 **disjoint** rects — gate rejects nearly every pair | 200 **concentric** rects — every bbox pair overlaps, so the gate never rejects |
| `importBulk.test.ts` | suffix cursor in `createNameAllocator` | 2,980 **repeated** names — every one hits the suffix loop | 2,980 **unique** names — never `taken`, so they return before the loop |

**A ratio between two input sizes is a different instrument, and not this one.** It sees a complexity change but is blind to a constant factor: on the classifier, dropping the bbox gate cost ~10x in absolute CPU but moved the size ratio only 3.19x → 4.07x, inside the baseline's own spread. Use a size ratio only when the property under test genuinely *is* the shape of the cost curve — `bestNonFittingCpuMs` in `src/engine/toolpaths/arcReconstruction.test.ts` is the correct use of it, and needs no change.

Whichever you write, record in the test the measured baseline row, the measured regressed row, and the headroom either side, so the next reader can re-derive the constant instead of guessing at it. Set the threshold at the geometric mid-point of the *worst* pair — highest observed baseline against lowest observed regression — not of the averages.

**Verify by mutation, not by a green run.** Temporarily delete the optimization, confirm the assertion fails, and restore. A perf test that has never been shown to fail against its own regression is not evidence of anything. Check the reference column stayed put across that mutation too: if both columns moved, the reference is contaminated and the ratio understates the regression.

## Git & Branching

- **Never commit directly to `main`.** All work lands through a feature branch + PR — even a one-line fix. This holds even when a request says "commit here", "commit and push", or "no PR": "no PR" means *don't open a PR yet*, not *commit onto `main`*. Branch first (`git checkout -b feat/<change>`), commit there, push the branch.
- Only commit on `main` if a human explicitly says "commit on `main`" / "commit directly to `main`".
- **Enforcement (Claude Code):** a `PreToolUse` hook — [`.claude/hooks/block-default-branch-commit.sh`](.claude/hooks/block-default-branch-commit.sh), wired in [`.claude/settings.json`](.claude/settings.json) — blocks any `git commit` while `HEAD` is on `main`/`master`. Commits on other branches pass through untouched.
- **Other tools (Codex, plain `git`, humans):** that hook only binds Claude Code sessions. Codex must follow this rule by reading this file (AGENTS.md). For tool-agnostic enforcement, a native git `pre-commit` hook can be added under a committed `.githooks/` dir + `git config core.hooksPath .githooks` — not set up yet.
- **Rebase onto current `main` before opening a PR**, and again before asking for a merge if `main` has moved. Run `git fetch origin && git rebase origin/main`, then re-run `npm run build`.
- **A conflicting PR gets no CI at all.** `pr-check.yml` runs on the merge ref, which GitHub cannot compute while the branch conflicts — so the `build` and `e2e` jobs never start. `gh pr checks <NN>` reporting *"no checks reported"* means **unverified**, not *pending*. This is not cosmetic: PR #380 sat with a TypeScript error nobody saw because a stale base suppressed the whole gate.
- **Enforcement (all tools):** the `main-requires-pr` ruleset requires the `build` and `e2e` checks to pass **and** the branch to be up to date with `main` before merging. Unlike the commit hook above, this binds every author — Claude, Codex, and humans. Use GitHub's **Update branch** button or auto-merge when `main` moves under an open PR.

## Communication Style

Applies to every agent in this repo — the main session, in-process subagents,
and delegated workers (Codex, opencode, the DeepSeek worker, etc.) alike.

- **Be terse.** Skip preamble, restating the request, and narrating what
  you're about to do. State results and decisions directly.
- **Stay on the task at hand.** Don't expand scope or chase tangential
  findings mid-task. Flag out-of-scope issues briefly at the end (or as a
  follow-up issue) instead of interrupting the current work.
- **Close with a short, structured summary, not a wall of prose.** What
  changed and what's next, skimmable as bullets — or the
  `STATUS/COMMIT/CHANGED_FILES/CHECKS/RISKS` block already used for delegated
  workers (`.agents/skills/manager-delegate/SKILL.md`). Scale the summary to
  the change: a one-line fix gets a one-line summary, not a paragraph.

## Execution Modes

Two independent choices: **where** the work happens, and **who** does it.

**Where — default to an isolated worktree.** New work starts in its own `git worktree` on its own branch unless the user says otherwise. This includes fast-lane changes: the reason is parallelism, not diff size. A worktree lets several branches be in flight at once without one agent's edits, build artifacts, or checkout state disturbing another's, and a one-line fix benefits from that as much as a large change does. Create it outside the repository directory, and do not commit the path.

A fresh worktree has no `node_modules`. Symlinking the primary checkout's copy avoids a full install:

```bash
ln -s <primary-checkout>/node_modules node_modules
```

**Do not symlink when the branch changes `package.json` or `package-lock.json`.** A dependency change needs its own real install; a symlinked tree resolves against the primary checkout's dependency set and would build against the wrong one.

**Who — delegation is optional. Use the simplest mode that fits the approved issue and the user's direction:**

- **Direct implementation:** one agent owns discovery, edits, verification, and
  delivery on the issue branch.
- **Built-in subagents (in-process):** subagents provided by the agent's own
  harness (its built-in task/subagent mechanism — same model, same session) may
  be used proactively for parallel research and for bounded implementation
  slices once the design is established and interface seams are frozen.
  Partition slices by file ownership: in-process subagents share the working
  tree, so overlapping edits conflict. No explicit authorization needed — the
  explicit-authorization rule in **Delegated slices** applies only to the
  external worker harness.
- **Delegated slices (external worker):** use only when the user explicitly
  authorizes delegation and the task divides into bounded, independently
  reviewable slices. Follow
  [`.agents/skills/manager-delegate/SKILL.md`](.agents/skills/manager-delegate/SKILL.md);
  the manager owns the real diff, verification, integration, and credentials.
- **Review/diagnosis:** stay read-only unless the user separately authorizes a
  fix. Report evidence and exact checks; do not turn review into implementation.

Regardless of mode, one owner remains accountable for the issue plan, scope,
repository state, test evidence, and final handoff. A worker report or generated
patch is input to review, not proof of completion.

## Assigned-Task Intake

Before editing:

1. Identify the requested outcome, acceptance criteria, and explicit stop point
   from the approved GitHub issue and current user direction.
2. Load only the authoritative context listed in the task router below.
3. Inspect the current implementation and repository state; do not implement
   from an old plan or assumed architecture.
4. State any scope-changing assumption. Ordinary implementation details can be
   resolved with best judgment.
5. Choose focused checks before editing and run the full required gate before
   delivery.

## Task Router

| Question or task | Read first | Required evidence |
| --- | --- | --- |
| Product scope, users, terminology, safety | [`PROJECT.md`](PROJECT.md) | Product contract plus current UI/tests when claiming shipped behavior |
| Repository orientation | [`INDEX.md`](INDEX.md), then nearest area `INDEX.md` | Current files and graph results |
| Architecture, data model, cross-cutting invariant | [`ARCHITECTURE.md`](ARCHITECTURE.md) | Live types/implementation and focused tests |
| Area-specific design | [`planning/INDEX.md`](planning/INDEX.md), then one matching current design reference | Design metadata and current implementation |
| One task's scope or plan | Approved GitHub issue | Issue body/comments and board status |
| React UI or canvas interaction | Component area index and relevant current tablet design | Focused logic tests; e2e/manual tablet checks when rendered behavior changes |
| CAM, geometry, simulation, or G-code | Engine area index and relevant current design | Focused engine fixtures plus `npm run build`; safety-sensitive assertions |
| Desktop/platform integration | [`planning/DESKTOP_DESIGN.md`](planning/DESKTOP_DESIGN.md) and `src/platform/` | Browser fallback plus affected native check |
| Agent harness or delegated execution | This file, [`scripts/INDEX.md`](scripts/INDEX.md), and the named skill | Actual diff, independent verification, and explicit dispatch approval |

## Key Architecture

Read `ARCHITECTURE.md` for the full picture. The critical points:

- **State:** All project mutations go through `src/store/projectStore.ts` (Zustand). Never mutate state directly.
- **2D geometry:** `clipper-lib` (integer math — always use the internal scaling factor).
- **3D preview:** `manifold-3d` WASM for CSG, rendered via Three.js.
- **Coordinate system:** Internal uses screen coords (Y increases downward). Machine/G-code uses Cartesian (Y increases upward). The `MachineOrigin` and G-code export handle inversion.
- **Units:** Project can be `mm` or `inch`. Check `project.meta.units` and use helpers in `src/utils/units.ts`.

## Structural Conventions (apply to all new work)

These are the patterns the `feat/core-arch-simplification` effort established. Build new code this way from the start so we don't have to refactor "files too big to touch safely" later — the `max-lines` ESLint guards on `App.tsx`/`src/app`, `src/store`, and `src/components/canvas` are ratchets (don't grow past them), **not** targets to fill. Historical migration detail is available in [`planning/archive/CORE_STATE_CANVAS_REFACTOR_Plan.md`](planning/archive/CORE_STATE_CANVAS_REFACTOR_Plan.md) when specifically needed.

- **Keep modules single-responsibility and small.** A file approaching its `max-lines` cap is a design smell — split before adding, don't bump the cap.
- **Big stores = composition root + slices.** `projectStore.ts` is a thin root that spreads per-domain `store/slices/*Slice.ts` (`createXxxSlice(set, get, deps)`) and pure `store/helpers/*`. The public `ProjectStore` interface in `store/types.ts` is a **frozen contract** — add behavior in a slice, don't widen the interface casually.
- **Big components = thin shell + per-interaction hooks.** Follow `SketchCanvas.tsx`: the shell owns shared refs/JSX; each interaction machine lives in its own `use*` hook that takes a typed `ctx` and returns only what the shell consumes. Public props/handle (e.g. `SketchCanvasProps`/`SketchCanvasHandle`) stay frozen.
- **Never put a whole hook-return object in a React dep array.** Hook returns (e.g. `dimEdit`, `fillet`, the slice objects) are recreated every render, so listing them makes `useEffect`/`useCallback`/`useMemo` fire every render — this caused two real "field gets wiped" regressions during the refactor. Depend on the **primitives** that actually gate the effect (`selection.mode`, `pendingAdd`, …); the `useState` setters and `useRef` objects you call are already stable. Add a `// eslint-disable-next-line react-hooks/exhaustive-deps` with a one-line reason when the linter wants the unstable object.

## Directory Layout

```
src/store/          Zustand state + slices
src/engine/toolpaths/   CAM logic (pocket, profile, v-carve, etc.)
src/engine/gcode/       Post-processors and G-code generation
src/components/canvas/  2D sketch canvas and interaction
src/components/viewport3d/  Three.js 3D preview
src/components/simulation/  Voxel-based toolpath simulation
src/import/         DXF, SVG, and STL importers
src/text/           Text-to-geometry conversion
src/types/project.ts    Core data model definitions
```

## Coding Standards

- Every `src/**/*.ts` / `*.tsx` file (including tests and `.d.ts`) starts with the Apache 2.0 license header — copy the exact comment block from any existing source file
- Strict TypeScript — no `any`
- React + vanilla CSS (no UI component libraries)
- New engine features or bug fixes must include unit tests
- Do not add Co-Authored-By lines to commits
- Do not append "Generated with [tool name]" or similar attribution footers to PR descriptions

## Icon System

Icons are **SVG-first**: each icon is an editable standalone SVG in `src/assets/icons/<name>.svg`. Running `npm run sync-icons` assembles them into the `public/icons.svg` sprite sheet. Never edit `public/icons.svg` directly. See [`src/assets/icons/README.md`](src/assets/icons/README.md) for sizing/colour conventions and how to add an icon.

## STL / 3D Mesh Import

STL files are imported via `src/import/stl.ts`. The pipeline:
1. Parses the binary/ASCII STL into a triangle mesh (`src/engine/importedMesh.ts`)
2. Supports axis orientation swaps (`none`, `yz`, `xz`, `xy`)
3. Extracts a silhouette profile for 2D sketch representation
4. The mesh participates in surface roughing/finishing toolpath generation (`src/engine/toolpaths/roughSurface.ts`, `finishSurface.ts`)

## Planning & Design Docs

Active tasks, backlog, and tech-debt live on the [GitHub Project board](https://github.com/orgs/PureCutCNC/projects/1) — see the workflow section above.

`planning/` now holds **durable design & reference docs only** (the "why" behind the data shapes, algorithm references, area-specific design). Check [`planning/INDEX.md`](planning/INDEX.md) for the one that matches your area before starting feature work — these take precedence over general defaults. They are living reference, not task trackers; update them in the same commit when you change the behavior they describe.

## Data Format

The native file format is `.camj`. Core types are in `src/types/project.ts`:
- **Project** — root object containing metadata, stock, feature definitions,
  feature instances, tools, operations, and machine setup.
- **FeatureDefinition** — canonical untransformed geometry and shared kind,
  operation, text, mesh, and dimension data.
- **FeatureInstance** — lightweight tree row with `definitionId`, placement,
  visibility/lock/name, constraints, and Z bounds.
- **ResolvedSketchFeature** — derived world-space runtime view used by geometry,
  rendering, editing, CAM, and export reads; never serialize it into format 3.0.
