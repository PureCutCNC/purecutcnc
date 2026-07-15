# Contributing to PureCutCNC

Thank you for your interest in contributing! This project is the result of a specific architectural and design vision. To ensure the project remains high-quality and consistent, please follow these guidelines.

## Our Philosophy
As the project owner and architect, I oversee the design, architecture, and quality assurance. I welcome contributions that align with the project's technical direction and user experience goals.

## Rules of Engagement

1. **Start with the authority chain:** read [`PROJECT.md`](PROJECT.md),
   [`INDEX.md`](INDEX.md), and [`AGENTS.md`](AGENTS.md), then load only the
   architecture or durable design reference for the area you are changing.
2. **Issue, plan, approval:** every change starts with a GitHub issue. Put the
   plan and acceptance criteria in the issue and wait for explicit approval
   before implementation. Checked-in `planning/` documents are not task plans.
3. **Branch and PR:** never commit directly to `main`; deliver completed work
   through a branch and a PR that closes the issue.
4. **Quality first:** run `npm run build` before committing. Run
   `npm run test:e2e` when rendered browser behavior or workflow wiring changes.
5. **Keep authority current:** update the nearest `INDEX.md` and the owning
   architecture/design document when a file responsibility or contract changes.
6. **The right to reject:** contributions may be rejected when they conflict
   with product scope, safety, architecture, or interaction direction.

## Licensing
By submitting a Pull Request, you agree to license your contribution under the Apache License, Version 2.0.
