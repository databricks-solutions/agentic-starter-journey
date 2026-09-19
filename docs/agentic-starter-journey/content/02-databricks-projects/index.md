---
description: From the workspace edge inward, every asset is a bundle resource deployed with databricks-agent-skills. One repo, one bundle, one owning team.
---

# 2. Databricks Projects

## Mental Model

From the workspace edge inward, every asset is created and deployed through Databricks Asset Bundles (DABs).
The `databricks-agent-skills` library writes the bundle YAML and source files and deploys them with the Databricks CLI.
The boundary is the workspace edge: outside it is Terraform (Infra Setup), inside it is DABs (this section).
One repo, one bundle, one owning team.

## Run in this order

Create the project repo, build the Spark Declarative Pipeline, define the metric view, publish the dashboard, ground the Genie Agent, then orchestrate the pipeline with jobs.

| Order | Page | Skill | Status |
|---|---|---|---|
| 1 | [Project repo](/docs/02-databricks-projects/project-repo/) | `databricks-dabs` | Done |
| 2 | [Spark Declarative Pipelines](/docs/02-databricks-projects/etl-pipelines/) | `databricks-pipelines` | Done |
| 3 | [Metric Views](/docs/02-databricks-projects/metric-views/) | `databricks-metric-views` | Done |
| 4 | [Dashboards](/docs/02-databricks-projects/dashboards/) | `databricks-core`, `databricks-aibi-dashboards`, `databricks-dabs` | Done |
| 5 | [Genie Agents](/docs/02-databricks-projects/genie-agents/) | `databricks-core`, `databricks-genie-agents`, `databricks-dabs` | Done |
| 6 | [Databricks Jobs](/docs/02-databricks-projects/databricks-jobs/) | `databricks-core`, `databricks-jobs`, `databricks-dabs` | Done |

## Next

- **Do next:** [Project repo](/docs/02-databricks-projects/project-repo/)
