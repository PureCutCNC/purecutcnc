# Desktop Implementation Plan

> **Status:** Proposed
> **Scope:** Native desktop packaging, file workflow, app shell, distribution
> **Last updated:** 2026-04-13

---

## 1. Goal

Ship PureCutCNC as a desktop application for macOS, Windows, and Linux without rewriting
the core CAD/CAM engine.

The current app is already a strong candidate for desktop packaging because it is:

- a pure Vite + React frontend
- driven by a single Zustand project store
- already self-contained in the browser
- already using local file concepts (`.camj`, machine JSON, G-code export)
- not dependent on a server runtime

The desktop effort should preserve that architecture and add a native shell around it.

---

## 2. Recommended Shell

## 2.1 Primary recommendation: Tauri

Use **Tauri** as the desktop shell.

Why it fits this repo:

- The app is already a browser app, so the frontend can stay largely unchanged.
- The project does not currently need a heavy Node/Electron main process.
- The main missing desktop features are native file dialogs, filesystem access, menus,
  recent files, file associations, and packaging.
- A lighter shell is a better fit for a CAM tool where startup time and memory use matter.

## 2.2 Fallback option: Electron

Keep **Electron** as the fallback if Tauri introduces blocking issues with:

- `manifold-3d` WASM loading
- WebGL / Three.js behavior in specific platform webviews
- file association / updater needs that become awkward in practice

The plan below is intentionally written so the app code stays shell-agnostic enough that
switching from Tauri to Electron later would still be manageable.

## 2.3 Decision

Proceed with **Tauri-first** unless a prototype shows hard blockers in:

- 3D viewport rendering
- simulation performance
- WASM loading and packaging
- native file open/save/export behavior

---

## 3. Current State

Today the app is browser-first:

- Project save uses blob download in `src/components/layout/Toolbar.tsx`
- Project load uses a temporary `<input type="file">` in `src/components/layout/Toolbar.tsx`
- G-code export uses blob download in `src/components/export/ExportDialog.tsx`
- The core application state lives in `src/store/projectStore.ts`
- The app build is `tsc -b && vite build`

That means the core engine is already portable, but the file workflow is still tied to browser
download/upload mechanics.

---

## 4. Architectural Direction

Do **not** spread desktop conditionals throughout the UI.

Instead, introduce a narrow platform/service layer that the UI calls for:

- open project
- save project
- save project as
- export G-code
- import machine definition
- import geometry
- open recent file
- reveal exported file in OS file manager

The React components should ask for an action, not care whether the action is implemented by:

- browser blob download / file input
- Tauri native dialog + filesystem APIs

This keeps the app web-capable while making desktop support clean.

---

## 5. Proposed Desktop Architecture

## 5.1 Add a platform adapter

Create a small module, for example:

```text
src/platform/
  api.ts
  browser.ts
  desktop.ts
```

With an interface like:

```ts
export interface PlatformApi {
  openProjectFile(): Promise<string | null>
  saveProjectFile(suggestedName: string, content: string, existingPath?: string | null): Promise<string | null>
  saveTextFile(
    suggestedName: string,
    content: string,
    extension: string,
    existingPath?: string | null
  ): Promise<string | null>
  pickJsonFile(): Promise<string | null>
  pickGeometryFile(): Promise<{ name: string; content: string } | null>
  revealInFileManager(path: string): Promise<void>
  isDesktop: boolean
}
```

The browser implementation continues to use:

- file input
- `FileReader`
- `Blob`
- anchor download

The desktop implementation uses Tauri APIs.

## 5.2 Track file session state in the project store

Add project-session state outside the serialized project model, for example:

```ts
interface ProjectSessionState {
  filePath: string | null
  lastExportPath: string | null
  dirty: boolean
}
```

This should not be stored inside `.camj`.

It should support:

- Save vs Save As
- dirty marker in title bar
- reopen last file
- recent files menu
- file association open events

## 5.3 Keep `.camj` as the source of truth

Do not introduce a desktop-only project format.

Desktop should still open and save the same `.camj` JSON files the browser version uses.

That preserves:

- interchange between web and desktop
- easier debugging
- less migration risk

---

## 6. Implementation Phases

## Phase 1: Desktop feasibility spike

Goal: prove the current frontend runs correctly inside a desktop shell.

Tasks:

- Add Tauri scaffolding to the repo
- Boot the existing Vite app inside Tauri
- Confirm these work without app rewrites:
  - Sketch canvas
  - Three.js 3D viewport
  - simulation viewport
  - `manifold-3d` WASM loading
  - icon sprite loading via `BASE_URL`
- Validate dev workflow:
  - web dev still works
  - desktop dev starts reliably

Exit criteria:

- App launches as a native window
- 2D, 3D, and simulation render correctly
- No blocking WASM or asset-path issue remains

## Phase 2: Native file workflow

Goal: replace browser file hacks with a platform API.

Tasks:

- Introduce the platform adapter layer
- Convert project open/save in `Toolbar.tsx` to use the platform API
- Convert G-code export in `ExportDialog.tsx` to use the platform API
- Convert machine-definition JSON import to use the platform API
- Preserve browser fallback behavior for the web build

Desktop behavior target:

- `Open...` uses native file picker
- `Save` writes to the current file path
- `Save As...` uses native save dialog
- `Export G-code...` writes directly to chosen path

Exit criteria:

- The desktop app can open, save, save as, and export without blob downloads
- The web app still works with current browser behavior

## Phase 3: Desktop app shell polish

Goal: make it behave like a real desktop application.

Tasks:

- Add application menu entries:
  - New
  - Open
  - Save
  - Save As
  - Export G-code
  - Undo / Redo
  - About
- Add unsaved-changes prompt on:
  - window close
  - opening another file
  - creating a new project
- Add title bar state:
  - app name
  - current file name
  - dirty indicator
- Add recent files list
- Add drag-and-drop `.camj` open
- Add file associations for `.camj`

Exit criteria:

- Desktop workflow feels native rather than browser-wrapped

## Phase 4: Packaging and release pipeline

Goal: generate installable artifacts for end users.

Targets:

- macOS `.dmg`
- Windows installer
- Linux package(s), likely AppImage and/or `.deb`

Tasks:

- Add CI build jobs for desktop artifacts
- Sign binaries if distribution requires it
- Version the app from package/release metadata
- Publish artifacts on GitHub Releases

Exit criteria:

- A tagged release produces installable desktop binaries

## Phase 5: Desktop-only enhancements

These are valuable, but not required for initial release:

- auto-update
- crash logging / diagnostic bundle export
- “Reveal exported file”
- configurable default export folder
- persistent window state
- multi-window support
- native clipboard integration for full G-code copy/export flows

---

## 7. Tauri Integration Notes

## 7.1 Rust surface area

Keep Rust usage minimal at first.

Initial Tauri responsibilities should be:

- opening native file dialogs
- reading/writing files
- receiving OS open-file events
- window lifecycle hooks

Do **not** move CAM logic into Rust.

The CAD/CAM engine should remain in TypeScript unless there is a proven performance reason
to relocate a specific subsystem later.

## 7.2 Asset and WASM handling

The highest-risk technical point is packaged asset loading:

- `manifold-3d` WASM
- `icons.svg`
- any future font / import assets

The spike should verify that:

- Vite’s production output is served correctly inside Tauri
- `import.meta.env.BASE_URL` usage still resolves correctly
- wasm loading works in packaged builds, not just dev mode

## 7.3 File permission model

Desktop file access should be explicit and user-driven:

- open selected files only
- save to user-chosen locations
- avoid broad filesystem scope unless it is truly necessary

This is important both for Tauri capability configuration and future trust/security posture.

---

## 8. App Changes Required In This Repo

## 8.1 New modules

- `src/platform/*` for browser vs desktop file actions
- desktop session state for current path / dirty flag / recent files
- Tauri config and Rust shell files

## 8.2 Existing components to refactor

- `src/components/layout/Toolbar.tsx`
  - replace blob download and file-input logic
- `src/components/export/ExportDialog.tsx`
  - replace G-code blob download
- `src/components/feature-tree/PropertiesPanel.tsx`
  - machine JSON import should route through platform file picker abstraction

## 8.3 Store work

`src/store/projectStore.ts` should gain session-aware actions such as:

- `newProjectSession()`
- `openProjectFromText(text, path?)`
- `saveProjectToCurrentPath()`
- `saveProjectToPath(path)`
- dirty-state tracking hooks

The serialized `Project` model should stay unchanged unless a desktop feature truly requires
project-level metadata.

---

## 9. UX Decisions To Make

These need explicit product decisions before full implementation:

- Should desktop still expose the current browser-style “Download” wording, or switch to `Save` / `Export` language everywhere?
- Should `Save` write `.camj` immediately to the existing path without confirmation?
- Should G-code export remember the last folder per machine or per project?
- Should opening a second `.camj` replace the current project or open another window?
- Should the desktop app retain a web build with identical UI, or can some controls be desktop-only?

My recommendation:

- Keep one UI where possible
- adapt labels only where platform expectations are strong
- open one project per window
- keep web support intact

---

## 10. Risks

## 10.1 Highest-risk items

- packaged WASM loading for `manifold-3d`
- WebGL behavior differences across desktop webviews
- desktop file-path/session state introducing bugs into save/load flows
- platform-specific installer/signing complexity

## 10.2 Medium-risk items

- drag-and-drop imports interfering with existing canvas interactions
- recent-files bookkeeping
- unsaved-change prompts around destructive workflow transitions

## 10.3 Low-risk items

- menu wiring
- native dialogs
- file association registration

---

## 11. Testing Strategy

## 11.1 Manual acceptance

For each platform build, test:

- create project, save `.camj`, reopen it
- import SVG / DXF
- export G-code
- load machine JSON
- verify 3D viewport and simulation both render
- close with unsaved changes
- open a `.camj` directly from the OS

## 11.2 Automated coverage

Add tests where practical for:

- platform adapter browser implementation
- session state transitions
- dirty-flag behavior
- open/save/export command routing

End-to-end desktop automation can come later; initial confidence will likely be mostly manual.

---

## 12. Suggested Rollout

## Milestone A

Desktop prototype builds and runs locally with 2D/3D/simulation intact.

## Milestone B

Open/save/export are native on desktop; browser still works.

## Milestone C

Desktop menus, dirty state, recent files, and `.camj` association are complete.

## Milestone D

Signed release artifacts are produced in CI for supported platforms.

---

## 13. Recommendation

Proceed with a **Tauri spike first**, not a full migration.

If the spike passes asset, WASM, and rendering validation, continue with the phased plan above.
If it fails on those fundamentals, stop and switch the shell plan to Electron rather than
forcing the architecture around platform quirks.
