# Issue #1178 handoff: Linux desktop tree reorder

Branch `fix/issue-1178-linux-tree-reorder`, based on `integration/0.6.0` at
`1c4ab3e8`. The plan of record is issue #1178, queued by Frank for 0.6.0. The PR goes into
`integration/0.6.0` with `Closes #1178` and a Manual impact section (expected:
none). It is not merged until Frank confirms it in the Linux desktop build.

## Problem
On the Linux desktop app (Tauri, WebKitGTK) a feature in the Project tree can be
dragged, but dropping it does not reorder anything. #303 already set
`dragDropEnabled: false` in `src-tauri/tauri.conf.json`, and it is still off.

## Likely cause
WebKitGTK treats an HTML5 drag whose `dragstart` stores nothing in `dataTransfer`
as an empty drag, so `drop` never fires. No tree drag handler calls `setData`.

## Task
1. In every tree `dragstart` — feature rows and folder rows in
   `src/components/feature-tree/FeatureTree.tsx` (incl. the shared row component
   around :1145–1256), and CAM operations in `src/components/cam/CAMPanel.tsx`
   (`handleOperationDragStart`, ~:809/:2339) — pass the event through, call
   `event.dataTransfer.setData('text/plain', <id>)`, and set
   `effectAllowed = 'move'`.
2. In the matching dragover handlers keep `preventDefault()` and set
   `dropEffect = 'move'`.
3. Check every other `draggable` element under `src/` for the same pattern, and fix
   it the same way if it reorders.
4. Do not change store actions or the tablet pointer reorder path. No new UI.

## Acceptance
- A unit or e2e test that fails if `setData` is removed from the feature and
  operation drag starts. The existing #303 browser reorder e2e must stay green.
- Run the same reorder e2e under Playwright's WebKit project as well, if it can
  be run locally. Say if it cannot.
- `npm run build` green; run the e2e specs that cover tree and operation reorder.
