---
name: manual-impact
description: Write the Manual impact section every PureCutCNC PR description carries — decide whether the change is visible in the user manual, name the manual pages and screenshots it affects, and keep the section current through review. Use before `gh pr create`, and again whenever review changes user-visible behaviour.
---

# manual-impact

The user manual lives in a separate repo, `PureCutCNC/purecutcnc.github.io`,
and nothing else tells it when the app changes (#818). You write a **Manual
impact** section in the PR description; when the PR merges,
[`manual-impact.yml`](../../../.github/workflows/manual-impact.yml) opens an
issue in the docs repo from that section **as merged**, with the merge commit.
The `manual-impact-check` job fails the PR while the section is missing or
malformed.

You decide, not a file list, because you know what changed. #816 moved where
automatic tabs land and touched only engine code; no path rule would have
caught it.

## 1. Decide

The change has manual impact when a user following the manual would now see or
get something different:

- a control, panel, dialog, menu entry, parameter, option, label or icon is
  added, removed, renamed, moved or restyled;
- a default value the manual could quote changes;
- an operation, strategy, shape or import format is added or behaves
  differently;
- behaviour a page describes changes, even with no visible UI change (#816);
- an existing screenshot is now wrong, including one framed around a bug the
  PR fixes (#813).

Pure refactors, performance work with identical output, test-only and
process-only changes, and translations outside `en` are `None`.

If the diff touches `src/i18n/locales/en/**`, `src/components/**`,
`src/assets/icons/**`, CSS or `src/theme/**`, or
`src/store/helpers/operationDefaults.ts`, look twice before writing `None`.

## 2. Find the pages and screenshots

The manual is being rebuilt on the docs repo's `site-revamp` branch; once it
merges, use `main`. List the pages:

```bash
gh api "repos/PureCutCNC/purecutcnc.github.io/git/trees/site-revamp?recursive=1" \
  --jq '.tree[].path | select(startswith("site/src/content/docs/guide/") and endswith(".mdx"))
        | ltrimstr("site/src/content/docs/") | rtrimstr(".mdx")'
```

List the captured screenshots with what each shows, then grep for the panel,
operation or control you changed:

```bash
gh api "repos/PureCutCNC/purecutcnc.github.io/contents/site/src/assets/manual/media.json?ref=site-revamp" \
  --jq .content | base64 -d \
  | jq -r 'to_entries[] | select(.value.source == "capture") | "\(.key)\t\(.value.shows)"'
```

Name pages as the first command prints them (`guide/cam-setup/tabs`) and
screenshots by their `media.json` key (`cam-setup/tabs/tab-crossings.png`). Name
what you found; do not guess a page that is not in the list.

## 3. Write the section

Put it in the PR description, exactly one per PR. No impact:

```markdown
<!-- manual-impact:start -->
### Manual impact
None
<!-- manual-impact:end -->
```

Impact:

```markdown
<!-- manual-impact:start -->
### Manual impact
Pages: guide/cam-setup/tabs, guide/operations/pocket
Changed: automatic tabs now land on feature edges instead of spacing evenly
along the path; the Tabs panel is unchanged.
Re-shoot: cam-setup/tabs/tab-crossings.png
<!-- manual-impact:end -->
```

- `Pages:` and `Changed:` are required, `Re-shoot:` is optional. Lists are
  comma-separated; a field may continue onto following lines.
- `Changed:` is written for the docs author, who has not read the PR: what the
  user now sees or gets, in user terms, including exact new labels and
  defaults.
- `None` is the only line when there is no impact.

Validate before pushing (Node 24+ runs it directly):

```bash
PR_BODY="$(cat body.md)" node tools/manual-impact/cli.ts check
```

## 4. Keep it current

The docs issue is written from the description at merge time, so the section
must describe the final PR. When review renames a label, drops an option or
changes behaviour, update the section in the same push:

```bash
gh pr edit NN --body-file body.md
```

Editing the description re-runs the check and moves the `manual-impact` label.

## After merge

The workflow opens `App change: <PR title> (purecutcnc#NN)` in the docs repo,
labelled `app-change`, and comments its link on the PR. If that job failed, for
example because the token expired, re-run it from Actions → Manual Impact →
Run workflow with the PR number; it never opens a second issue for the same PR.
