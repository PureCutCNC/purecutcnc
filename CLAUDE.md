# Claude Entry Point

Start with `INDEX.md`, then read `PROJECT.md` for the product contract and
`AGENTS.md` for the assigned-task workflow, task router, coding rules, and
verification. Read `ARCHITECTURE.md` only for technical contracts and the one
matching `planning/*.md` document for a durable design reference.

Every task plan and acceptance criteria live in an approved GitHub issue.
`planning/` contains durable design references, not implementation plans.

Delegation to Codex or a project worker is optional, not the default. Use it
only when the user authorizes delegation and the approved work divides into
bounded slices. Never have multiple agents edit the same files concurrently;
the owning agent must inspect the real diff and run the required verification.
For the DeepSeek integration-manager flow, follow the `manager-delegate` skill
instead of duplicating its credential and worktree procedure here.
