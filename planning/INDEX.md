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
- [TROCHOIDAL_EDGE_DESIGN.md](TROCHOIDAL_EDGE_DESIGN.md) — trochoidal Edge Route roughing: guide-domain fragmentation, the clearance budget, and the pipeline stages it must bypass.
- [INTEGRATION_HANDOFF_TEMPLATE.md](INTEGRATION_HANDOFF_TEMPLATE.md) — optional execution-ledger template for explicitly delegated, multi-slice work.
- [ISSUE_619_INTEGRATION_HANDOFF.md](ISSUE_619_INTEGRATION_HANDOFF.md) — active execution ledger for issue #619 (feed reduction on `rough_surface` and `finish_surface_cleanup`) on `feat/issue-619-feed-reduction`.
- [ISSUE_468_INTEGRATION_HANDOFF.md](ISSUE_468_INTEGRATION_HANDOFF.md) — active execution ledger for issue #468 (bulk tab and clamp editing) on `feat/issue-468-bulk-tabs-clamps`.
- [ISSUE_414_INTEGRATION_HANDOFF.md](ISSUE_414_INTEGRATION_HANDOFF.md) — active execution ledger for issue #414 (smooth tabs) on `feat/issue-414-smooth-tabs`.
- [I18N_MULTI_LANGUAGE_HANDOFF.md](I18N_MULTI_LANGUAGE_HANDOFF.md) — active execution ledger for issue #314 (multi-language support) on `feat/issue-314-multi-language`.
- [THEME_TOKENIZATION_HANDOFF.md](THEME_TOKENIZATION_HANDOFF.md) — colour policy and active execution ledger for issue #341 (complete theme tokenization).
- [REGION_DOMAIN_HANDOFF.md](REGION_DOMAIN_HANDOFF.md) — active execution ledger for issue #452 (regions as a resolved operation domain) on `feat/issue-452-region-domain`.

## Export and simulation

- [G-code_Export_Design.md](G-code_Export_Design.md) — machine origin, machine definitions, postprocessing, and export.
- [Post_Processor_Converter_Design.md](Post_Processor_Converter_Design.md) — standalone CLI (issue #402) that converts external CAM post-processor files into a machine definition; conversion-report contract, supported formats, and the safety/review workflow.
- [SIMULATION_GPU_HEIGHTFIELD_DESIGN.md](SIMULATION_GPU_HEIGHTFIELD_DESIGN.md) — CPU simulation state and GPU heightfield rendering boundary.

## UI

- [TOOLBAR_REVISIT.md](TOOLBAR_REVISIT.md) — proposed toolbar interaction and structural redesign constraints.
- [../src/assets/icons/README.md](../src/assets/icons/README.md) — SVG icon sources, sizing, colour, and sprite generation.

For the current medial-axis V-carve implementation, start with
[`src/engine/toolpaths/vcarveMedial/INDEX.md`](../src/engine/toolpaths/vcarveMedial/INDEX.md).
