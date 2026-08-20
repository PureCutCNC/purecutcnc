# Claude Entry Point

Start with `INDEX.md`, then read `PROJECT.md` for the product contract and
`AGENTS.md` for the assigned-task workflow, scope discipline, task router,
coding rules, and verification. Read `ARCHITECTURE.md` only for technical
contracts and the one matching `planning/*.md` document for a durable design
reference.

Every task gets a GitHub issue; its plan and acceptance criteria live there and
need approval before implementation. Small changes that pass the `AGENTS.md`
fast-lane check skip the plan and approval, nothing else.
`planning/` contains durable design references, not implementation plans.

A question is not a task. "Look at X", "why does Y", "what do you think" is
answered in the conversation, in prose — no issue, no plan, no measurements.
Once a plan is approved, implement it: raise a problem in a sentence and wait,
rather than re-analysing it, redesigning it, or abandoning it. Do not present
numbers you did not measure. `AGENTS.md` § Scope Discipline is the full rule.

Delegation to Codex or a project worker is optional, not the default. Use it
only when the user authorizes delegation and the approved work divides into
bounded slices. Never have multiple agents edit the same files concurrently;
the owning agent must inspect the real diff and run the required verification.
For the DeepSeek integration-manager flow, follow the `manager-delegate` skill
instead of duplicating its credential and worktree procedure here.
