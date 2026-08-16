---
name: github-issues
description: Wire the PureCutCNC GitHub workflow — create issues, set the org-level Priority field (R1), add board cards and set Status/Size/Area, move cards through the lifecycle, and open PRs. Use whenever AGENTS.md requires GitHub issue/board/PR mechanics, instead of re-discovering the GraphQL/REST calls each time.
---

# github-issues

Encodes the GitHub mechanics behind `AGENTS.md` §"Workflow: Issue → Plan →
Approve → Implement → PR" and §"The Backlog Contract". **AGENTS.md is
authoritative for policy** (R1–R5, caps, decay, fast lane); this skill is only
the *how* — the exact commands, IDs, and pitfalls. It exists because every one
of these calls was re-discovered from scratch on #524/#535/#536, at a cost of
several agent turns each.

Load it (or read it by path) before doing any of: `gh issue create`, board
wiring, Priority, status moves, PR opening. Then **verify after every mutation**
— mutation success is not delivery.

## The environment

- Repo: `PureCutCNC/purecutcnc`
- Project board: org `PureCutCNC`, project **#1** (node id `PVT_kwDOEEztyc4Bbqk-`)
- Org-level issue fields (native, set per-issue): `Priority` (R1), `Start date`,
  `Target date`, `Effort`
- Board fields: `Status`, `Size`, `Area`, plus read-only/derived ones

## Current IDs (fast path)

Verify with the discovery queries below if a mutation fails; IDs survive until
someone edits the fields, which is rare.

| Board field | field id | options |
| --- | --- | --- |
| Status | `PVTSSF_lADOEEztyc4Bbqk-zhWZisQ` | Backlog `f75ad846`, Ready `e18bf179`, In progress `47fc9ee4`, In review `aba860b9`, Done `98236657` |
| Size | `PVTSSF_lADOEEztyc4Bbqk-zhWZi5g` | XS `911790be`, S `b277fb01`, M `86db8eb3`, L `853c8207`, XL `2d0801e2` |
| Area | `PVTSSF_lADOEEztyc4Bbqk-zhWZltM` | vcarve `9741291f`, export `05ad4b5d`, simulation `fa63671b`, tablet-ux `12689f8a`, desktop `cd7286f9`, core `b4b71171`, ui `21d55d78`, toolpath `37ad0723`, i18n `12bb2556`, theme `56423e0d`, converters `083dd6f4` |

| Org issue field | field id | options |
| --- | --- | --- |
| Priority | `IFSS_kgDOAnL9vg` | Urgent `IFSSO_kgDOBEkkJg`, High `IFSSO_kgDOBEkkJw`, Medium `IFSSO_kgDOBEkkKA`, Low `IFSSO_kgDOBEkkKQ` |

Area guidance: engine/toolpath → `toolpath`, canvas/panels → `ui`, palette →
`theme`, gates/process/agent harness → `core`, desktop → `desktop`.

## Recipe: file an issue end-to-end (create → board → Priority)

1. **Create** (REST, cheap):

   ```bash
   gh issue create --title "…" --body "…" --label bug   # or enhancement/process/…
   ```

2. **Wire board + Priority** (GraphQL, one batch). Set `N`, the issue number,
   and the field values, then paste:

   ```bash
   python3 - <<'EOF'
   import json, subprocess
   def gql(query, **vars):
       p = subprocess.run(['gh','api','graphql','-f',f'query={query}',
                           *[f'-F{k}={v}' for k,v in vars.items()]],
                          capture_output=True, text=True)
       if p.returncode: raise SystemExit(p.stderr)
       return json.loads(p.stdout)

   N = 999  # the issue number
   STATUS = ('PVTSSF_lADOEEztyc4Bbqk-zhWZisQ', 'f75ad846')   # Backlog
   SIZE   = ('PVTSSF_lADOEEztyc4Bbqk-zhWZi5g', 'b277fb01')   # S
   AREA   = ('PVTSSF_lADOEEztyc4Bbqk-zhWZltM', '21d55d78')   # ui
   PRIO   = ('IFSS_kgDOAnL9vg', 'IFSSO_kgDOBEkkKA')          # Medium

   r = gql('query($n:Int!){ repository(owner:"PureCutCNC",name:"purecutcnc"){ issue(number:$n){ id } } }', n=N)
   issue_id = r['data']['repository']['issue']['id']
   PROJECT = 'PVT_kwDOEEztyc4Bbqk-'
   r = gql('mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }',
           p=PROJECT, c=issue_id)
   item_id = r['data']['addProjectV2ItemById']['item']['id']
   for field, value in (STATUS, SIZE, AREA):
       gql('mutation($p:ID!,$i:ID!,$f:ID!,$v:String!){ updateProjectV2ItemFieldValue(input:{'
           'projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$v}}){ clientMutationId } }',
           p=PROJECT, i=item_id, f=field, v=value)
   gql('mutation($i:ID!,$f:ID!,$v:String!){ setIssueFieldValue(input:{issueId:$i,'
       'issueFields:[{fieldId:$f,singleSelectOptionId:$v}]}){ clientMutationId } }',
       i=issue_id, f=PRIO[0], v=PRIO[1])
   print('wired', item_id)
   EOF
   ```

3. **Verify** (never skip — a mutation can 404 silently in a script):

   ```bash
   gh api repos/PureCutCNC/purecutcnc/issues/N --jq '.issue_field_values[] | select(.issue_field_name=="Priority") | .single_select_option.name'
   ```

   Board card fields — item id via the issue (cheaper than paginating items):

   ```bash
   gh api graphql -f query='query($n:Int!){ repository(owner:"PureCutCNC",name:"purecutcnc"){ issue(number:$n){ projectItems(first:5){ nodes{ id } } } } }' -F n=N
   gh api graphql -f query='query($i:ID!){ node(id:$i){ ... on ProjectV2Item { fieldValues(first:10){ nodes{ ... on ProjectV2ItemFieldSingleSelectValue { field{... on ProjectV2FieldCommon{name}} name } } } } } }' -F i='ITEM_ID'
   ```

## Priority — the exact shape that costs discovery

`setIssueFieldValue` takes `issueFields: [{ fieldId, singleSelectOptionId }]`.
The per-item nesting is required — passing `fieldId`/`singleSelectOptionId` at
the mutation top level fails validation. There is **no** REST endpoint for
setting org issue fields; only read them via REST (`.issue_field_values`, used
by `scripts/backlog-hygiene.ts`). Priority is the **native org issue field**,
not a board field — do not set it through `updateProjectV2ItemFieldValue`.

## Board item lookup

1. **Preferred:** `repository.issue(number).projectItems` (shown above) — one
   cheap query, no pagination.
2. **Fallback:** paginate `organization.projectV2.items(first:100, after:)`
   with cursors. `gh project item-list` defaults to 30 items per page and
   misleads by truncation — the card for a new issue lands at the **end** of
   the list, past the default page.

## Status lifecycle

Backlog (on file) → Ready (after plan approval) → In progress (implementing) →
In review (PR open) → Done (merge; auto). Move with
`updateProjectV2ItemFieldValue` and the Status option ids above. Don't leave a
card in the wrong state: `gh pr view --json ...` ≠ board state.

## PR mechanics

- `gh pr create --title … --body …` with `Closes #NN` in the body (merging
  auto-closes and moves the card to Done).
- Label `fast-lane` **only** when `npm run check:fast-lane` is green; the
  `fast-lane-guard` CI job re-checks every labeled PR and blocks merge if red.
- Rebase onto `origin/main` before opening and again if main moves
  (`git fetch origin && git rebase origin/main`, re-run `npm run build`).
- `gh pr checks NN` reporting "no checks reported" means the branch conflicts —
  unverified, not pending (AGENTS.md §Git & Branching).

## Rate limits — shared, and they bite

- REST and GraphQL are **separate 5000/hr pools, shared by every agent running
  on the same account**. A busy repo day exhausts GraphQL while REST is fine —
  observed on this account.
- Check first: `gh api rate_limit --jq '.resources.core.remaining, .resources.graphql'`.
- GraphQL resets at `resetAt` (query it); wait or fall back to REST, which
  covers issue create/view/edit/label and PR operations.
- Batch reads into one GraphQL query; **never poll GraphQL in a loop** — that is
  how a pool dies mid-task.

## Gotchas

- `gh issue edit --add-label/--remove-label` for labels; labels used here:
  `bug`, `enhancement`, `process`, `performance`, `documentation`,
  `external-report`, `needs-priority` (automatic), `stale`, `backlog-digest`,
  `fast-lane`.
- `issueFields` on `Organization` is a GraphQL **union** — direct field
  selection fails; use inline fragments (`... on IssueFieldSingleSelect` etc.).
- Some `fieldValues` nodes are not single-select (title text, derived fields) —
  filter on the fragment before reading `name`.
- After any wiring, re-check the card fields; setting a field on the *wrong
  item id* succeeds silently (happened once: 535 vs 536).
