# INDEX — src/components/commandPalette/

Ctrl/Cmd+K command palette. `CommandPaletteHost` owns the open state and the
global shortcut, so the store-backed command hooks stay unmounted while the
palette is closed. `CommandPalette` builds the registry from the existing file,
sketch and creation descriptors, filters enabled commands, and executes them
through the shared registry contract. Styling lives in `commandPalette.css`.

The palette is a consumer of `src/commands/`; it does not own command semantics.
