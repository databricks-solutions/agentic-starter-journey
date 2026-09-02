---
description: Create, publish, and verify the Bakehouse Franchise Performance dashboard from the governed metric view.
---

# Dashboards

## Mental Model

An AI/BI dashboard is a native DABs resource backed by a serialized `.lvdash.json` definition.
This page consumes the successful [Metric Views](/docs/02-databricks-projects/metric-views/) outcome.
Dataset SQL remains portable by using bare `franchise_sales_metrics` and putting the catalog and schema on the native resource.
In development mode, validation can prefix the configured display name, so the resource YAML proves the configured name and bundle summary supplies the effective name used by Lakeview APIs.

## Goal

Create and publish `Bakehouse Franchise Performance`.
Produce three KPI counters, one daily sales line chart, and two horizontal bar charts.
Prove every local and deployed dataset with executable structure, row, order, and value assertions.

## Prerequisites

- Auth surface: `workspace`.
- Complete the [Metric Views](/docs/02-databricks-projects/metric-views/) outcome.
- Use an existing bundle with a `dev` target, `${var.catalog}`, `${var.warehouse_id}`, `resources/*.yml`, and the live `bakehouse_gold.franchise_sales_metrics` metric view.
- Confirm the principal can use the warehouse, query the metric view, and create and publish dashboards.
- Install Databricks CLI v1.1.0 or newer.

## Skill

Read these verified upstream skills in this order after the auth precheck passes:

1. [`databricks-core`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-core).
2. [`databricks-aibi-dashboards`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-aibi-dashboards).
3. [`databricks-dabs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-dabs).

Test every SQL statement before deployment.

## Inputs

| Input | Source | How to obtain |
|---|---|---|
| Databricks account ID | Human-provided | Use the account ID named for this deployment |
| Workspace ID | Human-provided | Use the workspace ID named for this deployment |
| Workspace host | Human-provided | Use the named workspace URL |
| Workspace CLI profile | Human-provided | Use the named profile for the target workspace |
| Existing project path | Human-provided | Use the existing bundle project completed on the Metric Views page |
| Target catalog | Agent-derived | Read the active bundle target's `catalog` variable |
| SQL warehouse ID | Agent-derived | Read the active bundle target's `warehouse_id` variable |

## Run

Run every shell block in Run and Verify in the same Bash shell so resolved variables, helper functions, and fail-closed shell options persist.

### 0. Verify auth and active-target inputs

Require every human-provided input and fail closed if the profile reaches another target:

```bash
set -euo pipefail

: "${DATABRICKS_ACCOUNT_ID:?set the human-provided Databricks account ID}"
: "${DATABRICKS_WORKSPACE_ID:?set the human-provided workspace ID}"
: "${DATABRICKS_HOST:?set the human-provided workspace host}"
: "${DATABRICKS_CONFIG_PROFILE:?set the human-provided workspace CLI profile}"
: "${BAKEHOUSE_PROJECT_PATH:?set the human-provided existing bundle project path}"

cd "$BAKEHOUSE_PROJECT_PATH"

auth_target=$(
  databricks auth describe --profile "$DATABRICKS_CONFIG_PROFILE" -o json \
  | jq -ce \
      --arg account_id "$DATABRICKS_ACCOUNT_ID" \
      --arg workspace_id "$DATABRICKS_WORKSPACE_ID" \
      --arg host "$DATABRICKS_HOST" '
        {
          host: (.host // .details.host // .details.configuration.host.value),
          account_id: (.account_id // .details.configuration.account_id.value),
          workspace_id: (.workspace_id // .details.configuration.workspace_id.value)
        }
        | select(
            .host == $host
            and .account_id == $account_id
            and (.workspace_id | tostring) == $workspace_id
          )'
) || {
  printf '%s\n' 'blocked: auth preflight failed' >&2
  exit 1
}

printf '%s\n' "$auth_target"

databricks current-user me --profile "$DATABRICKS_CONFIG_PROFILE" -o json \
  | jq -e 'select(.active == true and .id != null and .userName != null)'

bundle_json=$(
  databricks bundle validate \
    --strict \
    --target dev \
    --profile "$DATABRICKS_CONFIG_PROFILE" \
    -o json
)

catalog=$(jq -er '.variables.catalog.value' <<<"$bundle_json")
warehouse_id=$(jq -er '.variables.warehouse_id.value' <<<"$bundle_json")
test -n "$catalog"
test -n "$warehouse_id"
dataset_schema=bakehouse_gold
```

Expected: auth matches every human-provided target, strict validation succeeds, and catalog and warehouse are read from the active bundle target.
Do not select another profile, catalog, warehouse, or project path after a mismatch.

### 1. Define dataset execution and assertions

Use one stable Statement Execution API helper for both source and deployed datasets:

```bash
run_sql() {
  local statement=$1 response statement_id state

  response=$(
    databricks api post /api/2.0/sql/statements \
      --profile "$DATABRICKS_CONFIG_PROFILE" \
      --json "$(jq -n \
        --arg warehouse_id "$warehouse_id" \
        --arg catalog "$catalog" \
        --arg schema "$dataset_schema" \
        --arg statement "$statement" \
        '{
          warehouse_id: $warehouse_id,
          catalog: $catalog,
          schema: $schema,
          statement: $statement,
          wait_timeout: "0s"
        }')"
  ) || return

  statement_id=$(jq -er '.statement_id' <<<"$response") || return

  while :; do
    state=$(jq -er '.status.state' <<<"$response") || return
    case "$state" in
      SUCCEEDED)
        jq -e '.status.state == "SUCCEEDED" and .result.data_array != null' <<<"$response" >/dev/null || return
        printf '%s\n' "$response"
        return
        ;;
      PENDING|RUNNING)
        sleep 5
        response=$(
          databricks api get "/api/2.0/sql/statements/$statement_id" \
            --profile "$DATABRICKS_CONFIG_PROFILE"
        ) || return
        ;;
      *)
        jq -c '.status.error // .status' <<<"$response" >&2
        return 1
        ;;
    esac
  done
}

dataset_sql() {
  local dashboard_file=$1 dataset_name=$2
  jq -er \
    --arg dataset_name "$dataset_name" '
      [.datasets[] | select(.name == $dataset_name) | .queryLines[]]
      | select(length > 0)
      | join("")' \
    "$dashboard_file"
}

assert_kpis() {
  jq -e '
    [.manifest.schema.columns[].name] == [
      "total_sales",
      "order_count",
      "avg_order_value"
    ]
    and (.manifest.total_row_count == 1)
    and (.result.data_array | length == 1)
    and (
      .result.data_array[0] | map(tonumber)
      | .[0] == 66471
      and .[1] == 3333
      and .[2] == 19.943294329432945
      and ((.[0] - (.[1] * .[2])) > -0.01)
      and ((.[0] - (.[1] * .[2])) < 0.01)
    )'
}

assert_sales_trend() {
  jq -e '
    [.manifest.schema.columns[].name] == ["sales_date", "total_sales"]
    and (.manifest.total_row_count == 17)
    and (.result.data_array | length == 17)
    and (
      .result.data_array as $rows
      | ([$rows[][0]] == ([$rows[][0]] | sort))
      and ($rows[0] == ["2024-05-01", "4128"])
      and ($rows[-1] == ["2024-05-17", "1932"])
      and ([$rows[][1] | tonumber] | add == 66471)
      and all($rows[]; (.[0] | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")) and (.[1] | tonumber) > 0)
    )'
}

assert_franchises() {
  jq -e '
    [.manifest.schema.columns[].name] == ["franchise", "total_sales"]
    and (.manifest.total_row_count == 10)
    and (.result.data_array | length == 10)
    and (.result.data_array[0] == ["Baked Bliss", "6642"])
    and (
      .result.data_array as $rows
      | ([$rows[][1] | tonumber] == ([$rows[][1] | tonumber] | sort | reverse))
      and all($rows[]; (.[0] | type == "string" and length > 0) and (.[1] | tonumber) > 0)
    )'
}

assert_products() {
  jq -e '
    [.manifest.schema.columns[].name] == ["product", "total_sales"]
    and (.manifest.total_row_count == 6)
    and (.result.data_array | length == 6)
    and (.result.data_array[0] == ["Golden Gate Ginger", "11595"])
    and (
      .result.data_array as $rows
      | ([$rows[][1] | tonumber] == ([$rows[][1] | tonumber] | sort | reverse))
      and all($rows[]; (.[0] | type == "string" and length > 0) and (.[1] | tonumber) > 0)
    )'
}

assert_all_datasets() {
  local dashboard_file=$1 sql

  sql=$(dataset_sql "$dashboard_file" ds_kpis) || return
  run_sql "$sql" | assert_kpis || return

  sql=$(dataset_sql "$dashboard_file" ds_sales_trend) || return
  run_sql "$sql" | assert_sales_trend || return

  sql=$(dataset_sql "$dashboard_file" ds_franchises) || return
  run_sql "$sql" | assert_franchises || return

  sql=$(dataset_sql "$dashboard_file" ds_products) || return
  run_sql "$sql" | assert_products || return
}
```

Every request uses the same active-target warehouse, catalog, and `bakehouse_gold` schema.
If the source data changes, stop and obtain human approval before changing the locked values.

### 2. Create the dashboard source

Create `src/bakehouse_franchise_performance.lvdash.json` with this complete definition:

```json
{"datasets":[{"name":"ds_kpis","displayName":"Franchise performance KPIs","queryLines":["SELECT MEASURE(total_sales) AS total_sales,\n","       MEASURE(order_count) AS order_count,\n","       MEASURE(avg_order_value) AS avg_order_value\n","FROM franchise_sales_metrics "]},{"name":"ds_sales_trend","displayName":"Daily sales trend","queryLines":["SELECT sales_date, MEASURE(total_sales) AS total_sales\n","FROM franchise_sales_metrics\n","GROUP BY sales_date\n","ORDER BY sales_date "]},{"name":"ds_franchises","displayName":"Top franchises","queryLines":["SELECT franchise, MEASURE(total_sales) AS total_sales\n","FROM franchise_sales_metrics\n","GROUP BY franchise\n","ORDER BY total_sales DESC\n","LIMIT 10 "]},{"name":"ds_products","displayName":"Top products","queryLines":["SELECT product, MEASURE(total_sales) AS total_sales\n","FROM franchise_sales_metrics\n","GROUP BY product\n","ORDER BY total_sales DESC\n","LIMIT 10 "]}],"pages":[{"name":"overview","displayName":"Overview","pageType":"PAGE_TYPE_CANVAS","layoutVersion":"GRID_V1","layout":[{"widget":{"name":"dashboard-title","multilineTextboxSpec":{"lines":["# Bakehouse Franchise Performance"]}},"position":{"x":0,"y":0,"width":12,"height":1}},{"widget":{"name":"dashboard-subtitle","multilineTextboxSpec":{"lines":["Daily sales, order volume, and product performance across the Bakehouse franchise network."]}},"position":{"x":0,"y":1,"width":12,"height":1}},{"widget":{"name":"total-sales-kpi","queries":[{"name":"main_query","query":{"datasetName":"ds_kpis","fields":[{"name":"total_sales","expression":"`total_sales`"}],"disaggregated":true}}],"spec":{"version":2,"widgetType":"counter","encodings":{"value":{"fieldName":"total_sales","displayName":"Total Sales","format":{"type":"number-plain","abbreviation":"compact","decimalPlaces":{"type":"max","places":2}}}},"frame":{"showTitle":true,"title":"Total Sales"}}},"position":{"x":0,"y":2,"width":4,"height":3}},{"widget":{"name":"order-count-kpi","queries":[{"name":"main_query","query":{"datasetName":"ds_kpis","fields":[{"name":"order_count","expression":"`order_count`"}],"disaggregated":true}}],"spec":{"version":2,"widgetType":"counter","encodings":{"value":{"fieldName":"order_count","displayName":"Order Count","format":{"type":"number-plain","decimalPlaces":{"type":"exact","places":0}}}},"frame":{"showTitle":true,"title":"Order Count"}}},"position":{"x":4,"y":2,"width":4,"height":3}},{"widget":{"name":"average-order-value-kpi","queries":[{"name":"main_query","query":{"datasetName":"ds_kpis","fields":[{"name":"avg_order_value","expression":"`avg_order_value`"}],"disaggregated":true}}],"spec":{"version":2,"widgetType":"counter","encodings":{"value":{"fieldName":"avg_order_value","displayName":"Average Order Value","format":{"type":"number-plain","decimalPlaces":{"type":"exact","places":2}}}},"frame":{"showTitle":true,"title":"Average Order Value"}}},"position":{"x":8,"y":2,"width":4,"height":3}},{"widget":{"name":"daily-sales-trend","queries":[{"name":"main_query","query":{"datasetName":"ds_sales_trend","fields":[{"name":"sales_date","expression":"`sales_date`"},{"name":"total_sales","expression":"`total_sales`"}],"disaggregated":true}}],"spec":{"version":3,"widgetType":"line","encodings":{"x":{"fieldName":"sales_date","displayName":"Sales Date","scale":{"type":"temporal"}},"y":{"fieldName":"total_sales","displayName":"Total Sales","scale":{"type":"quantitative","domainMin":0},"format":{"type":"number","abbreviation":"compact","decimalPlaces":{"type":"max","places":2}}}},"frame":{"showTitle":true,"title":"Daily Sales Trend","showDescription":true,"description":"Total sales by calendar day."}}},"position":{"x":0,"y":5,"width":12,"height":6}},{"widget":{"name":"top-franchises","queries":[{"name":"main_query","query":{"datasetName":"ds_franchises","fields":[{"name":"franchise","expression":"`franchise`"},{"name":"total_sales","expression":"`total_sales`"}],"disaggregated":true}}],"spec":{"version":3,"widgetType":"bar","encodings":{"x":{"fieldName":"total_sales","displayName":"Total Sales","scale":{"type":"quantitative","domainMin":0},"format":{"type":"number","abbreviation":"compact","decimalPlaces":{"type":"max","places":2}}},"y":{"fieldName":"franchise","displayName":"Franchise","scale":{"type":"categorical"}}},"frame":{"showTitle":true,"title":"Top Franchises","showDescription":true,"description":"Ten franchises with the highest total sales."}}},"position":{"x":0,"y":11,"width":6,"height":6}},{"widget":{"name":"top-products","queries":[{"name":"main_query","query":{"datasetName":"ds_products","fields":[{"name":"product","expression":"`product`"},{"name":"total_sales","expression":"`total_sales`"}],"disaggregated":true}}],"spec":{"version":3,"widgetType":"bar","encodings":{"x":{"fieldName":"total_sales","displayName":"Total Sales","scale":{"type":"quantitative","domainMin":0},"format":{"type":"number","abbreviation":"compact","decimalPlaces":{"type":"max","places":2}}},"y":{"fieldName":"product","displayName":"Product","scale":{"type":"categorical"}}},"frame":{"showTitle":true,"title":"Top Products","showDescription":true,"description":"Products ranked by total sales."}}},"position":{"x":6,"y":11,"width":6,"height":6}}]}],"uiSettings":{"theme":{"canvasBackgroundColor":{"light":"#F5F7FA","dark":"#111827"},"widgetBackgroundColor":{"light":"#FFFFFF","dark":"#1F2937"},"widgetBorderColor":{"light":"#FFFFFF","dark":"#1F2937"},"fontColor":{"light":"#172033","dark":"#F3F4F6"},"selectionColor":{"light":"#0072B2","dark":"#56B4E9"},"visualizationColors":["#0072B2","#E69F00","#009E73","#CC79A7","#D55E00","#56B4E9"],"widgetHeaderAlignment":"LEFT","fontFamily":"Inter","widgetCornerRadius":8}}}
```

Parse the source and execute all four exact queries before deployment:

```bash
dashboard_file=src/bakehouse_franchise_performance.lvdash.json
jq -e '.' "$dashboard_file" >/dev/null
assert_all_datasets "$dashboard_file" >/dev/null
printf '%s\n' 'local_datasets=passed kpis=66471,3333,19.943294329432945 trend=rows:17,first:2024-05-01:4128,last:2024-05-17:1932,total:66471 franchises=rows:10,leader:Baked Bliss:6642 products=rows:6,leader:Golden Gate Ginger:11595'
```

Expected: JSON parsing and all source dataset assertions succeed.

### 3. Create the native dashboard resource

Create `resources/bakehouse_franchise_performance.dashboard.yml`:

```yaml
resources:
  dashboards:
    bakehouse_franchise_performance:
      display_name: Bakehouse Franchise Performance
      file_path: ../src/bakehouse_franchise_performance.lvdash.json
      warehouse_id: ${var.warehouse_id}
      dataset_catalog: ${var.catalog}
      dataset_schema: bakehouse_gold
```

Strictly validate the local configuration:

```bash
databricks bundle validate \
  --strict \
  --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" \
  -o json >/dev/null

resource_file=resources/bakehouse_franchise_performance.dashboard.yml
rg -Fxq '      display_name: Bakehouse Franchise Performance' "$resource_file"
configured_display_name='Bakehouse Franchise Performance'
```

Expected: strict validation succeeds and the source YAML contains the exact configured display name `Bakehouse Franchise Performance`.
Development presets are already applied in validation and summary output, so only the source YAML proves the unprefixed configured value.

### 4. Deploy and publish

Deploy, resolve the dashboard ID only through bundle summary, and publish with positional CLI syntax:

```bash
pre_deploy_summary=$(
  databricks bundle summary \
    --target dev \
    --profile "$DATABRICKS_CONFIG_PROFILE" \
    -o json
)

pre_existing_dashboard_id=$(
  jq -r '
    .resources.dashboards.bakehouse_franchise_performance.id
    // empty
    | tostring' \
    <<<"$pre_deploy_summary"
)

databricks bundle deploy \
  --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" \
  --auto-approve

summary=$(
  databricks bundle summary \
    --target dev \
    --profile "$DATABRICKS_CONFIG_PROFILE" \
    -o json
)

jq -e \
  --arg catalog "$catalog" \
  --arg warehouse_id "$warehouse_id" '
    .resources.dashboards.bakehouse_franchise_performance
    | .id != null
    and (.id | tostring | length > 0)
    and (.url | type == "string" and length > 0)
    and .warehouse_id == $warehouse_id
    and .dataset_catalog == $catalog
    and .dataset_schema == "bakehouse_gold"' \
  <<<"$summary" >/dev/null

dashboard_id=$(
  jq -er '
    .resources.dashboards.bakehouse_franchise_performance.id
    | tostring
    | select(length > 0)' \
    <<<"$summary"
)

dashboard_url=$(
  jq -er '.resources.dashboards.bakehouse_franchise_performance.url' \
    <<<"$summary"
)

effective_display_name=$(
  jq -er '
    .resources.dashboards.bakehouse_franchise_performance.display_name
    | select(type == "string" and length > 0)
    | select(endswith("Bakehouse Franchise Performance"))' \
    <<<"$summary"
)

if test -n "$pre_existing_dashboard_id"
then
  test "$pre_existing_dashboard_id" = "$dashboard_id"
fi

dashboards=$(
  databricks lakeview list \
    --profile "$DATABRICKS_CONFIG_PROFILE" \
    -o json
)

jq -e \
  --arg configured_display_name "$configured_display_name" \
  --arg dashboard_id "$dashboard_id" '
    [.[] | select((.display_name? // "") | endswith($configured_display_name))]
    | length == 1
    and .[0].dashboard_id == $dashboard_id' \
  <<<"$dashboards" >/dev/null

printf 'configured_display_name=%s\neffective_display_name=%s\ndashboard_url=%s\n' \
  "$configured_display_name" "$effective_display_name" "$dashboard_url"
printf 'bundle_summary_and_duplicate=passed pre_existing_dashboard_id=%s deployed_dashboard_id=%s matching_dashboards=1 duplicate_dashboards=0\n' \
  "$pre_existing_dashboard_id" "$dashboard_id"

published_after_publish=$(
  databricks lakeview publish "$dashboard_id" \
    --warehouse-id "$warehouse_id" \
    --profile "$DATABRICKS_CONFIG_PROFILE" \
    -o json
)

jq -e \
  --arg effective_display_name "$effective_display_name" \
  --arg warehouse_id "$warehouse_id" '
    .display_name == $effective_display_name
    and .warehouse_id == $warehouse_id
    and (.revision_create_time | type == "string" and length > 0)' \
  <<<"$published_after_publish" >/dev/null

printf '%s\n' 'publish=passed'
```

Expected: deployment succeeds, summary returns one nonempty dashboard ID and URL, the effective name is nonempty and ends with `Bakehouse Franchise Performance`, exactly one matching dashboard has the bundle-summary ID, and publish returns that effective name, the warehouse, and a revision timestamp.
The pre-existing ID may be empty on first creation, but a nonempty value must equal the deployed ID.
The list assertion detects duplicate or orphaned dashboards.

## Verify

Retrieve and assert the draft and published objects with positional IDs:

```bash
draft=$(
  databricks lakeview get "$dashboard_id" \
    --profile "$DATABRICKS_CONFIG_PROFILE" \
    -o json
)

published=$(
  databricks lakeview get-published "$dashboard_id" \
    --profile "$DATABRICKS_CONFIG_PROFILE" \
    -o json
)

jq -e \
  --arg dashboard_id "$dashboard_id" \
  --arg effective_display_name "$effective_display_name" \
  --arg warehouse_id "$warehouse_id" '
    .dashboard_id == $dashboard_id
    and .display_name == $effective_display_name
    and .warehouse_id == $warehouse_id
    and (.serialized_dashboard | type == "string" and length > 0)' \
  <<<"$draft" >/dev/null

jq -e \
  --arg effective_display_name "$effective_display_name" \
  --arg warehouse_id "$warehouse_id" '
    .display_name == $effective_display_name
    and .warehouse_id == $warehouse_id
    and (.revision_create_time | type == "string" and length > 0)' \
  <<<"$published" >/dev/null

printf '%s\n' 'draft_and_published=passed'
```

Expected: bundle summary proves the requested namespace, draft metadata and serialized content use the effective deployed name, and the published object has that name, the warehouse, and a revision timestamp.

Extract and assert the deployed serialized dashboard:

```bash
deployed_dashboard=$(mktemp)
trap 'rm -f "$deployed_dashboard"' EXIT

jq -er '.serialized_dashboard | fromjson' <<<"$draft" >"$deployed_dashboard"

jq -e --slurpfile source src/bakehouse_franchise_performance.lvdash.json '. == $source[0]' "$deployed_dashboard" >/dev/null
printf '%s\n' 'deployed_structure_and_theme=passed'
```

Expected: the deployed serialization exactly equals the source contract.

Execute the deployed queries through the same API assertions:

```bash
assert_all_datasets "$deployed_dashboard" >/dev/null
printf '%s\n' 'deployed_datasets=passed kpis=66471,3333,19.943294329432945 trend=rows:17,first:2024-05-01:4128,last:2024-05-17:1932,total:66471 franchises=rows:10,leader:Baked Bliss:6642 products=rows:6,leader:Golden Gate Ginger:11595'
```

Expected: all four deployed datasets satisfy the same row and value assertions as the source.
No visual inspection may substitute for these executable checks.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| Auth precheck fails or target values mismatch | A required input is missing or the profile reaches another target | Reauthenticate the named profile against the named host and repeat the full precheck |
| `catalog` or `warehouse_id` extraction fails | The active `dev` target does not define both variables | Add the missing target values, strictly validate, and rerun extraction |
| Dataset SQL reports a missing metric view or unsupported function | The governed metric view is absent or the warehouse is incompatible | Complete Metric Views and use a compatible warehouse before continuing |
| A dashboard query resolves the wrong namespace | A `queryLines` statement qualifies `franchise_sales_metrics` | Restore the bare table name and keep namespace values on the resource |
| Statement execution resolves the wrong namespace | The API payload omits `catalog` or `schema` | Pass the active-target catalog and `bakehouse_gold` in every request |
| A local dataset assertion fails | Source data, SQL, columns, rows, ordering, or values drifted | Stop and reconcile the source contract before deployment |
| SQL contains merged tokens or swallowed lines | A `queryLines` fragment lacks a trailing space or newline | Restore the exact locked fragments and rerun all source assertions |
| A widget is invalid | A counter is not version 2 or a line or bar is not version 3 | Restore the exact widget versions |
| A widget has no selected fields | A query field name differs from its encoding field name | Restore the exact locked field bindings |
| Strict bundle validation fails | The native resource is malformed or its source path is wrong | Restore the exact resource and the `../src` path |
| Configured display-name assertion fails | The source YAML does not contain the exact `display_name: Bakehouse Franchise Performance` line | Restore the exact configured line in `resources/bakehouse_franchise_performance.dashboard.yml` and rerun its `rg -Fxq` assertion |
| Validation reports an unexpected display-name prefix | The active development preset differs from the expected target configuration | Inspect the validation output and target preset, keep the source YAML unprefixed, and use bundle summary as the authority for the effective Lakeview API name |
| Effective display-name extraction fails | The deployed development name is empty or does not retain the configured name as its suffix | Inspect the target presets and require an effective name ending with `Bakehouse Franchise Performance` |
| Dashboard ID extraction fails | Bundle summary lacks the exact resource key | Inspect deployment output and restore `bakehouse_franchise_performance` |
| Dashboard identity-retention assertion fails | Deployment replaced an existing bundle-managed dashboard with a new ID | Stop and reconcile bundle state so updates retain the pre-existing dashboard ID |
| Duplicate-dashboard assertion fails | More than one dashboard ends with the configured name or the only match has another ID | Use bundle summary to identify the bundle-owned dashboard, reconcile only dashboards whose ownership is proven, leave unproven suffix matches unchanged, and require the sole suffix match to equal the bundle-summary ID |
| Publish, draft GET, or published GET returns another display name | Lakeview state is stale or the response was compared with the configured name instead of the effective name | Refresh bundle summary, derive `effective_display_name` again, and require publish, get, and get-published to return that exact value before continuing |
| Publish fails or the published check fails | The principal cannot publish, the warehouse is wrong, or no published revision exists | Correct permission or warehouse access, republish the positional ID, and repeat both checks |
| Deployed structure assertion fails | Server serialization or the deployed source differs from the locked contract | Compare the extracted object with the source, correct the source, and redeploy |
| Deployed dataset assertion fails | Deployed SQL or source values differ from the verified local contract | Stop and reconcile the extracted queries and metric-view data |
| Bundle deployment reports drift after UI edits | The workspace draft was changed outside the bundle | Treat the committed source as authoritative and redeploy it through the bundle |

## Next

- **Back to section:** [Databricks Projects](/docs/02-databricks-projects/)
- **Reference:** [AI/BI dashboards](https://docs.databricks.com/aws/en/dashboards/)
- **Reference:** [Dashboard catalog and schema parameterization](https://docs.databricks.com/aws/en/dev-tools/bundles/examples#dashboard-catalog-and-schema-parameterization)
