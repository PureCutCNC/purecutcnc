# INDEX — src/commands/

Shared command-model hooks and pure derivation helpers used by desktop and tablet command surfaces.

## Files
- `commandRegistry.ts` — framework-free `CommandSpec` contract, token search, serializable `listCommands` projection, duplicate-id guard, and guarded `run` results. Shared by the palette today and a future bridge.
- `useAppCommands.ts` — adapter that gives the existing file, sketch and creation descriptors namespaced ids and the palette's metadata; also exposes the view command. It does not own command semantics.
- `sketchCommands.ts` — unified store-backed predicates and command descriptors for feature transforms (including one-shot feature distribution), boolean actions, arrange tools, sketch-edit tools, constraints, and measure/dimension tools.
- `creationShapes.ts` — single creation shape option list plus placement/text command descriptors.
- `fileCommands.ts` — shared file/history command descriptors for new/open/import/export/print/save/undo/redo.

## Tests
- `commandRegistry.test.ts` — search ordering, metadata projection, duplicate ids, and guarded run outcomes.
- `sketchCommands.test.ts` — DOM-free predicate and active/disabled derivation coverage.
