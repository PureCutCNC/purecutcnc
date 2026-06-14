Read and follow `AGENTS.md` for project overview, build commands, coding standards, directory layout, and key conventions.
Read `ARCHITECTURE.md` for deeper architectural detail.
Consult `planning/` for feature-specific implementation plans before starting work.

## Codex MCP Delegation

When implementation, tests, repo inspection, build failures, or PR review would benefit from Codex, delegate to the Codex MCP server.

When calling Codex:
- Set `cwd` to the active repo/worktree root for the task.
- For PureCutCNC, use `/Users/frankp/Projects/purecutcnc` only when working in the main checkout; use the task-specific worktree path when one exists.
- Use `sandbox=workspace-write` for implementation and `sandbox=read-only` for review.
- Use `approval-policy=on-request` or `approval-policy=untrusted`.
- Ask Codex to follow the repo `AGENTS.md`.
- Do not have Claude and Codex edit the same files concurrently.
- For larger edits, prefer a separate branch or worktree.
- Ask Codex to return a concise summary of files changed and verification run.