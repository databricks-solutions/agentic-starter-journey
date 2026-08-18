---
description: Build the medallion bronze, silver, gold ETL pipeline as a bundle resource with databricks-pipelines. Layer mapping, run steps, verification, and failure modes.
---

# ETL Pipelines

## Mental Model

ETL is the transformation layer on top of ingested data. A Lakeflow Spark Declarative Pipeline (SDP) holds the bronze, silver, and gold datasets in one pipeline resource, with expectations for data quality.
Bronze is raw, exactly as it arrived. Silver is cleaned and conformed. Gold is aggregates over the full dataset.
The dataset type per layer is load-bearing: a streaming table is append-only and will not recompute an aggregate when source rows change; a materialized view does.

## Goal

A bronze, silver, gold SDP defined as a bundle resource, deployed and running against the dev target.

## Prerequisites

- Auth surface: `workspace`.
- [Project repo](/docs/02-databricks-projects/project-repo/) set up: a Git repo with a `databricks.yml` bundle and a dev target.
- A configured Databricks CLI profile that reaches the dev workspace.
- [Ingestion Pipelines](/docs/02-databricks-projects/ingestion-pipelines/) complete, so bronze has data in it.

## Skill

`databricks-pipelines` (databricks-agent-skills). Invoke it before writing any pipeline code, not after. `databricks-dabs` for the resource YAML.

## Inputs

Collect all of these before writing code. The first four decide the pipeline's shape; get them wrong and the fix is dropping tables, not editing YAML.

| Input | Source | How to obtain |
|---|---|---|
| Source table | Human | The bronze table from Ingestion Pipelines, `<catalog>.<project>_bronze.<table>` |
| Update semantics | Human | Append only, or upserts and change tracking. Upserts mean Auto CDC and need a key plus a sequence column. |
| Expectations | Human | The actual rules: which columns are never null, which ranges are valid, what a duplicate means. Push for specifics. |
| Language | Human | SQL or Python. Sinks, ForEachBatch sinks, CDC from snapshots, and custom data sources are Python-only. |
| Target catalog | You derive | The bundle's `catalog` variable |
| Target schemas | You derive | `<project>_bronze`, `<project>_silver`, `<project>_gold` |
| Serverless? | You derive | Default yes. Automatic incremental refresh of aggregating materialized views needs serverless plus Delta row tracking on the source. |

:::warning
Ask the arrival pattern before choosing a dataset type.
A streaming source needs a streaming table; a batch source needs a materialized view.
You cannot change a streaming table into a materialized view in place, and a full refresh does not help: the table has to be dropped or the dataset renamed.
:::

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

### 1. The layer mapping

| Layer | Dataset type | Why |
|---|---|---|
| Bronze | Streaming table with Auto Loader (or the ingested table from Ingestion Pipelines) | Raw, exactly as it arrived. Nothing filtered or deduplicated, so a broken downstream transformation can be reprocessed from here. |
| Silver | Streaming table, or a streaming table populated by Auto CDC for upserts | Cleaned, deduplicated, conformed. The source of truth for ad-hoc queries. |
| Gold | Materialized view | Aggregates over the full dataset. A streaming table is append-only and will not recompute an aggregate when source rows change; a materialized view does. |

Gold reading from a streaming table needs a **batch** read, `spark.read.table` in Python or `SELECT ... FROM <table>` without `STREAM` in SQL. Using a streaming read for an aggregation is the most common mistake in this layer.

### 2. Write the pipeline source

Invoke `databricks-pipelines` with the collected inputs. Its decision tree picks the dataset types and features; its reference file per feature and language has the exact API. Read the reference file for the feature before writing the code.

Shape of a silver streaming table with Auto CDC, in SQL:

```sql
CREATE OR REFRESH STREAMING TABLE orders_silver
  (CONSTRAINT valid_id EXPECT (order_id IS NOT NULL) ON VIOLATION DROP ROW)
AS SELECT * FROM STREAM read_kafka(....);
```

Shape of a gold materialized view, in SQL:

```sql
CREATE OR REFRESH MATERIALIZED VIEW orders_daily
AS SELECT order_date, count(*) AS orders, sum(amount) AS revenue
   FROM <catalog>.<project>_silver.orders_silver
   GROUP BY order_date;
```

Note `CREATE OR REFRESH`, not `CREATE OR REPLACE`. The latter is standard SQL and not valid for SDP datasets.

### 3. Add the resource to the bundle

```yaml
# resources/<project>.pipeline.yml
resources:
  pipelines:
    <project>_medallion:
      name: ${bundle.name}-medallion
      catalog: ${var.catalog}
      schema: ${var.schema_prefix}_bronze
      serverless: true
      libraries:
        - glob:
            include: ../src/pipelines/**
      configuration:
        source_path: ${var.source_path}
```

Targets other than bronze come from fully-qualified dataset names in the source, `${var.catalog}.${var.schema_prefix}_gold.orders_daily`, since the pipeline has one default schema.

Declare `source_path` as a variable in `databricks.yml` with a per-target value. A dev pipeline reading the production landing path is the failure this prevents.

### 4. Validate and deploy to dev

```bash
databricks bundle validate --strict --target dev --profile <name>
databricks bundle deploy --target dev --profile <name>
databricks bundle run <project>_medallion --target dev --profile <name>
```

Deploy to dev only. Staging and production go through CI/CD, which is a later section not in this seed.

## Verify

```bash
# Pipeline exists and the last update succeeded
databricks bundle run <project>_medallion --target dev --profile <name> -o json \
  | jq -r '.state, .cause'

# All three layers materialized
for layer in bronze silver gold; do
  echo "== $layer"
  databricks tables list --catalog <catalog> --schema <project>_$layer --profile <name> -o json \
    | jq -r '.[] | .name'
done

# Gold has rows, and they came from the source
databricks api post /api/2.0/sql/statements --profile <name> --json '{
  "warehouse_id": "<warehouse-id>",
  "statement": "SELECT count(*) AS rows FROM <catalog>.<project>_gold.<table>",
  "wait_timeout": "50s"
}' | jq -r '.result.data_array[0][0]'
```

Expected: `COMPLETED`, tables listed in all three schemas, and a non-zero row count in gold.

Check the expectations actually fired rather than assuming they are wired:

```bash
databricks api post /api/2.0/sql/statements --profile <name> --json '{
  "warehouse_id": "<warehouse-id>",
  "statement": "SELECT explode(from_json(get_json_object(details, \"$.flow_progress.data_quality.expectations\"), \"array<struct<name:string,passed_records:bigint,failed_records:bigint>>\")) AS e FROM event_log(TABLE(<catalog>.<project>_silver.orders_silver)) WHERE event_type = \"flow_progress\"",
  "wait_timeout": "50s"
}' | jq -r '.result.data_array'
```

Expected: a row per expectation with pass and fail counts. An empty result means the expectations are not attached to the dataset.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| Auth precheck blocked: missing named targets | Brief only has a workspace URL or display name | Collect Databricks account id, workspace id, workspace host, and workspace profile name before Run |
| Profile `Valid=NO` | Expired OAuth or SP secret | `databricks auth login --host <workspace-host> --profile <workspace-profile>` or rotate the SP secret |
| Account id or host mismatch on `auth describe` | Profile points at the wrong account or workspace | Re-login against the named host; confirm account id in the account console |
| `workspace_id` mismatch on `metastores current` | Wrong profile or wrong workspace in the brief | List workspaces and align id, host, and profile |
| `current-user me` fails with Valid profile | Principal not on the workspace | Workspace admin assigns the user or SP |
| `Cannot create streaming table from batch query` | `FROM read_files(...)` instead of `FROM STREAM read_files(...)` | Add `STREAM` |
| `CREATE OR REPLACE` rejected | Not valid for SDP datasets | Use `CREATE OR REFRESH` |
| `Column not found` at ingest | `schemaHints` disagree with the files | Sample the source with `read_files` and align the hints |
| Pipeline stuck `INITIALIZING` on serverless | Cold start | Normal, takes a few minutes. Do not kill it. |
| Gold aggregate never updates when source rows change | Gold is a streaming table, which is append-only | Make it a materialized view with a batch read |
| Materialized view falls back to full recompute | No serverless, or no Delta row tracking on the source | Serverless plus `delta.enableRowTracking = true` |
| SCD2 query returns nothing on `START_AT` | Columns are `__START_AT` and `__END_AT`, double underscore | `WHERE __END_AT IS NULL` for current rows |
| Real error missing from the events output | Reading `.message`, which only says the update failed | Read `error.exceptions[0].message` |
| `databricks fs ls /Volumes/...` errors | Volume paths still need the `dbfs:` prefix | `databricks fs ls dbfs:/Volumes/...` |

## Next

- **Manual fallback:** [Starter Journey: build the first pipeline](https://databricks-solutions.github.io/starter-journey/docs/07-build-first-pipeline/)
- **Reference:** [Lakeflow Spark Declarative Pipelines](https://docs.databricks.com/aws/en/ldp/)
