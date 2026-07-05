# AGENTS.md — PureCutCNC

## What This Is

PureCutCNC is a browser-based 2.5D CAD/CAM application for CNC hobbyists. It collapses CAD sketching and CAM operation definition into a single workflow. Built with Vite + React + TypeScript, state managed by Zustand, with a Tauri wrapper for desktop builds.

## Code Map (read first)

Start every session by reading [`INDEX.md`](INDEX.md) at the repo root. It maps the codebase folder-by-folder and points to per-folder `INDEX.md` files for deeper detail. When you work inside a folder that has an `INDEX.md`, read it before exploring files there. Prefer the index over grepping blind.

**Maintenance rule:** when you add, rename, remove, or significantly change the purpose of a file, update the nearest `INDEX.md` in the same commit. If you create a new folder with non-trivial content, add an `INDEX.md` there and link it from the parent index.

## Codebase memory (MCP)

If the `codebase-memory-mcp` server is connected, prefer its graph tools (`search_graph`, `get_architecture`, `trace_path`, `get_code_snippet`, `search_code`) over blind grep for structural questions; fall back to Grep/Glob/Read for text content.

**Every tool takes a `project` argument that is the project *name*, not a filesystem path.** Call `list_projects` first and pass back the exact `name` it returns (the repo path with `/` replaced by `-`, e.g. `Users-frankp-Projects-purecutcnc`). Passing a path yields `{"error":"project not found or not indexed"}` — a wrong-argument error, not a broken server; retry with the name. If the repo isn't listed yet, run `index_repository` once. If calls repeatedly fail with `Connection closed`, the local graph cache is bloated with stale project graphs — prune it and retry.

## Workflow: Issue → Plan → Approve → Implement → PR

**Every task follows this loop. No exceptions — even a one-line bug fix gets an issue and a short plan.** The plan can be tiny if the task is tiny; the point is that intent is written down, agreed, and traceable. Tasks are tracked on the GitHub Project board ([PureCutCNC project #1](https://github.com/orgs/PureCutCNC/projects/1)), **not** in checked-in plan files.

1. **Issue.** Open a GitHub issue for the work (`gh issue create`). Add it to the Project board, set the area label and Size, and set Status to `Backlog` (or `Ready` once planned).
2. **Plan.** Before changing any code, write the plan **in the issue** — in the body, or a follow-up comment if it grows. Do not create a `planning/*_Plan.md` file; the issue is the plan's home.
3. **Approve.** Share the issue with the user and **wait for an explicit "approved" (or equivalent) signal**. Do not start implementation before approval. If the user asks for changes, edit the issue and re-confirm. On approval, set Status to `Ready`.
4. **Implement.** Branch (`<type>/issue-<NN>-<slug>`), set the board Status to `In progress`, and implement against the plan in the issue. If the plan changes mid-flight, edit the issue so it stays the source of truth.
5. **PR when done.** When work is complete and the build is green, open the PR with `Closes #NN` in the description. Move Status to `In review`. The PR is created at the **end** as the delivery — it is not where the plan lives.
6. **Merge.** Merging auto-closes the issue and moves the card to `Done`.

Abandoned work: close the issue with a short reason; the board moves it to `Done`/closed. No file cleanup needed.

## Build & Verify

```bash
npm run build          # Full build (lint + icon generation + tsc + tests + vite). Run this before committing.
npm test               # Run the structural test suite (every src/**/*.test.ts via tsx)
npm run dev            # Vite dev server (do NOT start this unless asked — the user runs it themselves)
npm run lint           # ESLint over supported source only: src, vite.config.ts, and build/test scripts
npm run lint:scripts   # Optional: lint the one-off diagnostic scripts in scripts/ (not a quality gate)
npm run sync-icons     # Regenerate public/icons.svg from src/assets/icons/*.svg
```

Always run `npm run build` from the project root to verify changes compile before committing. `npm run lint` and `npm test` run automatically as part of the build, so a lint failure or failing structural test will fail the build. Do not start the dev/preview server unless asked.

## Git & Branching

- **Never commit directly to `main`.** All work lands through a feature branch + PR — even a one-line fix. This holds even when a request says "commit here", "commit and push", or "no PR": "no PR" means *don't open a PR yet*, not *commit onto `main`*. Branch first (`git checkout -b feat/<change>`), commit there, push the branch.
- Only commit on `main` if a human explicitly says "commit on `main`" / "commit directly to `main`".
- **Enforcement (Claude Code):** a `PreToolUse` hook — [`.claude/hooks/block-default-branch-commit.sh`](.claude/hooks/block-default-branch-commit.sh), wired in [`.claude/settings.json`](.claude/settings.json) — blocks any `git commit` while `HEAD` is on `main`/`master`. Commits on other branches pass through untouched.
- **Other tools (Codex, plain `git`, humans):** that hook only binds Claude Code sessions. Codex must follow this rule by reading this file (AGENTS.md). For tool-agnostic enforcement, a native git `pre-commit` hook can be added under a committed `.githooks/` dir + `git config core.hooksPath .githooks` — not set up yet.

## DeepSeek implementation workers

The project-local launcher is `scripts/run-claude-deepseek-agent.sh`. It runs one non-interactive Claude Code session against the DeepSeek Anthropic-compatible endpoint for a **user-authorized, bounded slice** — it is not a general-purpose autonomous command. The management session dispatches it directly (filling the prompt template, piping it in, reading the worker's completion block back) so the user is not a copy/paste middleman.

The full manager loop (plan → dispatch → review → merge) is packaged as the **`manager-delegate` skill** (`.agents/skills/manager-delegate/SKILL.md`, symlinked into `.claude/skills/`; both Claude Code and Codex read it). It wraps the leaf launcher with two orchestrators: `scripts/dispatch-task.sh` (create worktree+branch, run the worker, run an independent `npm run build` gate, report — never merges) and `scripts/finish-task.sh` (merge an approved slice `--no-ff` into the integration branch and tear down the worktree). The skill spells out the elevated permissions dispatch needs (credential read, network, bypass worker) and requires explicit approval before dispatching.

### How to run it (integration manager workflow)

1. **Create the task worktree first.** Each slice runs in its own git worktree under `/Users/frankp/Projects/worktrees/purecutcnc/`, never in the primary checkout or on `main`:
   ```
   git worktree add /Users/frankp/Projects/worktrees/purecutcnc/<slice> -b <slice-branch>
   ```
2. **Fill the prompt template.** Copy `scripts/claude-deepseek-agent-prompt.md`, replace the bracketed fields for this slice, and save it to a temp file (e.g. `work/slice-prompt.md`).
3. **Dispatch.** Point `DEEPSEEK_AGENT_ENV_FILE` at the one canonical credential file in the primary checkout and pass the worktree explicitly:
   ```
   DEEPSEEK_AGENT_ENV_FILE=/Users/frankp/Projects/purecutcnc/.env.agent \
     scripts/run-claude-deepseek-agent.sh \
     --mode implement --allow-bypass \
     --worktree /Users/frankp/Projects/worktrees/purecutcnc/<slice> \
     --output-format json < work/slice-prompt.md
   ```
   - `--worktree DIR` is **required for `--mode implement`**: the launcher `cd`s into it so the worker operates there by default. This sets the working directory only — it is **not** a sandbox; a `bypassPermissions` worker can still reach any absolute path, so staying in the worktree is a prompt-and-review convention, not a technical boundary. Bound the real risk with a capped, rotatable key and the post-hoc review in step 4. `--worktree` is optional for `--mode review` (read-only, `--permission-mode plan`), which is the safer default — prefer it whenever the slice doesn't need to write.
   - For slices that run for minutes, dispatch in the background and read the result when it exits, rather than blocking on a foreground call.
4. **Review the real artifacts, not the report.** The worker ends with a `STATUS/COMMIT/CHANGED_FILES/CHECKS/RISKS` completion block — that is a *report, not acceptance*. Inspect the actual worktree diff, the commit, and the test output before accepting or merging.

### Credential & token handling

- Keep exactly one canonical, untracked credential file in the primary checkout: `<primary-worktree>/.env.agent`. It is gitignored and must be `chmod 600` (owner-only). The launcher **refuses to run** if it is group/other-readable. Never add it, print it, copy it into a task worktree, or read a fallback credential from `~/Documents`.
- The launcher passes the DeepSeek key to the worker via the environment (`ANTHROPIC_AUTH_TOKEN`), never on the command line. A `--mode implement` worker is an autonomous agent that necessarily has that key in its env; the prompt's "do not echo the credential" rule is a guardrail, not enforcement. Bound the residual risk by using a capped, easily-rotatable DeepSeek key, preferring `--mode review`, and confining writes to the worktree.
- A task worker must not inspect, edit, echo, log, or commit the credential file. It only receives the authenticated Claude process needed for its assigned slice.
- Require the user's explicit approval before any credential-backed dispatch.
- The integration manager owns task-worktree creation, review, verification, merge, cleanup, and PR decisions. Worker-reported completion is not acceptance.

## Key Architecture

Read `ARCHITECTURE.md` for the full picture. The critical points:

- **State:** All project mutations go through `src/store/projectStore.ts` (Zustand). Never mutate state directly.
- **2D geometry:** `clipper-lib` (integer math — always use the internal scaling factor).
- **3D preview:** `manifold-3d` WASM for CSG, rendered via Three.js.
- **Coordinate system:** Internal uses screen coords (Y increases downward). Machine/G-code uses Cartesian (Y increases upward). The `MachineOrigin` and G-code export handle inversion.
- **Units:** Project can be `mm` or `inch`. Check `project.meta.units` and use helpers in `src/utils/units.ts`.

## Structural Conventions (apply to all new work)

These are the patterns the `feat/core-arch-simplification` effort established (see `planning/CORE_STATE_CANVAS_REFACTOR_Plan.md`). Build new code this way from the start so we don't have to refactor "files too big to touch safely" later — the `max-lines` ESLint guards on `App.tsx`/`src/app`, `src/store`, and `src/components/canvas` are ratchets (don't grow past them), **not** targets to fill.

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
- **Project** — root object (metadata, stock, features, tools, operations)
- **SketchFeature** — atomic design unit with sketch geometry, operation (add/subtract), and Z bounds (z_top/z_bottom)
