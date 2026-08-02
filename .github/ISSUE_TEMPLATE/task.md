---
name: Task / Plan
about: A unit of work. Write the plan here, get approval, then implement. (See AGENTS.md workflow.)
title: ""
labels: []
---

<!--
This issue IS the plan. Fill in each section, then ask the user for approval BEFORE changing any code.
Add this issue to the Project board, set the area label, Size, and PRIORITY, and set Status to Backlog/Ready.
When work is done, open a PR with "Closes #<this issue>" — the PR is the delivery, not the plan.
-->

> **Before filing — intake rule (AGENTS.md § The Backlog Contract, R5).**
> Open an issue only for work that is **(a)** a defect, **(b)** externally
> requested, or **(c)** something you intend to start this cycle. An idea that
> is none of these does not get a card. If it matters, it will come back — with
> better evidence than you could write today.
>
> Issues that are `P2` or unprioritized and go 60 days without activity are
> labelled `stale`, then closed 14 days later. Set a **Priority** on the board.

## Goal

What we're trying to accomplish and why. One short paragraph. Include the user-visible outcome if relevant.

## Approach

The strategy at a high level. Bullets are fine. Mention key data-model changes, new types/files, and any algorithm choice worth flagging.

## Files affected

- `path/to/file.ts` — what changes and why
- *(new)* `path/to/newfile.ts` — what it will contain

Keep this list honest — it's the agreement about scope.

> Anchor references on **file + function/symbol names** (e.g. `updateHeightfieldTexture()` in `gpuMesh.ts`), not line numbers — line numbers go stale on the next refactor. A line number is fine as a parenthetical hint, never as the anchor.

## Tests

What unit/integration tests will be added or updated. Engine work **must** have unit tests (see AGENTS.md).

## Open questions / risks

Anything that needs a decision before implementation, or risks worth flagging (perf, migration, UX trade-offs). Leave empty if none.

## Out of scope

Things that look related but won't be tackled here, so reviewers don't expect them.
