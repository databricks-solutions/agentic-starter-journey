---
description: Get data into Databricks. Auto Loader for files, databricks-lakeflow-connect for SaaS and databases, databricks-zerobus-ingest for near real-time pushes.
---

# Ingestion Pipelines

## Mental Model

Ingestion is getting data into Databricks. The path depends only on where the data already sits.
Files in cloud storage land through Auto Loader. SaaS apps and databases land through managed connectors. Near real-time record streams land through Zerobus gRPC.
All three paths end in governed Delta tables in Unity Catalog, so access is governed and audited in one place either way.

## Goal

Data from the source lands in a bronze Delta table in Unity Catalog, governed and queryable.

## Prerequisites

- Auth surface: `workspace`.
- [Project repo](/docs/02-databricks-projects/project-repo/) set up: a Git repo with a `databricks.yml` bundle and a dev target.
- A configured Databricks CLI profile that reaches the dev workspace.
- [Cloud Object Storage access](/docs/01-infra-setup/cloud-object-storage/) complete if the source is files in cloud storage (the source path must sit inside an external location).
- A bronze schema in a catalog (from [Catalogs](/docs/01-infra-setup/catalogs/)).

## Skill

Pick by source. The decision tree below names the skill.

## Inputs

The shared inputs first, then per-path inputs.

| Input | Source | How to obtain |
|---|---|---|
| Source system | Human | Where the data sits. Drives the path. |
| Target catalog and bronze schema | You derive | From the bundle's `catalog` variable and the project's `<project>_bronze` schema |

Per-path inputs:

| Path | Extra inputs | Source |
|---|---|---|
| Auto Loader (files) | Source path, source format, arrival pattern | Human |
| Lakeflow Connect (SaaS/DB) | Source connector, source credentials (in a secret scope, never in bundle YAML), objects to ingest, network reachability for on-prem SQL Server | Human |
| Zerobus (near real-time) | Target UC table, serialization (JSON or Protobuf), language for the client | Human |

## Run

### 0. Auth precheck

Refuse to continue if the brief or prior pages do not name all of these:

- Databricks account id
- Workspace id
- Workspace host (`https://<deployment>.cloud.databricks.com`)
- Workspace CLI profile name

```bash
databricks auth profiles

databricks auth describe --profile <workspace-profile> -o json \
  | jq '{host, account_id}'

databricks current-user me --profile <workspace-profile> -o json \
  | jq '{id, userName}'

databricks metastores current --profile <workspace-profile> -o json \
  | jq '{workspace_id, metastore_id}'
```

Expected:

- `<workspace-profile>` shows `Valid` = `YES` in `auth profiles`.
- `auth describe` `host` equals the named workspace host, and `account_id` equals the named Databricks account id.
- `current-user me` succeeds with no auth error.
- `metastores current` `workspace_id` equals the named workspace id.

On any failure: print **blocked: auth preflight failed**, list the failing check, give the human the remediation below, and stop.
Do not invoke skills, run `bundle validate`, or deploy until auth is green.

| Check failed | Human remediation |
|---|---|
| Missing named account id, workspace id, host, or profile | Ask the human for all four before continuing |
| Profile `Valid=NO` or auth error on describe | `databricks auth login --host <workspace-host> --profile <workspace-profile>` (or refresh the SP OAuth secret on the profile) |
| Host or account id mismatch on `auth describe` | Re-login the profile against the named host; confirm the Databricks account id in the account console |
| `workspace_id` mismatch on `metastores current` | `databricks account workspaces list --profile <account-profile> -o json` and align id with the named host |
| `current-user me` fails after profile is Valid | Workspace admin assigns the user or SP to the workspace |

### 1. Pick the path

```text
Where does the data sit?
├── Files in cloud object storage (S3, ADLS, GCS)  -> Auto Loader (databricks-pipelines)
├── SaaS app or database with a managed connector   -> databricks-lakeflow-connect
├── App or device that pushes events at you          -> databricks-zerobus-ingest
└── Anything else                                    -> read it in the ETL pipeline
```

If the source is not in the Lakeflow Connect connector list, do not force it. Read it in the ETL pipeline instead (next page).

### 2a. Auto Loader path

Invoke `databricks-pipelines` with the source path and format. The bronze dataset is a streaming table with Auto Loader.

```sql
CREATE OR REFRESH STREAMING TABLE orders_bronze
AS SELECT *, _metadata.file_path AS source_file, current_timestamp() AS ingested_at
   FROM STREAM read_files('${source_path}', format => '<format>');
```

`FROM STREAM read_files(...)` is what engages Auto Loader. Plain `FROM read_files(...)` is a batch query and fails with `Cannot create streaming table from batch query`.

Add the pipeline as a bundle resource, then validate and deploy to dev:

```bash
databricks bundle validate --strict --target dev --profile <name>
databricks bundle deploy --target dev --profile <name>
databricks bundle run <project>_ingest --target dev --profile <name>
```

### 2b. Lakeflow Connect path

Invoke `databricks-lakeflow-connect` with the connector, the credentials (referenced from a secret scope, never written into bundle YAML), and the objects to ingest.
It builds a managed serverless pipeline that lands the source into Unity Catalog Delta tables.
For on-prem SQL Server, confirm the source is reachable from serverless; if not, this needs `databricks-private-networking` and an NCC.

### 2c. Zerobus path

Invoke `databricks-zerobus-ingest`. It builds a client that ingests records directly into a Delta table via the Zerobus gRPC API, with schema validation and durability acknowledgments.
Default to Python with JSON for a prototype, Protobuf for a production producer. Install the SDK through the job or cluster library configuration, not pip at runtime: the SDK cannot pip-install on serverless compute.

## Verify

```bash
# Pipeline exists and the last update succeeded
databricks pipelines list-pipelines --profile <name> -o json \
  | jq -r '.[] | select(.name | test("<project>")) | "\(.name)\t\(.state)"'

# Bronze tables listed
databricks tables list --catalog <catalog> --schema <project>_bronze --profile <name> -o json \
  | jq -r '.[] | .name'

# Bronze has rows, and they came from the source
databricks api post /api/2.0/sql/statements --profile <name> --json '{
  "warehouse_id": "<warehouse-id>",
  "statement": "SELECT count(*) AS rows FROM <catalog>.<project>_bronze.<table>",
  "wait_timeout": "50s"
}' | jq -r '.result.data_array[0][0]'
```

Expected: the pipeline in a healthy state (`RUNNING` or `IDLE`), the ingested tables listed, and a non-zero row count.

For Zerobus, also confirm the client received acknowledgments:

```text
# In the client run output, expect ACKs for each ingested batch
# A missing ACK means the record was not durably persisted
```

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| Auth precheck blocked: missing named targets | Brief only has a workspace URL or display name | Collect Databricks account id, workspace id, workspace host, and workspace profile name before Run |
| Profile `Valid=NO` | Expired OAuth or SP secret | `databricks auth login --host <workspace-host> --profile <workspace-profile>` or rotate the SP secret |
| Account id or host mismatch on `auth describe` | Profile points at the wrong account or workspace | Re-login against the named host; confirm account id in the account console |
| `workspace_id` mismatch on `metastores current` | Wrong profile or wrong workspace in the brief | List workspaces and align id, host, and profile |
| `current-user me` fails with Valid profile | Principal not on the workspace | Workspace admin assigns the user or SP |
| `Cannot create streaming table from batch query` (Auto Loader) | `FROM read_files(...)` instead of `FROM STREAM read_files(...)` | Add `STREAM` |
| `Column not found` at ingest (Auto Loader) | `schemaHints` disagree with the files | Sample the source with `read_files` and align the hints |
| Lakeflow Connect pipeline stuck `INITIALIZING` on serverless | Cold start | Normal, takes a few minutes. Do not kill it. |
| On-prem SQL Server unreachable | Source not reachable from serverless | Use `databricks-private-networking` and an NCC |
| Zerobus: `grpcio-tools` version error on proto compile | Mismatched `protobuf` runtime | Pin `grpcio-tools==1.62.0` for older protobuf 5.26/5.29 |
| Zerobus: SDK not installed on serverless | pip-installed at runtime | Install through job/cluster library configuration |
| Bronze row count is zero | Path is real but empty, or the wrong path | Distinguish a permission error from an empty path |

## Next

- **Do next:** [ETL Pipelines](/docs/02-databricks-projects/etl-pipelines/)
- **Reference:** [Lakeflow Connect](https://docs.databricks.com/aws/en/data-ingestion/ingest/), [Zerobus Ingest](https://docs.databricks.com/ingestion/zerobus-ingest)
