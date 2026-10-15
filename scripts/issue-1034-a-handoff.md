# Issue #1034 — slice A: design independent of machine

Follow #962 Session rules and Manager handbook. Frank requested and approved #1034 on2026-10-15 (“Approve #1034”, comment6193836024). DSH codes; manager reviews. Base integration/0.6.0 b5d407b9. #1016 PR1033 green/open at88cf1bbd was handed off; its trees are OFF LIMITS. This independent feature starts from integration: Thread/Flutes code is absent here; its caller later consumes the shared guard.

## Ownership / frozen seams
Own src/store/helpers/activeFace.ts, focused existing/new store tests, src/store/INDEX.md; focused output-boundary regression tests under src/app/toolpathGeneration and its INDEX. Update existing Around-availability tests to approved behavior, preserving unrelated safety assertions.
Read callers workspaceFace, setupsSlice, provisionalSetup and design preview; change callers only for independently reproduced machine-dependent authoring gates and report exact changes.
Keep aroundUnavailableReason exported return UNION unchanged during A; UI B owns FaceSwitch tooltip cleanup. Runtime authoring return must be needsRotaryProject / needsRoundBar / null only. No fake/default machine. Preserve type/stock constraints, edit busy guard, provisional realization, undo and saved content.
OFF LIMITS: UI, locales, e2e, package/config/gates, format/store types, engine toolpaths/G-code/machine, agent entrypoints, all unrelated trees. If output safety needs a production change beyond ownership, report reproduction and stop before that edit; manager dispatches bounded correction under approved plan.
No other coder active; UI B follows accepted A. Symlinked deps. Never read credential files.

## Source map
aroundUnavailableReason requires Rotary type, round bar, rotary machine and matching axis. Consumers: FaceSwitch, switchWorkspaceFace, create/select setup, realizeProvisionalSetup/syncWorkspaceSetups. Fix shared store authoring, not just a button.
aroundFrame(stock) is geometric; stock axis/dimensions define design.
Plasma machineMode already reads projectType; toolsSlice.addTool uses projectType. Audit equivalent authoring gates; report no defect if none. Obsolete operationOffer/family wording deferred B.
Export guards: prepareExport no-machine and projectMachineMismatch; runPostProcessor planRotaryRefusals/inspectRotaryOperation refuses postRotaryNoAxis, postRotaryAxisMismatch, missing inverse-time, borrowed-axis travel. Preserve all. Do not alter signs/feed/output implementation in A.

## Tests / evidence
X/Y + mm/inch matrix: no machine, router, plasma, matching/opposite rotary all permit Rotary round-bar authoring. Actually enter Around, create geometry/realize setup, change machine without evicting face/content, save/load, undo/redo.
Milling/Plasma refuse Around by type; Rotary block refused by stock; busy guard unchanged.
Plasma no-machine/router permits actual plasma-profile and plasma-tool creation; machine changes alone never change project type/mode or retained content.
Actual export-preparation/post seams must refuse missing machine, family mismatch, no rotary axis, opposite axis. Cover compatible axes/units/own-borrowed-reversed as relevant, real nonempty moves/warnings/text. Compatible emitted programs equal baseline b5d407b9 byte-for-byte (handle date-header midnight deterministically).
Mutate old authoring machine guard back: test must fail. Independently remove existing export refusal: new output regression must fail. Restore exactly; report survivors. No zero-move false positives, implementation-mirror tests or hardware claims.
Worker runs focused tests serially, app tsc/scoped lint. NO full build/browser/test pools/install/commits. COMMIT:none, dispatcher commits after successful exit. Update nearest INDEX for new files/purpose. Manager reviews whole diff/RISKS, independent tests/mutations/browser/gates and safety review if boundary production changes.
Final report STATUS/COMMIT/CHANGED_FILES/CHECKS/RISKS: exact commands/exits/mutations, Plasma audit result and every unresolved safety risk.

## Approved issue contract
Follow-up to #1028 / PR #1032 in the 0.6.0 release (#962), requested by Frank 2026-10-15: "we should fix that. and check if there are some leftovers in the plasma type too".

## Problem and verified evidence

At feature head bb73f3b5 (integration b5d407b9 ancestor), aroundUnavailableReason in src/store/helpers/activeFace.ts still requires a selected rotary-capable machine and matching bar axis after checking Rotary type and round stock. FaceSwitch, workspace switching, setup creation/realization/synchronization and canned Thread/Flutes consume that authoring guard. Thus selecting an unrelated machine prevents design. The #1028 plan explicitly retained the old machine/axis checks, contradicting its PROJECT.md rule that project type decides available faces and operations.

Around geometry is stock-defined: aroundFrame in src/engine/aroundFrame.ts uses only the bar axis, diameter and centre. It does not need a machine.

Plasma check: machineMode already reads projectType; operation offers, tool family and face visibility follow that mode. projectMachineKind has no production callers in the current graph. However operationOffer still returns needs-plasma-machine for a non-Plasma project, and plasmaMode.smoke.spec.ts explicitly preserves the obsolete "Needs a plasma machine" message. CAM family badges/counts also still describe the machine although their input is project type. These are confirmed misleading leftovers, not proof of another functional Plasma gate.

## Proposed behavior

- A Rotary project with supported round stock can enter Around, author/edit geometry, create Thread/Flutes and rotary model operations, and inspect design preview without selecting a rotary machine. No machine, router/plasma machine or rotary axis mismatch must not hide or invalidate that authoring surface.
- Project type and stock geometry remain valid authoring constraints. Milling/Plasma do not gain Around. Existing saved content, type-change keep/hide behavior, provisional setup semantics and undo remain intact.
- Machine suitability, rotary capability, axis alignment, output drive/sign/controller settings remain required when preparing/exporting machine output. An invalid setup must refuse output with an actionable machine message; do not weaken or replace the existing safety checks with a default machine.
- Plasma authoring must likewise remain available in a Plasma project regardless of no machine or a mismatched selected machine. Keep real machine-specific export/material/controller restrictions at the output boundary.
- Correct authoring hints, retained-operation badges and count messages to name project type when that is the actual cause. Keep machine wording for genuine export incompatibility. Update all five locales.
- No file-format/version change, stock expansion (#1027), output sign convention, plasma strategy redesign, or unrelated machine-library cleanup.

## DSH slices

A. Separate the stock/type authoring guard from machine/output suitability, updating all current callers rather than only the face-switch UI. Audit Plasma authoring call sites and fix any reproducible equivalent machine-driven gate within this boundary; report the exact finding if none. Add focused store/helper/output-boundary tests and nearest INDEX updates where purpose changes.

B. Correct only confirmed project-type wording in desktop/tablet CAM and properties surfaces, five locales and existing browser specs. Test Rotary/Plasma authoring while machine selection changes; preserve all authored content and one-step undo semantics.

C. Manager review and verification: whole diffs/RISKS, parsed locale comparison, independent guard mutation, isolated port1439 browser with two workers and tablet screenshots, focused tests, build:gates, hosted full build/E2E/conformance. Obtain independent output-safety review if output-boundary code changes. Deliver a separate PR into integration/0.6.0 for Frank's UI acceptance; no merge without his go. Finish the current #1016 direction amendment first; preserve its worktrees.

## Acceptance matrix

- Rotary round bar, X/Y and mm/inch: no machine, ordinary router, plasma machine, matching rotary and opposite-axis rotary all permit Around design and setup realization. Thread/Flutes and rotary model authoring remain possible; changing machine preserves geometry and design preview.
- Milling and Plasma still refuse Around for project-type reasons.
- Plasma with no machine or router selected still offers plasma-profile creation and plasma tools; machine changes alone do not switch mode or hide editable work. Existing other-family content remains kept and appropriately described by project type.
- Incompatible or missing machine/output settings still block actual export on all exposed export entry points. A compatible machine retains existing valid posted output byte-identically.
- Mutating the authoring guard back to the old machine requirement fails the new tests. Removing the export refusal independently fails output-boundary tests.
- Save/load, undo/redo, desktop/tablet workflows and current #1016 direction tests remain green.

Status: planned, awaiting Frank's approval before implementation.

Plan approved by Frank 2026-10-15: “Approve #1034”. DSH implements the bounded Rotary/Plasma design-independence fix after the current #1016 direction amendment is verified and handed off. Machine/output safety checks remain required; no merge without Frank UI acceptance.
