# Section eval cycle (Captain handbook)

This handbook is the eval and rewrite loop after pages exist on the published site.
To author a new leaf from scratch, follow [AGENTS.md](AGENTS.md) (Writing a new section or leaf).
Open a Captain session when you are ready to prove that leaf with cold Crew.

How to prove a section (or a single page) is ready for peers: Captain supervises cold-start Crew, you verify outcomes, then feedback rewrites the site.

Use this file when the task is any of:

- Test whether a published page or feature works for a coding agent with no prior context
- Fan out agents across clouds, topologies, or targets
- Collect doc feedback, rewrite from that feedback, or destroy eval stacks
- Open a session with “Captain, the goal of this session is …”

For blank-page authorship or day-to-day prose/nav edits, start at [AGENTS.md](AGENTS.md) instead.

Captain skill (load in the parent chat):

- Cursor: [`.cursor/skills/captain/SKILL.md`](.cursor/skills/captain/SKILL.md)
- Claude Code: [`.claude/skills/captain/SKILL.md`](.claude/skills/captain/SKILL.md)

## Roles

| Role | Who | Job |
|---|---|---|
| **You** | Human developer / content author | State the goal. Verify each Crew outcome (workspace config, pipeline + DABs, etc.). Pass/fail. Decide destroy at the end. |
| **Captain** | Parent agent in this chat | Mission plan → auth preflight → fan out Crew → pause for your verify → recover on fail → synthesize feedback → rewrite site. |
| **Crew** | Cold-start Task agents | No shared context. Follow the published site only. Apply without plan approval. Write feedback files. |

Session opener example:

> Captain, the goal of this session is to create an ETL pipeline from `s3://…` using tables A, B, C.

## Scope

Flexible by design. A run may cover a whole section (example: Infra Setup end-to-end) or one leaf (example: only Cloud Object Storage against an existing workspace and catalog).

Put existing assets and the exact goal in the Captain brief / Crew briefs.
Do not force a full rebuild when the human already has upstream resources.

Briefs must name resolved targets, not ambiguous URLs or bucket names alone.
Required when the page auth surface includes them: Databricks account id and matching account CLI profile; workspace id, host, and workspace CLI profile; cloud account id and cloud CLI profile when cloud IAM, object storage, or cloud provisioning is in scope.
A brief that only names a workspace URL or S3 bucket without account ids and profiles is incomplete.
Captain refuses fan-out until the brief is complete and preflight is green.

## When the topic already has a leaf

Do not create a duplicate slug or parallel page.
Crew evals the existing leaf and writes feedback.
Captain rewrites that leaf only after feedback synthesis (and human verify when resources were created).
If the goal was “create” and the leaf already exists, state that in the mission plan and switch to eval-then-rewrite.

## Cycle

1. **Serve this repo’s published site.** From `docs/agentic-starter-journey/`: `npm run build && npm run serve`. Before fanning out Crew, confirm the entry URL is this site (Agentic Starter Journey title/copy), not another app on the same port. If wrong, free the port and re-serve `out/`, or use the deployed Pages URL. Crew starts at `http://localhost:3000/agentic-starter-journey/` (or Pages). They follow the pages under test, not `content/` in git.
2. **Captain states a mission plan**, then proceeds unless you interrupt. No terraform plan/apply approvals from you.
3. **Auth preflight (Captain gate).** Before fan-out, Captain infers the auth surface from the page(s) under test (`account` | `workspace` | `both`). Captain requires named resolved targets in the mission: Databricks account id and matching account CLI profile; workspace id, host, and workspace CLI profile when the surface includes workspace; cloud account id and cloud CLI profile when cloud IAM, object storage, or cloud provisioning is in scope. Captain runs the live checks itself (profile Valid=YES, identity calls, account id match). If any check fails: report **blocked: auth preflight failed**, list which check failed, give copy-paste remediation commands, and **do not** start Crew. Wait for you to fix credentials and confirm before retrying. Missing, expired, or mismatched auth is a Captain gate failure, not a useful Crew signal.
4. **Fan out Crew.** Only after preflight is green. Parallelize independent matrix cells (cloud × topology, or one page × N targets). Briefs stay short: entry URL, goal, resolved profiles and account ids, human defaults, auto-apply, feedback path.
5. **After each Crew, Captain checkpoints you.** You verify the real object (workspace, catalog, pipeline, DABs). Pass continues. Fail + why → Captain classifies (doc gap vs permission vs bad brief) and re-briefs or rewrites.
6. **Primary deliverable is doc feedback.** Each Crew writes a structured file. Resource creation proves the page; rewriting the page is the point.
7. **Synthesize, then rewrite.** Captain ranks gaps, patches the section, runs `npm run build` and `npm run typecheck` from `docs/agentic-starter-journey/`. Refresh the served `out/` if peers hit localhost.
8. **Leave stacks up** until you say destroy. Destroy only on explicit ask. Prefer Terraform destroy from Crew state dirs, then CLI cleanup of leftovers. Do not delete shared account resources (example: a pre-existing regional metastore) unless the brief says so.

Auto-apply is intentional: permission blockers during apply surface faster when Crew is not waiting on yes/no for every apply.
Auth preflight happens before fan-out so Crew never burns tokens on expired SSO or ambiguous targets.

## Feedback file shape

One file per Crew agent.
Keep it local and untracked (do not commit).
Captain sets an absolute path in each Crew brief.

Required sections:

- Outcome: pass | partial | fail
- Resources created (URLs, IDs, names)
- Doc gaps: page → symptom → suggested rewrite
- Failed Verify claims vs what actually worked
- Skill or page mismatches

## Worked example

Infra Setup cold-start on AWS serverless + classic (2026-08-06).
Feedback drove naming gates, Verify fixes, serverless vs classic topology, and metastore-scoped catalogs.
Feedback artifacts were kept local and not committed.
Later sessions should open as Captain sessions using this handbook and the Captain skill.
