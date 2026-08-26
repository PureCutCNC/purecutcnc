# `/resume-work`

`/resume-work` is a transcript-backed worktree handoff reader. Start a fresh
agent session in the existing worktree, then run:

```sh
npx tsx tools/resume-work/run.ts
```

The command appends the incoming claim to the untracked
`.handoff/ledger.jsonl`, reads the preceding claim as the authoritative
predecessor, and prints a concise briefing. It never relies on a dying agent to
write a final message or a commit.

On a worktree's first handoff there is no predecessor ledger entry. In that
case the command falls back to the most recently updated transcript that matches
the current working directory and labels the briefing as a fallback. The
fallback is only for first-run discovery; later predecessor attribution comes
from the ledger, never mtime.

Use `--from` only to correct a missing or stale first-run attribution:

```sh
npx tsx tools/resume-work/run.ts --from codex
```

## Agent integration

Add this sentence to the repository's `AGENTS.md`:

> If the user says `/resume-work`, run `tools/resume-work/run.ts` and follow its output.

## Adapter contract

Each adapter converts its native transcript to newline-safe records in this
common format:

```text
sequence<TAB>kind<TAB>text
```

`kind` is `user`, `assistant`, `tool`, or `tool-result`. DSH's existing
`scripts/dsh-progress-filter.jq` remains the reference shape. The reader uses
the user records for intent and correction history, plus the most recent tool
records for execution context.

## Configuration

[`config.json`](config.json) supplies the expected worktree base, store paths,
branch-to-issue pattern, and conservative output limits. It uses `~`-relative
defaults for the four supported stores: DSH, Claude Code, Codex, and OpenCode.
The code has no PureCutCNC-specific runtime dependency; copy this directory
with its configuration to reuse it elsewhere.
