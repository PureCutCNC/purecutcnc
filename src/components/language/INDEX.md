# INDEX — src/components/language/

Language management UI: the manager dialog reached from the language menu and
the per-key custom-language editor. All state flows through `useI18n()`
(backed by `src/i18n/`); language packs are application-local preferences —
nothing here touches project data.

- `LanguageManagerDialog.tsx` — built-in locales + custom language packs;
  activate, duplicate-and-edit, rename, edit, delete, import, and export
  actions with translation-progress reporting; mirrors `ThemeManagerDialog`
  and reuses its list/detail layout classes.
- `LanguageEditorDialog.tsx` — per-key translation editor: rows grouped by
  key namespace in collapsed sections (rows render only when a section is
  open), search plus all/untranslated/edited filtering, placeholder-parity
  gate blocking Apply, name + BCP-47 tag fields, and "Preview in app" which
  persists the draft (Cancel restores the on-open snapshot and previously
  active language).
