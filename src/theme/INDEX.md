# INDEX — src/theme/

Application-local appearance preferences. Theme state is deliberately separate from the `.camj` project store, so changing appearance never dirties a project or changes saved files.

- `theme.ts` — theme preference types, persistence codec, system resolution, and pre-React root bootstrap.
- `ThemeProvider.tsx` — React context, localStorage persistence, and the conditional system-theme listener.
- `themeContext.ts` — context contract and `useTheme()` consumer hook, separated for Fast Refresh.
- `palette.ts` — typed 2D canvas and Three.js colors keyed by resolved theme.
- `theme.test.ts` — pure preference, bootstrap-root, codec, and palette coverage.
