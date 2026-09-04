---
description: Build and verify a batch Spark Declarative Pipeline from project-defined sources, datasets, and quality rules.
---

# Spark Declarative Pipelines

## Mental Model

A batch Spark Declarative Pipeline copies selected sources into bronze materialized views, applies grouped quality rules in silver materialized views, and is deployed as a native bundle pipeline.

## Goal

Add a project-defined batch pipeline to the existing bundle, run one new update, and verify its materialized views and expectation counters.

## Prerequisites

- Complete the [Project repo](/docs/02-databricks-projects/project-repo/) outcome.
- Identify readable batch source tables and their required columns.
- Provide writable bronze and silver schemas in the target catalog.
- Configure workspace authentication for the intended account, workspace, and host.
- Provide a SQL warehouse that the deployment principal can use for verification.

## Skill

Invoke these verified skills in order:

1. [`databricks-core`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-core)
2. [`databricks-pipelines`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-pipelines)
3. [`databricks-dabs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-dabs)

## Inputs

| Input | Source | How to obtain |
|---|---|---|
| `DATABRICKS_ACCOUNT_ID` | Human-provided | Copy the intended Databricks account ID |
| `DATABRICKS_WORKSPACE_ID` | Human-provided | Copy the intended workspace ID |
| `DATABRICKS_HOST` | Human-provided | Copy the intended workspace URL |
| `DATABRICKS_CONFIG_PROFILE` | Human-provided | Name the Databricks CLI profile for the intended workspace |
| `PROJECT_PATH` | Human-provided | Use the local path to the completed project repository |
| `<pipeline_key>` | Human-provided | Choose the stable bundle resource key and source directory name |
| `<pipeline_display_name>` | Human-provided | Choose the displayed pipeline name |
| Source FQNs | Human-provided | List each readable batch source as a three-part name |
| Selected columns | Human-provided | List the source columns required by each dataset |
| `<bronze_dataset>` names | Human-provided | Choose one unique bronze materialized view name per source |
| `<silver_dataset>` names | Human-provided | Choose one unique silver materialized view name per transformed dataset |
| `<quality_rule_name>` values | Human-provided | Choose one unique name per quality rule |
| `<quality_rule_sql>` values | Human-provided | Provide each SQL boolean expression |
| Quality rule actions | Human-provided | Choose `warn`, `drop`, or `fail` for each rule |
| `catalog` | Agent-derived | Read `.variables.catalog.value` from strict bundle validation |
| `schema_prefix` | Agent-derived | Read `.variables.schema_prefix.value` from strict bundle validation |
| `warehouse_id` | Agent-derived | Read `.variables.warehouse_id.value` from strict bundle validation |
| Source catalog, schema, and table components | Agent-derived | Parse all three fields from each validated human-provided source FQN |
| Bronze schema | Agent-derived | Use `${schema_prefix}_bronze` |
| Silver schema | Agent-derived | Use `${schema_prefix}_silver` |
| `SOURCE_SPECS_JSON` | Agent-derived | Add redundant catalog, schema, and table fields parsed from the human-provided FQNs, then cross-check them before use |
| `QUALITY_RULES_JSON` | Human-provided | Encode every rule name, SQL expression, and allowed action in the required JSON shape |
| File layout | Agent-derived | Put each focused dataset file under `src/<pipeline_key>/` and the resource under `resources/` |

## Run

### 1. Resolve authentication and the bundle target

Set all human-provided environment variables before running this block.
The identity check fails before any file or live resource change when the profile targets another account, workspace, or host.

```bash
set -euo pipefail
: "${DATABRICKS_ACCOUNT_ID:?}"
: "${DATABRICKS_WORKSPACE_ID:?}"
: "${DATABRICKS_HOST:?}"
: "${DATABRICKS_CONFIG_PROFILE:?}"
: "${PROJECT_PATH:?}"
: "${SOURCE_SPECS_JSON:?}"
: "${QUALITY_RULES_JSON:?}"
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
schema_prefix=$(jq -er '.variables.schema_prefix.value' <<<"$bundle")
warehouse_id=$(jq -er '.variables.warehouse_id.value' <<<"$bundle")
```

### 2. Inspect every batch source

Use this Statement Execution helper for the source precheck and later verification.

```bash
run_sql() {
  local statement=$1 response statement_id state
  response=$(
    databricks api post /api/2.0/sql/statements \
      --profile "$DATABRICKS_CONFIG_PROFILE" \
      --json "$(jq -n \
        --arg warehouse_id "$warehouse_id" \
        --arg statement "$statement" \
        '{warehouse_id:$warehouse_id,statement:$statement,wait_timeout:"0s"}')"
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

After the human provides each source FQN and its selected columns, populate `SOURCE_SPECS_JSON` with the parsed catalog, schema, and table fields.

```json
[
  {
    "fqn": "<catalog>.<source_schema>.<source_table>",
    "catalog": "<catalog>",
    "schema": "<source_schema>",
    "table": "<source_table>",
    "required_columns": ["<required_column_one>", "<required_column_two>"]
  }
]
```

Validate every redundant field against the human-provided FQN and stop before authoring when a required column is absent.

```bash
jq -e '
  type == "array"
  and length > 0
  and all(.[];
    (.fqn | type == "string" and test("^[^.]+\\.[^.]+\\.[^.]+$"))
    and (.catalog | type == "string" and length > 0)
    and (.schema | type == "string" and length > 0)
    and (.table | type == "string" and length > 0)
    and (.fqn == ([.catalog, .schema, .table] | join(".")))
    and (.required_columns | type == "array" and length > 0)
  )' >/dev/null <<<"$SOURCE_SPECS_JSON"
source_count=$(jq 'length' <<<"$SOURCE_SPECS_JSON")
for ((source_index = 0; source_index < source_count; source_index++))
do
  source_fqn=$(jq -er --argjson index "$source_index" \
    '.[$index].fqn' <<<"$SOURCE_SPECS_JSON")
  IFS=. read -r source_catalog source_schema source_table <<<"$source_fqn"
  required_columns=$(mktemp)
  observed_columns=$(mktemp)
  jq -r --argjson index "$source_index" \
    '.[$index].required_columns[]' <<<"$SOURCE_SPECS_JSON" \
    | LC_ALL=C sort -u >"$required_columns"
  statement=$(cat <<SQL
SELECT column_name
FROM $source_catalog.information_schema.columns
WHERE table_schema = '$source_schema'
  AND table_name = '$source_table'
ORDER BY column_name
SQL
)
  run_sql "$statement" \
    | jq -r '.result.data_array[] | .[0]' \
    | LC_ALL=C sort -u >"$observed_columns"
  missing=$(comm -23 "$required_columns" "$observed_columns")
  test -z "$missing" || {
    printf 'missing required columns for %s:\n%s\n' \
      "$source_fqn" "$missing" >&2
    exit 1
  }
done
printf 'source_precheck=passed sources=%s\n' "$source_count"
```

Expected: `source_precheck=passed` with the configured positive source count.

Define `QUALITY_RULES_JSON` with this human-provided shape.

```json
[
  {
    "name": "<quality_rule_name>",
    "sql": "<quality_rule_sql>",
    "action": "warn"
  }
]
```

Validate every rule and reject any action other than `warn`, `drop`, or `fail`.

```bash
jq -e '
  type == "array"
  and length > 0
  and all(.[];
    (.name | type == "string" and length > 0)
    and (.sql | type == "string" and length > 0)
    and (.action == "warn" or .action == "drop" or .action == "fail")
  )
  and ([.[].name] | length == (unique | length))
  ' >/dev/null <<<"$QUALITY_RULES_JSON"
printf 'quality_rule_precheck=passed rules=%s\n' \
  "$(jq 'length' <<<"$QUALITY_RULES_JSON")"
```

Expected: `quality_rule_precheck=passed` with the configured positive rule count.
Only after both prechecks pass, invoke `databricks-core`, then `databricks-pipelines`, then `databricks-dabs`.

### 3. Write focused dataset files

Create one bronze file for each source under `src/<pipeline_key>/bronze/`.

```python
from pyspark import pipelines as dp

@dp.materialized_view(name="<bronze_dataset>")
def bronze_dataset():
    return spark.read.table("<source_fqn>")
```

Create one silver file for each transformed dataset under `src/<pipeline_key>/silver/`.
Group rules by action and use the exact native decorator for that action.

```python
from pyspark import pipelines as dp

@dp.materialized_view(name="<silver_schema>.<silver_dataset>")
@dp.expect_all({
    "<warn_rule_name>": "<warn_rule_sql>",
})
@dp.expect_all_or_drop({
    "<drop_rule_name>": "<drop_rule_sql>",
})
@dp.expect_all_or_fail({
    "<fail_rule_name>": "<fail_rule_sql>",
})
def silver_dataset():
    return spark.read.table("<bronze_dataset>")
```

Map `warn` to `expect_all`, `drop` to `expect_all_or_drop`, and `fail` to `expect_all_or_fail`.
Omit a decorator when that action group is empty.
Give every dataset one focused file.

### 4. Add the native pipeline resource

Create `resources/<pipeline_key>.pipeline.yml`.

```yaml
resources:
  pipelines:
    <pipeline_key>:
      name: <pipeline_display_name>
      catalog: ${var.catalog}
      target: ${var.schema_prefix}_bronze
      root_path: ../src/<pipeline_key>
      libraries:
        - glob:
            include: ../src/<pipeline_key>/**
      configuration:
        silver_schema: ${var.schema_prefix}_silver
      serverless: true
      continuous: false
      development: true
      photon: true
      channel: current
```

The resource uses the bundle variables resolved in the first step and has no schedule.

### 5. Deploy and resolve the pipeline ID

The first deployment may create the pipeline before the baseline is captured.

```bash
databricks bundle validate --strict --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE"
databricks bundle deploy --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" --auto-approve
pipeline_id=$(
  databricks bundle summary --target dev \
    --profile "$DATABRICKS_CONFIG_PROFILE" -o json \
  | jq -er --arg key "<pipeline_key>" '.resources.pipelines[$key].id'
)
```

### 6. Capture the baseline, then start one update

Represent a first run explicitly and reject malformed baseline responses.

```bash
baseline=$(
  databricks pipelines list-updates "$pipeline_id" --max-results 1 \
    --profile "$DATABRICKS_CONFIG_PROFILE" -o json
)
baseline_update_id=$(jq -er '
  .updates
  | if length == 0
    then "__NO_PRIOR_UPDATE__"
    elif length == 1
    then .[0].update_id
    else error("max-results 1 returned multiple updates")
    end' <<<"$baseline")
update_id=$(
  databricks bundle run <pipeline_key> --target dev \
    --profile "$DATABRICKS_CONFIG_PROFILE" --no-wait -o json \
  | jq -er '.update_id'
)
test "$update_id" != "$baseline_update_id"
```

## Verify

Poll the exact update returned by the bundle run.
Only `COMPLETED` passes.

```bash
while :
do
  update=$(databricks pipelines get-update "$pipeline_id" "$update_id" \
    --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
  state=$(jq -er '.update.state' <<<"$update")
  case "$state" in
    COMPLETED) break ;;
    CREATED|INITIALIZING|QUEUED|RESETTING|RUNNING|SETTING_UP_TABLES|WAITING_FOR_RESOURCES|STOPPING) sleep 15 ;;
    FAILED|CANCELED) jq '.update' >&2 <<<"$update"; exit 1 ;;
    *) printf 'unknown update state: %s\n' "$state" >&2; exit 1 ;;
  esac
done
```

List every configured output, every silver output with expectations, and every configured quality rule.
Then verify object types, nonempty outputs, and numeric expectation counters from the exact update.

```bash
output_fqns=(
  "<catalog>.<bronze_schema>.<bronze_dataset>"
  "<catalog>.<silver_schema>.<silver_dataset>"
)
expectation_silver_fqns=(
  "<catalog>.<silver_schema>.<silver_dataset_with_expectations>"
)
quality_rule_names=(
  "<quality_rule_name>"
)
materialized_view_count=0
nonempty_output_count=0
for output_fqn in "${output_fqns[@]}"
do
  table=$(
    databricks tables get "$output_fqn" \
      --profile "$DATABRICKS_CONFIG_PROFILE" -o json
  )
  jq -e '.table_type == "MATERIALIZED_VIEW"' >/dev/null <<<"$table"
  materialized_view_count=$((materialized_view_count + 1))
  statement=$(printf 'SELECT count(*) FROM %s' "$output_fqn")
  run_sql "$statement" \
    | jq -e '
        .result.data_array
        | select(length == 1)
        | .[0][0]
        | tonumber
        | select(. > 0)' >/dev/null
  nonempty_output_count=$((nonempty_output_count + 1))
done

expectations_file=$(mktemp)
: >"$expectations_file"
expectation_schema=$(printf 'array\74struct\74name:string,passed_records:bigint,failed_records:bigint\76\76')
for silver_fqn in "${expectation_silver_fqns[@]}"
do
  statement=$(cat <<SQL
SELECT
  expectation.name,
  expectation.passed_records,
  expectation.failed_records
FROM event_log(TABLE($silver_fqn))
LATERAL VIEW explode(
  from_json(
    get_json_object(details, '$.flow_progress.data_quality.expectations'),
    '$expectation_schema'
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
    | jq -ce '
        .result.data_array[]
        | {
            name: .[0],
            passed_records: (.[1] | tonumber),
            failed_records: (.[2] | tonumber)
          }' >>"$expectations_file"
done

expected_rules=$(mktemp)
observed_rules=$(mktemp)
printf '%s\n' "${quality_rule_names[@]}" | LC_ALL=C sort -u >"$expected_rules"
jq -sr '
  select(length > 0)
  | select(all(.[];
      (.passed_records | type) == "number"
      and (.failed_records | type) == "number"))
  | map(.name)
  | unique
  | sort
  | .[]' "$expectations_file" >"$observed_rules"
diff -u "$expected_rules" "$observed_rules"
printf 'update=%s\nmaterialized_views=%s\nnonempty_outputs=%s\nexpectations=%s\n' \
  "$state" \
  "$materialized_view_count" \
  "$nonempty_output_count" \
  "$(wc -l <"$observed_rules" | tr -d ' ')"
```

Expected:

```text
update=COMPLETED
materialized_views=<configured-output-count>
nonempty_outputs=<configured-output-count>
expectations=<configured-rule-count>
```

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| Authentication check fails before validation | The profile targets another account, workspace, or host | Correct the named values or reauthenticate the intended profile before continuing |
| Source precheck reports missing required columns | The human source mapping does not match the live table | Correct the mapping or approve revised dataset logic before authoring |
| Source precheck fails before inspection | A source FQN is not three nonempty components or a redundant field differs from the parsed FQN | Correct the derived source specification before continuing |
| Quality rule precheck fails | A rule is incomplete, duplicated, or uses an action other than `warn`, `drop`, or `fail` | Correct the rule contract before authoring |
| Source inspection or deployment returns permission denied | The deployment principal lacks source, schema, or warehouse privileges | Grant the minimum required read, write, and warehouse permissions |
| Pipeline source imports `dlt` | The project uses the legacy pipeline module | Replace it with `from pyspark import pipelines as dp` |
| A batch source is read as a stream | The dataset uses a streaming read for a batch input | Use a materialized view with `spark.read.table` |
| Bundle validation reports a missing library | The resource path does not match `src/<pipeline_key>/` | Align `root_path`, the glob, and the source directory |
| `tables get` reports another object type | The output was not published as a materialized view | Use `@dp.materialized_view` and redeploy |
| The row-count check returns zero | The source is empty or transformation logic removed every row | Inspect the selected source and rule actions before accepting the run |
| The expectation query returns no numeric counters | Rules did not attach or the event log has no matching flow progress for the update | Inspect the grouped decorator and query the exact update ID |
| Verification passes an idle pipeline while work is active | Polling uses top-level pipeline state or a different update | Poll `get-update` with both the resolved pipeline ID and returned update ID |

## Next

- **Do next:** [Metric Views](/docs/02-databricks-projects/metric-views/)
- **Manual fallback:** [Starter Journey: build the first pipeline](https://databricks-solutions.github.io/starter-journey/docs/07-build-first-pipeline/)
- **Back to section:** [Databricks Projects](/docs/02-databricks-projects/)
