---
description: Pick a catalog layout and create the catalogs with medallion schemas and group grants using databricks-unity-catalog-setup.
---

# Catalogs

## Mental Model

A catalog is the isolation boundary for data. Its layout determines every table name in the account, and changing it after a few hundred tables exist means rewriting every query that references them, so in practice it never gets changed.
A catalog lives in one metastore, and a metastore is regional.
Workspaces in different regions cannot share one catalog object.
Same name in two regions means two catalogs (two storage roots).
Databricks creates catalogs through Terraform via `databricks-unity-catalog-setup`, which writes the storage, credential, external location, catalog, schemas, and grants in one apply.
One dedicated bucket or container per catalog is non-negotiable: shared storage breaks blast-radius isolation.

## Goal

One catalog per environment, each backed by its own object storage, with medallion schemas and schema-level group grants.

## Prerequisites

- [Workspaces](/docs/01-infra-setup/workspaces/) complete, with a metastore in the region assigned to the workspace.
- Auth surface: both (account profile, workspace profile, and cloud CLI for the target cloud).
- Account-admin auth that can run `databricks account metastores list` and `databricks account groups list`.
- Account-level groups exist. Unity Catalog cannot see workspace-local groups.
- Deploy principal has effective `CREATE_CATALOG`, `CREATE_STORAGE_CREDENTIAL`, and `CREATE_EXTERNAL_LOCATION` on the chosen metastore (shared metastores often lack these until granted).
- Azure: subscription/RG rights include User Access Administrator (or Owner) so Access Connector role assignments can be written. Contributor alone is not enough.

Gate before Run:

```bash
databricks metastores current --profile <workspace-profile> -o json | jq '{metastore_id, name}'
databricks account groups list --profile <account-profile> -o json | jq 'length'
```

If either fails, stop. Do not create workspace-local groups as a substitute. Do not invoke the skill.

## Skill

`databricks-unity-catalog-setup` (ai-platform-kit). Read its `SKILL.md`, then the file for the target cloud.

## Inputs

The layout decision comes first. Ask:

> Does more than one business unit share this Databricks deployment, and must teams from different units be prevented from seeing each other's development data by default?

No to either half: propose A. Yes to both: propose B. Do not pick for the user.

| Input | Source | How to obtain |
|---|---|---|
| Layout | Human | Proposal A (one catalog per environment, no prefix) or B (A plus a business-unit prefix on catalogs, workspaces, groups) |
| Environment list | Human | Usually `dev`, `stg`, `prod`. Plus `sandbox` if they want one. Layout A catalog names are often bare `dev` / `stg` / `prod`. Storage buckets still use `<prefix>-catalog-<env>`. |
| Catalog name override | Human | Optional exact catalog name (example: `ivansandbox123`). When set, use it instead of the layout default. Does not automatically set the bucket name. |
| Storage naming convention | Human | Chosen from the ≤3 options in Run step "Naming" before any HCL is written. Catalog UC name and cloud bucket/container name are separate. |
| Storage strategy | Human | Self-managed storage per catalog (recommended) or Databricks-managed metastore. The skill asks if unstated. |
| Project name | Human | Drives schema names: `<project>_bronze`, `_silver`, `_gold` (page Verify expects this shape, not bare `bronze`) |
| Owning group per project | Human | Must be account-level. Confirm against `databricks account groups list`. If create returns `WorkspaceGroup` / `meta.resourceType=WorkspaceGroup`, hard-fail and fix account SCIM. |
| Metastore ID | You derive | `databricks account metastores list`, filtered to the region of the target workspace |
| Workspace IDs | You derive | Needed when `isolation_mode = ISOLATED`. OPEN catalogs are visible to every workspace on that metastore without a binding resource. |
| Resource prefix / bucket name | You derive | From the chosen storage naming convention. Globally unique. |

:::danger
Each catalog needs its own bucket, container, or storage account.
The skill refuses a shared one: shared storage across environments means a dev job can reach production bytes.
:::

## Run

### 0. Auth precheck

Refuse if the human did not name all of these: Databricks account id, Databricks account CLI profile, workspace host, workspace id, workspace CLI profile, target cloud (`aws`, `azure`, or `gcp`), cloud account id, cloud CLI profile.
Do not invoke the skill until every named target is present.

Run live checks:

```bash
databricks auth profiles
databricks account workspaces list --profile <account-profile> -o json | jq 'length'
databricks metastores current --profile <workspace-profile> -o json | jq '{workspace_id, metastore_id, name}'
databricks current-user me --profile <workspace-profile> -o json | jq '{userName, workspace_id}'
aws sts get-caller-identity --profile <aws-profile>     # AWS: Account must equal named cloud account id
az account show --profile <azure-profile>                  # Azure: tenant + subscription must match named ids
gcloud auth list                                           # GCP: active account must match named project
```

Confirm the workspace profile reaches the named host and that `workspace_id` matches the human-named workspace id.
Compare live cloud identity and Databricks account id to the human-named values when obtainable.

On any failure, print **blocked: auth preflight failed**, name the failing check, give the human these remediations, and **stop**.
Do not invoke the skill.
Do not run Terraform.

| Check failed | Human must run |
|---|---|
| Account profile missing or `Valid=NO` | `databricks auth login --host <account-host> --profile <account-profile>` or fix M2M SP secret and Account admin role |
| `account workspaces list` fails | Confirm Account admin on the SP; regenerate OAuth secret (AWS) |
| `metastores current` or `current-user me` fails | `databricks auth login --host <workspace-host> --profile <workspace-profile>` |
| Workspace id mismatch | Fix workspace profile or human-named workspace id |
| Cloud CLI not authenticated | `aws sso login --profile <aws-profile>` / `az login --tenant <tenant>` / `gcloud auth login` |
| Cloud account id mismatch | Pick the profile whose account id matches the human-named cloud account id |

### 1. Check the metastore before touching it

```bash
databricks account metastores list --profile <account-profile> -o json \
  | jq '.[] | select(.region=="<region>") | {name, metastore_id, owner, default_data_access_config_id}'
```

If more than one comes back, do not attach to whichever appears first.
Report the list and let the user choose: adopt the clean one, delete the orphans, or create a distinctly named new one (`<prefix>-metastore`).
`default_data_access_config_id` may be null; that is acceptable when catalog storage is self-managed on this page.

Confirm the deploy principal can create UC objects on that metastore. If not, have a metastore admin grant `CREATE_CATALOG`, `CREATE_STORAGE_CREDENTIAL`, and `CREATE_EXTERNAL_LOCATION` before plan.

### 2. List existing catalogs

```bash
databricks catalogs list --profile <workspace-profile> -o json \
  | jq -r '.[] | "\(.name)\t\(.owner)\t\(.storage_root // "managed")"'
```

Reuse rather than duplicate.

### 3. Naming (mandatory before HCL)

Unity Catalog catalog name and cloud storage name are independent.
Example: catalog `ivansandbox123` can sit on `s3://ivansandbox123-euw3-catalog-…/` or on `s3://databricks-ivansandbox123-catalog-…/`.
Do not assume the bucket equals the catalog name or the workspace prefix.

Present at most three options in one message. Wait for an explicit pick. Map the pick to skill/Terraform inputs (`catalog_name`, bucket/container name, credential/location name stems). Do not fill templates before the pick.

Example options (adapt to the org; keep ≤3):

| Option | Catalog name | Bucket / container pattern | Notes |
|---|---|---|---|
| A | Layout default (`dev` / `stg` / `prod`) or override | `<prefix>-catalog-<env>` (Azure: `st<prefix>catalogdev`) | Skill-style default. |
| B | Human override (example `ivansandbox123`) | `<prefix>-catalog-<suffix>` still unique | Catalog label ≠ bucket label. |
| C | Same as A or B | `databricks-<prefix>-catalog-<env>` (or org-required cloud prefix) | When cloud accounts require a `databricks` (or other) prefix on buckets. |

State the exact strings you will pass into Terraform for the chosen option (catalog name + full bucket/container name stem).

### 4. Invoke the skill

Pass the layout decision, the environment list, the project name, the owning groups, and the chosen naming mapping.
It writes the Terraform for storage plus credential plus external location plus catalog plus schemas plus grants, then runs `init` and `plan`.

Create catalog and schemas as the deployer first.
After schemas exist, transfer catalog and schema ownership to the account group (`databricks catalogs update --owner` / schema equivalent, or Terraform ownership resources).
Setting `owner = group` before schema create can drop the deployer's `CREATE SCHEMA`.
Do not leave the deploy SP as owner when Verify expects the group.

`OPEN` catalogs need no `databricks_workspace_binding`. They are visible to all workspaces attached to that metastore.
`ISOLATED` catalogs need explicit workspace bindings. Production usually uses `ISOLATED` bound only to the production workspace; dev and staging stay `OPEN`.

If the human asks to attach one catalog to workspaces in different regions, create one catalog per metastore (same display name allowed). Do not promise a single cross-region catalog object.

### 5. Plan review

Mandatory. Get explicit approval before `apply`.
If the human already approved apply in the task brief, apply and record that approval.

## Verify

```bash
# Every catalog exists with its own storage root
databricks catalogs list --profile <workspace-profile> -o json \
  | jq -r '.[] | select(.name | startswith("<prefix>") or test("^(dev|stg|prod|sandbox)")) | "\(.name)\t\(.owner)\t\(.storage_root)"'

# Storage roots are distinct: this must print nothing
databricks catalogs list --profile <workspace-profile> -o json \
  | jq -r '[.[] | select(.storage_root != null) | .storage_root] | group_by(.) | map(select(length > 1)) | .[][]'

# Medallion schemas present (positional catalog name; --catalog is not valid on CLI 1.1.0)
databricks schemas list <catalog> --profile <workspace-profile> -o json | jq -r '.[] | .name'

# Owner is the account group (transfer if still the deploy SP)
databricks catalogs get <catalog> --profile <workspace-profile> -o json | jq -r '.owner'

# Grants when present (ownership alone may leave privilege_assignments empty)
databricks grants get SCHEMA <catalog>.<project>_gold --profile <workspace-profile> -o json \
  | jq -r '.privilege_assignments[]? | "\(.principal)\t\(.privileges | join(","))"'

# Production is bound to the production workspace only
databricks catalogs get <prod-catalog> --profile <workspace-profile> -o json | jq '{name, isolation_mode}'
```

Expected: account group as catalog owner (after transfer), the duplicate-storage check silent, `<project>_bronze` / `_silver` / `_gold` listed, and `ISOLATED` on the production catalog when applicable.

Then confirm data actually moves. One statement per request (semicolon-chained statements fail with `PARSE_SYNTAX_ERROR`):

```bash
databricks api post /api/2.0/sql/statements --profile <workspace-profile> --json '{
  "warehouse_id": "<warehouse-id>",
  "statement": "CREATE TABLE <catalog>.<project>_bronze._verify (id INT)",
  "wait_timeout": "50s"
}' | jq -r '.status.state'

databricks api post /api/2.0/sql/statements --profile <workspace-profile> --json '{
  "warehouse_id": "<warehouse-id>",
  "statement": "INSERT INTO <catalog>.<project>_bronze._verify VALUES (1)",
  "wait_timeout": "50s"
}' | jq -r '.status.state'

databricks api post /api/2.0/sql/statements --profile <workspace-profile> --json '{
  "warehouse_id": "<warehouse-id>",
  "statement": "SELECT count(*) FROM <catalog>.<project>_bronze._verify",
  "wait_timeout": "50s"
}' | jq -r '.status.state'

databricks api post /api/2.0/sql/statements --profile <workspace-profile> --json '{
  "warehouse_id": "<warehouse-id>",
  "statement": "DROP TABLE <catalog>.<project>_bronze._verify",
  "wait_timeout": "50s"
}' | jq -r '.status.state'
```

Expected text each time:

```text
SUCCEEDED
```

A failure here with the metadata all correct usually means the storage credential cannot reach the bucket.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| **blocked: auth preflight failed** before Run | Missing named account id, profiles, workspace host/id, or cloud account id | Ask the human for every required target; rerun ### 0 |
| Workspace profile fails `metastores current` | Expired workspace login or wrong host | `databricks auth login --host <workspace-host> --profile <workspace-profile>` |
| Workspace id mismatch | Wrong workspace profile | Fix profile or human-named workspace id |
| Cloud STS fails or account id mismatch | Expired or wrong cloud profile | `aws sso login --profile <aws-profile>` / `az login --tenant <tenant>` / `gcloud auth login` |
| Skill invoked despite red precheck | Agent skipped ### 0 | Always run ### 0 first; stop on any failure |
| `PERMISSION_DENIED: User is not an owner of Metastore` | Caller cannot create catalogs | Grant CREATE_* on the metastore, or add them to the metastore admin group |
| `No metastore assigned` | Workspace not attached to a metastore | Account admin assigns or creates the regional metastore, then retry |
| Catalog created, admins cannot see it | A service principal created and therefore owns it | Transfer owner to the account group after schemas exist; grant `ALL_PRIVILEGES` and `MANAGE` as needed |
| Classic compute cannot read the catalog | Databricks-managed metastore storage, which is serverless-only | Deploy a self-managed metastore with the customer's own bucket |
| `Storage root already in use` | Two catalogs pointed at one location | One dedicated bucket or container per catalog |
| Grants applied but the group sees nothing | Group is workspace-local | Recreate at account level; never use WorkspaceGroup for UC |
| Production catalog visible from dev | `isolation_mode` left `OPEN`, or no workspace binding | Set `ISOLATED` and add `databricks_workspace_binding` |
| Cannot attach one catalog to workspaces in two regions | Catalog is metastore-scoped; metastores are regional | Create one catalog per region/metastore; same name is fine |
| Owner still the deploy SP after apply | Ownership transfer skipped | Transfer owner to the account group after schemas exist |
| Bucket missing org-required prefix (example `databricks-`) | Naming step skipped or option A assumed | Re-run Naming; pick the cloud-prefix option before apply |
| Azure `AuthorizationFailed` on role assignment | No User Access Administrator / Owner | Elevate RBAC, then recreate Access Connector grants |

## Next

- **Do next:** [Cloud Object Storage access](/docs/01-infra-setup/cloud-object-storage/)
- **Manual fallback:** [Starter Journey: data governance](https://databricks-solutions.github.io/starter-journey/docs/05-data-governance-strategy/)
- **Reference:** [Create catalogs](https://docs.databricks.com/aws/en/catalogs/create-catalog)
