# INDEX — src/machine/

Application machine library. Deliberately separate from the `.camj` project
store: bundled definitions always come from the current build, custom
definitions ("My Machines") are application preferences in namespaced local
storage, and neither is ever serialized into a project file. Mirrors the
`src/theme/` and `src/i18n/` architecture.

A project embeds only the single definition selected for it
(`project.meta.machineDefinitions` holds zero or one entry). That embedded
snapshot is authoritative for G-code export, so library edits and application
upgrades can never silently change a project's output — replacing the snapshot
is always an explicit user action. See
[`planning/G-code_Export_Design.md`](../../planning/G-code_Export_Design.md).

- `registry.ts` — bundled/custom split and reserved bundled IDs, custom-machine
  **structural** validation (`builtin` forced to `false`; capability checks and
  defaults, no #1057 template rules), functional-field fingerprinting and
  comparison, collision-safe ID allocation, duplication, combined library
  assembly, the picker's candidate list (`machineCandidates`: the library plus a project's embedded snapshot when the library no longer has it, issue #1028), project-snapshot status
  (`in-sync` / `update-available` / `not-in-library`), and JSON import/export.
  A template-invalid machine is accepted and kept; export refuses it (#1119).
- `diagnostics.ts` — structured `MachineLoadDiagnostic` reports for rescue,
  consolidation, re-keying, retained-invalid machines and unreadable library
  envelopes, plus the `MachineLoadError` a lossy project load throws and
  `machineLoadWarning` (every report, including rescue/consolidation info, so
  the one-time load alert names what moved — #1119).
- `storage.ts` — versioned local-storage codec for My Machines. A
  template-invalid record is kept, a duplicate or bundled-ID record is re-keyed
  rather than dropped, and an unreadable envelope is reported and marks the
  library write-blocked so its stored bytes are preserved. One corrupt entry
  still cannot block app start.
- `store.ts` — framework-agnostic library state: snapshot + subscribe/notify,
  custom-machine save/delete, the legacy-project merge used by decode, and the
  read diagnostics / write-blocked flag the machine manager shows (#1119). The
  merge reports whether the written list is durable and a delete/blocked write
  returns a displayable reason, so a project never compacts a machine the
  library did not actually store.
- `bootstrap.ts` — loads My Machines before React renders (project decode reads
  the library synchronously during a file open).
- `useMachineLibrary.ts` — React binding (`useSyncExternalStore`) for the
  library snapshot; pair with the pure `machineSnapshotStatus()`.
- `grblPlasmaMachine.test.ts` — G-code pierce mode (#983): touch-off validation, the bundled Grbl plasma machine's parity with `grbl.json`, QtPlasmaC key-order stability, pierce-mode switching in the focused form, and the delivered probe/pierce/dwell/cut sequence.
- `plasmaMachine.test.ts` — plasma schema, library import/duplicate, storage, 3.3 project snapshot, focused form and no-torch-output regression checks.
- `*.test.ts` — registry validation/fingerprint/import/duplication/merge
  coverage, store persistence behavior, and the #1119 retain/rescue/report
  paths.

## Conventions
- Library mutations never call into `projectStore`: they must not dirty a
  project or enter its undo history.
- Bundled IDs are reserved. A custom definition that claims one is re-keyed on
  read or import, never dropped.
- A definition that still breaks a template rule is stored unchanged and
  refused at export; eligibility is computed from `machineTemplateDiagnostics`,
  never persisted as an "invalid" flag.
- Compare definitions with `machinesFunctionallyEqual` (ignores the
  non-functional `builtin` flag), never with raw deep equality.
