# #1016 C1 slice B — Thread / Flutes dialogs and Around tool entries
DSH coder, approved plan #1016 comment 6141495167, approval 6159743687 (“1015 and 1016 are good”), follow #962 Session rules and evening manager handbook. Manager owns review, browser/screenshots, integration and PR. Read INDEX.md, PROJECT.md, AGENTS.md, src/components/INDEX.md, layout/toolbar/INDEX.md, planning/TABLET_UX_DESIGN.md, e2e/README.md and nearest indexes. Use codebase graph first; index your own worktree as needed. node_modules symlinked by manager; no dependencies or installs.

## Current state and scope
A core is built at 1a62cf94 on feat/issue-1016-thread-flutes-core-dsh: typed ordinary geometry and store action (below). Manager independently read product diff and ran both tests. A1 is a parallel TEST-ONLY slice in thread-flutes-core-tests-dsh, owning src/store/rotaryPatterns.test.ts and helpers/rotaryPatterns.test.ts only, adding cross-unit imports and G-code pitch assertions; those files and all store/engine code are OFF LIMITS to you. Interface is frozen; UI can build on A while its test gap is corrected. Do not integrate A1 yourself. Feature integration waits for both reviews. No C2 hex/square-to-round. Rolled-up bar simulation already shipped.

## What to build
On available, active Around, two clearly discoverable entries next to the drawing tools: Thread and Flutes. Ordinary flat-face/milling/plasma views must not offer them. Cover both desktop toolbar assemblies (CreationToolbar and combined Toolbar) and tablet route. Reuse current command/dialog/focus styling; no toolbar redesign.
- Thread dialog: start along bar, length, pitch in mm projects or threads-per-inch in inch projects, starts default 1, depth default 0.61 x physical pitch. Right-hand only. One short visible note: radial V-bit threads approximate a 60-degree thread at small helix angles, suitable for wood/plastic/decorative threads, not precision thread tooling. No stored thread tables, internal/tapered/left-hand options or relief/run-out. No new persisted parameters. Inch UI converts TPI to physical pitch = 1/TPI before store call. Respect depth override while editing other fields; default recalculation must not overwrite a depth the user chose.
- Flutes dialog: start, length, count, twist (turns over length, 0 straight; negative opposite hand), depth; choose a compatible existing project tool, preserving user's explicit choice. Ball gives rounded grooves, V-bit a V groove.
- Validate finite values, positive length/pitch/depth, integer starts/count and depth strictly less than bar radius. Bound count fields to reasonable UI limits to prevent absurd allocations; invalid input disables Create and gives localized explanation. Start is distance from stock min along bar; user may extend lines past bar ends (do not silently clip).
- Create calls the existing action ONCE; successful result closes and returns focus, reveals/selects resulting folder/lines and operation in ordinary UI. Cancel/Escape creates nothing. Store refusal stays visible, localized, no partial content. Thread passes loaded tool-library entries so existing V-bit or bundled V-bit import works; don't invent tooling/feeds/speeds. Created Engrave uses rough pass for stepdown depth passes; do not change that to finish.
- Use five real locale translations with key order and no changed existing strings. Every refusal including around detail maps to human text, not raw code. Accessible labels/keyboard/focus, scroll-fitting dialogs, tablet touch targets. Keep implementation details out of product text.

## Frozen API (read helper for exact exported types)
src/store/helpers/rotaryPatterns.ts:
RotaryPatternInput =
 {kind:'thread'; start:number; length:number; pitch:number; starts?:number; depth:number}
 | {kind:'flutes'; start:number; length:number; count:number; twist:number; depth:number; toolRef:string}
RotaryPatternResult =
 {ok:true; folderId:string; featureIds:string[]; operationId:string}
 | {ok:false; reason:RotaryPatternRefusal; detail?:string}
useProjectStore.getState().addRotaryPattern(input, libraryTools?:ToolLibraryEntry[]):RotaryPatternResult
Refusals: aroundUnavailable, aroundNotActive, invalidStart, invalidLength, invalidDepth, invalidPitch, invalidStarts, invalidCount, invalidTwist, depthReachesCentreline, noVBitTool, toolNotFound, toolIncompatible, targetNotAllowed.
Exports rotaryPatternFrame(project), THREAD_DEPTH_PER_PITCH = .61, buildRotaryPatternLines etc. Around/frame source current #1026 centered zero; project type from #1028.
All input lengths are project units; only dialog handles TPI display. Start measured from stock minimum along axis. Create stores ordinary lines/folder/Engrave, all in one undo step. No parameter records. Thread V-bit is chosen/imported by store; flute toolRef must exist.

## File ownership
Allowed: focused new dialog/helper files in src/components/layout/toolbar/ or canvas/, toolbar wiring (CreationToolbar.tsx, Toolbar.tsx, CreationActions.tsx, useToolbarState.ts as needed), focused CSS in existing relevant area, five locale files, nearest INDEX.md, e2e/aroundSketch.smoke.spec.ts and narrow test support if genuinely needed.
Prefer extend aroundSketch.smoke.spec.ts (already assigned to CI) for one C1 describe rather than a new unassigned spec or package script edit. No package/lock/deps, src/store/**, src/engine/**, src/machine/**, format, simulation renderer or unrelated features. No .env.agent reads. No app dev server started by you. Manager owns browser runs and screenshots.

## Required checks/tests
Use e2e fixtures/helpers and actual current UI, not guessed selectors. Seed coherent Rotary type, round stock, rotary machine, Around active, valid V-bit and ball tool. Wait generation up-to-date; assert generated operation has NONEMPTY moves and no errors before asserting rendering.
- Thread mm: dialog creates folder/line/Engrave; actual generated angles travel expected turns (360/pitch along), depth passes; 3D overlay published segment data shows wrapping, simulation removes material. One undo removes whole creation, redo restores.
- Inch dialog: 20 TPI -> pitch .05 inch; inspect generated geometry or moves, not just text field.
- Multi-start and flutes count/twist/tool selection; straight and nonzero twist affect actual geometry/output.
- Invalid depth at centreline refused with no content/history, cancel/Escape no changes.
- Entries absent outside available Around; switching type/frame cannot apply stale dialog to invalid context.
- Tablet dialog fits and actions remain reachable; keyboard focus restored.
Focused logic/component tests only where meaningful. NODE_OPTIONS=--no-experimental-global-navigator for browser-global structural tests (CI Node20). Run changed tests/type checks, check:i18n, check:e2e-lanes; no full build or browser/test pool. Manager will run e2e on isolated port1439, two workers, inspect default/zoomed/low-angle screenshots and collect review passes.
Named mutations must fail permanent tests where runnable; report browser-only mutations unrun rather than claiming. Leave all edits uncommitted COMMIT:none. Report file changes, API use, exact commands/exits, mutation outcomes, RISKS and selectors/screens to capture. Raise a true approved-plan blocker; no alternative design.
