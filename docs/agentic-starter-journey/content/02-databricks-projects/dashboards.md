---
description: Create, publish, and verify the Bakehouse Franchise Performance dashboard from the governed metric view.
---

# Dashboards

## Mental Model

An AI/BI dashboard is a native DABs resource backed by a serialized `.lvdash.json` definition.
This page consumes the successful [Metric Views](/docs/02-databricks-projects/metric-views/) outcome.
Dataset SQL remains portable by using bare `franchise_sales_metrics` and putting the catalog and schema on the native resource.

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
With strict mode active, any failed auth check, strict validation, dataset assertion, bundle-summary assertion, publish assertion, draft assertion, published assertion, deployed structure assertion, or deployed dataset assertion stops the workflow.

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
      and .[2] > 0
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
  set -o pipefail

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
assert_all_datasets "$dashboard_file"
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
databricks bundle deploy \
  --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE"

summary=$(
  databricks bundle summary \
    --target dev \
    --profile "$DATABRICKS_CONFIG_PROFILE" \
    -o json
)

jq -e \
  --arg catalog "$catalog" '
    .resources.dashboards.bakehouse_franchise_performance
    | .id != null
    and (.id | tostring | length > 0)
    and (.url | type == "string" and length > 0)
    and .dataset_catalog == $catalog
    and .dataset_schema == "bakehouse_gold"' \
  <<<"$summary"

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

printf 'configured_display_name=%s\neffective_display_name=%s\ndashboard_id=%s\ndashboard_url=%s\n' \
  "$configured_display_name" "$effective_display_name" "$dashboard_id" "$dashboard_url"

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
  <<<"$published_after_publish"
```

Expected: deployment succeeds, summary returns one nonempty dashboard ID and URL, the effective name is nonempty and ends with `Bakehouse Franchise Performance`, and publish returns that effective name, the warehouse, and a revision timestamp.

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
  <<<"$draft"

jq -e \
  --arg effective_display_name "$effective_display_name" \
  --arg warehouse_id "$warehouse_id" '
    .display_name == $effective_display_name
    and .warehouse_id == $warehouse_id
    and (.revision_create_time | type == "string" and length > 0)' \
  <<<"$published"
```

Expected: bundle summary proves the requested namespace, draft metadata and serialized content use the effective deployed name, and the published object has that name, the warehouse, and a revision timestamp.

Extract and assert the deployed serialized dashboard:

```bash
deployed_dashboard=$(mktemp)
trap 'rm -f "$deployed_dashboard"' EXIT

jq -er '.serialized_dashboard | fromjson' <<<"$draft" >"$deployed_dashboard"

jq -e '
  ([.datasets[].name] == [
    "ds_kpis",
    "ds_sales_trend",
    "ds_franchises",
    "ds_products"
  ])
  and (.datasets | length == 4)
  and (.pages | length == 1)
  and (.pages[0].name == "overview")
  and (.pages[0].pageType == "PAGE_TYPE_CANVAS")
  and (.pages[0].layoutVersion == "GRID_V1")
  and (.pages[0].layout | length == 8)
  and (
    [
      .pages[0].layout[].widget
      | select(.spec != null)
      | {
          title: .spec.frame.title,
          type: .spec.widgetType,
          version: .spec.version
        }
    ] == [
      {"title":"Total Sales","type":"counter","version":2},
      {"title":"Order Count","type":"counter","version":2},
      {"title":"Average Order Value","type":"counter","version":2},
      {"title":"Daily Sales Trend","type":"line","version":3},
      {"title":"Top Franchises","type":"bar","version":3},
      {"title":"Top Products","type":"bar","version":3}
    ]
  )
  and (
    [
      .pages[0].layout[].widget
      | select(.spec != null)
      | {
          name,
          dataset: .queries[0].query.datasetName,
          fields: [.queries[0].query.fields[].name],
          encodings: (
            .spec.encodings
            | [
                .value.fieldName?,
                .x.fieldName?,
                .y.fieldName?
              ]
            | map(select(. != null))
          )
        }
    ] == [
      {"name":"total-sales-kpi","dataset":"ds_kpis","fields":["total_sales"],"encodings":["total_sales"]},
      {"name":"order-count-kpi","dataset":"ds_kpis","fields":["order_count"],"encodings":["order_count"]},
      {"name":"average-order-value-kpi","dataset":"ds_kpis","fields":["avg_order_value"],"encodings":["avg_order_value"]},
      {"name":"daily-sales-trend","dataset":"ds_sales_trend","fields":["sales_date","total_sales"],"encodings":["sales_date","total_sales"]},
      {"name":"top-franchises","dataset":"ds_franchises","fields":["franchise","total_sales"],"encodings":["total_sales","franchise"]},
      {"name":"top-products","dataset":"ds_products","fields":["product","total_sales"],"encodings":["total_sales","product"]}
    ]
  )
  and ([.datasets[].queryLines | join("") | contains("FROM franchise_sales_metrics")] | all)
  and ([.datasets[].queryLines | join("") | test("FROM[[:space:]]+[^[:space:]]*\\.[^[:space:]]*franchise_sales_metrics")] | any | not)
  and ([.pages[].layout[].widget.spec.widgetType? | select(. != null) | startswith("filter")] | any | not)
  and (.uiSettings.genieSpace? == null)
  and (.uiSettings.theme.canvasBackgroundColor.light == "#F5F7FA")
  and (.uiSettings.theme.canvasBackgroundColor.dark == "#111827")
  and (.uiSettings.theme.widgetBackgroundColor.light == "#FFFFFF")
  and (.uiSettings.theme.widgetBackgroundColor.dark == "#1F2937")
  and (.uiSettings.theme.widgetBorderColor.light == "#FFFFFF")
  and (.uiSettings.theme.widgetBorderColor.dark == "#1F2937")
  and (.uiSettings.theme.fontColor.light == "#172033")
  and (.uiSettings.theme.fontColor.dark == "#F3F4F6")
  and (.uiSettings.theme.selectionColor.light == "#0072B2")
  and (.uiSettings.theme.selectionColor.dark == "#56B4E9")
  and (.uiSettings.theme.visualizationColors == [
    "#0072B2",
    "#E69F00",
    "#009E73",
    "#CC79A7",
    "#D55E00",
    "#56B4E9"
  ])
  and (.uiSettings.theme.widgetHeaderAlignment == "LEFT")
  and (.uiSettings.theme.fontFamily == "Inter")
  and (.uiSettings.theme.widgetCornerRadius == 8)
' "$deployed_dashboard"
```

Expected: the deployed object has exactly four datasets, eight layout widgets, six exact business widgets, exact versions and bindings, bare metric-view references, no filters, no Genie link, and the complete light and dark theme.

Execute the deployed queries through the same API assertions:

```bash
assert_all_datasets "$deployed_dashboard"
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
| Effective display-name extraction fails | The deployed development name is empty or does not retain the configured name as its suffix | Inspect the target presets and require an effective name ending with `Bakehouse Franchise Performance` |
| Dashboard ID extraction fails | Bundle summary lacks the exact resource key | Inspect deployment output and restore `bakehouse_franchise_performance` |
| Publish fails or the published check fails | The principal cannot publish, the warehouse is wrong, or no published revision exists | Correct permission or warehouse access, republish the positional ID, and repeat both checks |
| Deployed structure assertion fails | Server serialization or the deployed source differs from the locked contract | Compare the extracted object with the source, correct the source, and redeploy |
| Deployed dataset assertion fails | Deployed SQL or source values differ from the verified local contract | Stop and reconcile the extracted queries and metric-view data |
| Bundle deployment reports drift after UI edits | The workspace draft was changed outside the bundle | Treat the committed source as authoritative and redeploy it through the bundle |

## Next

- **Back to section:** [Databricks Projects](/docs/02-databricks-projects/)
- **Reference:** [AI/BI dashboards](https://docs.databricks.com/aws/en/dashboards/)
- **Reference:** [Dashboard catalog and schema parameterization](https://docs.databricks.com/aws/en/dev-tools/bundles/examples#dashboard-catalog-and-schema-parameterization)
