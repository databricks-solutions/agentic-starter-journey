---
description: Page contract for Agentic Starter Journey. Every content page uses the same nine blocks. Read once, then route from the contents.
---

# How to use this site

Every page is written for a coding agent, not a human.
A human sends the agent a page URL and an outcome.
The agent reads the page, collects the inputs, invokes the skill, and runs the verification.

## Page contract

| Block | What the agent does with it |
|---|---|
| Mental Model | What the page's topic is and why it exists. |
| Goal | The single outcome the page produces. |
| Prerequisites | What must be true before running. Agent checks first. |
| Skill | The exact skill to invoke, and which library ships it. |
| Inputs | Table of values. Source says human-provided or agent-derived. |
| Auth precheck | Before the Run body, resolve named targets for the page's auth surface (`account` \| `workspace` \| `both`). Run live CLI checks. Live Databricks and cloud account ids must match the human-named ids. Workspace surface also requires workspace host, workspace id, and workspace profile. On failure: tell the human it is blocked, give exact config or commands to fix, and stop. Do not invent SSO recovery mid-skill. |
| Run | The commands or skill invocation. When the page has a Naming step, present ≤3 naming options, wait for a pick, then map them to Terraform inputs before writing HCL. |
| Verify | A runnable check plus its expected output. |
| Where this fails | Silent-failure traps: symptom, cause, fix. |
| Next | Do next, manual fallback, reference. |

Start at [contents](/) and pick the section whose "Pick if" matches the outcome.
