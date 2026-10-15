# Issue #1034 — slice B: project-type wording and browser coverage

Follow #962 Session rules/Manager handbook and approved #1034 below. Frank approved comment6193836024. DSH codes; manager verifies. Core A fd964ac3 accepted after manager whole diff/RISKS, four focusedfiles, own stock guard and missing-machine export mutations (both fail/restored), same safety probe against baseline modules (5/5 and identical valid-program hash).
A changes Around authoring guard to type+round stock only. No production output change. Plasma audit found NO remaining functional machine-driven authoring gate: actual Plasma addTool/addOperation works without machine or with router. Remaining defects are UI wording and unreachable old Around tooltip logic. UI B follows A, no other coder active.
Feature is integration-based, so #1016 Thread/Flutes UI is absent. Preserve its separate green PR1033/worktrees; no edits or scope contamination. Base fd964ac3 plus this tracked handoff.

## Ownership
Own src/components/layout/FaceSwitch.tsx; src/components/cam/machineMode.ts and its focused test; necessary narrow CAMPanel/operation family badge/count/add-menu hint consumers; relevant five-locale cam/appShell catalogs; e2e/aroundFace.smoke.spec.ts, plasmaMode.smoke.spec.ts, projectType.smoke.spec.ts and selectors if necessary; nearest INDEX.
You may narrow aroundUnavailableReason's return union to null|needsRotaryProject|needsRoundBar and update its obsolete explanatory comment / matching store INDEX sentence after removing FaceSwitch's unreachable machine branches. Do not change its runtime type/stock checks or any other store behavior/tests.
OFF LIMITS: engine/toolpaths/G-code/machine, export preparation/service production, format/types, package/gates/entrypoints/shared Select, all other trees. Report genuine out-of-scope output gap rather than patching it. No broad rename/refactor of machineMode APIs just because names are historical.

## Concrete changes
FaceSwitch machine tooltip branches no longer reachable after A. Remove dead machine-axis lookup and unused imports, clean exact obsolete locale keys after checking all callers. Around remains type+round-stock authored, busy guards unchanged.
operationOffer returns needs-plasma-machine for non-Plasma type; use a project-type reason and hint (e.g. choose Plasma project type in properties), not machine instruction. Existing CAM badges/counts “not on this machine” / “left out of export on this machine” are driven by PROJECT TYPE: correct them for retained other-family content. Preserve machine wording where it actually describes export compatibility/controller settings. Inspect every key's consumers; no blind string sweep.
Five locales: real translations, matching key order; report exact added/removed/changed key list per catalog. No unrelated existing-value changes. Do not remove unused projectMachineKind merely for cleanup.
No new blocking authoring warning, control, fake/default machine, or machine capability change.

## Browser tests (worker cannot run)
Update old Around spec at~136 that demands disabled no-rotary-machine button. Replace with actual authoring and keep real export refusal assertions.
Rotary X/Y mm/inch with no/plain/plasma/matching/opposite-axis machine: enabled Around, draw/select/edit geometry, provisionally realized setup, machine changes retain face/content; preview/simulation with real nonempty generated moves. Reasonable browser matrix plus A's full structural matrix, avoid repetitive expensive suite.
Plasma with no machine or router: actual plasma-profile creation and plasma torch/tool-library family available, selection does not change mode or geometry; no Top/Bottom rotary expansion. Non-Plasma hint directs project type; retained-operation badges/counts describe type. Switching type keep/hide behavior remains.
At least one real incompatible-machine ExportDialog workflow blocks SAVE/download with proper warning, and missing-machine output still refuses; do not conflate authoring with posting. Keep other existing output coverage, no weakening assertions to make UI green.
Desktop and tablet1180x820 (hasTouch true): usable enabled Around and corrected menus/labels, focus/undo. Manager will inspect screenshots and low-angle preview/simulation as relevant. All specs in existing CI lanes, no new spec unless necessary with lane registration (package offlimits so prefer existing).
Avoid canvas/viewport assertions that pass with zero moves; assert gear up-to-date and nonempty paths for preview/sim tests. Shared Select ambiguity: scope by semantic field.

Worker may run app tsc/scoped lint/focused mode test/list and locale/lane check serially; NO browser/fullbuild/testpool/install/commit. COMMIT:none. Manager reads realdiff/RISKS/locales, runs own UI mutation, actual isolated1439 two-worker browser/screenshots, all gates. Report exact command exits and known blind browser assumptions/RISKS.

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
