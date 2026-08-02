/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Backlog Contract enforcement — see AGENTS.md § "The Backlog Contract".
 *
 * Runs weekly from .github/workflows/backlog-hygiene.yml and:
 *   R1  labels open issues that have no board Priority
 *   R2  marks quiet issues `stale`, then closes them after a grace period
 *   R4  rewrites the body of the single pinned digest issue
 *
 * R3 (auto-label external reports) is enforced declaratively in the workflow,
 * not here. R5 (intake) is convention; R2 is its backstop.
 *
 * Default is a dry run. Pass --apply, or set DRY_RUN=false, to mutate.
 */

const STALE_AFTER_DAYS = 60
const CLOSE_AFTER_STALE_DAYS = 14
const P0_CAP = 5
const P1_CAP = 10
const EXTERNAL_RESPONSE_SLA_DAYS = 14

/** Never decays. An outside report is the scarcest signal the tracker holds. */
const EXEMPT_LABELS = ['external-report', 'pinned', 'backlog-digest']
/** Priorities that mean "committed" — decay would contradict the commitment. */
const EXEMPT_PRIORITIES = ['P0 — Now', 'P1 — Next']
/** Board statuses that mean somebody is already on it. */
const EXEMPT_STATUSES = ['Ready', 'In progress', 'In review']

const PROJECT_NUMBER = 1
const DIGEST_LABEL = 'backlog-digest'
const STALE_LABEL = 'stale'
const NEEDS_PRIORITY_LABEL = 'needs-priority'

/** Grace window absorbing the gap between our own comment and our own label. */
const SELF_EDIT_TOLERANCE_MS = 120_000

const MS_PER_DAY = 86_400_000

interface Issue {
  number: number
  title: string
  url: string
  updatedAt: string
  labels: string[]
  assigned: boolean
  authorAssociation: string
}

interface BoardFields {
  status: string | null
  priority: string | null
}

interface Plan {
  markStale: Issue[]
  close: { issue: Issue; staleSince: string }[]
  unStale: Issue[]
  addNeedsPriority: Issue[]
  removeNeedsPriority: Issue[]
}

const token = process.env.GITHUB_TOKEN ?? ''
const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? 'PureCutCNC/purecutcnc').split('/')
const apply = process.argv.includes('--apply') || process.env.DRY_RUN === 'false'
const now = Date.now()

if (!token) {
  console.error('backlog-hygiene: GITHUB_TOKEN is required')
  process.exit(1)
}

async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  const payload = (await response.json()) as { data?: T; errors?: { message: string }[] }
  if (payload.errors?.length) {
    throw new Error(`GraphQL: ${payload.errors.map((e) => e.message).join('; ')}`)
  }
  if (!payload.data) throw new Error('GraphQL: empty response')
  return payload.data
}

function daysSince(iso: string): number {
  return (now - Date.parse(iso)) / MS_PER_DAY
}

/** Every open issue in the repo, including any that never reached the board. */
async function fetchOpenIssues(): Promise<Issue[]> {
  const issues: Issue[] = []
  let cursor: string | null = null
  do {
    const data = await graphql<{
      repository: {
        issues: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
          nodes: {
            number: number
            title: string
            url: string
            updatedAt: string
            authorAssociation: string
            labels: { nodes: { name: string }[] }
            assignees: { totalCount: number }
          }[]
        }
      }
    }>(
      `query($owner:String!,$repo:String!,$cursor:String){
        repository(owner:$owner,name:$repo){
          issues(states:OPEN,first:100,after:$cursor){
            pageInfo{hasNextPage endCursor}
            nodes{
              number title url updatedAt authorAssociation
              labels(first:30){nodes{name}}
              assignees{totalCount}
            }
          }
        }
      }`,
      { owner, repo, cursor },
    )
    const page = data.repository.issues
    for (const node of page.nodes) {
      issues.push({
        number: node.number,
        title: node.title,
        url: node.url,
        updatedAt: node.updatedAt,
        labels: node.labels.nodes.map((l) => l.name),
        assigned: node.assignees.totalCount > 0,
        authorAssociation: node.authorAssociation,
      })
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (cursor)
  return issues
}

/** Board Status + Priority for every issue card on the project. */
async function fetchBoardFields(): Promise<Map<number, BoardFields>> {
  const fields = new Map<number, BoardFields>()
  let cursor: string | null = null
  do {
    const data = await graphql<{
      organization: {
        projectV2: {
          items: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null }
            nodes: {
              content: { number?: number } | null
              fieldValues: {
                nodes: { name?: string; field?: { name?: string } }[]
              }
            }[]
          }
        }
      }
    }>(
      `query($owner:String!,$number:Int!,$cursor:String){
        organization(login:$owner){
          projectV2(number:$number){
            items(first:100,after:$cursor){
              pageInfo{hasNextPage endCursor}
              nodes{
                content{ ... on Issue { number } }
                fieldValues(first:20){
                  nodes{ ... on ProjectV2ItemFieldSingleSelectValue { name field{ ... on ProjectV2FieldCommon { name } } } }
                }
              }
            }
          }
        }
      }`,
      { owner, number: PROJECT_NUMBER, cursor },
    )
    // A token without `project` scope returns null here rather than erroring.
    // Failing loudly matters: silently empty board data would read as "nothing
    // is prioritized" and mark the entire backlog stale in one run.
    if (!data.organization?.projectV2) {
      throw new Error(
        `cannot read project #${PROJECT_NUMBER} for org ${owner} — the token needs \`project\` scope. ` +
          'The default Actions GITHUB_TOKEN cannot read Projects v2; set the BACKLOG_PROJECT_TOKEN secret.',
      )
    }
    const page = data.organization.projectV2.items
    for (const node of page.nodes) {
      const issueNumber = node.content?.number
      if (issueNumber === undefined) continue
      let status: string | null = null
      let priority: string | null = null
      for (const value of node.fieldValues.nodes) {
        if (value.field?.name === 'Status') status = value.name ?? null
        if (value.field?.name === 'Priority') priority = value.name ?? null
      }
      fields.set(issueNumber, { status, priority })
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (cursor)
  return fields
}

/**
 * When the `stale` label was last applied. The workflow comments *before* it
 * labels, so this timestamp is the last thing we touched — anything newer in
 * `updatedAt` is a human, and rescues the issue.
 */
async function fetchStaleSince(issueNumber: number): Promise<string | null> {
  const data = await graphql<{
    repository: {
      issue: {
        timelineItems: { nodes: { createdAt?: string; label?: { name: string } }[] }
      }
    }
  }>(
    `query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){
        issue(number:$number){
          timelineItems(last:100,itemTypes:[LABELED_EVENT]){
            nodes{ ... on LabeledEvent { createdAt label{name} } }
          }
        }
      }
    }`,
    { owner, repo, number: issueNumber },
  )
  const events = data.repository.issue.timelineItems.nodes
    .filter((n) => n.label?.name === STALE_LABEL && n.createdAt)
    .map((n) => n.createdAt as string)
    .sort()
  return events.length > 0 ? events[events.length - 1] : null
}

function isExempt(issue: Issue, board: BoardFields | undefined): boolean {
  if (issue.labels.some((l) => EXEMPT_LABELS.includes(l))) return true
  if (issue.assigned) return true
  if (board?.priority && EXEMPT_PRIORITIES.includes(board.priority)) return true
  if (board?.status && EXEMPT_STATUSES.includes(board.status)) return true
  return false
}

async function buildPlan(issues: Issue[], board: Map<number, BoardFields>): Promise<Plan> {
  const plan: Plan = {
    markStale: [],
    close: [],
    unStale: [],
    addNeedsPriority: [],
    removeNeedsPriority: [],
  }

  for (const issue of issues) {
    const fields = board.get(issue.number)
    const exempt = isExempt(issue, fields)
    const hasStale = issue.labels.includes(STALE_LABEL)
    const hasNeedsPriority = issue.labels.includes(NEEDS_PRIORITY_LABEL)
    const isDigest = issue.labels.includes(DIGEST_LABEL)

    // R1 — every open issue carries a Priority.
    if (!isDigest && !fields?.priority && !hasNeedsPriority) plan.addNeedsPriority.push(issue)
    if (fields?.priority && hasNeedsPriority) plan.removeNeedsPriority.push(issue)

    // R2 — decay.
    if (hasStale) {
      if (exempt) {
        plan.unStale.push(issue)
        continue
      }
      const staleSince = await fetchStaleSince(issue.number)
      if (!staleSince) continue
      const rescued = Date.parse(issue.updatedAt) > Date.parse(staleSince) + SELF_EDIT_TOLERANCE_MS
      if (rescued) plan.unStale.push(issue)
      else if (daysSince(staleSince) >= CLOSE_AFTER_STALE_DAYS) plan.close.push({ issue, staleSince })
      continue
    }

    if (!exempt && daysSince(issue.updatedAt) >= STALE_AFTER_DAYS) plan.markStale.push(issue)
  }

  return plan
}

async function rest(method: string, path: string, body?: unknown): Promise<void> {
  if (!apply) return
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    method,
    headers: {
      Authorization: `bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`)
  }
}

const staleComment = () =>
  `## No activity for ${STALE_AFTER_DAYS} days\n\n` +
  `Per the [Backlog Contract](../blob/main/AGENTS.md#the-backlog-contract), this will close ` +
  `in **${CLOSE_AFTER_STALE_DAYS} days** unless something happens here.\n\n` +
  `**To keep it:** comment saying why, or raise its board Priority to \`P1 — Next\`. ` +
  `Either resets the clock. One sentence is enough — that sentence *is* the act of valuing it.\n\n` +
  `**If it closes, nothing is lost.** Closed issues stay searchable and reopenable forever. ` +
  `The good ones come back on their own, with better evidence than the original filing — ` +
  `that is the whole bet this rule makes.\n\n` +
  `<sub>Exempt from decay: external reports, \`P0\`/\`P1\`, assigned issues, and anything past ` +
  `\`Backlog\` on the board.</sub>`

const closeComment = (staleSince: string) =>
  `## Closed by the Backlog Contract\n\n` +
  `Quiet for ${STALE_AFTER_DAYS} days, then warned on ${staleSince.slice(0, 10)} with ` +
  `${CLOSE_AFTER_STALE_DAYS} days' notice, and nothing happened.\n\n` +
  `**This is a scheduling decision, not a verdict on the idea.** Reopen it the moment someone ` +
  `hits it for real — a reopen with a concrete case attached is worth more than this card was.\n\n` +
  `<sub>Rule: [AGENTS.md § The Backlog Contract](../blob/main/AGENTS.md#the-backlog-contract). ` +
  `Adjust or disable it there.</sub>`

async function execute(plan: Plan): Promise<void> {
  for (const issue of plan.addNeedsPriority) {
    await rest('POST', `/issues/${issue.number}/labels`, { labels: [NEEDS_PRIORITY_LABEL] })
  }
  for (const issue of plan.removeNeedsPriority) {
    await rest('DELETE', `/issues/${issue.number}/labels/${NEEDS_PRIORITY_LABEL}`)
  }
  for (const issue of plan.unStale) {
    await rest('DELETE', `/issues/${issue.number}/labels/${STALE_LABEL}`)
  }
  // Comment first, then label: the label event becomes the last thing we did,
  // so any later `updatedAt` is unambiguously a human rescuing the issue.
  for (const issue of plan.markStale) {
    await rest('POST', `/issues/${issue.number}/comments`, { body: staleComment() })
    await rest('POST', `/issues/${issue.number}/labels`, { labels: [STALE_LABEL] })
  }
  for (const { issue, staleSince } of plan.close) {
    await rest('POST', `/issues/${issue.number}/comments`, { body: closeComment(staleSince) })
    await rest('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'not_planned' })
  }
}

function buildDigest(issues: Issue[], board: Map<number, BoardFields>, plan: Plan): string {
  const list = (rows: string[]) => (rows.length > 0 ? rows.join('\n') : '_none_')
  const link = (i: Issue) => `- #${i.number} — ${i.title}`

  const byPriority = (name: string) =>
    issues.filter((i) => board.get(i.number)?.priority === name)
  const p0 = byPriority('P0 — Now')
  const p1 = byPriority('P1 — Next')
  const p2 = byPriority('P2 — Later')
  const unranked = issues.filter(
    (i) => !board.get(i.number)?.priority && !i.labels.includes(DIGEST_LABEL),
  )
  const external = issues.filter((i) => i.labels.includes('external-report'))
  const externalQuiet = external.filter((i) => daysSince(i.updatedAt) >= EXTERNAL_RESPONSE_SLA_DAYS)

  const capWarning = (label: string, count: number, cap: number, meaning: string) =>
    count > cap ? `> [!WARNING]\n> **${label} is over cap** (${count}/${cap}). ${meaning}\n` : ''

  const soon = issues
    .filter((i) => !i.labels.includes(STALE_LABEL) && !isExempt(i, board.get(i.number)))
    .map((i) => ({ i, days: STALE_AFTER_DAYS - daysSince(i.updatedAt) }))
    .filter((e) => e.days > 0 && e.days <= 14)
    .sort((a, b) => a.days - b.days)

  return [
    '<!-- generated by scripts/backlog-hygiene.ts — edits are overwritten weekly -->',
    '# Backlog digest',
    '',
    `Rewritten weekly by [\`backlog-hygiene.yml\`](../blob/main/.github/workflows/backlog-hygiene.yml).`,
    'This issue is edited in place, never commented on, so it cannot become clutter itself.',
    '',
    `**${issues.length} open** · ${p0.length} P0 · ${p1.length} P1 · ${p2.length} P2 · ${unranked.length} unranked`,
    '',
    capWarning('P0 — Now', p0.length, P0_CAP, 'If everything is urgent, nothing is.'),
    capWarning('P1 — Next', p1.length, P1_CAP, 'More committed than a cycle can hold.'),
    '## P0 — Now',
    list(p0.map(link)),
    '',
    '## P1 — Next',
    list(p1.map(link)),
    '',
    `## External reports (${external.length}) — never auto-closed`,
    list(external.map(link)),
    '',
    `### Awaiting a reply for ${EXTERNAL_RESPONSE_SLA_DAYS}+ days`,
    externalQuiet.length > 0
      ? `> [!IMPORTANT]\n> These are the scarcest signal in the tracker.\n\n` +
        list(externalQuiet.map((i) => `- #${i.number} — quiet ${Math.floor(daysSince(i.updatedAt))}d — ${i.title}`))
      : '_none_',
    '',
    '## Decay',
    '',
    `**Marked stale this run (${plan.markStale.length})** — close in ${CLOSE_AFTER_STALE_DAYS} days:`,
    list(plan.markStale.map(link)),
    '',
    `**Closed this run (${plan.close.length})**:`,
    list(plan.close.map((c) => link(c.issue))),
    '',
    `**Rescued this run (${plan.unStale.length})** — activity resumed, clock reset:`,
    list(plan.unStale.map(link)),
    '',
    `**Goes stale within 14 days (${soon.length})** — one comment stops any of these:`,
    list(soon.map((e) => `- #${e.i.number} — ${Math.ceil(e.days)}d left — ${e.i.title}`)),
    '',
    '## Unranked',
    '',
    'Every open issue should carry a board Priority.',
    list(unranked.map(link)),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function updateDigest(body: string): Promise<void> {
  const data = await graphql<{
    repository: { issues: { nodes: { number: number }[] } }
  }>(
    `query($owner:String!,$repo:String!,$label:String!){
      repository(owner:$owner,name:$repo){
        issues(states:OPEN,first:1,labels:[$label]){ nodes{ number } }
      }
    }`,
    { owner, repo, label: DIGEST_LABEL },
  )
  const digest = data.repository.issues.nodes[0]
  if (!digest) {
    console.log(`backlog-hygiene: no open issue labelled \`${DIGEST_LABEL}\` — skipping digest`)
    return
  }
  await rest('PATCH', `/issues/${digest.number}`, { body })
  console.log(`backlog-hygiene: digest → #${digest.number}`)
}

async function main(): Promise<void> {
  const [issues, board] = await Promise.all([fetchOpenIssues(), fetchBoardFields()])
  const plan = await buildPlan(issues, board)

  console.log(`backlog-hygiene: ${apply ? 'APPLY' : 'DRY RUN'} · ${issues.length} open issues`)
  const report = (label: string, numbers: number[]) =>
    console.log(`  ${label}: ${numbers.length}${numbers.length ? ` — ${numbers.join(', ')}` : ''}`)
  report('mark stale', plan.markStale.map((i) => i.number))
  report('close', plan.close.map((c) => c.issue.number))
  report('un-stale', plan.unStale.map((i) => i.number))
  report('+needs-priority', plan.addNeedsPriority.map((i) => i.number))
  report('-needs-priority', plan.removeNeedsPriority.map((i) => i.number))

  await execute(plan)
  await updateDigest(buildDigest(issues, board, plan))

  if (!apply) console.log('backlog-hygiene: dry run — nothing was changed. Pass --apply to mutate.')
}

main().catch((error: unknown) => {
  console.error(`backlog-hygiene: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
