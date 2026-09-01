---
description: bakehouse_e2e_pipeline reads samples.bakehouse and publishes governed bronze and silver materialized views with enforced expectations.
---

# Spark Declarative Pipelines

## Mental Model

`samples.bakehouse` is a batch source.
Bronze preserves source rows.
Silver applies quality rules.
Batch inputs use materialized views and `spark.read.table`.
The existing project DABs bundle owns and deploys the pipeline.

## Goal

Successfully update the pipeline named `bakehouse_e2e_pipeline`.

## Prerequisites

- Auth surface: `workspace`.
- Complete the [Project repo](/docs/02-databricks-projects/project-repo/) outcome.
- Use a target catalog that contains `bakehouse_bronze` and `bakehouse_silver`.
- Confirm the deployment principal can read `samples.bakehouse`.
- Use a SQL warehouse for verification.

## Skill

Read `databricks-pipelines` and `databricks-dabs`, but invoke them only after the auth precheck passes.

## Inputs

| Input | Source | How to obtain |
|---|---|---|
| Existing project repository path | Human-provided | Use the repository completed on the Project repo page |
| Target catalog | Agent-derived | Read the active bundle target's `catalog` variable |
| Workspace profile | Human-provided | Use the named Databricks CLI profile for the target workspace |
| Workspace host and workspace ID | Agent-derived | Read the named profile and `databricks metastores current` |
| SQL warehouse ID | Agent-derived | Select a running warehouse available to the deployment principal |
| Language | Agent-derived, fixed runbook decision | Use Python |

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
  | jq -c '{
      host: (.host // .details.host),
      account_id: (.account_id // .details.configuration.account_id.value),
      workspace_id: (.workspace_id // .details.configuration.workspace_id.value)
    }'

databricks current-user me --profile <workspace-profile> -o json \
  | jq '{id, userName}'

databricks metastores current --profile <workspace-profile> -o json \
  | jq '{workspace_id, metastore_id}'
```

Expected:

- `<workspace-profile>` shows `Valid` = `YES` in `auth profiles`.
- `auth describe` prints `{"host":"https://<deployment>.cloud.databricks.com","account_id":"<databricks-account-id>","workspace_id":"<workspace-id>"}` with no null values.
- `auth describe` `host`, `account_id`, and `workspace_id` equal the named values.
- `current-user me` succeeds with no auth error.
- `metastores current` `workspace_id` equals the named workspace id.

If any projected `auth describe` value is null, inspect the raw `databricks auth describe --profile <workspace-profile> -o json` response before prescribing re-login.
On any failure: print **blocked: auth preflight failed**, list the failing check, give the human the remediation below, and stop.
Do not invoke skills, run `bundle validate`, or deploy until auth is green.

| Check failed | Human remediation |
|---|---|
| Missing named account id, workspace id, host, or profile | Ask the human for all four before continuing |
| Profile `Valid=NO` or auth error on describe | `databricks auth login --host <workspace-host> --profile <workspace-profile>` (or refresh the SP OAuth secret on the profile) |
| Host, account id, or workspace id mismatch on `auth describe` | Inspect the raw response, then re-login the profile against the named host if the configured values are wrong; confirm the Databricks account id in the account console |
| `workspace_id` mismatch on `metastores current` | `databricks account workspaces list --profile <account-profile> -o json` and align id with the named host |
| `current-user me` fails after profile is Valid | Workspace admin assigns the user or SP to the workspace |

### 1. Inspect the batch source

Invoke `databricks-pipelines` and `databricks-dabs`.
Define one helper that waits for SQL Statement Execution to finish:

```bash
run_sql() {
  local statement=$1 response statement_id state

  response=$(databricks api post /api/2.0/sql/statements \
    --profile <workspace-profile> \
    --json "$(jq -n \
      --arg warehouse_id '<warehouse-id>' \
      --arg statement "$statement" \
      '{warehouse_id: $warehouse_id, statement: $statement, wait_timeout: "0s"}')") \
    || return
  statement_id=$(jq -er '.statement_id' <<<"$response") || return

  while :; do
    state=$(jq -er '.status.state' <<<"$response") || return
    case "$state" in
      SUCCEEDED)
        printf '%s\n' "$response"
        return 0
        ;;
      PENDING|RUNNING)
        sleep 5
        response=$(databricks api get "/api/2.0/sql/statements/$statement_id" \
          --profile <workspace-profile>) || return
        ;;
      *)
        jq -c '.status.error // .status' <<<"$response" >&2
        return 1
        ;;
    esac
  done
}
```

The helper prints results only for `SUCCEEDED`.
It prints the API error and fails for every terminal failure state.
Inspect all four source schemas before using source columns in expectations.

```bash
statement=$(cat <<'SQL'
SELECT table_name, column_name, full_data_type
FROM samples.information_schema.columns
WHERE table_schema = 'bakehouse'
  AND table_name IN (
    'sales_transactions',
    'sales_customers',
    'sales_franchises',
    'sales_suppliers'
  )
ORDER BY table_name, column_name
SQL
)

run_sql "$statement" \
  | jq -e '
      .result.data_array as $rows
      | {
          tables: ([$rows[][0]] | unique),
          transaction_columns: ([
            $rows[]
            | select(
                .[0] == "sales_transactions"
                and (.[1] == "customerID" or .[1] == "quantity" or .[1] == "franchiseID")
              )
            | .[1]
          ] | sort)
        }
      | select(
          (.tables | length) == 4
          and .transaction_columns == ["customerID", "franchiseID", "quantity"]
        )'
```

Expected: four table names and all three required transaction columns.
Stop if `customerID`, `quantity`, or `franchiseID` is absent.

### 2. Write the pipeline source

Create `src/bakehouse_pipeline/transformations.py`:

```python
from pyspark import pipelines as dp

silver_schema = spark.conf.get("silver_schema")

@dp.materialized_view(name="sales_transactions_raw")
def sales_transactions_raw():
    return spark.read.table("samples.bakehouse.sales_transactions")

@dp.materialized_view(name="sales_customers_raw")
def sales_customers_raw():
    return spark.read.table("samples.bakehouse.sales_customers")

@dp.materialized_view(name="sales_franchises_raw")
def sales_franchises_raw():
    return spark.read.table("samples.bakehouse.sales_franchises")

@dp.materialized_view(name="sales_suppliers_raw")
def sales_suppliers_raw():
    return spark.read.table("samples.bakehouse.sales_suppliers")

@dp.materialized_view(name=f"{silver_schema}.transactions_clean")
@dp.expect_or_drop("valid_customer", "customerID IS NOT NULL")
@dp.expect_or_drop("valid_quantity", "quantity > 0")
@dp.expect_or_drop("valid_franchise", "franchiseID IS NOT NULL")
def transactions_clean():
    return spark.read.table("sales_transactions_raw")

@dp.materialized_view(name=f"{silver_schema}.customers_clean")
def customers_clean():
    return spark.read.table("sales_customers_raw")

@dp.materialized_view(name=f"{silver_schema}.franchises_clean")
def franchises_clean():
    return spark.read.table("sales_franchises_raw")

@dp.materialized_view(name=f"{silver_schema}.suppliers_clean")
def suppliers_clean():
    return spark.read.table("sales_suppliers_raw")
```

The default target publishes these bronze tables:

```text
bakehouse_bronze.sales_transactions_raw
bakehouse_bronze.sales_customers_raw
bakehouse_bronze.sales_franchises_raw
bakehouse_bronze.sales_suppliers_raw
```

The configured silver schema publishes these tables:

```text
bakehouse_silver.transactions_clean
bakehouse_silver.customers_clean
bakehouse_silver.franchises_clean
bakehouse_silver.suppliers_clean
```

### 3. Add the pipeline resource

Create `resources/bakehouse_e2e_pipeline.pipeline.yml`:

```yaml
resources:
  pipelines:
    bakehouse_e2e_pipeline:
      name: bakehouse_e2e_pipeline
      catalog: ${var.catalog}
      target: bakehouse_bronze
      root_path: ../src/bakehouse_pipeline
      libraries:
        - glob:
            include: ../src/bakehouse_pipeline/**
      serverless: true
      continuous: false
      development: true
      photon: true
      channel: current
      configuration:
        silver_schema: bakehouse_silver
```

Both paths resolve relative to the YAML file under `resources/`.
`${var.catalog}` prevents a hardcoded workspace catalog.

### 4. Deploy and run

Run from the existing project repository:

```bash
databricks bundle validate --strict --target dev --profile <workspace-profile>
databricks bundle deploy --target dev --profile <workspace-profile>

pipeline_id=$(databricks bundle summary \
  --target dev \
  --profile <workspace-profile> \
  -o json \
  | jq -er '.resources.pipelines.bakehouse_e2e_pipeline.id')

update_id=$(databricks bundle run bakehouse_e2e_pipeline \
  --target dev \
  --profile <workspace-profile> \
  --no-wait \
  -o json \
  | jq -er '.update_id')
```

## Verify

Prove the bundle update completed and all eight governed tables exist:

```bash
while :; do
  update=$(databricks pipelines get-update \
    "$pipeline_id" \
    "$update_id" \
    --profile <workspace-profile> \
    -o json) || exit 1
  state=$(jq -er '.update.state' <<<"$update") || exit 1
  printf 'update=%s state=%s\n' "$update_id" "$state"

  case "$state" in
    COMPLETED)
      break
      ;;
    FAILED|CANCELED)
      jq '.update' <<<"$update" >&2
      exit 1
      ;;
    *)
      sleep 30
      ;;
  esac
done

for table in \
  <catalog>.bakehouse_bronze.sales_transactions_raw \
  <catalog>.bakehouse_bronze.sales_customers_raw \
  <catalog>.bakehouse_bronze.sales_franchises_raw \
  <catalog>.bakehouse_bronze.sales_suppliers_raw \
  <catalog>.bakehouse_silver.transactions_clean \
  <catalog>.bakehouse_silver.customers_clean \
  <catalog>.bakehouse_silver.franchises_clean \
  <catalog>.bakehouse_silver.suppliers_clean
do
  databricks tables get "$table" --profile <workspace-profile> -o json \
    | jq -er '.full_name'
done
```

Expected: the run state is `COMPLETED` and all eight exact table names print.

Use one query to prove every silver table has rows:

```bash
statement=$(cat <<'SQL'
SELECT 'transactions_clean' AS table_name, count(*) AS row_count
FROM <catalog>.bakehouse_silver.transactions_clean
UNION ALL
SELECT 'customers_clean', count(*)
FROM <catalog>.bakehouse_silver.customers_clean
UNION ALL
SELECT 'franchises_clean', count(*)
FROM <catalog>.bakehouse_silver.franchises_clean
UNION ALL
SELECT 'suppliers_clean', count(*)
FROM <catalog>.bakehouse_silver.suppliers_clean
SQL
)

run_sql "$statement" \
  | jq -e '
      [.result.data_array[] | {table: .[0], rows: (.[1] | tonumber)}]
      | select(length == 4 and all(.[]; .rows > 0))'
```

Expected: four rows with `rows` greater than zero.

Prove no invalid transaction rows survived:

```bash
statement=$(cat <<'SQL'
SELECT
  count_if(customerID IS NULL) AS null_customer_ids,
  count_if(quantity IS NULL OR quantity <= 0) AS invalid_quantities,
  count_if(franchiseID IS NULL) AS null_franchise_ids
FROM <catalog>.bakehouse_silver.transactions_clean
SQL
)

run_sql "$statement" \
  | jq -e '
      .result.data_array[0]
      | map(tonumber)
      | select(. == [0, 0, 0])'
```

Expected: `[0, 0, 0]`.

Prove all expectations emitted numeric counters:

```bash
statement=$(cat <<SQL
SELECT
  expectation.name,
  expectation.passed_records,
  expectation.failed_records
FROM event_log(TABLE(<catalog>.bakehouse_silver.transactions_clean))
LATERAL VIEW explode(
  from_json(
    get_json_object(details, '$.flow_progress.data_quality.expectations'),
    'array<struct<name:string,passed_records:bigint,failed_records:bigint>>'
  )
) exploded AS expectation
WHERE event_type = 'flow_progress'
  AND origin.update_id = '$update_id'
QUALIFY row_number() OVER (
  PARTITION BY expectation.name
  ORDER BY timestamp DESC
) = 1
ORDER BY expectation.name
SQL
)

run_sql "$statement" \
  | jq -e '
      [.result.data_array[] | {
        name: .[0],
        passed_records: (.[1] | tonumber),
        failed_records: (.[2] | tonumber)
      }]
      | select(
          map(.name) == ["valid_customer", "valid_franchise", "valid_quantity"]
          and all(.[]; (.passed_records | type) == "number")
          and all(.[]; (.failed_records | type) == "number")
        )'
```

Expected: `valid_customer`, `valid_franchise`, and `valid_quantity`, each with numeric pass and fail counters.
An empty result fails the check.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| Auth precheck is blocked or targets mismatch | Required auth value is missing or the profile reaches another workspace | Apply the auth remediation table and stop until all checks pass |
| Source inspection returns permission denied | The deployment principal cannot read `samples.bakehouse` | Grant `USE CATALOG`, `USE SCHEMA`, and `SELECT` on the source |
| Deploy reports a missing catalog or schema | The target catalog, `bakehouse_bronze`, or `bakehouse_silver` does not exist | Create the missing governed namespace before deploying |
| Source inspection omits a required column | Bakehouse source column spelling drifted | Update expectations only after confirming the replacement column with the human |
| Pipeline code contains legacy decorators | The source imports the legacy `dlt` module | Migrate to `from pyspark import pipelines as dp` |
| A batch source fails validation as a stream | The source uses a streaming read | Use materialized views with `spark.read.table` |
| Pipeline remains `INITIALIZING` for several minutes | Normal serverless cold start | Wait for the update and do not cancel it |
| Polling reports an idle pipeline before work completes | The check polls top-level pipeline state | Poll the active update or use the blocking bundle run |
| Expectation query returns no rows | Expectations did not attach or no flow progress event contains metrics | Inspect the update event log and fix the decorators before continuing |

## Next

- **Manual fallback:** [Starter Journey: build the first pipeline](https://databricks-solutions.github.io/starter-journey/docs/07-build-first-pipeline/)
- **Reference:** [Lakeflow Spark Declarative Pipelines](https://docs.databricks.com/aws/en/ldp/)
