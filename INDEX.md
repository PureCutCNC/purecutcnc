# INDEX — PureCutCNC

Map of the repo. Start here when picking up new work. Each entry is a one-line summary of what lives in a folder/file, plus a pointer to a deeper `INDEX.md` when one exists.

## Read first
- [AGENTS.md](AGENTS.md) — build commands, coding standards, key architecture
- [ARCHITECTURE.md](ARCHITECTURE.md) — deeper architectural detail
- [planning/](planning/INDEX.md) — active design docs and implementation plans. **Open `planning/INDEX.md` first**, not the folder listing. Shipped/stale plans live in `planning/archive/` — do not read those by default.

## Top-level
- [src/](src/INDEX.md) — application source (React + TS). **See its INDEX for the breakdown.**
- [src-tauri/](src-tauri/) — Tauri (Rust) wrapper for desktop builds
- [scripts/](scripts/) — build/codegen scripts (icon sync, release helpers) plus one-off diagnostic scripts; diagnostics are outside the default `npm run lint` gate (use `npm run lint:scripts`)
- [public/](public/) — static assets served as-is (incl. generated `icons.svg`)
- [.github/](.github/) — workflows and PR templates

## Config / metadata
- `package.json` — npm scripts and deps
- `vite.config.ts` — Vite build config
- `tsconfig.*.json` — TS configs (app, node, debug)
- `eslint.config.js` — ESLint rules
- `index.html` — Vite entry HTML
- `CLAUDE.md` / `GEMINI.md` / `.cursorrules` / `.clinerules` / etc. — agent-specific pointers (all eventually defer to `AGENTS.md`)

## How to use this index
1. Start at this file to find the right folder.
2. Open that folder's `INDEX.md` for file-level detail (if one exists).
3. Only then open source files.

## Maintenance
When you add, rename, remove, or significantly change the purpose of a file, update the nearest `INDEX.md` in the same commit. If you create a new folder with non-trivial content, add an `INDEX.md` there and link it from the parent index.
