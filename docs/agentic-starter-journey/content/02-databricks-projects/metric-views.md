---
description: Add the governed Bakehouse franchise_sales_metrics metric view to the existing bundle and reconcile every measure against raw SQL.
---

# Metric Views

## Mental Model

A metric view stores governed semantic YAML and computes measures at query time instead of storing pre-aggregated rows.
This page consumes the successful Spark Declarative Pipelines outcome in `bakehouse_silver`.
Metric views are not native bundle resource types.
The existing bundle deploys committed metric-view DDL through an unscheduled SQL job.

## Goal

Create `<catalog>.bakehouse_gold.franchise_sales_metrics` from `bakehouse_silver.transactions_clean` joined to `bakehouse_silver.franchises_clean`.
Expose `franchise`, `sales_date`, and `product` dimensions and `total_sales`, `order_count`, and `avg_order_value` measures.
Reconcile every semantic aggregate against equivalent raw SQL.

## Prerequisites

- Auth surface: `workspace`.
- Complete the [Spark Declarative Pipelines](/docs/02-databricks-projects/etl-pipelines/) outcome.
- Use an existing bundle project with a `dev` target.
- Confirm the deployment principal can read both Bakehouse silver materialized views and create the `bakehouse_gold` schema and metric view.
- Use a running SQL warehouse that supports metric views and that the deployment principal can use.

## Skill

Read these verified upstream skills in this order, but invoke them only after the auth precheck passes:

1. [`databricks-core`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-core).
2. [`databricks-metric-views`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-metric-views).
3. [`databricks-dbsql`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-dbsql).
4. [`databricks-jobs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-jobs).
5. [`databricks-dabs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-dabs).

## Inputs

| Input | Source | How to obtain |
|---|---|---|
| Databricks account ID | Human-provided | Use the account ID named for this deployment |
| Workspace ID | Human-provided | Use the workspace ID named for this deployment |
| Workspace host | Human-provided | Use the named `https://<deployment>.cloud.databricks.com` host |
| Workspace CLI profile | Human-provided | Use the named profile for the target workspace |
| Existing project path | Human-provided | Use the bundle project completed on the Project repo page |
| Target catalog | Agent-derived | Read the existing bundle target's `catalog` variable |
| SQL warehouse ID | Agent-derived | Select a running compatible warehouse available to the deployment principal |

## Run

### 0. Verify the auth target

Refuse to continue if the human has not provided the account ID, workspace ID, workspace host, workspace CLI profile, and existing project path.

```bash
databricks auth profiles

auth_target=$(
  databricks auth describe --profile <workspace-profile> -o json \
    | jq -ce '{
        host: (.host // .details.host),
        account_id: (.account_id // .details.configuration.account_id.value),
        workspace_id: (.workspace_id // .details.configuration.workspace_id.value)
      }
      | select(
          .host != null
          and .account_id != null
          and .workspace_id != null
          and .host == "<workspace-host>"
          and .account_id == "<databricks-account-id>"
          and (.workspace_id | tostring) == "<workspace-id>"
        )'
) || {
  printf '%s\n' 'blocked: auth preflight failed' >&2
  exit 1
}

printf '%s\n' "$auth_target"

databricks current-user me --profile <workspace-profile> -o json \
  | jq -e '{id, userName}'
```

Expected: the profile is valid, the projection contains no null values, every projected target equals the human-provided value, and `current-user me` succeeds.
If the projection fails, inspect the raw `auth describe` response.
Use only the already collected workspace profile and host to remediate with `databricks auth login --host <workspace-host> --profile <workspace-profile>`.
Do not select another profile or infer replacement account, workspace, or host values.
Invoke the five skills in the listed order only after every check passes.

### 1. Verify the silver sources

Change to the existing project path.
Define one helper that safely passes arbitrary SQL to the stable Statement Execution API, polls its statement ID, prints only successful results, and fails on every terminal error state:

```bash
cd <existing-project-path>

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

Verify the required columns in both source schemas:

```bash
statement=$(cat <<'SQL'
SELECT table_name, column_name
FROM <catalog>.information_schema.columns
WHERE table_schema = 'bakehouse_silver'
  AND (
    (table_name = 'transactions_clean'
      AND column_name IN ('franchiseID', 'dateTime', 'product', 'totalPrice'))
    OR
    (table_name = 'franchises_clean'
      AND column_name IN ('franchiseID', 'name'))
  )
ORDER BY table_name, column_name
SQL
)

run_sql "$statement" \
  | jq -e '
      [.result.data_array[] | {table: .[0], column: .[1]}]
      | group_by(.table)
      | map({
          key: .[0].table,
          value: (map(.column) | sort)
        })
      | from_entries
      | select(
          .transactions_clean == ["dateTime", "franchiseID", "product", "totalPrice"]
          and .franchises_clean == ["franchiseID", "name"]
        )'
```

Expected: `transactions_clean` contains `franchiseID`, `dateTime`, `product`, and `totalPrice`, and `franchises_clean` contains `franchiseID` and `name`.

Verify that each franchise key is non-null and unique:

```bash
statement=$(cat <<'SQL'
SELECT count(*) AS invalid_franchise_keys
FROM (
  SELECT franchiseID
  FROM <catalog>.bakehouse_silver.franchises_clean
  GROUP BY franchiseID
  HAVING franchiseID IS NULL OR count(*) <> 1
)
SQL
)

run_sql "$statement" \
  | jq -e '.result.data_array[0][0] | tonumber | select(. == 0)'
```

Expected: `0`.

Verify that every transaction matches a franchise:

```bash
statement=$(cat <<'SQL'
SELECT count(*) AS unmatched_transactions
FROM <catalog>.bakehouse_silver.transactions_clean t
LEFT ANTI JOIN <catalog>.bakehouse_silver.franchises_clean f
  ON t.franchiseID = f.franchiseID
SQL
)

run_sql "$statement" \
  | jq -e '.result.data_array[0][0] | tonumber | select(. == 0)'
```

Expected: `0`.
Stop before writing or deploying DDL if any source check fails.

### 2. Add the metric-view SQL

Create `src/bakehouse_franchise_sales_metrics.metric_view.sql`:

```sql
CREATE SCHEMA IF NOT EXISTS IDENTIFIER({{catalog}} || '.bakehouse_gold');
USE CATALOG IDENTIFIER({{catalog}});
USE SCHEMA bakehouse_gold;

DECLARE OR REPLACE VARIABLE metric_view_ddl STRING DEFAULT
'CREATE OR REPLACE VIEW franchise_sales_metrics
WITH METRICS
LANGUAGE YAML
AS $$
version: 1.1
comment: Governed Bakehouse franchise sales metrics.
source: ' || current_catalog() || '.bakehouse_silver.transactions_clean

joins:
  - name: franchise_details
    source: ' || current_catalog() || '.bakehouse_silver.franchises_clean
    on: source.franchiseID = franchise_details.franchiseID

dimensions:
  - name: franchise
    expr: franchise_details.name
    comment: Franchise display name.
  - name: sales_date
    expr: DATE(source.dateTime)
    comment: Calendar date of the sale.
  - name: product
    expr: source.product
    comment: Sold Bakehouse product.

measures:
  - name: total_sales
    expr: SUM(source.totalPrice)
    comment: Total sales value.
  - name: order_count
    expr: COUNT(1)
    comment: Number of sales transactions.
  - name: avg_order_value
    expr: AVG(source.totalPrice)
    comment: Average value per transaction.
$$';

EXECUTE IMMEDIATE metric_view_ddl;
```

### 3. Add the unscheduled SQL job

Create `resources/bakehouse_franchise_sales_metrics.job.yml`:

```yaml
resources:
  jobs:
    bakehouse_franchise_sales_metrics:
      name: bakehouse_franchise_sales_metrics
      description: Creates or refreshes the Bakehouse franchise sales metric view.
      parameters:
        - name: catalog
          default: ${var.catalog}
      tasks:
        - task_key: create_metric_view
          sql_task:
            warehouse_id: ${var.warehouse_id}
            file:
              path: ../src/bakehouse_franchise_sales_metrics.metric_view.sql
```

Do not add a schedule or trigger.
Integrate the resource into the existing bundle with these definitions:

```yaml
include:
  - resources/*.yml

variables:
  catalog:
    description: Unity Catalog catalog for the Bakehouse project.
  warehouse_id:
    description: SQL warehouse ID used to create and verify the metric view.
```

Merge only missing definitions into the existing `databricks.yml`.
Do not replace the existing bundle configuration.
Set target-specific `catalog` and `warehouse_id` values through the bundle's existing target structure.

### 4. Deploy and run

Run from the existing project repository:

```bash
databricks bundle validate --strict --target dev --profile <workspace-profile>
databricks bundle deploy --target dev --profile <workspace-profile>

run_id=$(databricks bundle run bakehouse_franchise_sales_metrics \
  --target dev \
  --profile <workspace-profile> \
  --no-wait \
  -o json | jq -er '.run_id')
```

Poll that exact run until it terminates:

```bash
while :; do
  run=$(databricks jobs get-run \
    --run-id "$run_id" \
    --profile <workspace-profile> \
    -o json) || exit 1
  life_cycle_state=$(jq -er '.state.life_cycle_state' <<<"$run") || exit 1
  result_state=$(jq -r '.state.result_state // empty' <<<"$run") || exit 1
  state_message=$(jq -r '.state.state_message // empty' <<<"$run") || exit 1
  printf 'run=%s lifecycle=%s result=%s message=%s\n' \
    "$run_id" "$life_cycle_state" "$result_state" "$state_message"

  case "$life_cycle_state" in
    TERMINATED)
      test "$result_state" = SUCCESS || exit 1
      break
      ;;
    INTERNAL_ERROR|SKIPPED)
      exit 1
      ;;
    PENDING|RUNNING|TERMINATING|BLOCKED|WAITING_FOR_RETRY|QUEUED)
      sleep 15
      ;;
    *)
      exit 1
      ;;
  esac
done
```

Expected: the exact captured run reaches `TERMINATED` with result state `SUCCESS`.
Internal errors, skipped runs, and every other terminal outcome fail the check.

## Verify

Query all dimensions and measures:

```bash
statement=$(cat <<'SQL'
SELECT
  franchise,
  sales_date,
  product,
  MEASURE(total_sales) AS total_sales,
  MEASURE(order_count) AS order_count,
  MEASURE(avg_order_value) AS avg_order_value
FROM <catalog>.bakehouse_gold.franchise_sales_metrics
GROUP BY ALL
SQL
)

run_sql "$statement" >/tmp/bakehouse-franchise-sales-metrics.json
```

Expected: at least one row, non-null dimensions, positive total sales and order count, and non-negative average order value.
Prove those conditions over the complete result:

```bash
statement=$(cat <<'SQL'
WITH metric AS (
  SELECT
    franchise,
    sales_date,
    product,
    MEASURE(total_sales) AS total_sales,
    MEASURE(order_count) AS order_count,
    MEASURE(avg_order_value) AS avg_order_value
  FROM <catalog>.bakehouse_gold.franchise_sales_metrics
  GROUP BY ALL
)
SELECT
  count(*) AS metric_rows,
  count_if(
    franchise IS NULL
    OR sales_date IS NULL
    OR product IS NULL
    OR total_sales IS NULL
    OR order_count IS NULL
    OR avg_order_value IS NULL
    OR total_sales <= 0
    OR order_count <= 0
    OR avg_order_value < 0
  ) AS invalid_rows
FROM metric
SQL
)

run_sql "$statement" \
  | jq -e '
      .result.data_array[0] | map(tonumber)
      | select(.[0] > 0 and .[1] == 0)'
```

Expected: `metric_rows` is greater than zero and `invalid_rows` is zero.

Reconcile every semantic aggregate against equivalent raw SQL:

```bash
statement=$(cat <<'SQL'
WITH metric AS (
  SELECT
    franchise,
    sales_date,
    product,
    MEASURE(total_sales) AS total_sales,
    MEASURE(order_count) AS order_count,
    MEASURE(avg_order_value) AS avg_order_value
  FROM <catalog>.bakehouse_gold.franchise_sales_metrics
  GROUP BY ALL
),
raw AS (
  SELECT
    f.name AS franchise,
    DATE(t.dateTime) AS sales_date,
    t.product,
    SUM(t.totalPrice) AS total_sales,
    COUNT(1) AS order_count,
    AVG(t.totalPrice) AS avg_order_value
  FROM <catalog>.bakehouse_silver.transactions_clean t
  JOIN <catalog>.bakehouse_silver.franchises_clean f
    ON t.franchiseID = f.franchiseID
  GROUP BY ALL
),
mismatches AS (
  SELECT
    coalesce(m.franchise, r.franchise) AS franchise,
    coalesce(m.sales_date, r.sales_date) AS sales_date,
    coalesce(m.product, r.product) AS product
  FROM metric m
  FULL OUTER JOIN raw r USING (franchise, sales_date, product)
  WHERE m.franchise IS NULL
     OR r.franchise IS NULL
     OR m.total_sales IS NULL
     OR r.total_sales IS NULL
     OR m.order_count IS NULL
     OR r.order_count IS NULL
     OR m.avg_order_value IS NULL
     OR r.avg_order_value IS NULL
     OR abs(m.total_sales - r.total_sales) > 0.01
     OR m.order_count <> r.order_count
     OR abs(m.avg_order_value - r.avg_order_value) > 0.01
)
SELECT
  (SELECT count(*) FROM metric) AS metric_rows,
  (SELECT count(*) FROM raw) AS raw_rows,
  count(*) AS mismatch_rows
FROM mismatches
SQL
)

run_sql "$statement" \
  | jq -e '
      .result.data_array
      | select(length == 1)
      | .[0]
      | map(tonumber)
      | select(.[0] > 0 and .[0] == .[1] and .[2] == 0)'
```

Expected: the aggregate query returns exactly one row, `metric_rows` is greater than zero, `metric_rows` equals `raw_rows`, and `mismatch_rows` is zero.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| Auth precheck is blocked or target values mismatch | A required value is missing or the profile reaches another target | Use the named profile and collected host for re-login, then repeat every auth check |
| Source schema assertion fails | A required silver column is missing or renamed | Stop and align the DDL with the confirmed pipeline contract |
| Franchise key check is nonzero | `franchises_clean.franchiseID` is null or duplicated | Repair the silver franchise key before creating the metric view |
| Anti join count is nonzero | Transactions reference franchises absent from `franchises_clean` | Repair the silver data or pipeline join contract before deployment |
| DDL returns a privilege error | The principal lacks source read or target namespace privileges | Grant `USE CATALOG`, `USE SCHEMA`, `SELECT`, and the required create privileges |
| SQL task cannot start | The warehouse is stopped, incompatible, or unavailable to the principal | Start a compatible warehouse and grant `CAN USE` |
| DDL contains unresolved `{{catalog}}` | The job parameter or bundle variable is missing | Restore the `catalog` job parameter and target variable |
| Job reaches a terminal non-success state | The SQL task failed, was skipped, or encountered an internal error | Inspect the exact captured run and repair its task error before retrying |
| Metric view creation rejects the YAML | The YAML version, join, dimension, or measure definition is invalid | Compare the committed DDL with the verified metric-view syntax and rerun the job |
| Reconciliation reports mismatches | The semantic and raw definitions differ or source data changed between queries | Stop downstream work, rerun on a stable source, and align the measure expressions |

## Next

- **Back to section:** [Databricks Projects](/docs/02-databricks-projects/)
- **Reference:** [Unity Catalog metric views](https://docs.databricks.com/metric-views/)
