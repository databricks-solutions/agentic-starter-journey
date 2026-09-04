---
description: Deploy and publish a project-selected AI/BI dashboard, preserve its identity, and compare every dataset with an independent SQL baseline.
---

# Dashboards

## Mental Model

An AI/BI dashboard is a source-controlled Lakeview document plus one native bundle resource.
Dataset SQL is authored with bare table names because the bundle resource injects the catalog and schema.
Capture raw SQL baselines before deployment, then compare those results with every deployed dataset.

## Goal

Deploy and publish one dashboard without changing its identity, and prove its datasets match independent SQL baselines.

## Prerequisites

- Complete [Metric Views](/docs/02-databricks-projects/metric-views/).
- Provide dashboard create and publish privileges.
- Provide access to the configured SQL warehouse and metric view.
- Install Databricks CLI v1.1.0 or newer.

## Skill

Invoke these verified skills in order:

1. [`databricks-core`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-core)
2. [`databricks-aibi-dashboards`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-aibi-dashboards)
3. [`databricks-dabs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-dabs)

## Inputs

| Input | Source | How to obtain |
|---|---|---|
| Databricks account ID as `DATABRICKS_ACCOUNT_ID` | Human-provided | Use the account ID named for this deployment |
| Workspace ID as `DATABRICKS_WORKSPACE_ID` | Human-provided | Use the workspace ID named for this deployment |
| Workspace host as `DATABRICKS_HOST` | Human-provided | Use the named workspace URL |
| Workspace CLI profile as `DATABRICKS_CONFIG_PROFILE` | Human-provided | Use the named profile for the target workspace |
| Existing bundle project path as `PROJECT_PATH` | Human-provided | Use the project completed on the Metric Views page |
| Dashboard resource key | Human-provided | Choose one stable bundle key and matching source filename |
| Dashboard display name | Human-provided | Choose the unprefixed source display name |
| Metric-view FQN | Human-provided | Provide the deployed three-part metric-view name |
| Dataset questions | Human-provided | State the KPI and grouped question each dataset must answer |
| Expected dataset columns | Human-provided | List the ordered result columns for each question |
| Widget types | Human-provided | Select a counter for the KPI and a bar chart for the breakdown |
| Field bindings | Human-provided | Map every widget field and encoding to an expected dataset column |
| Page and widget layout | Human-provided | Provide page names, labels, and nonoverlapping grid positions |
| Measure definition | Human-provided | Provide the measure name and display name used by both datasets |
| Dimension definition | Human-provided | Provide the dimension name, display name, and breakdown title |
| Dashboard theme | Human-provided | Provide all light, dark, visualization, alignment, font, and radius values |
| Target catalog | Agent-derived | Read `.variables.catalog.value` from strict bundle validation |
| Metric-view schema | Agent-derived | Extract the middle token from the provided metric-view FQN |
| SQL warehouse ID | Agent-derived | Read `.variables.warehouse_id.value` from strict bundle validation |
| Bare metric-view name | Agent-derived | Extract the final token from the provided metric-view FQN |
| Effective display name | Agent-derived | Read the deployed dashboard resource from bundle summary |
| Dataset baselines | Agent-derived | Execute every source dataset before deployment and store its canonical result |

Replace each published placeholder below with its matching input.
Keep the dashboard key stable after first deployment.

## Run

Run every Bash block in Run and Verify in the same shell so resolved values, helpers, and temporary baselines persist.

### 0. Verify auth and resolve the active target

Require the named target before reading or deploying project files:

```bash
set -euo pipefail
: "${DATABRICKS_ACCOUNT_ID:?}"
: "${DATABRICKS_WORKSPACE_ID:?}"
: "${DATABRICKS_HOST:?}"
: "${DATABRICKS_CONFIG_PROFILE:?}"
: "${PROJECT_PATH:?}"
cd "$PROJECT_PATH"
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
bundle=$(databricks bundle validate --strict --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
catalog=$(jq -er '.variables.catalog.value' <<<"$bundle")
warehouse_id=$(jq -er '.variables.warehouse_id.value' <<<"$bundle")
dataset_schema='<metric_view_schema>'
dashboard_key='<dashboard_key>'
configured_display_name='<dashboard_display_name>'
dashboard_source="src/$dashboard_key.lvdash.json"

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
        '{warehouse_id:$warehouse_id,catalog:$catalog,schema:$schema,statement:$statement,wait_timeout:"0s"}')"
  ) || return
  statement_id=$(jq -er '.statement_id' <<<"$response") || return
  while :
  do
    state=$(jq -er '.status.state' <<<"$response") || return
    case "$state" in
      SUCCEEDED) printf '%s\n' "$response"; return 0 ;;
      PENDING|RUNNING)
        sleep 5
        response=$(databricks api get "/api/2.0/sql/statements/$statement_id" \
          --profile "$DATABRICKS_CONFIG_PROFILE") || return
        ;;
      *) jq -c '.status.error // .status' >&2 <<<"$response"; return 1 ;;
    esac
  done
}
```

Expected: auth matches all three human-provided target identifiers, strict validation succeeds, and the active catalog and warehouse resolve.

### 1. Create and validate the Lakeview source

Create `src/<dashboard_key>.lvdash.json` with this complete shape.
Replace only placeholders represented in Inputs:

```json
{
  "datasets": [
    {
      "name": "ds_kpi",
      "queryLines": [
        "SELECT MEASURE(<measure_name>) AS <measure_name>\n",
        "FROM <bare_metric_view_name> "
      ]
    },
    {
      "name": "ds_breakdown",
      "queryLines": [
        "SELECT <dimension_name>, MEASURE(<measure_name>) AS <measure_name>\n",
        "FROM <bare_metric_view_name>\n",
        "GROUP BY <dimension_name>\n",
        "ORDER BY <measure_name> DESC "
      ]
    }
  ],
  "pages": [
    {
      "name": "overview",
      "displayName": "Overview",
      "pageType": "PAGE_TYPE_CANVAS",
      "layoutVersion": "GRID_V1",
      "layout": [
        {
          "widget": {
            "name": "dashboard-title",
            "multilineTextboxSpec": {
              "lines": ["# <dashboard_display_name>"]
            }
          },
          "position": {
            "x": 0,
            "y": 0,
            "width": 12,
            "height": 1
          }
        },
        {
          "widget": {
            "name": "measure-kpi",
            "queries": [
              {
                "name": "main_query",
                "query": {
                  "datasetName": "ds_kpi",
                  "fields": [
                    {
                      "name": "<measure_name>",
                      "expression": "`<measure_name>`"
                    }
                  ],
                  "disaggregated": true
                }
              }
            ],
            "spec": {
              "version": 2,
              "widgetType": "counter",
              "encodings": {
                "value": {
                  "fieldName": "<measure_name>",
                  "displayName": "<measure_display_name>"
                }
              },
              "frame": {
                "showTitle": true,
                "title": "<measure_display_name>"
              }
            }
          },
          "position": {
            "x": 0,
            "y": 1,
            "width": 4,
            "height": 3
          }
        },
        {
          "widget": {
            "name": "dimension-breakdown",
            "queries": [
              {
                "name": "main_query",
                "query": {
                  "datasetName": "ds_breakdown",
                  "fields": [
                    {
                      "name": "<dimension_name>",
                      "expression": "`<dimension_name>`"
                    },
                    {
                      "name": "<measure_name>",
                      "expression": "`<measure_name>`"
                    }
                  ],
                  "disaggregated": true
                }
              }
            ],
            "spec": {
              "version": 3,
              "widgetType": "bar",
              "encodings": {
                "x": {
                  "fieldName": "<measure_name>",
                  "displayName": "<measure_display_name>",
                  "scale": {
                    "type": "quantitative",
                    "domainMin": 0
                  }
                },
                "y": {
                  "fieldName": "<dimension_name>",
                  "displayName": "<dimension_display_name>",
                  "scale": {
                    "type": "categorical"
                  }
                }
              },
              "frame": {
                "showTitle": true,
                "title": "<breakdown_title>"
              }
            }
          },
          "position": {
            "x": 0,
            "y": 4,
            "width": 12,
            "height": 6
          }
        }
      ]
    }
  ],
  "uiSettings": {
    "theme": {
      "canvasBackgroundColor": {
        "light": "<light_canvas_color>",
        "dark": "<dark_canvas_color>"
      },
      "widgetBackgroundColor": {
        "light": "<light_widget_color>",
        "dark": "<dark_widget_color>"
      },
      "widgetBorderColor": {
        "light": "<light_border_color>",
        "dark": "<dark_border_color>"
      },
      "fontColor": {
        "light": "<light_font_color>",
        "dark": "<dark_font_color>"
      },
      "selectionColor": {
        "light": "<light_selection_color>",
        "dark": "<dark_selection_color>"
      },
      "visualizationColors": [
        "<visualization_color_one>",
        "<visualization_color_two>",
        "<visualization_color_three>"
      ],
      "widgetHeaderAlignment": "LEFT",
      "fontFamily": "<font_family>",
      "widgetCornerRadius": 8
    }
  }
}
```

Validate structure, supported widget versions, complete theme, and exactly one bare table token after `FROM` in each dataset:

```bash
jq -e '
  (.datasets | length >= 2)
  and all(.datasets[]; all(.queryLines[]; endswith("\n") or endswith(" ")))
  and all(.pages[];
    .pageType == "PAGE_TYPE_CANVAS"
    and .layoutVersion == "GRID_V1"
    and all(.layout[].widget;
      (.spec == null)
      or (.spec.widgetType == "counter" and .spec.version == 2)
      or (.spec.widgetType == "bar" and .spec.version == 3)))
  and (.uiSettings.theme | keys | sort) == [
    "canvasBackgroundColor",
    "fontColor",
    "fontFamily",
    "selectionColor",
    "visualizationColors",
    "widgetBackgroundColor",
    "widgetBorderColor",
    "widgetCornerRadius",
    "widgetHeaderAlignment"
  ]' "$dashboard_source" >/dev/null
python3 - "$dashboard_source" <<'PY'
import json
import sys

def tokens(sql):
    result = []
    index = 0
    while index < len(sql):
        if sql[index].isspace():
            index += 1
        elif sql.startswith("--", index):
            newline = sql.find("\n", index + 2)
            index = len(sql) if newline < 0 else newline + 1
        elif sql.startswith("/*", index):
            end = sql.find("*/", index + 2)
            assert end >= 0, "unterminated comment"
            index = end + 2
        elif sql[index] == "'":
            index += 1
            while index < len(sql):
                if sql[index] == "'" and index + 1 < len(sql) and sql[index + 1] == "'":
                    index += 2
                elif sql[index] == "'":
                    index += 1
                    break
                else:
                    index += 1
            else:
                raise AssertionError("unterminated string")
        elif sql[index] == "`":
            start = index
            index += 1
            while index < len(sql):
                if sql[index] == "`" and index + 1 < len(sql) and sql[index + 1] == "`":
                    index += 2
                elif sql[index] == "`":
                    index += 1
                    break
                else:
                    index += 1
            else:
                raise AssertionError("unterminated identifier")
            result.append(("identifier", sql[start:index]))
        elif sql[index].isalpha() or sql[index] == "_":
            start = index
            index += 1
            while index < len(sql) and (
                sql[index].isalnum() or sql[index] in "_-"
            ):
                index += 1
            result.append(("word", sql[start:index]))
        else:
            result.append(("symbol", sql[index]))
            index += 1
    return result

terminators = {
    "CROSS",
    "EXCEPT",
    "FULL",
    "GROUP",
    "HAVING",
    "INNER",
    "INTERSECT",
    "JOIN",
    "LEFT",
    "LIMIT",
    "ORDER",
    "PIVOT",
    "QUALIFY",
    "RIGHT",
    "SAMPLE",
    "UNION",
    "WHERE",
}
dashboard = json.load(open(sys.argv[1]))
for dataset in dashboard["datasets"]:
    sql = "".join(dataset["queryLines"])
    parsed = tokens(sql)
    from_indexes = [
        index
        for index, token in enumerate(parsed)
        if token[0] == "word" and token[1].upper() == "FROM"
    ]
    assert len(from_indexes) == 1, {
        "dataset": dataset["name"],
        "from_count": len(from_indexes),
    }
    from_index = from_indexes[0]
    assert from_index + 1 < len(parsed), dataset["name"]
    table_kind, table_token = parsed[from_index + 1]
    assert table_kind in {"word", "identifier"}, {
        "dataset": dataset["name"],
        "table_token": table_token,
    }
    assert "." not in table_token.replace("``", ""), {
        "dataset": dataset["name"],
        "table_token": table_token,
    }
    suffix = parsed[from_index + 2 :]
    assert (
        not suffix
        or suffix == [("symbol", ";")]
        or (suffix[0][0] == "word" and suffix[0][1].upper() in terminators)
    ), {
        "dataset": dataset["name"],
        "invalid_suffix": suffix[0],
    }
print("bare_from_tokens=passed")
PY
```

Expected: the source parses, every query fragment has a separator, page and widget versions match the contract, the theme is complete, and each dataset has exactly one bare `FROM` table token with no qualified or invalid suffix.

### 2. Capture canonical source baselines

Use the same extraction for source and deployed documents:

```bash
dataset_sql() {
  jq -er --arg name "$2" '
    [.datasets[] | select(.name == $name) | .queryLines[]]
    | select(length > 0)
    | join("")' "$1"
}
baseline_dir=$(mktemp -d)
while IFS= read -r dataset
do
  sql=$(dataset_sql "src/<dashboard_key>.lvdash.json" "$dataset")
  baseline_file="$baseline_dir/$dataset.json"
  run_sql "$sql" \
    | jq -eS '{
        columns: [.manifest.schema.columns[].name],
        rows: (.result.data_array | sort),
        row_count: .manifest.total_row_count
      } | select(.row_count > 0)' \
    >"$baseline_file"
  test -s "$baseline_file"
done < <(jq -r '.datasets[].name' "src/<dashboard_key>.lvdash.json" | LC_ALL=C sort)
```

Expected: every source dataset creates one nonempty canonical baseline with ordered column names, sorted exact rows, and a positive row count.
An empty result makes `jq -eS` fail, and `test -s` independently rejects an empty baseline file.

### 3. Add the native dashboard resource

Create `resources/<dashboard_key>.dashboard.yml`:

```yaml
resources:
  dashboards:
    <dashboard_key>:
      display_name: <dashboard_display_name>
      file_path: ../src/<dashboard_key>.lvdash.json
      warehouse_id: ${var.warehouse_id}
      dataset_catalog: ${var.catalog}
      dataset_schema: <metric_view_schema>
```

Expected: catalog and schema live on the native resource, not in dataset SQL.

### 4. Preserve identity, deploy, and resolve

Capture a bundle-owned ID before deployment.
An empty ID is allowed only on first creation:

```bash
databricks bundle validate --strict --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" >/dev/null
pre_summary=$(databricks bundle summary --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
pre_id=$(jq -r --arg key "<dashboard_key>" \
  '.resources.dashboards[$key].id // empty | tostring' <<<"$pre_summary")
databricks bundle deploy --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" --auto-approve
summary=$(databricks bundle summary --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
dashboard_id=$(jq -er --arg key "<dashboard_key>" \
  '.resources.dashboards[$key].id | tostring | select(length > 0)' <<<"$summary")
if test -n "$pre_id"
then
  test "$pre_id" = "$dashboard_id"
fi
```

Expected: strict validation reruns after the source and resource are written, immediately before identity capture and deployment.
Deployment returns a nonempty bundle-owned dashboard ID, and every update retains the pre-deploy ID.

### 5. Reject duplicates and publish

Use exact configured or effective names.
Do not delete any unproven match:

```bash
effective_display_name=$(jq -er --arg key "$dashboard_key" '
  .resources.dashboards[$key].display_name
  | select(type == "string" and length > 0)' <<<"$summary")
dashboard_url=$(jq -er --arg key "$dashboard_key" '
  .resources.dashboards[$key].url
  | select(type == "string" and length > 0)' <<<"$summary")
dashboards=$(
  databricks lakeview list \
    --profile "$DATABRICKS_CONFIG_PROFILE" -o json
)
jq -e \
  --arg configured "$configured_display_name" \
  --arg effective "$effective_display_name" \
  --arg dashboard_id "$dashboard_id" '
    [(if type == "array" then . else (.dashboards // []) end)[]
     | select(.display_name == $configured or .display_name == $effective)]
    | select(length == 1)
    | .[0].dashboard_id == $dashboard_id' \
  >/dev/null <<<"$dashboards"
published_after_publish=$(
  databricks lakeview publish "$dashboard_id" \
    --warehouse-id "$warehouse_id" \
    --profile "$DATABRICKS_CONFIG_PROFILE" -o json
)
jq -e \
  --arg effective "$effective_display_name" \
  --arg warehouse_id "$warehouse_id" '
    .display_name == $effective
    and .warehouse_id == $warehouse_id
    and (.revision_create_time | type == "string" and length > 0)' \
  >/dev/null <<<"$published_after_publish"
printf '%s\n' 'duplicates=0 published=true'
```

Expected: exactly one exact-name match has the bundle ID, and publish returns the effective name, warehouse, and revision timestamp.

## Verify

### Verify metadata and canonical serialization

Compare deployed metadata with bundle state, then remove only the catalog and schema fields injected into each dataset before exact source comparison:

```bash
draft=$(databricks lakeview get "$dashboard_id" \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
published=$(databricks lakeview get-published "$dashboard_id" \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
jq -e \
  --arg dashboard_id "$dashboard_id" \
  --arg effective "$effective_display_name" \
  --arg warehouse_id "$warehouse_id" '
    .dashboard_id == $dashboard_id
    and .display_name == $effective
    and .warehouse_id == $warehouse_id
    and (.serialized_dashboard | type == "string" and length > 0)' \
  >/dev/null <<<"$draft"
jq -e \
  --arg effective "$effective_display_name" \
  --arg warehouse_id "$warehouse_id" '
    .display_name == $effective
    and .warehouse_id == $warehouse_id
    and (.revision_create_time | type == "string" and length > 0)' \
  >/dev/null <<<"$published"
deployed_dashboard=$(mktemp)
jq -er '.serialized_dashboard | fromjson' >"$deployed_dashboard" <<<"$draft"
test -s "$deployed_dashboard"
jq -e \
  --arg catalog "$catalog" \
  --arg schema "$dataset_schema" \
  --slurpfile source "$dashboard_source" '
    all(.datasets[]; .catalog == $catalog and .schema == $schema)
    and ((.datasets |= map(del(.catalog, .schema))) == $source[0])' \
  "$deployed_dashboard" >/dev/null
printf '%s\n' 'serialization_matches=true'
```

Expected: draft and published metadata match bundle state, every dataset has the target namespace, and removing only injected namespace fields yields exact source equality.

### Compare every deployed dataset exactly

Canonicalize deployed results exactly as the pre-deploy results, compare every file, and separately prove the dataset name sets are identical:

```bash
deployed_baseline_dir=$(mktemp -d)
while IFS= read -r dataset
do
  sql=$(dataset_sql "$deployed_dashboard" "$dataset")
  deployed_baseline_file="$deployed_baseline_dir/$dataset.json"
  run_sql "$sql" \
    | jq -eS '{
        columns: [.manifest.schema.columns[].name],
        rows: (.result.data_array | sort),
        row_count: .manifest.total_row_count
      } | select(.row_count > 0)' \
    >"$deployed_baseline_file"
  test -s "$deployed_baseline_file"
  diff -u \
    "$baseline_dir/$dataset.json" \
    "$deployed_baseline_file"
done < <(jq -r '.datasets[].name' "$deployed_dashboard" | LC_ALL=C sort)
source_dataset_names=$(mktemp)
deployed_dataset_names=$(mktemp)
jq -r '.datasets[].name' "$dashboard_source" | LC_ALL=C sort >"$source_dataset_names"
jq -r '.datasets[].name' "$deployed_dashboard" | LC_ALL=C sort >"$deployed_dataset_names"
test -s "$source_dataset_names"
test -s "$deployed_dataset_names"
diff -u "$source_dataset_names" "$deployed_dataset_names"
dataset_count=$(wc -l <"$deployed_dataset_names" | tr -d ' ')
printf 'identity_retained=true\nduplicates=0\npublished=true\nserialization_matches=true\ndatasets_match_baseline=%s\n' \
  "$dataset_count"
```

Expected: identity, duplicate, publish, and serialization checks report true, and `datasets_match_baseline=<dataset-count>` reports every source dataset.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| Auth or active-target validation fails | A target input is missing or the profile reaches another workspace | Reauthenticate the named profile against the named target and repeat the precheck |
| Catalog, schema, or warehouse resolution fails | The bundle variables or provided metric-view FQN are incomplete | Correct the active target or input before authoring the source |
| Bare-name validation fails | A dataset has zero or multiple `FROM` clauses, a qualified name with or without spaces around dots, or an invalid table suffix | Keep exactly one bare table token after `FROM` and restore namespace injection on the resource |
| Query-line validation fails | A fragment has no trailing newline or space | Restore the separator so adjacent SQL tokens cannot merge |
| Counter or bar validation fails | The widget uses an unsupported type or version | Use counter version 2 and bar version 3 |
| A widget returns the wrong field | Its selected fields and encodings do not match expected dataset columns | Restore the exact field bindings from Inputs |
| Theme validation fails | A required key is missing or renamed | Restore the complete theme contract before querying |
| A local baseline is empty | The SQL, metric view, namespace, or warehouse is wrong | Repair the source query or target before deployment |
| Strict bundle validation or deployment fails | The native resource, source path, or namespace is invalid | Restore the resource shape and validate again |
| Effective name differs from the configured name | The development target applies a name prefix | Use the configured source name for exact duplicate matching and bundle summary for the effective API name |
| Identity assertion fails | Deployment replaced an existing bundle-managed dashboard | Stop and reconcile bundle state before publishing |
| Duplicate assertion fails | Zero or multiple exact configured-or-effective matches exist, or the sole match has another ID | Reconcile only ownership-proven dashboards and do not delete unproven matches |
| Publish check fails | Permission, warehouse, effective name, or revision state is wrong | Correct access or state and republish the bundle-owned ID |
| Serialization comparison fails | Namespace injection is wrong or another deployed field drifted | Correct the source or resource and redeploy |
| Dataset comparison fails | Names, ordered columns, row count, or exact sorted rows differ from the pre-deploy baseline | Stop and reconcile the deployed source and underlying metric-view data |

## Next

- **Do next:** [Genie Agents](/docs/02-databricks-projects/genie-agents/)
- **Back to section:** [Databricks Projects](/docs/02-databricks-projects/)
