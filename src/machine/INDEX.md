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
  schema validation (`builtin` forced to `false`), functional-field
  fingerprinting and comparison, collision-safe ID allocation, duplication,
  combined library assembly, project-snapshot status
  (`in-sync` / `update-available` / `not-in-library`), and JSON import/export.
- `storage.ts` — versioned local-storage codec for My Machines. Invalid,
  duplicate, and bundled-ID-claiming records are dropped individually so one
  corrupt entry can never block app start.
- `store.ts` — framework-agnostic library state: snapshot + subscribe/notify,
  custom-machine save/delete, and the legacy-project merge used by decode.
- `bootstrap.ts` — loads My Machines before React renders (project decode reads
  the library synchronously during a file open).
- `useMachineLibrary.ts` — React binding (`useSyncExternalStore`) for the
  library snapshot; pair with the pure `machineSnapshotStatus()`.
- `*.test.ts` — registry validation/fingerprint/import/duplication/merge
  coverage and store persistence behavior.

## Conventions
- Library mutations never call into `projectStore`: they must not dirty a
  project or enter its undo history.
- Bundled IDs are reserved. Custom definitions that claim one are rejected on
  read and re-keyed on import.
- Compare definitions with `machinesFunctionallyEqual` (ignores the
  non-functional `builtin` flag), never with raw deep equality.
