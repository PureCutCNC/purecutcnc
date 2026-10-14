# Issue #1028, slice A: the project type field and the rules that read it

Follow the Session rules in issue #962. Base: `feat/issue-1028-project-type` (from
`integration/0.6.0` @ 97098461). `gh` may be blocked in your sandbox; this file carries what you
need. Plan approved by Frank 2026-10-14, with (a) keep-and-hide and (b) note + export refused.
This slice is model and rules only: **no UI** (slice B builds the UI on the interfaces frozen
below).

## Why

Today the kind of project is inferred from other settings: plasma vs milling from the active
machine (`machineMode(project)` in `src/components/cam/machineMode.ts` →
`projectMachineKind` in `src/engine/gcode/definitions/index.ts`; also `toolsSlice.ts` line 72),
and rotary from stock + machine (`aroundUnavailableReason` in
`src/store/helpers/activeFace.ts`; the rotary operations exist only on Around). Frank wants the
user to choose a **project type** and everything else to follow it.

## Frozen interfaces (slice B codes against these exactly)

In `src/types/project.ts`:
```ts
export type ProjectType = 'milling' | 'plasma' | 'rotary'
// ProjectMeta gains:
projectType: ProjectType
```

New module `src/store/helpers/projectType.ts` (pure, no React, no store access):
```ts
/** Today's rules, used once on load for a file without the field. */
export function inferProjectType(project: Project): ProjectType
//   active machine is plasma (resolveMachineKind) -> 'plasma'
//   else isRoundStock(project.stock)                -> 'rotary'
//   else                                            -> 'milling'

/** The stored type; a hand-built project without it reads as inferProjectType. */
export function projectType(project: Pick<Project, 'meta' | 'stock'>): ProjectType

/** Whether a machine suits a type: plasma <-> machineKind 'plasma';
 *  rotary <-> router with a `rotary` block; milling <-> any router (rotary-capable included). */
export function machineMatchesProjectType(definition: MachineDefinition, type: ProjectType): boolean

/** null when the active machine suits the project type (or there is no machine). */
export function projectMachineMismatch(project: Project): null | { expected: ProjectType; machineName: string }

/** Stock shapes a type offers: milling/plasma -> ['block'], rotary -> ['round']. */
export function stockShapesForProjectType(type: ProjectType): ReadonlyArray<'block' | 'round'>

/** What changing the type would do, for the confirm dialog (slice B). Nothing is deleted. */
export interface ProjectTypeChangeSummary {
  readonly from: ProjectType
  readonly to: ProjectType
  /** enabled operations that would not be cut under the new type (plasma ops in milling/rotary, milling ops in plasma, rotary ops outside rotary) */
  readonly inactiveOperations: number
  /** Around features kept but hidden and not exported (leaving rotary) */
  readonly hiddenAroundFeatures: number
  readonly stockConversion: null | 'toBlock' | 'toRound'
  /** the machine that will be selected, or null when the current one matches or none matches */
  readonly machineChange: null | { id: string; name: string }
}
export function projectTypeChangeSummary(project: Project, to: ProjectType, candidates: readonly MachineDefinition[]): ProjectTypeChangeSummary
```

Store action (in the slice that owns `meta`, e.g. `workpieceSlice.ts`; one undo step):
```ts
setProjectType: (type: ProjectType, candidates: readonly MachineDefinition[]) => void
```
It sets `meta.projectType`; converts the stock with the existing `toBlockStock` / `toRoundStock`
(`src/store/helpers/stockShape.ts`, the same path `setStockShape` takes) when the current shape is
not offered by the new type; and when `projectMachineMismatch` would be non-null, selects the first
machine in `candidates` that matches (through the existing `setProjectMachine` logic in
`machineDefsSlice.ts`), else leaves the machine. It deletes nothing. `candidates` is the list the
machine picker shows (bundled definitions plus the user's library); find where that list is built
and export a helper that returns it, so slice B passes the same list.

## Rules to switch over

- **Load:** `normalizeProject` / `projectFormat.ts`: a file without `meta.projectType` gets
  `inferProjectType`. Format stays **3.3** (migration keyed on the missing field, decision 2 in
  #962). Saving writes the field. `newProject()` defaults to `'milling'`.
- **`machineMode(project)`** returns `'plasma'` for a plasma project, `'router'` for milling and
  rotary, from `projectType`, no longer from the machine. Same for `toolsSlice.ts` line 72.
- **`aroundUnavailableReason`**: a new first reason `'needsRotaryProject'` when the type is not
  rotary; then today's checks. Callers that hide Around on `'needsRoundBar'` must hide it on
  `'needsRotaryProject'` too (`FaceSwitch.tsx` line 72); no new UI text needed for it.
- **Rotary operations** (`rotaryAddKindsForFace` and the rotary target rules in
  `operationValidity.ts`, `setupTargets.ts`): offered only in a rotary project.
- **Keep and hide (a):** in a non-rotary project, Around features are not drawn, not in the 3D
  model, not generated and not exported, but stay in the project and the tree (find where
  `authoringFace === 'around'` features are filtered today, e.g. `flatFaceProject` in
  `src/engine/aroundFrame.ts`, and gate on the type). Plasma/milling operations under the other
  type already follow `operationCutOnMachine`, which now reads the type.
- **Export refused (b):** `src/app/toolpathGeneration/exportPreparation.ts` refuses to prepare a
  program when `projectMachineMismatch` is non-null, with a new warning code
  `exportMachineTypeMismatch` (params: machine name, expected type), added to `warningCodes.ts`,
  the five `warnings` locale files (real translations, key order as `en`) and
  `warningsCoverage.test.ts`. The postprocessor and emitters are not touched.

## Tests (they must bite: break the code, see a test fail; list each mutation)

- `inferProjectType` on every fixture project in the repo (`src/test/**`, the e2e fixtures you can
  load headless, `src/engine/**/fixtures`): the inferred type reproduces today's `machineMode` and
  today's `aroundUnavailableReason` for each. Generation and export of those fixtures are
  byte-identical before and after (pick at least one plasma, one round-bar Around, one plain
  milling fixture and compare the exported program text).
- Load/save round trip: a file without the field gains it; a file with it keeps it.
- `projectTypeChangeSummary` and `setProjectType` for each of the six type changes, on a project
  that has plasma operations, milling operations, Around features and a rotary operation; switching
  back restores everything (deep-equal on features and operations).
- `projectMachineMismatch` and the export refusal: a plasma machine on a milling project refuses;
  a rotary-capable router on a milling project does not.
- Machine selection on type change: picks the first matching candidate; none matching leaves it.

## Off limits

UI components and their locales (slice B), `src/engine/gcode/postprocessor.ts` and emitters,
`rotaryFrame.ts`, the toolpath generators. Browser specs: do not change any; list the ones you
expect to break (they switch plasma mode by picking a machine) in RISKS; slice C updates them.

## Report

Changes per file, each mutation and whether it was caught, commands with exit codes, RISKS
(including every place you found that infers the project kind from the machine or the stock that
this handoff did not list).
