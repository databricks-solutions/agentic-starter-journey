---
description: Provision Databricks workspaces with databricks-platform-provisioning. Per-cloud auth inputs, run sequence, and verification.
---

# Workspaces

## Mental Model

A workspace is the compute entry point.
It cannot change region or merge with another after creation, so the layout is a one-way decision.
Databricks manages workspaces through Terraform, not the console wizard.
`databricks-platform-provisioning` writes that Terraform from the requirements and runs `plan`, then stops for a human approval before `apply`.
Default to three workspaces (dev, staging, prod).
One workspace is fine for a POC.

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

`databricks-platform-provisioning` (ai-platform-kit).
Read its `SKILL.md`, then the file for the target cloud only.
Reading the other clouds' files adds noise.

For AWS serverless, use the skill's serverless / no-customer-VPC path (field scenario `aws-serverless-ncc`), not a BYOVPC template.
For Azure serverless, azurerm may not expose `computeMode=Serverless` yet.
Use `az databricks workspace create --compute-mode Serverless` (or azapi) until the skill documents a Terraform path.
Classic Azure uses VNet injection templates.

## Inputs

Ask for every human-sourced value in one message.

| Input | Source | How to obtain |
|---|---|---|
| Cloud | Human | `aws`, `azure`, or `gcp` |
| Cloud region | Human | Must support the chosen topology. Check feature-region-support for Serverless workspaces when topology is serverless. |
| Topology | Human | `serverless` or `classic` (table above) |
| Databricks account ID | Human | Account console, top-right user menu |
| AWS account id and named profile | Human | Required for AWS. The profile is passed with `--profile`, and its live 12-digit account id must match the expected id. |
| Azure expected subscription id and active CLI context | Human | Required for Azure. Select the expected subscription in the active context with `az account set --subscription <azure-subscription-id>`. |
| GCP project id and named configuration | Human | Required for GCP. The configuration is passed with `--configuration`, and its live project must match the expected id. |
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
The OAuth secret (AWS) is displayed once.
Do not write it to a file in the repo, and do not echo it back.
Pass it through environment variables only.
:::

:::danger
Azure: the Azure AD tenant of `az account show` must be the tenant that owns the Databricks account.
Mismatch shows as `IncorrectClaimException` (expected iss ≠ actual iss) or a workspace that never appears under `databricks account workspaces list`.
Resolve account ID ↔ AAD tenant ID ↔ subscription ID before plan.
Refuse to continue on mismatch.
:::

## Run

### 0. Auth precheck

Refuse if the human did not name the Databricks account id, Databricks account CLI profile, target cloud, and that cloud's expected identifier and auth context.
AWS requires an account id and named profile.
Azure requires an expected subscription id and active Azure CLI context.
GCP requires a project id and named configuration.
Do not invoke the skill until every named target is present.

Run live checks:

```bash
databricks auth profiles
databricks account workspaces list --profile <account-profile> -o json | jq 'length'
test "$(aws sts get-caller-identity --profile <aws-profile> --query Account --output text)" = "<aws-account-id>" \
  || { echo "BLOCKED: AWS account id mismatch"; exit 1; }
test "$(az account show --query id -o tsv)" = "<azure-subscription-id>" \
  || { echo "BLOCKED: Azure subscription id mismatch"; exit 1; }
test "$(gcloud config get-value project --configuration <gcp-configuration>)" = "<gcp-project-id>" \
  || { echo "BLOCKED: GCP project id mismatch"; exit 1; }
```

Run only the block for the target cloud.
Each comparison must pass before skill invocation.
When the account API returns an account id, compare it to the human-named Databricks account id.

On any failure, print **blocked: auth preflight failed**, name the failing check, give the human these remediations, and **stop**.
Do not invoke the skill.
Do not run Terraform.

| Check failed | Human must run |
|---|---|
| Account profile missing or `Valid=NO` | `databricks auth login --host <account-host> --profile <account-profile>` or fix M2M SP secret and Account admin role |
| `account workspaces list` fails | Confirm Account admin on the SP; regenerate OAuth secret (AWS) |
| AWS CLI not authenticated or account id mismatch | `aws sso login --profile <aws-profile>` and select the profile matching `<aws-account-id>` |
| Azure CLI not authenticated or subscription id mismatch | `az login --tenant <tenant>` then `az account set --subscription <azure-subscription-id>` |
| GCP CLI not authenticated or project id mismatch | `gcloud auth login --configuration <gcp-configuration>` then set `<gcp-project-id>` in that configuration |
| Databricks account id mismatch | Fix the account profile or the human-named account id before continuing |

### 1. Pre-flight

```bash
aws sts get-caller-identity --profile <aws-profile>     # AWS
az account show                                          # Azure: confirm active tenant + subscription
gcloud auth list --configuration <gcp-configuration>     # GCP
env | grep -i DATABRICKS          # stale DATABRICKS_HOST or DATABRICKS_TOKEN breaks provider auth
databricks auth profiles          # never echoes secrets
terraform version                 # >= 1.9.0
```

A stale `DATABRICKS_HOST` or `DATABRICKS_TOKEN` in the shell is the most common cause of a confusing provider auth failure.
Unset them.
Prefer one-shot `env VAR=... cmd` over exporting SP secrets into the shell for the rest of the session.

Azure only: confirm `az group create` would succeed on the target subscription (Contributor or equivalent).
Do not trust a precheck `OK` that only reflects view-only policy.

### 2. Naming (mandatory before HCL)

Organizations disagree on Databricks vs cloud names.
Workspace name, resource prefix, root bucket, and IAM name stems are different strings that must stay consistent inside one Terraform apply.

Present at most three options in one message.
Wait for an explicit pick.
Then map the pick to skill/Terraform inputs.
Do not fill templates before the pick.

Example options (adapt labels to the customer; keep ≤3):

| Option | Workspace name pattern | Resource prefix | Notes |
|---|---|---|---|
| A | `<prefix>-dev` (example `asjawsrv-dev`) | `asjawsrv` | Common skill default: env as suffix. |
| B | `dev-<prefix>` (example `dev-asjawsrv`) | `asjawsrv` | Env as prefix. |
| C | Exact human label (example `development`) | short unique stem for cloud resources | Workspace display name decoupled from cloud prefix. |

Multi-env: apply the same pattern to staging/prod (`<prefix>-staging` / `staging-<prefix>` / human labels).
Cloud object names (root storage, credentials) still need a globally unique stem derived from the chosen prefix.
State that stem in the option table.

### 3. Permission sweep

Read-only.
Returns which deployment topologies the caller's cloud permissions support, before any HCL exists.

```bash
bash precheck-aws.sh      # or precheck-azure.sh / precheck-gcp.sh, from the skill's scripts/
```

### 4. Invoke the skill

Hand the skill the collected inputs, including topology and the chosen naming mapping, and let it run its own intake for anything missing.
It writes the HCL, then runs `terraform init` and `terraform plan`.

### 5. Plan review

The skill stops here.
Show the plan to the user and get an explicit approval before `terraform apply`.
Resources created here cost money and are slow to unwind.
If the human already approved apply in the task brief, run `terraform apply` and record that approval.
Do not treat plan as done.

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

- Serverless topology: serverless SQL warehouse path only (CREATE/INSERT/SELECT/DROP on a UC table once catalogs exist).
  Skip classic clusters.
- Classic topology: classic cluster and serverless SQL as in `databricks-deployment-verification`.
  Start the classic cluster early; cold start is 10 to 15 minutes.

On Azure, workspace admin for the creator is often automatic via Azure AD. `databricks_mws_permission_assignment` does not work on Azure; do not use it there.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| **blocked: auth preflight failed** before Run | Missing Databricks target or cloud-specific expected id and auth context | Ask for the AWS profile, active Azure context, or gcloud configuration required by the selected cloud; rerun ### 0 |
| Account profile `Valid=NO` or account list fails | Expired login or wrong SP secret | `databricks auth login --host <account-host> --profile <account-profile>` or fix M2M and Account admin role |
| Cloud identity check fails | Wrong AWS profile, active Azure subscription, or gcloud configuration | Reauthenticate the selected context and make its live identifier match the human-provided expected id |
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
