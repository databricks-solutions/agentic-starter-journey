---
description: Create a cloud IAM identity, then a Unity Catalog storage credential and a read-only external location so Databricks can read the customer's object storage.
---

# Cloud Object Storage access

## Mental Model

Databricks does not hold long-lived cloud keys in notebooks.
It assumes a cloud identity you create (IAM role, Access Connector, or service account), then binds that identity to a Unity Catalog storage credential and an external location over the customer's path.
One credential can back several locations.
This page connects **existing** customer landing / lake paths.
Catalog managed storage was created on [Catalogs](/docs/01-infra-setup/catalogs/).
Do not overlap those roots.

## Goal

A storage credential plus a **read-only** external location so Databricks can list and read the customer's object storage path through Unity Catalog.

## Prerequisites

- [Catalogs](/docs/01-infra-setup/catalogs/) complete, so a metastore is assigned and there is somewhere to grant access.
- Auth surface: both (account profile, workspace profile, and cloud CLI for the target cloud).
- `databricks metastores current` succeeds on the workspace profile.
- Permission for the skill to create the cloud identity (IAM role / Access Connector / service account) in the customer's cloud account.
- Caller has `CREATE STORAGE CREDENTIAL` and `CREATE EXTERNAL LOCATION` on the metastore (metastore admin has both by default).
- Azure: User Access Administrator or Owner on the RG/subscription so Access Connector role assignments succeed.
Contributor alone fails with `AuthorizationFailed` on `roleAssignments/write`.

## Skill

`databricks-unity-catalog-setup` (ai-platform-kit).
Read its `SKILL.md`, then the cloud file (`AWS.md` / `AZURE.md` / `GCP.md`).
It writes the cloud IAM side and the Unity Catalog side together, then stops for plan review unless the brief already approved apply.

The skill's AWS/Azure/GCP recipes center on **write-capable** metastore or catalog managed buckets (`PutObject` / `DeleteObject` and full UC templates).
This page's goal is narrower: **connect an existing path read-only**.
Use the skill for trust policy, ExternalId, and self-assume gotchas.
Narrow the IAM actions yourself to read-only on the path, and set `databricks_external_location.read_only = true`.
Do not copy a write-capable bucket template unchanged.

## Hard rule: read-only

This page always creates a **read-only** external location (`read_only = true`).
Grant consumers `READ FILES` only.
Do not grant `WRITE FILES`.
If the human needs Databricks to write into this path, stop and say this page is the wrong path.
Do not flip the location to read-write here.
Evaluate this rule before auth preflight or skill invocation.
For Databricks-managed writable storage, return to [Catalogs](/docs/01-infra-setup/catalogs/).
For a writable external customer path, use the manual fallback under **Next**.

## Inputs

| Input | Source | How to obtain |
|---|---|---|
| Storage path | Human | Exact URI: `s3://bucket/prefix/`, `abfss://container@account.dfs.core.windows.net/prefix/`, or `gs://bucket/prefix/`. Ask for the full path, not just the bucket name. |
| Which groups need read access | Human | Account-level groups. Grant `READ FILES` only. If the human omits groups (cold-start / eval brief), fall back to `account users`, grant `READ FILES` only, and log that the human did not name a group. |
| Cloud identity selector | Human | AWS profile, active Azure CLI session, or active GCP account/configuration. Azure CLI does not have AWS-style named credential profiles. |
| Azure tenant id | Human, Azure only | The tenant expected for the subscription and Databricks account. Compare it with `az account show`; do not change the active session to make a failed preflight pass. |
| Cloud IAM identity | Skill-derived unless reusing | Default: skill creates the IAM role (AWS), Access Connector (Azure), or service account (GCP) with **read** permissions on the path. Only ask for an existing ARN/identity when reusing. |
| Credential and location names | You derive | Prefer a ≤3-option naming pick when a human is present. If the brief already supplies names, or no human picker is available (cold-start Crew), use `<prefix>_cred_<purpose>` / `<prefix>_ext_<purpose>` (underscores) and record the choice. Do not stall waiting for a pick. |

:::warning
An external location must not overlap another one, and must not sit inside a catalog's managed storage root.
Overlapping paths make grants ambiguous, and Unity Catalog rejects the create.
List existing locations before proposing a path.
:::

## Run

### 0. Auth precheck

Evaluate the read-only hard rule before this step.
Refuse if the human did not name all of these: Databricks account id, Databricks account CLI profile, workspace host, workspace id, workspace CLI profile, target cloud (`aws`, `azure`, or `gcp`), cloud account id, and the cloud identity selector.
Also require the Azure tenant id for Azure.
Do not invoke the skill until every named target is present.

Run live checks:

```bash
databricks auth profiles
databricks account workspaces list --profile <account-profile> -o json | jq 'length'
databricks account workspaces get <workspace-id> --profile <account-profile> -o json \
  | jq '{account_id, workspace_id, cloud, azure_workspace_info}'
databricks metastores current --profile <workspace-profile> -o json | jq '{workspace_id, metastore_id, name}'
databricks current-user me --profile <workspace-profile> -o json | jq '{userName, workspace_id}'
aws sts get-caller-identity --profile <aws-profile>     # AWS: Account must equal named cloud account id
az account show -o json | jq '{id, tenantId, user}'     # Azure: id and tenantId must match named ids
gcloud auth list                                           # GCP: active account must match named project
```

Prefer `metastores current.workspace_id` (and/or account `workspaces get`) as the workspace-id check.
Treat `workspace_id: null` on `current-user me` as non-blocking when the workspace host matches and `metastores current` returns the named workspace id (common for SP oauth-m2m).

Confirm the workspace profile reaches the named host and that the live workspace id matches the human-named workspace id.
Confirm `account workspaces get.account_id` matches the named Databricks account id.
On Azure, confirm `azure_workspace_info.subscription_id`, `az account show.id`, and the human-named subscription are identical.
Also confirm `az account show.tenantId` matches the human-named Azure tenant.
Do not run `az account set`, `az login`, or another command that changes identity to repair a failed preflight.

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
| Azure subscription or tenant mismatch | Activate the intended Azure identity outside this workflow, then rerun preflight |

### 1. Check what already exists

```bash
databricks external-locations list --profile <workspace-profile> -o json \
  | jq -r '.[] | "\(.name)\t\(.url)\t\(.credential_name)\t\(.read_only)"'

databricks storage-credentials list --profile <workspace-profile> -o json \
  | jq -r '.[] | "\(.name)\t\(.owner)\t\(.read_only)"'
```

If a location already covers the path, reuse it.
Normalize trailing slashes before comparing URI prefixes.
If an existing location is equal to, inside, or above the proposed path, print **refused: overlapping external location**, verify the proposed location name is absent, and stop before the skill or Terraform.

On Azure, the exact ADLS directory in a non-root URI must already exist.
When the active Azure user has data-plane access, check it before planning:

```bash
az storage fs directory exists \
  --account-name <storage-account> \
  --file-system <container> \
  --name <prefix> \
  --auth-mode login \
  --query exists -o tsv
```

Expected: `true`.
If the command is denied, ask the human to confirm the directory exists.
Do not infer directory existence from the container alone.
Do not create or seed the directory unless the human explicitly requests it.

### 2. Naming (new credential + location)

When a human is present, present ≤3 naming options for the credential and the external location, then wait for a pick before writing HCL.
If the brief already supplies names, or no human picker is available (cold-start Crew), use `<prefix>_cred_<purpose>` / `<prefix>_ext_<purpose>` and record the choice.
Do not invent a new bucket unless the human asked for one.
This page's default is connect-to-existing path.

When reusing a storage credential, inspect the credential and every location that references it.
Reference it with a Terraform data source or literal credential name.
The plan must not import, create, replace, or manage the credential, its cloud identity, or its IAM assignments.
One credential may back several non-overlapping locations when its cloud identity can read each path.

### 3. Invoke the skill

Pass:

1. The storage path.
2. That the external location must be **read-only**.
3. That the cloud IAM policy is read-scoped (AWS: `s3:GetObject`, `s3:ListBucket`, `s3:GetBucketLocation` on the bucket/prefix; no `PutObject` / `DeleteObject` for this path).
4. The consuming groups for `READ FILES`.

On AWS the skill creates (or reuses) an IAM role whose trust policy allows the Unity Catalog master role (with the Databricks account id as `ExternalId`) and self-assume, plus an inline policy that includes `sts:AssumeRole` on the role's own ARN.
Without self-assume in **both** trust and inline policy, credential validation fails with `non self-assuming role`.
Then it creates the storage credential (role ARN) and the external location (`read_only = true`) in the workspace.

Pin the Databricks provider to the human-named workspace host and profile.
If the profile already supplies PAT or OAuth authentication, do not also set `auth_type` or `azure_tenant_id`.
When supported by the provider, pin `workspace_id` and confirm it matches `metastores current` before planning.

### 4. Plan review

Mandatory unless the brief already approved apply.
Get explicit approval before `apply`, or record that the brief approved it.
Apply only the exact saved plan the human approved.
If the saved plan becomes stale, apply fails partway, or recovery changes the plan, save and present a new plan and wait for fresh approval.

## Verify

```bash
# Location exists, points at the path, and is read-only
databricks external-locations get <location-name> --profile <workspace-profile> -o json \
  | jq '{name, url, credential_name, read_only}'
```

Expected: `url` matches the intended URI and `read_only` is `true`.
The hard rule applies to the **external location** `read_only` flag (and read-scoped IAM actions), not the storage credential object's `read_only` field.
A credential may report `read_only: false` while the location is correctly `read_only: true`.

```bash
# Grants are READ FILES on groups only
databricks grants get EXTERNAL_LOCATION <location-name> --profile <workspace-profile> -o json \
  | jq -r '.privilege_assignments[]? | "\(.principal)\t\(.privileges | join(","))"'
```

Expected: consuming groups show `READ_FILES` (or `READ FILES`).
No `WRITE_FILES` / `WRITE FILES`.

Then prove a read works.
Prefer a warehouse SQL check that works on serverless:

```bash
databricks api post /api/2.0/sql/statements --profile <workspace-profile> --json '{
  "warehouse_id": "<warehouse-id>",
  "statement": "LIST '\''<storage-path>'\''",
  "wait_timeout": "50s"
}' | jq -r '.status.state'
```

AWS alternative: `SELECT * FROM read_files("<storage-path>") LIMIT 1` when objects exist under the path.
Do not use `databricks external-locations validate` (missing on CLI 1.1.0) or `list_files(...)` (unsupported FILE type on serverless SQL).

Expected: `SUCCEEDED`.
Empty listing with `SUCCEEDED` is different from a permission error.

Prove write is denied while `read_only` is true with a **path-direct** probe (avoids catalog `USE CATALOG` failures that mask the read-only check):

```bash
databricks api post /api/2.0/sql/statements --profile <workspace-profile> --json '{
  "warehouse_id": "<warehouse-id>",
  "statement": "CREATE TABLE delta.`<storage-path>/_write_probe` AS SELECT 1 AS n",
  "wait_timeout": "50s"
}' | jq -r '.status.state, .status.error.message // empty'
```

Expected: failure mentioning a read-only external location (for example `User cannot write to a read-only external location <name>`).
Do not use catalog-scoped `CREATE TABLE ...
LOCATION` as the first write probe; it can fail on catalog privileges before testing the location.
Do not leave probe objects behind on a successful write (that would mean the location was not read-only).

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| **blocked: auth preflight failed** before Run | Missing named account id, profiles, workspace host/id, or cloud account id | Ask the human for every required target; rerun ### 0 |
| Cloud STS fails or account id mismatch | Expired or wrong cloud profile | `aws sso login --profile <aws-profile>` / `az login --tenant <tenant>` / `gcloud auth login` |
| Azure subscription or tenant differs from the named target | Wrong active Azure identity or target belongs to another tenant | Stop without changing the active session; have the human activate the matching identity, then rerun ### 0 |
| Workspace profile fails `metastores current` | Expired workspace login or wrong host | `databricks auth login --host <workspace-host> --profile <workspace-profile>` |
| Provider reports multiple auth methods or resolves another workspace | Profile auth was mixed with explicit Azure auth, or workspace metadata was ambiguous | Use the named profile and host without a second auth method; pin and verify the workspace id |
| Skill invoked despite red precheck | Agent skipped ### 0 | Always run ### 0 first; stop on any failure |
| SQL read fails on every operation | IAM role trust / Access Connector role assignment not propagated | Wait a minute and retry. Cloud IAM is eventually consistent. |
| Azure location create returns `PathNotFound` or HTTP 404 | The ADLS directory in the URI does not exist | Have the path owner create the directory, then generate a fresh plan and get fresh approval |
| `non self-assuming role` | AWS role missing `sts:AssumeRole` on its own ARN in the **inline** policy | Add the self-assume statement to the role policy, then re-validate |
| `Overlapping external location` | Path is equal to, inside, or above an existing location or catalog managed root | Normalize trailing slashes, stop before mutation, then pick a non-overlapping prefix or reuse the covering location |
| `PERMISSION_DENIED` creating the credential | Caller lacks `CREATE STORAGE CREDENTIAL` on the metastore | Metastore admin grants it, or runs this step |
| Location works for the creator only | Service principal owns it, no grants issued | Grant `READ FILES` to the consuming groups and `MANAGE` to the admin group |
| Write succeeds against a "read" path | External location created without `read_only = true` | Recreate or update the location with `read_only = true`; do not grant `WRITE FILES` |
| Write probe fails on `USE CATALOG` before testing read-only | Catalog-scoped `CREATE TABLE ... LOCATION` used as the probe | Prefer path-direct `CREATE TABLE delta.\`<path>/_write_probe\` ...`; expected message is read-only external location |
| Azure: `AuthorizationFailed` on role assignment | Access Connector missing RBAC write rights | Grant User Access Administrator or Owner, assign `Storage Blob Data Reader` for read-only, then retry |

## Next

- **Do next:** [Databricks Projects](/docs/02-databricks-projects/)
- **Manual fallback:** [Starter Journey: cloud object storage](https://databricks-solutions.github.io/starter-journey/docs/06-access-your-data/cloud-object-storage/)
