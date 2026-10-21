# INDEX — src/components/commandPalette/

Ctrl/Cmd+K command palette. `CommandPaletteHost` owns the open state, the global
shortcut and the toolbar open event, so the store-backed command hooks stay
unmounted while the palette is closed; it also returns focus to the element that
opened the palette. `CommandPalette` builds the registry from the existing file,
sketch and creation descriptors, filters enabled commands, and executes them
through the shared registry contract. Its Escape handler runs in the capture
phase so an underlying dialog keeps its draft, and Tab is contained by the
modal. `events.ts` defines the shared open event. Styling lives in
`commandPalette.css`.

The palette is a consumer of `src/commands/`; it does not own command semantics.
