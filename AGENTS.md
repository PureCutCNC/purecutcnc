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

## Git & Branching

- **Never commit directly to `main`.** All work lands through a feature branch + PR — even a one-line fix. This holds even when a request says "commit here", "commit and push", or "no PR": "no PR" means *don't open a PR yet*, not *commit onto `main`*. Branch first (`git checkout -b feat/<change>`), commit there, push the branch.
- Only commit on `main` if a human explicitly says "commit on `main`" / "commit directly to `main`".
- **Enforcement (Claude Code):** a `PreToolUse` hook — [`.claude/hooks/block-default-branch-commit.sh`](.claude/hooks/block-default-branch-commit.sh), wired in [`.claude/settings.json`](.claude/settings.json) — blocks any `git commit` while `HEAD` is on `main`/`master`. Commits on other branches pass through untouched.
- **Other tools (Codex, plain `git`, humans):** that hook only binds Claude Code sessions. Codex must follow this rule by reading this file (AGENTS.md). For tool-agnostic enforcement, a native git `pre-commit` hook can be added under a committed `.githooks/` dir + `git config core.hooksPath .githooks` — not set up yet.

## Execution Modes

Delegation is optional. Use the simplest mode that fits the approved issue and
the user's direction:

- **Direct implementation (default):** one agent owns discovery, edits,
  verification, and delivery on the issue branch.
- **Isolated worktree:** use when the user requests isolation or concurrent work
  would otherwise disturb the active checkout.
- **Delegated slices:** use only when the user explicitly authorizes delegation
  and the task divides into bounded, independently reviewable slices. Follow
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
