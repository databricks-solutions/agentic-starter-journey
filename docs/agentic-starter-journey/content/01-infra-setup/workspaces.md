---
description: Provision Databricks workspaces with databricks-platform-provisioning. Per-cloud auth inputs, run sequence, and verification.
---

# Workspaces

## Mental Model

A workspace is the compute entry point. It cannot change region or merge with another after creation, so the layout is a one-way decision.
Databricks manages workspaces through Terraform, not the console wizard.
`databricks-platform-provisioning` writes that Terraform from the requirements and runs `plan`, then stops for a human approval before `apply`.
Default to three workspaces (dev, staging, prod). One workspace is fine for a POC.

Two topologies:

| Topology | Network | When to use |
|---|---|---|
| Serverless | No customer VPC/VNet. AWS `compute_mode=SERVERLESS`. Azure `computeMode=Serverless`. | POC and teams that do not need classic compute plane networking. |
| Classic | Dedicated customer VPC/VNet plus Secure Cluster Connectivity. Also supports serverless compute inside the workspace. | Production, Private Link, or classic clusters required. |

## Goal

One workspace per environment in the chosen topology, plus a Unity Catalog metastore in the region (create or attach).

## Prerequisites

- [Pre-requisites](/docs/01-infra-setup/prerequisites/) passing, including `terraform version` at 1.9.0 or later.
- Auth surface: account (plus cloud CLI for the target cloud).
- An authenticated cloud CLI session with permission to create IAM roles, object storage, and (classic only) VPC or VNet resources.
- A Databricks account-admin principal: OAuth SP on AWS, `azure-cli` on Azure with matching tenant (below), or service account impersonation on GCP.

## Skill

`databricks-platform-provisioning` (ai-platform-kit). Read its `SKILL.md`, then the file for the target cloud only. Reading the other clouds' files adds noise.

For AWS serverless, use the skill's serverless / no-customer-VPC path (field scenario `aws-serverless-ncc`), not a BYOVPC template.
For Azure serverless, azurerm may not expose `computeMode=Serverless` yet. Use `az databricks workspace create --compute-mode Serverless` (or azapi) until the skill documents a Terraform path. Classic Azure uses VNet injection templates.

## Inputs

Ask for every human-sourced value in one message.

| Input | Source | How to obtain |
|---|---|---|
| Cloud | Human | `aws`, `azure`, or `gcp` |
| Cloud region | Human | Must support the chosen topology. Check feature-region-support for Serverless workspaces when topology is serverless. |
| Topology | Human | `serverless` or `classic` (table above) |
| Databricks account ID | Human | Account console, top-right user menu |
| Environment strategy | Human | One workspace, or dev / staging / prod |
| Purpose | Human | POC or production |
| Existing network? | Human | Classic only: new network, or an existing one (VPC/VNet ID, two private subnets in different AZs when the region has AZs, security group IDs). Omit `zones` on PIP/NAT in non-zonal regions (example: Azure `westcentralus`). |
| Naming convention | Human | Chosen from the ≤3 options in Run step "Naming" before any HCL is written. Maps to resource prefix, workspace names, and related cloud names. |
| Resource prefix | You derive | From the chosen naming convention. Object storage names are globally unique, so never reuse a prefix. |
| Workspace names | You derive | From the chosen naming convention. Examples: `<prefix>-dev`, `dev-<prefix>`, or a human label like `development`. |

Do not invent a fourth naming scheme in the same turn.
If the human already has an org standard, make that option 1 and offer at most two alternates.

Per-cloud provider auth:

| Cloud | Databricks provider auth | What you need |
|---|---|---|
| AWS | OAuth M2M with an account-admin service principal | SP client ID and OAuth secret. The secret is shown once at generation. |
| Azure | `auth_type = "azure-cli"` on every provider block | `az login --tenant <account-tenant>`, `azure_tenant_id` on every provider block, and a subscription in that same tenant with Contributor (classic also needs networking rights). |
| GCP | `auth_type = "google-id"` with service account impersonation | The service account, with impersonation rights. |

:::danger
The OAuth secret (AWS) is displayed once. Do not write it to a file in the repo, and do not echo it back. Pass it through environment variables only.
:::

:::danger
Azure: the Azure AD tenant of `az account show` must be the tenant that owns the Databricks account.
Mismatch shows as `IncorrectClaimException` (expected iss ≠ actual iss) or a workspace that never appears under `databricks account workspaces list`.
Resolve account ID ↔ AAD tenant ID ↔ subscription ID before plan. Refuse to continue on mismatch.
:::

## Run

### 0. Auth precheck

Refuse if the human did not name all of these: Databricks account id, Databricks account CLI profile, target cloud (`aws`, `azure`, or `gcp`), cloud account id, cloud CLI profile.
Do not invoke the skill until every named target is present.

Run live checks:

```bash
databricks auth profiles
databricks account workspaces list --profile <account-profile> -o json | jq 'length'
aws sts get-caller-identity --profile <aws-profile>     # AWS: Account must equal named cloud account id
az account show --profile <azure-profile>                  # Azure: tenant + subscription must match named ids
gcloud auth list                                           # GCP: active account must match named project
```

Compare the live cloud identity to the human-named cloud account id.
When the account API returns an account id, compare it to the human-named Databricks account id.

On any failure, print **blocked: auth preflight failed**, name the failing check, give the human these remediations, and **stop**.
Do not invoke the skill.
Do not run Terraform.

| Check failed | Human must run |
|---|---|
| Account profile missing or `Valid=NO` | `databricks auth login --host <account-host> --profile <account-profile>` or fix M2M SP secret and Account admin role |
| `account workspaces list` fails | Confirm Account admin on the SP; regenerate OAuth secret (AWS) |
| Cloud CLI not authenticated | `aws sso login --profile <aws-profile>` / `az login --tenant <tenant>` / `gcloud auth login` |
| Cloud account id mismatch | Pick the profile whose account id matches the human-named cloud account id |
| Databricks account id mismatch | Fix the account profile or the human-named account id before continuing |

### 1. Pre-flight

```bash
aws sts get-caller-identity --profile <aws-profile>     # AWS
az account show                                          # Azure: confirm tenant + subscription
gcloud auth list                                         # GCP
env | grep -i DATABRICKS          # stale DATABRICKS_HOST or DATABRICKS_TOKEN breaks provider auth
databricks auth profiles          # never echoes secrets
terraform version                 # >= 1.9.0
```

A stale `DATABRICKS_HOST` or `DATABRICKS_TOKEN` in the shell is the most common cause of a confusing provider auth failure. Unset them.
Prefer one-shot `env VAR=... cmd` over exporting SP secrets into the shell for the rest of the session.

Azure only: confirm `az group create` would succeed on the target subscription (Contributor or equivalent). Do not trust a precheck `OK` that only reflects view-only policy.

### 2. Naming (mandatory before HCL)

Organizations disagree on Databricks vs cloud names.
Workspace name, resource prefix, root bucket, and IAM name stems are different strings that must stay consistent inside one Terraform apply.

Present at most three options in one message. Wait for an explicit pick. Then map the pick to skill/Terraform inputs. Do not fill templates before the pick.

Example options (adapt labels to the customer; keep ≤3):

| Option | Workspace name pattern | Resource prefix | Notes |
|---|---|---|---|
| A | `<prefix>-dev` (example `asjawsrv-dev`) | `asjawsrv` | Common skill default: env as suffix. |
| B | `dev-<prefix>` (example `dev-asjawsrv`) | `asjawsrv` | Env as prefix. |
| C | Exact human label (example `development`) | short unique stem for cloud resources | Workspace display name decoupled from cloud prefix. |

Multi-env: apply the same pattern to staging/prod (`<prefix>-staging` / `staging-<prefix>` / human labels).
Cloud object names (root storage, credentials) still need a globally unique stem derived from the chosen prefix. State that stem in the option table.

### 3. Permission sweep

Read-only. Returns which deployment topologies the caller's cloud permissions support, before any HCL exists.

```bash
bash precheck-aws.sh      # or precheck-azure.sh / precheck-gcp.sh, from the skill's scripts/
```

### 4. Invoke the skill

Hand the skill the collected inputs, including topology and the chosen naming mapping, and let it run its own intake for anything missing.
It writes the HCL, then runs `terraform init` and `terraform plan`.

### 5. Plan review

The skill stops here. Show the plan to the user and get an explicit approval before `terraform apply`.
Resources created here cost money and are slow to unwind.
If the human already approved apply in the task brief, run `terraform apply` and record that approval. Do not treat plan as done.

## Verify

Match the environment strategy.

```bash
# Workspaces RUNNING (filter by prefix)
databricks account workspaces list --profile <account-profile> -o json \
  | jq -r '.[] | select(.workspace_name | startswith("<prefix>")) | "\(.workspace_name)\t\(.workspace_status)"'
```

Expected: one RUNNING line for a POC, or three for dev/staging/prod.

Azure fallback when account list cannot see the workspace (auth gap): `az databricks workspace show` for `provisioningState` and `computeMode`, then a workspace-profile `databricks current-user me`.

```bash
# Metastores in the region. default_data_access_config_id may be null when the template creates a metastore without a storage root; catalog storage is handled on Catalogs.
databricks account metastores list --profile <account-profile> -o json \
  | jq '.[] | select(.region=="<region>") | {name, metastore_id, owner, default_data_access_config_id}'
```

If more than one metastore returns: do not auto-pick.
Prefer an account-standard metastore (often owner `account users` or a shared naming convention).
Never attach to a user-named orphan without approval.
In shared sandboxes, creating `<prefix>-metastore` is valid when the human wants isolation.
One usable metastore per region is the hard limit for attach; creating another when one already exists may fail.

```bash
# Workspace-level auth. M2M profiles return the SP application id, not a human email.
databricks current-user me --profile <workspace-profile> -o json | jq -r '.userName'
```

Compute verification after the workspace is up:

- Serverless topology: serverless SQL warehouse path only (CREATE/INSERT/SELECT/DROP on a UC table once catalogs exist). Skip classic clusters.
- Classic topology: classic cluster and serverless SQL as in `databricks-deployment-verification`. Start the classic cluster early; cold start is 10 to 15 minutes.

On Azure, workspace admin for the creator is often automatic via Azure AD. `databricks_mws_permission_assignment` does not work on Azure; do not use it there.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| **blocked: auth preflight failed** before Run | Missing named account id, account profile, cloud account id, or cloud profile | Ask the human for every required target; rerun ### 0 |
| Account profile `Valid=NO` or account list fails | Expired login or wrong SP secret | `databricks auth login --host <account-host> --profile <account-profile>` or fix M2M and Account admin role |
| Cloud STS / `az account show` fails or account id mismatch | Wrong or expired cloud profile | `aws sso login --profile <aws-profile>` / `az login --tenant <tenant>` / `gcloud auth login`; pick the profile that matches the named cloud account id |
| Skill invoked despite red precheck | Agent skipped ### 0 | Always run ### 0 first; stop on any failure |
| `400 BAD_REQUEST: Failed to get oauth access token` (AWS) | SP is not an account admin, or the secret is wrong | Confirm the Account admin role on the Roles tab, regenerate the secret |
| Provider hits the wrong host | `DATABRICKS_HOST` or `DATABRICKS_TOKEN` set in the shell | `unset` both, re-run |
| `PERMISSION_DENIED: User is not an owner of Metastore` | The SP cannot create catalogs | Add the SP to the metastore admin group |
| Apply fails on IAM or VPC | Cloud principal lacks create rights | Run the precheck script and report the gaps rather than retrying |
| Multiple metastores returned for the region | Orphan metastores from earlier deploys | Report the list; use the decision rules under Verify |
| Azure `IncorrectClaimException` | `az` tenant ≠ Databricks account tenant | `az login --tenant <account-tenant>` and pick a subscription in that tenant |
| Azure workspace missing from account list | Created under the wrong tenant/subscription | Recreate in the account's tenant, or obtain account admin on the account that owns the workspace |
| Azure zonal PIP/NAT fails | Region has no availability zones | Omit `zones` on Public IP / NAT |
| Precheck OK but `resourcegroups/write` denied | View-only subscription | Switch to a subscription with Contributor (and later UAA for UC storage) |
| Workspace or bucket names surprise the human | Naming step skipped; skill default assumed | Re-run Naming (≤3 options) and map the pick before plan |

## Next

- **Do next:** [Catalogs](/docs/01-infra-setup/catalogs/)
- **Manual fallback:** [Starter Journey: create workspaces](https://databricks-solutions.github.io/starter-journey/docs/03-infra-setup/create-workspaces/)
- **Reference:** [Databricks Terraform provider](https://registry.terraform.io/providers/databricks/databricks/latest/docs), [AWS feature regions](https://docs.databricks.com/aws/en/resources/feature-region-support), [Azure feature regions](https://learn.microsoft.com/en-us/azure/databricks/resources/feature-region-support)
