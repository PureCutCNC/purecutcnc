# INDEX — planning/

This directory contains durable design references: the area-specific contracts
and rationale that should survive one implementation task. Read only the entry
for the area you are changing, then update it in the same change when its
contract moves.

Tasks are not tracked here. Active work, backlog, acceptance criteria, and the
approved plan live in a [GitHub issue](https://github.com/PureCutCNC/purecutcnc/issues)
on the [project board](https://github.com/orgs/PureCutCNC/projects/1). Follow the
workflow in [AGENTS.md](../AGENTS.md).

## Lifecycle metadata

Every top-level design reference except this index declares:

- `status`: `current` for implemented contracts or `proposed` for an unshipped
  design;
- `authoritative-for`: the narrow decisions the document owns;
- `last-verified`: the date it was checked against the repository.

Superseded plans, completed execution ledgers, and historical analyses belong
in [`archive/`](archive/). Do not use archived documents as current authority.
Reviews under [`reviews/`](reviews/) are dated assessments, not product or
architecture contracts.

## Product surfaces and cross-cutting contracts

- [DESKTOP_DESIGN.md](DESKTOP_DESIGN.md) — desktop shell and platform-adapter boundaries.
- [TABLET_UX_DESIGN.md](TABLET_UX_DESIGN.md) — tablet interaction, command-surface, layout, and focus contracts.
- [REGION_FEATURE_SEMANTICS.md](REGION_FEATURE_SEMANTICS.md) — regions as machining filters rather than material or standalone targets.
- [INTEGRATION_HANDOFF_TEMPLATE.md](INTEGRATION_HANDOFF_TEMPLATE.md) — optional execution-ledger template for explicitly delegated, multi-slice work.
- [I18N_MULTI_LANGUAGE_HANDOFF.md](I18N_MULTI_LANGUAGE_HANDOFF.md) — active execution ledger for issue #314 (multi-language support) on `feat/issue-314-multi-language`.
- [THEME_TOKENIZATION_HANDOFF.md](THEME_TOKENIZATION_HANDOFF.md) — colour policy and active execution ledger for issue #341 (complete theme tokenization).

## Export and simulation

- [G-code_Export_Design.md](G-code_Export_Design.md) — machine origin, machine definitions, postprocessing, and export.
- [SIMULATION_GPU_HEIGHTFIELD_DESIGN.md](SIMULATION_GPU_HEIGHTFIELD_DESIGN.md) — CPU simulation state and GPU heightfield rendering boundary.

## UI

- [TOOLBAR_REVISIT.md](TOOLBAR_REVISIT.md) — proposed toolbar interaction and structural redesign constraints.
- [../src/assets/icons/README.md](../src/assets/icons/README.md) — SVG icon sources, sizing, colour, and sprite generation.

For the current medial-axis V-carve implementation, start with
[`src/engine/toolpaths/vcarveMedial/INDEX.md`](../src/engine/toolpaths/vcarveMedial/INDEX.md).
