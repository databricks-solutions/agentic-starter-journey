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

On Azure, `no_public_ip` / `enableNoPublicIp` hides classic cluster node public IPs (Secure Cluster Connectivity).
`publicNetworkAccess` is a separate control for the workspace UI and API.
Do not treat a public UI as an SCC failure.

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
Classic Azure uses VNet injection templates.
The skill's Azure matrix still defaults to classic VNet injection.
Do not follow that default when the human chose Azure serverless.

For Azure serverless, `azurerm_databricks_workspace` does not expose `computeMode=Serverless`.
Do not run `az databricks workspace create` when this page requires a Terraform plan gate: that CLI command applies immediately and cannot produce a reviewable plan.
Use `azapi_resource` for `Microsoft.Databricks/workspaces` with `properties.computeMode = "Serverless"` and `sku.name = "premium"`.
Check the live registered API versions on the subscription.
Prefer a stable version whose embedded AzAPI schema accepts `computeMode` with `schema_validation_enabled = true`.
Do not disable schema validation to force a plan.
Do not set `managedResourceGroupId`, customer VNet, access connector, or customer storage on an Azure serverless create body.
Export `properties.workspaceId` and pass it to `databricks_metastore_assignment`.
Reserve `az databricks workspace create --compute-mode Serverless` for an explicitly approved non-Terraform path.

On Azure, omit `databricks_mws_permission_assignment`.
It does not work there.
Creator workspace admin is usually automatic via Azure AD.

## Inputs

Ask for every human-sourced value in one message.

| Input | Source | How to obtain |
|---|---|---|
| Cloud | Human | `aws`, `azure`, or `gcp` |
| Cloud region | Human | Must support the chosen topology. Check feature-region-support for Serverless workspaces when topology is serverless. |
| Topology | Human | `serverless` or `classic` (table above) |
| Databricks account ID | Human | Account console, top-right user menu |
| Databricks account CLI profile | Human | Named Databricks CLI profile that can call `databricks account workspaces list` |
| Environment strategy | Human | One workspace, or dev / staging / prod |
| Purpose | Human | POC or production |
| Existing network? | Human | Classic only: new network, or an existing one (VPC/VNet ID, two private subnets in different AZs when the region has AZs, security group IDs). Omit `zones` on PIP/NAT in non-zonal regions (example: Azure `westcentralus`). |
| Classic multi-env network layout | Human | Classic plus three environments: shared VNet/subnets/NSG/NAT, or dedicated per environment. The plan must show names, CIDRs, and the sharing boundary. If the skill requires unique VNet CIDRs per workspace, use dedicated networks. |
| Naming convention | Human | Chosen from the ≤3 options in Run step "Naming" before any HCL is written. Maps to resource prefix, workspace names, and related cloud names. |
| Resource prefix | You derive | From the chosen naming convention. |
| Workspace names | You derive | From the chosen naming convention. Examples: `<prefix>-dev`, `dev-<prefix>`, or a human label like `development`. |
| Storage / object-name stems | You derive | Classic (and AWS/GCP object storage): one globally unique stem per workspace. Azure serverless: no customer storage account is created; keep any human stem as later catalog/storage intent only. Do not invent a storage account to consume the stem. |

Do not invent a fourth naming scheme in the same turn.
If the human already has an org standard, make that option 1 and offer at most two alternates.

Azure extras (required when cloud is `azure`):

| Input | Source | How to obtain |
|---|---|---|
| Azure subscription ID | Human | Cloud account id for Azure. Use `az account show --subscription <id>`. Azure CLI has no named `--profile` like AWS. |
| Azure AD tenant ID | Human | Must equal the tenant that owns the Databricks account. |
| Resource group | Human | Existing name, or permission to create one. Prefer `az group show` when it already exists. Do not mutate with `az group create` as a precheck. |

Per-cloud provider auth:

| Cloud | Databricks provider auth | What you need |
|---|---|---|
| AWS | OAuth M2M with an account-admin service principal | SP client ID and OAuth secret. The secret is shown once at generation. Named AWS CLI `--profile`. |
| Azure | `auth_type = "azure-cli"` on every provider block | `az login --tenant <account-tenant>`, `azure_tenant_id` on every provider block, and a subscription in that same tenant with Contributor (classic also needs networking rights). Pin `ARM_TENANT_ID` if the default `az` tenant can drift. |
| GCP | `auth_type = "google-id"` with service account impersonation | The service account, with impersonation rights. |

:::danger
The OAuth secret (AWS) is displayed once.
Do not write it to a file in the repo, and do not echo it back.
Pass it through environment variables only.
:::

:::danger
Azure: the Azure AD tenant of the named subscription must be the tenant that owns the Databricks account.
Mismatch shows as `IncorrectClaimException` (expected iss ≠ actual iss) or a workspace that never appears under `databricks account workspaces list`.
Resolve account ID ↔ AAD tenant ID ↔ subscription ID in ### 0.
Refuse to continue on mismatch.
Do not wait for the provider error.
:::

## Run

### 0. Auth precheck

Refuse if the human did not name all of these: Databricks account id, Databricks account CLI profile, target cloud (`aws`, `azure`, or `gcp`), cloud account id.
AWS also requires a named AWS CLI profile.
Azure requires subscription id plus the current `az` session (use `--subscription`).
Do not refuse Azure solely because there is no Azure CLI profile name.
Do not invoke the skill until every named target is present.

Run live checks:

```bash
databricks auth profiles
databricks account workspaces list --profile <account-profile> -o json | jq 'length'
aws sts get-caller-identity --profile <aws-profile>     # AWS: Account must equal named cloud account id
az account show --subscription <subscription-id>        # Azure: .id and .tenantId
gcloud auth list                                           # GCP: active account must match named project
```

Treat a successful `databricks account workspaces list` whose returned account id matches the named Databricks account id as the account-auth gate.
Azure account profiles can show `Valid=NO` in `databricks auth profiles` while account APIs still work.
Do not stop on `Valid=NO` if the list command succeeded.

Compare the live cloud identity to the human-named cloud account id.
When the account API returns an account id, compare it to the human-named Databricks account id.

Azure extra compare (mandatory):

```bash
az account show --subscription <subscription-id> --query '{id:id,tenantId:tenantId}' -o json
```

`.id` must equal the named subscription.
`.tenantId` must equal the Databricks account Azure AD tenant, not merely the tenant printed on that subscription row if the human named a mismatched subscription.
If those two tenants differ, print **blocked: auth preflight failed**, name "Azure tenant ≠ Databricks account tenant", give `az login --tenant <account-tenant>` plus a subscription in that tenant, and **stop**.

On any failure, print **blocked: auth preflight failed**, name the failing check, give the human these remediations, and **stop**.
Do not invoke the skill.
Do not run Terraform.

| Check failed | Human must run |
|---|---|
| Account profile missing, or `account workspaces list` fails | `databricks auth login --host <account-host> --profile <account-profile>` or fix M2M SP secret and Account admin role |
| Cloud CLI not authenticated | `aws sso login --profile <aws-profile>` / `az login --tenant <tenant>` / `gcloud auth login` |
| Cloud account id mismatch | Pick the AWS profile or Azure subscription whose id matches the human-named cloud account id |
| Azure tenant ≠ Databricks account tenant | `az login --tenant <account-tenant>` and pick a subscription in that tenant |
| Databricks account id mismatch | Fix the account profile or the human-named account id before continuing |

### 1. Pre-flight

```bash
aws sts get-caller-identity --profile <aws-profile>     # AWS
az account show --subscription <subscription-id>        # Azure
gcloud auth list                                           # GCP
env | grep -i DATABRICKS          # stale DATABRICKS_HOST or DATABRICKS_TOKEN breaks provider auth
databricks auth profiles          # never echoes secrets
terraform version                 # >= 1.9.0
```

A stale `DATABRICKS_HOST` or `DATABRICKS_TOKEN` in the shell is the most common cause of a confusing provider auth failure.
Unset them.
Prefer one-shot `env VAR=... cmd` over exporting SP secrets into the shell for the rest of the session.

Azure only: confirm Contributor (classic also User Access Administrator later for UC storage) with a read-only permission or role-assignment query.
Use `az group show` when the resource group already exists.
Do not treat `az group create` as a precheck.
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
Classic cloud object names (root storage, credentials) still need a globally unique stem per workspace derived from the chosen prefix.
State that stem in the option table.
Azure serverless: state the stem as unused for workspace create.

### 3. Permission sweep

Read-only.
Returns which deployment topologies the caller's cloud permissions support, before any HCL exists.

```bash
bash precheck-aws.sh      # or precheck-azure.sh / precheck-gcp.sh, from the skill's scripts/
```

Fetch the script from the skill checkout (`scripts/` next to `SKILL.md`).
Do not invent a local copy.

### 4. Invoke the skill

Hand the skill the collected inputs, including topology, naming mapping, and (classic multi-env) the shared vs dedicated network pick, and let it run its own intake for anything missing.
It writes the HCL, then runs `terraform init` and `terraform plan`.
If Azure serverless has no skill template, write the AzAPI workspace plus `databricks_metastore_assignment` yourself and still run `plan`.
Do not add `lifecycle { prevent_destroy = true }` unless the human asked for retention protection.

Minimal Azure serverless body (API version must match a live registered version that validates):

```hcl
resource "azapi_resource" "workspace" {
  type      = "Microsoft.Databricks/workspaces@2026-01-01"
  name      = var.workspace_name
  parent_id = var.resource_group_id
  location  = var.location
  body = {
    sku        = { name = "premium" }
    properties = { computeMode = "Serverless" }
  }
  response_export_values = ["properties.computeMode", "properties.workspaceId", "properties.workspaceUrl"]
}
```

### 5. Plan review

The skill stops here.
Show the plan to the user and get an explicit approval before `terraform apply`.
Resources created here cost money and are slow to unwind.
If the human already approved apply in the task brief, run `terraform apply` and record that approval.
Do not treat plan as done.

The plan must show:

- Exact workspace names from the naming pick.
- Azure serverless: `computeMode = "Serverless"` and no managed resource group or customer VNet.
- Classic: VNet, two delegated subnets, NSG associations, NAT for `no_public_ip` egress, unique storage account name per workspace, `no_public_ip = true`.
- Classic multi-env: every environment's network names and CIDRs, and whether those resources are shared or dedicated.
- Metastore: assignment to the chosen existing metastore, or an explicit create.
- If the human said attach only: zero `databricks_metastore` creates.

## Verify

Match the environment strategy.

```bash
# Workspaces RUNNING (filter by prefix)
databricks account workspaces list --profile <account-profile> -o json \
  | jq -r '.[] | select(.workspace_name | startswith("<prefix>")) | "\(.workspace_name)\t\(.workspace_status)"'
```

Expected: one RUNNING line for a POC, or three for dev/staging/prod.
Azure account records often return `workspace_url = null`.
Use `az databricks workspace show` as the source for `workspaceUrl`, `workspaceId`, `provisioningState`, and `computeMode` / `parameters.enableNoPublicIp`.

```bash
az databricks workspace show \
  --subscription <subscription-id> --resource-group <rg> --name <workspace-name> \
  --query '{provisioningState:provisioningState,computeMode:computeMode,workspaceId:workspaceId,workspaceUrl:workspaceUrl,enableNoPublicIp:parameters.enableNoPublicIp.value}' -o json
```

Expected Azure serverless: `Succeeded`, `computeMode=Serverless`.
Expected Azure classic: `Succeeded`, `enableNoPublicIp=true`.

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

A regional list does not prove assignment.
For every new workspace id:

```bash
databricks account metastore-assignments get <workspace-id> --profile <account-profile> -o json \
  | jq '.metastore_assignment | {workspace_id, metastore_id}'
```

The id is nested under `metastore_assignment`.
Azure ARM `isUcEnabled` can stay false even when this assignment exists.
Trust the Databricks assignment API.

After apply, add a tokenless Azure workspace profile (no PAT file):

```ini
[<workspace-name>]
host = https://<workspaceUrl>
workspace_id = <workspace-id>
auth_type = azure-cli
azure_tenant_id = <account-tenant>
```

```bash
# Workspace-level auth. M2M profiles return the SP application id, not a human email.
databricks current-user me --profile <workspace-profile> -o json | jq -r '.userName'
```

Compute verification after the workspace is up:

- Serverless topology: serverless SQL warehouse path only (CREATE/INSERT/SELECT/DROP on a UC table once catalogs exist).
Skip classic clusters.
- Classic topology: start a classic cluster early; cold start is often several minutes (budget 10 to 15).
Discover a compatible `spark_version` and `node_type_id` from the new workspace, set 30-minute auto-termination, poll until `RUNNING` or a terminal failure.

```bash
databricks clusters spark-versions --profile <workspace-profile> -o json
databricks clusters list-node-types --profile <workspace-profile> -o json
databricks clusters create --profile <workspace-profile> --json '<minimal classic cluster spec>'
databricks clusters get <cluster-id> --profile <workspace-profile> -o json | jq -r '.state'
```

On Azure, workspace admin for the creator is often automatic via Azure AD. `databricks_mws_permission_assignment` does not work on Azure; do not use it there.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| **blocked: auth preflight failed** before Run | Missing named account id, account profile, or cloud account id | Ask the human for every required target; rerun ### 0 |
| `az account show --profile` errors | Azure CLI has no `--profile` on this command | Use `az account show --subscription <subscription-id>` |
| Account profile `Valid=NO` but list works | Azure account-profile validity bit is unreliable | Gate on `account workspaces list` and matching account id |
| Azure tenant ≠ Databricks account tenant | Named subscription is in another AAD tenant | Stop at ### 0. `az login --tenant <account-tenant>` and a same-tenant subscription. Skipping this is what later becomes `IncorrectClaimException` |
| Cloud STS / `az account show` fails or account id mismatch | Wrong or expired cloud identity | `aws sso login --profile <aws-profile>` / `az login --tenant <tenant>` / `gcloud auth login`; pick the identity that matches the named cloud account id |
| Skill invoked despite red precheck | Agent skipped ### 0 | Always run ### 0 first; stop on any failure |
| `400 BAD_REQUEST: Failed to get oauth access token` (AWS) | SP is not an account admin, or the secret is wrong | Confirm the Account admin role on the Roles tab, regenerate the secret |
| Provider hits the wrong host | `DATABRICKS_HOST` or `DATABRICKS_TOKEN` set in the shell | `unset` both, re-run |
| `PERMISSION_DENIED: User is not an owner of Metastore` | The SP cannot create catalogs | Add the SP to the metastore admin group |
| Apply fails on IAM or VPC | Cloud principal lacks create rights | Run the precheck script and report the gaps rather than retrying |
| Multiple metastores returned for the region | Orphan metastores from earlier deploys | Report the list; use the decision rules under Verify |
| Azure `IncorrectClaimException` | ### 0 tenant compare skipped | `az login --tenant <account-tenant>` and pick a subscription in that tenant |
| Azure workspace missing from account list | Created under the wrong tenant/subscription | Recreate in the account's tenant, or obtain account admin on the account that owns the workspace |
| Azure zonal PIP/NAT fails | Region has no availability zones | Omit `zones` on Public IP / NAT |
| AzAPI rejects `computeMode` or requires `managedResourceGroupId` | Wrong `Microsoft.Databricks/workspaces` API version | List registered versions; use a stable schema that accepts serverless without a customer managed RG |
| Precheck OK but `resourcegroups/write` denied | View-only subscription | Switch to a subscription with Contributor (and later UAA for UC storage) |
| Workspace or bucket names surprise the human | Naming step skipped; skill default assumed | Re-run Naming (≤3 options) and map the pick before plan |
| Multi-env classic networks surprise the human | Shared vs dedicated layout never shown in plan | Ask, then show every env VNet/subnet/CIDR in plan review |
| `terraform destroy` blocked later | Agent added `prevent_destroy` | Omit that lifecycle unless the human asked to retain |

## Next

- **Do next:** [Catalogs](/docs/01-infra-setup/catalogs/)
- **Manual fallback:** [Starter Journey: create workspaces](https://databricks-solutions.github.io/starter-journey/docs/03-infra-setup/create-workspaces/)
