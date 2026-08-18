# Agentic Starter Journey

Agent-facing runbooks that take a coding agent from an empty Databricks account to a deployed, bundle-defined project.

Every page is written for a machine reader: goal, required inputs, the skill to invoke, and a runnable verification check. No screenshots, no click-by-click UI walkthroughs, no video embeds.

## What this is

A Next.js static site at `docs/agentic-starter-journey/`. A user points an agent (Claude Code, Codex, OpenCode, Cursor) at a page URL and asks for the outcome. The agent reads the page, collects the listed inputs from the user, invokes the named skill, and verifies the result.

The site is deliberately plain: single column, no sidebar, no navbar, no search. The landing page is a title, a tagline, a pointer to the page contract, and a numbered section table with pick-if criteria. Every other page ends with a next-page link and a link back to the contents.

The journey draws on two upstream skill libraries. Neither is vendored here.

| Library | Covers | Repo |
|---|---|---|
| **ai-platform-kit** | Workspaces, Unity Catalog metastore and catalogs, groups and service principals, storage credentials, external locations, private networking, workspace config | [databricks-solutions/ai-platform-kit](https://github.com/databricks-solutions/ai-platform-kit) |
| **databricks-agent-skills** | Pipelines, jobs, DABs, DBSQL, metric views, AI/BI dashboards, Genie Agents, ML training, model serving, vector search, Agent Bricks | [databricks/databricks-agent-skills](https://github.com/databricks/databricks-agent-skills) |

## How it differs from Starter Journey

This repo is structurally cloned from [Starter Journey](https://databricks-solutions.github.io/starter-journey/), which teaches a human to set up Databricks by clicking through the UI. Same journey, different reader.

| | Starter Journey | Agentic Starter Journey |
|---|---|---|
| Reader | Human | Coding agent |
| Execution | Person clicks through consoles and portals | Agent invokes a skill and runs CLI commands |
| Verification | "Confirm the workspace shows Running in the console" | A CLI command plus its expected output |
| Content | Screenshots, video walkthroughs, concept explainers | Inputs table, skill invocation, verification command |
| Onboarding sections | `01-get-started`, `02-before-you-start` (foundations, cloud tenant) | Dropped. Replaced by `01-prerequisites`, which checks the CLI and both skill libraries |
| Deploy paths | Manual / Terraform / SRA per cloud | The agentic path, with a link to the Starter Journey page for the manual fallback |

Where no agentic path exists, the page links the Starter Journey page and says plainly that the step is manual.

## Running the site locally

```bash
cd docs/agentic-starter-journey
npm install
npm run dev
```

The site opens at `http://localhost:3000/agentic-starter-journey/`.

| Command | Purpose |
|---|---|
| `npm run build` | Static export to `out/`, then the internal link and anchor check. Fails on any broken link. |
| `npm run check-links` | Link check alone, over an existing `out/`. |
| `npm run typecheck` | TypeScript check. |
| `npm run serve` | Serve the static export. |

## Section eval (Captain)

Open with: “Captain, the goal of this session is …”.

You verify outcomes. The Captain agent fans out cold-start Crew, auto-applies, pauses for your pass/fail after each Crew, then rewrites docs from feedback.

Handbook: [SECTION-EVAL.md](SECTION-EVAL.md)

Captain skill (in-repo):

- Cursor: [`.cursor/skills/captain/SKILL.md`](.cursor/skills/captain/SKILL.md)
- Claude Code: [`.claude/skills/captain/SKILL.md`](.claude/skills/captain/SKILL.md)

For ordinary edits to this repo (prose, nav, build), start at [AGENTS.md](AGENTS.md).

## Repository layout

```
agentic-starter-journey/
├── AGENTS.md                      ← instructions for agents editing this repo
├── SECTION-EVAL.md                ← Captain handbook (You → Captain → Crew)
├── .cursor/skills/captain/        ← Captain skill (Cursor)
├── .claude/skills/captain/        ← Captain skill (Claude Code)
├── README.md
├── .github/workflows/deploy.yml   ← build and publish to GitHub Pages
└── docs/agentic-starter-journey/          ← Next.js project root
    ├── content/                   ← the journey pages (.md)
    ├── lib/nav.ts                 ← reading order and the landing page table
    ├── lib/content.ts             ← markdown to HTML at build time
    ├── pages/                     ← landing page and the /docs catch-all route
    ├── scripts/check-links.mjs    ← internal link and anchor check
    ├── styles/globals.css         ← the whole visual layer
    └── public/                    ← favicons and .nojekyll
```

See [AGENTS.md](AGENTS.md) before editing.
See [SECTION-EVAL.md](SECTION-EVAL.md) before Captain / eval sessions.
