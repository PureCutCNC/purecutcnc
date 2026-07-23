# INDEX — PureCutCNC

Map of the repo. Start here when picking up new work. Each entry is a one-line summary of what lives in a folder/file, plus a pointer to a deeper `INDEX.md` when one exists.

## Read first
- [PROJECT.md](PROJECT.md) — product purpose, users, scope, safety, terminology, and documentation authority
- [AGENTS.md](AGENTS.md) — assigned-task workflow, execution modes, task routing, coding rules, and verification
- [ARCHITECTURE.md](ARCHITECTURE.md) — current technical architecture, data model, and cross-cutting invariants
- [planning/](planning/INDEX.md) — current durable area-specific design references. **Open `planning/INDEX.md` first**, not the folder listing. Task plans live in GitHub issues; historical plans live in `planning/archive/`.

## Top-level
- [DRAWING_MODES_TUTORIAL_VOICEOVER.md](DRAWING_MODES_TUTORIAL_VOICEOVER.md) — editable narration source for the Drawing Modes tutorial video
- [src/](src/INDEX.md) — application source (React + TS). **See its INDEX for the breakdown.**
- [src-tauri/](src-tauri/) — Tauri (Rust) wrapper for desktop builds
- [scripts/](scripts/INDEX.md) — quality gates, build/codegen tools, optional agent-dispatch harness, and one-off diagnostics
- [public/](public/) — static assets served as-is (incl. generated `icons.svg`)
- [.github/](.github/) — workflows and PR templates

## Config / metadata
- `package.json` — npm scripts and deps
- `vite.config.ts` — Vite build config
- `tsconfig.*.json` — TS configs (app, node, debug)
- `eslint.config.js` — ESLint rules
- `index.html` — Vite entry HTML
- `CLAUDE.md` / `GEMINI.md` / `.cursorrules` / `.clinerules` / etc. — normalized agent entrypoints that defer to the authority chain above

## How to use this index
1. Start at this file to find the right folder.
2. Open that folder's `INDEX.md` for file-level detail (if one exists).
3. Only then open source files.

## Maintenance
When you add, rename, remove, or significantly change the purpose of a file, update the nearest `INDEX.md` in the same commit. If you create a new folder with non-trivial content, add an `INDEX.md` there and link it from the parent index.
