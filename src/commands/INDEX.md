# INDEX — src/commands/

Shared command-model hooks and pure derivation helpers used by desktop and tablet command surfaces.

## Files
- `sketchCommands.ts` — unified store-backed predicates and command descriptors for feature transforms, boolean actions, arrange tools, sketch-edit tools, constraints, and measure/dimension tools.
- `creationShapes.ts` — single creation shape option list plus placement/text command descriptors.
- `fileCommands.ts` — shared file/history command descriptors for new/open/import/export/print/save/undo/redo.

## Tests
- `sketchCommands.test.ts` — DOM-free predicate and active/disabled derivation coverage.
