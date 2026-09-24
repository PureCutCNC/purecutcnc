# INDEX — tools/manual-impact/

- [`manualImpact.ts`](manualImpact.ts) — parses the PR description's Manual impact section and renders the user-manual issue opened on merge (#818).
- [`cli.ts`](cli.ts) — `check` and `render` entry points for [`manual-impact.yml`](../../.github/workflows/manual-impact.yml); runs on plain Node 24+.
- [`manualImpact.test.ts`](manualImpact.test.ts) — parser, renderer and CLI tests, run by `npm test`.

Authors write the section with the [`manual-impact` skill](../../.agents/skills/manual-impact/SKILL.md).
