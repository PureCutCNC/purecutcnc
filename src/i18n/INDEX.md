# INDEX — src/i18n/

Typed localization layer. Application-local language preferences, deliberately
separate from the `.camj` project store: switching language never dirties a
project, never enters undo history, and never changes machine-facing output
(G-code, serialized enums, deterministic number formatting). English is the
canonical catalog and per-key fallback; other locales — built-in or
user-created — are overlays. Mirrors the `src/theme/` architecture.

- `catalog.ts` — message contract: `{placeholder}` interpolation, placeholder
  parity helpers, and `Intl.PluralRules`-backed `.one`/`.other` variant
  selection.
- `locales/en/` — the canonical English catalog, one module per UI area
  (`shell.ts` today; later extraction phases add `sketch.ts`, `cam.ts`, …).
  `index.ts` merges the modules and derives `MessageKey`.
- `locales/zh-CN/` — Simplified Chinese, mirroring the `en/` module layout;
  each module is typed as a complete record of its English counterpart so
  extraction and translation land together. Terminology in `GLOSSARY.md`.
- `GLOSSARY.md` — en ↔ zh-CN CNC terminology and style reference for
  translators and future locales.
- `registry.ts` — built-in locale metadata, custom language-pack schema
  validation, base+overrides resolution, duplication, translation progress,
  placeholder-issue reporting, and the versioned import/export envelope.
- `selection.ts` — storage keys/codecs, stored-data sanitization, navigator
  locale detection (`zh` → zh-CN unless explicitly Traditional), and
  initial-locale resolution (explicit stored choice wins).
- `store.ts` — framework-agnostic active-locale store: `translate()` /
  `translatePlural()` for non-React call sites, custom-pack CRUD,
  subscribe/notify for React, and `document.documentElement.lang` upkeep.
- `warningText.ts` — the single presentation mapper for structured engine
  warnings (`{ code, params }` → localized text; injects the clamp move-kind
  word). Catalog module `locales/*/warnings.ts`; coverage locked by
  `warningsCoverage.test.ts`.
- `bootstrap.ts` — resolves the locale before React renders (no
  wrong-language flash; covers the phone-blocker screen).
- `i18nContext.ts` / `I18nProvider.tsx` — React context (`useI18n()` →
  `t`/`tPlural`/`setLocale`/pack CRUD) over the store via
  `useSyncExternalStore`.
- `*.test.ts` — catalog helpers, registry validation/resolution (including
  zh-CN completeness and placeholder parity), selection/detection, and store
  behavior.
