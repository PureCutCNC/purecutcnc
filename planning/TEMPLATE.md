---
status: Draft   # Draft → Approved → In progress → Done | Abandoned
created: YYYY-MM-DD
---

# <TASK NAME> Plan

> Copy this file to `<TOPIC>_Plan.md`, fill in each section, add an entry to `planning/INDEX.md` under "Pending approval", and ask the user for approval **before changing any code**. Delete this blockquote and the inline hints once filled in.

## Goal

What we're trying to accomplish and why. One short paragraph. Include the user-visible outcome if relevant.

## Approach

The strategy at a high level. Bullets are fine. Mention key data-model changes, new types/files, and any algorithm choice that's worth flagging.

## Files affected

- `path/to/file.ts` — what changes and why
- `path/to/other.tsx` — …
- *(new)* `path/to/newfile.ts` — what it will contain

Keep this list honest — it's the agreement about scope.

## Tests

What unit/integration tests will be added or updated. Engine work **must** have unit tests (see [AGENTS.md](../AGENTS.md)).

## Open questions / risks

Anything that needs a decision from the user before implementation, or risks worth flagging (perf, migration, UX trade-offs). Leave empty if there are none.

## Out of scope

Explicitly call out things that look related but won't be tackled here, so reviewers don't expect them.
