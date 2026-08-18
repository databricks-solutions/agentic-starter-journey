---
description: Provision workspaces, catalogs, and governed access to customer object storage with ai-platform-kit. All Terraform, run outside the workspace.
---

# 1. Infra Setup

## Mental Model

Infra Setup is one-time platform work per organization.
Databricks manages the platform through Terraform, not the workspace UI.
This project drives that Terraform with the `ai-platform-kit` skill library, which writes and applies it for the coding agent.
Everything here lives outside any project repo, at the account and metastore layer.

## Run in this order

The order is load-bearing. Prerequisites must pass before workspaces can be created. Workspaces must exist before catalogs. Catalogs must exist before governed object storage access.

| Order | Page | Skill |
|---|---|---|
| 1 | [Pre-requisites](/docs/01-infra-setup/prerequisites/) | (check page) |
| 2 | [Workspaces](/docs/01-infra-setup/workspaces/) | `databricks-platform-provisioning` |
| 3 | [Catalogs](/docs/01-infra-setup/catalogs/) | `databricks-unity-catalog-setup` |
| 4 | [Cloud Object Storage access](/docs/01-infra-setup/cloud-object-storage/) | `databricks-unity-catalog-setup` |

## Next

- **Do next:** [Pre-requisites](/docs/01-infra-setup/prerequisites/)
- **Reference:** [Databricks administration](https://docs.databricks.com/aws/en/admin/)
