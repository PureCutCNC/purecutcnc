---
status: current
authoritative-for: desktop shell and platform-abstraction design
last-verified: 2026-07-16
---

# Desktop Design

## Purpose

PureCutCNC uses Tauri to provide a native desktop shell without forking the CAD/
CAM engine or the React application. Web and desktop builds share the same
project model, store actions, UI components, and `.camj` format.

The shipped implementation sequence is preserved in
[`archive/DESKTOP_Implementation_Plan.md`](archive/DESKTOP_Implementation_Plan.md).
This document owns the durable architecture.

## Platform boundary

Application components request capabilities through `src/platform/` rather
than importing Tauri APIs directly:

- `api.ts` defines the shared platform contract;
- `browser.ts` implements browser downloads, uploads, and web-safe fallbacks;
- `desktop.ts` implements native Tauri dialogs and filesystem operations;
- `index.ts` selects the active platform;
- `useFileActions.ts` coordinates project file actions;
- `useDesktopIntegration.ts` connects native shell events and application state;
- `printDocument.ts` owns the browser-safe print surface.

The platform adapter is the compatibility seam. New native capabilities must
retain a meaningful browser fallback or be explicitly desktop-only.

## Current desktop responsibilities

The Tauri shell may own:

- native open, save, save-as, and export dialogs;
- current-path, dirty-state, recent-file, and close-request integration;
- native menus and application metadata;
- `.camj` file association and shell lifecycle;
- packaging assets and narrowly scoped filesystem capabilities.

It must not duplicate project mutation, geometry, CAM, or export logic in Rust.
Those remain in the shared TypeScript application.

## File and lifecycle invariants

- Browser and desktop builds read and write the same `.camj` schema.
- Project mutations and history continue through the Zustand store.
- Native close/open flows must respect unsaved-change confirmation.
- A failed native operation must return a user-visible error without silently
  clearing dirty state or changing the current path.
- Platform detection must be guarded so the app still boots in plain Chromium
  and browser e2e tests.
- Native paths and filesystem capabilities are never serialized into portable
  project data unless the schema explicitly defines them.
- The main window keeps Tauri native drag/drop disabled so the shared frontend
  HTML5 drag interaction remains available for Project-tree and CAM-operation
  reordering. Finder-to-window `.camj` dropping is intentionally unsupported;
  projects open through File > Open or macOS file association instead.

## Security and distribution

Tauri capabilities should stay least-privilege. Avoid broad filesystem or shell
access when a scoped dialog-selected path is sufficient. Signing, notarization,
installer production, and cross-platform distribution are release concerns and
must not change the shared application contract.

## Verification

Desktop/platform changes should cover:

- focused platform or store tests;
- `npm run build`;
- browser fallback boot and the relevant `npm run test:e2e` smoke;
- Project-tree feature/folder and CAM-operation reordering;
- native file/close/menu testing on the affected desktop platform;
- tablet impact when shared commands or dialogs change.
