---
description: Design, deploy, break, diagnose, and verify batch, file-ingestion, and CDC Spark Declarative Pipelines.
---

# Spark Declarative Pipelines

## Mental Model

A Spark Declarative Pipeline is a bundle-defined data product rather than a collection of unrelated tables.
Choose the dataset type from source semantics before writing code.
Use a materialized view for batch or full-recompute logic.
Use a streaming table for incremental sources.
Use Auto Loader for incrementally discovered files.
Use Auto CDC for ordered changes, deletes, and SCD history.
Publish bronze, silver, and gold datasets to separate schemas when those layers have different quality and access contracts.

## Goal

Add one serverless pipeline to an existing Declarative Automation Bundle, deploy it, deliberately break one assumption, diagnose the exact failure, repair it, and verify data postconditions.

## Prerequisites

- Complete the [Project repo](/docs/02-databricks-projects/project-repo/) outcome.
- Configure a named workspace profile and pass `--profile` on every CLI command.
- Provide a writable catalog and distinct bronze, silver, and optional gold schemas.
- Provide a SQL warehouse for source inspection and output verification.
- State whether each source is a batch table, an incremental table, raw files, or a CDC event stream.
- State the ownership and replay policy before creating streaming tables.

## Skill

Invoke these verified skills in order:

1. [`databricks-core`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-core)
2. [`databricks-pipelines`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-pipelines)
3. [`databricks-dabs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-dabs)

Read the feature reference selected by the source decision before authoring.
Use modern `pyspark.pipelines` APIs and do not introduce legacy `dlt` APIs.

## Inputs

| Input | Source | How to obtain |
|---|---|---|
| Account ID, workspace ID, host, profile | Human-provided | Name the exact live target and named CLI profile |
| Project path and bundle target | Human-provided | Point to the existing bundle and choose `dev` or another explicit target |
| Pipeline key and display name | Human-provided | Choose stable bundle and workspace names |
| Source kind | Human-provided | Choose `batch_table`, `incremental_table`, `files`, or `cdc` per source |
| Source FQN or folder URI | Human-provided | Provide a three-part table name or folder path, not an individual arrival file |
| Bronze, silver, and gold schemas | Human-provided | Assign one schema per layer instead of putting all layers in one schema |
| Dataset contract | Human-provided | Name every output, object type, grain, key, required column, and quality rule |
| File contract | Human-provided | For files, provide format, schema hints, evolution mode, and rescued-data policy |
| CDC contract | Human-provided | For CDC, provide keys, operation mapping, sequence columns, tie-break rule, delete behavior, and SCD type |
| Refresh and replay policy | Human-provided | Define selective refresh targets and when a full refresh may be approved |
| Catalog, warehouse, deployed IDs and FQNs | Agent-derived | Resolve from strict validation, bundle summary, and live resource metadata |

Use one output manifest as the source of truth.

```json
[
  {
    "name": "orders_bronze",
    "fqn": "<catalog>.<bronze_schema>.orders_bronze",
    "type": "STREAMING_TABLE",
    "source_kind": "files",
    "quality_rules": ["valid_order_id"]
  },
  {
    "name": "orders_daily",
    "fqn": "<catalog>.<gold_schema>.orders_daily",
    "type": "MATERIALIZED_VIEW",
    "source_kind": "batch_table",
    "quality_rules": []
  }
]
```

## Run

### 1. Preflight the exact target

```bash
set -euo pipefail
: "${DATABRICKS_ACCOUNT_ID:?}"
: "${DATABRICKS_WORKSPACE_ID:?}"
: "${DATABRICKS_HOST:?}"
: "${DATABRICKS_CONFIG_PROFILE:?}"
: "${PROJECT_PATH:?}"

auth=$(databricks auth describe --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
jq -e \
  --arg account "$DATABRICKS_ACCOUNT_ID" \
  --arg workspace "$DATABRICKS_WORKSPACE_ID" \
  --arg host "$DATABRICKS_HOST" '
    {
      host: (.host // .details.host // .details.configuration.host.value),
      account_id: (.account_id // .details.configuration.account_id.value),
      workspace_id: (.workspace_id // .details.configuration.workspace_id.value | tostring)
    }
    | select(.host == $host and .account_id == $account and .workspace_id == $workspace)' \
  >/dev/null <<<"$auth"

cd "$PROJECT_PATH"
databricks bundle validate --strict --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE"
```

Expected: authentication matches the intended workspace and strict validation succeeds.
Strict validation is necessary but does not resolve every resource dependency.
Deployment remains a separate graph-resolution check.

### 2. Apply the source decision

| Source and output | Authoring rule | Required verification |
|---|---|---|
| Batch table to persisted result | Use `@dp.materialized_view` or `CREATE OR REFRESH MATERIALIZED VIEW` with a batch read | Reconcile row count and business results with independent SQL |
| Incremental table to append-only result | Use a streaming table and `spark.readStream.table` or `STREAM(table)` | Rerun without input and prove no duplication |
| Raw files | Use Auto Loader with `spark.readStream.format("cloudFiles")` or `FROM STREAM read_files(...)` | Test schema drift, malformed input, `_rescued_data`, and no-input idempotency |
| CDC events | Create a streaming target and use `dp.create_auto_cdc_flow` | Verify current rows, closed history, deletes, and deterministic sequence behavior |
| Full-data aggregation | Use a materialized view with a batch read | Preserve business dimensions and reconcile aggregates |

For raw files, ingest folders and retain provenance.

```sql
CREATE OR REFRESH STREAMING TABLE <catalog>.<bronze_schema>.orders_bronze
AS SELECT
  *,
  _metadata.file_path AS source_file,
  current_timestamp() AS ingested_at
FROM STREAM read_files(
  '/Volumes/<catalog>/<source_schema>/<volume>/orders',
  format => 'json',
  schemaEvolutionMode => 'rescue'
);
```

For CDC, make sequencing deterministic and use modern APIs.

```python
from pyspark import pipelines as dp
from pyspark.sql.functions import expr, struct

dp.create_streaming_table(
    name="<catalog>.<silver_schema>.customers_scd2",
)

dp.create_auto_cdc_flow(
    target="<catalog>.<silver_schema>.customers_scd2",
    source="customer_changes_view",
    keys=["customer_id"],
    sequence_by=struct("event_timestamp", "event_sequence"),
    apply_as_deletes=expr("operation = 'DELETE'"),
    except_column_list=["operation", "event_sequence"],
    stored_as_scd_type=2,
)
```

Use `__START_AT` and `__END_AT` when verifying SCD Type 2 history.
Reject duplicate key and sequence pairs before deployment.

### 3. Encode medallion ownership in the bundle

```yaml
resources:
  pipelines:
    <pipeline_key>:
      name: <pipeline_display_name>
      catalog: ${var.catalog}
      target: ${var.bronze_schema}
      serverless: true
      continuous: false
      channel: CURRENT
      libraries:
        - glob:
            include: ../src/<pipeline_key>/**
```

Use fully qualified dataset names for every layer when exact schema placement is an acceptance criterion.
Development mode may rewrite an unqualified pipeline target with a user prefix.
Do not derive deployed FQNs from bundle variables alone.
Resolve them from the live pipeline and catalog metadata.
One pipeline owns each streaming table or materialized view.
Do not deploy a second pipeline against an already owned output FQN.

Default to serverless unless a documented platform limitation requires classic compute.
Keep `continuous: false` for triggered pipelines unless continuous latency is a stated requirement.
Use one focused transformation file per dataset.
Parameterize catalog and schemas for each target.

### 4. Deploy, run, and poll the exact update

```bash
databricks bundle validate --strict --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE"
databricks bundle deploy --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" --auto-approve
databricks bundle summary --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE"
databricks bundle run <pipeline_key> --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE"
```

Poll the update ID returned by the run.
Do not infer update completion from the pipeline's top-level state.
For failed updates, query pipeline events for that exact update and read `.error.exceptions[0].message`.
The CLI may return the event list as a top-level array.

Use selective refresh for focused recovery.
Pass fully qualified dataset identifiers to `--refresh`.
Do not use full refresh as routine recovery because it resets streaming state and can reprocess or destroy data.
Require explicit human approval before full refresh.

### 5. Break, diagnose, and repair

Break one assumption that the contract should catch.
Examples include removing `STREAM` from `read_files`, misspelling a CDC key, or referencing a nonexistent pipeline resource from a Job.
Capture the failed update or deployment ID and the exact actionable error.
Repair only the cause, redeploy, rerun without full refresh, and prove the postconditions again.

## Verify

Verify the live resource configuration first.

```bash
pipeline=$(databricks pipelines get "$PIPELINE_ID" \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
jq -e '
  .spec.serverless == true
  and .spec.continuous == false
  and (.spec.channel | ascii_upcase) == "CURRENT"
  and .state == "IDLE"
' >/dev/null <<<"$pipeline"
```

For every output, assert its manifest-declared object type and exact FQN.
Do not require every valid pipeline output to be a materialized view.

For files, record counts, rerun with no new files, and assert counts are unchanged.
Add one file and assert only its rows appear.
Count `_rescued_data` and inspect representative rescued payloads.
State whether rescued rows are retained, dropped, or quarantined downstream.

For CDC, verify current state and history separately.

```sql
SELECT count(*) AS current_rows
FROM <catalog>.<silver_schema>.<scd2_table>
WHERE __END_AT IS NULL;

SELECT <key>, __START_AT, __END_AT
FROM <catalog>.<silver_schema>.<scd2_table>
ORDER BY <key>, __START_AT;
```

For expectations, verify configured rule names against an update that processed rows.
A completed no-input streaming update may emit no expectation event or zero counters.
Do not treat that as proof that rules are absent.

Expected: deployed settings match the contract, every output has the intended type and schema, data postconditions hold, the deliberate failure is explained, and the repaired update completes without full refresh.

## Where this fails

| Symptom | Cause | Action |
|---|---|---|
| `CREATE_APPEND_ONCE_FLOW_FROM_BATCH_QUERY_NOT_ALLOWED` | `STREAM` was omitted from file ingestion | Use `FROM STREAM read_files(...)` or a streaming DataFrame |
| `UNRESOLVED_COLUMN` in Auto CDC | A key, operation, or sequence column is wrong | Align the CDC contract with the source schema |
| Selective refresh says the dataset identifier is invalid | A bare dataset name was passed | Pass the fully qualified catalog, schema, and dataset name |
| Expected schema is empty after a successful run | Development mode rewrote an unqualified target | Inspect the live target and fully qualify layer outputs |
| Another pipeline owns the table | Two pipelines target the same persisted dataset | Keep one owning pipeline or choose a new FQN |
| Strict validation passes but deployment fails on a resource reference | Strict validation did not resolve the dependency graph | Diagnose deployment output and correct the resource key |
| Streaming output fails a materialized-view assertion | Verification hard-coded the wrong object type | Verify the type declared in the output manifest |
| No expectation events appear on a completed update | No rows flowed in that update | Inspect an update that processed rows |
| Aggregates drift or lose filters | Gold removed required business dimensions | Preserve the dimensions consumers need to slice |
| A proposed fix requires full refresh | Streaming state or schema changed incompatibly | Explain replay and data-loss impact and request explicit approval |

## Next

Add a [Databricks Job](/docs/02-databricks-projects/databricks-jobs/) when the pipeline must share an operational lifecycle with other tasks, triggers, notifications, or postcondition checks.
