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

The project repo and bundle must exist before any pipeline lands in it. Ingestion must land data before ETL can transform it.

| Order | Page | Skill | Status |
|---|---|---|---|
| 1 | [Project repo](/docs/02-databricks-projects/project-repo/) | `databricks-dabs` | Done |
| 2 | [Ingestion Pipelines](/docs/02-databricks-projects/ingestion-pipelines/) | `databricks-lakeflow-connect`, `databricks-zerobus-ingest` | Done |
| 3 | [ETL Pipelines](/docs/02-databricks-projects/etl-pipelines/) | `databricks-pipelines` | Done |

Pages are linked as they are added.

## Next

- **Do next:** [Project repo](/docs/02-databricks-projects/project-repo/)
- **Reference:** [Databricks Asset Bundles](https://docs.databricks.com/aws/en/dev-tools/bundles/)
