---
description: Build and verify batch, streaming, file-ingestion, and CDC Spark Declarative Pipelines from project-defined contracts.
---

# Spark Declarative Pipelines

## Mental Model

A Spark Declarative Pipeline chooses each persisted dataset from source semantics.
Use a materialized view for batch inputs and full-data recomputation.
Use a streaming table for incremental tables and files.
Use Auto Loader for incrementally discovered files and Auto CDC for ordered changes, deletes, and SCD history.
Publish bronze, silver, and gold datasets to separate schemas when their quality and access contracts differ.

## Goal

Add a project-defined pipeline to the existing bundle, run one new update, and verify every dataset type, data postcondition, and expectation counter declared by the project.

## Prerequisites

- Complete the [Project repo](/docs/02-databricks-projects/project-repo/) outcome.
- Classify every source as `batch_table`, `incremental_table`, `files`, or `cdc`.
- Identify readable source tables or file folders and their required fields.
- Provide writable bronze, silver, and optional gold schemas in the target catalog.
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
| Source kind | Human-provided | Choose `batch_table`, `incremental_table`, `files`, or `cdc` for each source |
| Source FQNs or folder URIs | Human-provided | List each readable table as a three-part name or each file source as a folder URI |
| Selected columns | Human-provided | List the source columns required by each dataset |
| Output types | Human-provided | Choose `MATERIALIZED_VIEW` for batch recomputation or `STREAMING_TABLE` for incremental processing |
| `<bronze_dataset>` names | Human-provided | Choose one unique bronze dataset per source and publish it explicitly in the bronze schema |
| `<silver_dataset>` names | Human-provided | Choose one unique silver dataset per transformation and publish it explicitly in the silver schema |
| File ingestion policy | Human-provided | For files, provide format, schema hints, evolution mode, rescued-data policy, and provenance columns |
| CDC policy | Human-provided | For CDC, provide keys, operation mapping, deterministic sequence, delete behavior, and SCD type |
| `<quality_rule_name>` values | Human-provided | Choose one unique name per quality rule |
| `<quality_rule_sql>` values | Human-provided | Provide each SQL boolean expression |
| Quality rule actions | Human-provided | Choose `warn`, `drop`, or `fail` for each rule |
| `catalog` | Agent-derived | Read `.variables.catalog.value` from strict bundle validation |
| `schema_prefix` | Agent-derived | Read `.variables.schema_prefix.value` from strict bundle validation |
| `warehouse_id` | Agent-derived | Read `.variables.warehouse_id.value` from strict bundle validation |
| Source catalog, schema, and table components | Agent-derived | Parse all three fields from each validated human-provided source FQN |
| Bronze schema | Agent-derived | Use `${schema_prefix}_bronze` |
| Silver schema | Agent-derived | Use `${schema_prefix}_silver` |
| `SOURCE_SPECS_JSON` | Agent-derived | Encode each source kind and its table identity or file-ingestion policy, then cross-check it before use |
| `QUALITY_RULES_JSON` | Human-provided | Encode every rule name, SQL expression, and allowed action in the required JSON shape |
| `OUTPUT_MANIFEST_JSON` | Agent-derived | Encode every focused Python file, dataset name, object type, and complete deployed FQN |
| `EXPECTATION_MANIFEST_JSON` | Agent-derived | Encode every focused Python file, dataset name, rule name, SQL expression, and action used for authoring |
| File layout | Agent-derived | Put each focused dataset file under `src/<pipeline_key>/` and the resource under `resources/` |

## Run

Start one persistent Bash session, then run every remaining Run and Verify block in that session.
This preserves strict options, variables, arrays, and functions and avoids reserved-name behavior from another shell.

```bash
bash
```

### 1. Resolve authentication and the bundle target

Set all human-provided environment variables before running this block.
The identity check fails before any file or live resource change when the profile targets another account, workspace, or host.

```bash
set -euo pipefail
: "${BASH_VERSION:?Start the required persistent Bash session}"
persistent_bash_pid=$$
: "${DATABRICKS_ACCOUNT_ID:?}"
: "${DATABRICKS_WORKSPACE_ID:?}"
: "${DATABRICKS_HOST:?}"
: "${DATABRICKS_CONFIG_PROFILE:?}"
: "${PROJECT_PATH:?}"
: "${SOURCE_SPECS_JSON:?}"
: "${QUALITY_RULES_JSON:?}"
: "${OUTPUT_MANIFEST_JSON:?}"
: "${EXPECTATION_MANIFEST_JSON:?}"
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

### 2. Inspect every source

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

Populate `SOURCE_SPECS_JSON` with one contract per source.
Table and CDC sources use a three-part FQN.
File sources use a folder URI and an explicit ingestion policy.

```json
[
  {
    "kind": "batch_table",
    "fqn": "<catalog>.<source_schema>.<source_table>",
    "catalog": "<catalog>",
    "schema": "<source_schema>",
    "table": "<source_table>",
    "required_columns": ["<required_column_one>", "<required_column_two>"]
  },
  {
    "kind": "files",
    "uri": "/Volumes/<catalog>/<schema>/<volume>/<folder>",
    "format": "json",
    "schema_hints": "order_id BIGINT, amount DECIMAL(18,2)",
    "schema_evolution_mode": "rescue",
    "required_columns": ["order_id", "amount"]
  }
]
```

Validate every source-kind contract and stop before authoring when a required table column or file policy is absent.

```bash
jq -e '
  type == "array"
  and length > 0
  and all(.[];
    (.kind | IN("batch_table", "incremental_table", "files", "cdc"))
    and (.required_columns | type == "array" and length > 0)
    and (
      if .kind == "files" then
        (.uri | type == "string" and startswith("/Volumes/"))
        and (.format | IN("json", "csv", "parquet", "avro", "orc", "text", "xml", "binaryFile"))
        and (.schema_hints | type == "string" and length > 0)
        and (.schema_evolution_mode | IN("addNewColumns", "rescue", "failOnNewColumns", "none"))
      else
        (.fqn | type == "string" and test("^[^.]+\\.[^.]+\\.[^.]+$"))
        and (.catalog | type == "string" and length > 0)
        and (.schema | type == "string" and length > 0)
        and (.table | type == "string" and length > 0)
        and (.fqn == ([.catalog, .schema, .table] | join(".")))
      end
    )
  )' >/dev/null <<<"$SOURCE_SPECS_JSON"
source_count=$(jq 'length' <<<"$SOURCE_SPECS_JSON")
for ((source_index = 0; source_index < source_count; source_index++))
do
  source_kind=$(jq -er --argjson index "$source_index" \
    '.[$index].kind' <<<"$SOURCE_SPECS_JSON")
  if test "$source_kind" = files
  then
    source_uri=$(jq -er --argjson index "$source_index" \
      '.[$index].uri' <<<"$SOURCE_SPECS_JSON")
    databricks fs ls "dbfs:$source_uri" \
      --profile "$DATABRICKS_CONFIG_PROFILE" >/dev/null
    continue
  fi
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

Derive complete authoring manifests before writing any focused Python file.

```json
[
  {"file": "bronze/<bronze_dataset>.py", "name": "<bronze_schema>.<bronze_dataset>", "type": "<MATERIALIZED_VIEW_or_STREAMING_TABLE>", "fqn": "<catalog>.<bronze_schema>.<bronze_dataset>"},
  {"file": "silver/<silver_dataset>.py", "name": "<silver_schema>.<silver_dataset>", "type": "<MATERIALIZED_VIEW_or_STREAMING_TABLE>", "fqn": "<catalog>.<silver_schema>.<silver_dataset>"}
]
```

```json
[
  {"file": "silver/<silver_dataset>.py", "dataset": "<silver_schema>.<silver_dataset>", "name": "<quality_rule_name>", "sql": "<quality_rule_sql>", "action": "drop"}
]
```

Validate both manifests and require their complete expectation set to equal the human-provided quality rules.

```bash
jq -en \
  --argjson outputs "$OUTPUT_MANIFEST_JSON" \
  --argjson expectations "$EXPECTATION_MANIFEST_JSON" \
  --argjson quality "$QUALITY_RULES_JSON" '
  ($outputs | length > 0
    and all(.[];
      (.file | type == "string" and endswith(".py"))
      and (.name | type == "string" and length > 0)
      and (.type | IN("MATERIALIZED_VIEW", "STREAMING_TABLE"))
      and (.fqn | type == "string" and test("^[^.]+\\.[^.]+\\.[^.]+$")))
    and ([.[].file] | length == (unique | length))
    and ([.[].name] | length == (unique | length))
    and ([.[].fqn] | length == (unique | length)))
  and ($expectations | length > 0
    and all(.[];
      (.file | type == "string" and endswith(".py"))
      and (.dataset | type == "string" and length > 0)
      and (.name | type == "string" and length > 0)
      and (.sql | type == "string" and length > 0)
      and (.action | IN("warn", "drop", "fail")))
    and ([.[] | [.file, .dataset, .name]] | length == (unique | length)))
  and ($quality | sort_by(.name))
    == ($expectations | map({name, sql, action}) | sort_by(.name))
' >/dev/null
```

Expected: both manifests are nonempty and unique, and no quality rule is missing or added.
Only after both prechecks pass, invoke `databricks-core`, then `databricks-pipelines`, then `databricks-dabs`.

### 3. Write focused dataset files

Choose the dataset API before writing files.

| Source behavior | Dataset API | Read API |
|---|---|---|
| Batch table or full-data aggregation | `@dp.materialized_view` | `spark.read.table` |
| Incremental Delta table | `@dp.table` | `spark.readStream.table` |
| Incrementally discovered files | `@dp.table` with Auto Loader | `spark.readStream.format("cloudFiles")` |
| Ordered changes, deletes, or SCD history | `dp.create_streaming_table` plus `dp.create_auto_cdc_flow` | A streaming temporary view |

Create one focused file for each dataset under `src/<pipeline_key>/`.
This batch example produces materialized views.

```python
from pyspark import pipelines as dp

@dp.materialized_view(name="<bronze_schema>.<bronze_dataset>")
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
    return spark.read.table("<bronze_schema>.<bronze_dataset>")
```

This file-ingestion example produces a bronze streaming table and retains malformed or drifted data for inspection.

```python
from pyspark import pipelines as dp
from pyspark.sql import functions as F

@dp.table(name="<bronze_schema>.<bronze_dataset>")
def bronze_dataset():
    return (
        spark.readStream.format("cloudFiles")
        .option("cloudFiles.format", "<file_format>")
        .option("cloudFiles.schemaHints", "<schema_hints>")
        .option("cloudFiles.schemaEvolutionMode", "rescue")
        .load("<folder_uri>")
        .withColumn("source_file", F.col("_metadata.file_path"))
    )
```

Read folders rather than individual arrival files.
Keep `_rescued_data` in bronze and state whether silver retains, drops, or quarantines rescued rows.
Verify idempotency by rerunning without new files and requiring unchanged counts.

This CDC example creates an SCD Type 2 streaming target with deterministic sequencing.

```python
from pyspark import pipelines as dp
from pyspark.sql.functions import expr, struct

@dp.temporary_view(name="customer_changes")
def customer_changes():
    return spark.readStream.table("<source_fqn>")

dp.create_streaming_table(name="<silver_schema>.customers_scd2")

dp.create_auto_cdc_flow(
    target="<silver_schema>.customers_scd2",
    source="customer_changes",
    keys=["customer_id"],
    sequence_by=struct("event_timestamp", "event_sequence"),
    apply_as_deletes=expr("operation = 'DELETE'"),
    except_column_list=["operation", "event_sequence"],
    stored_as_scd_type=2,
)
```

Reject null keys, null sequences, and duplicate key-plus-sequence rows before deployment.
For SCD Type 2, query current rows with `__END_AT IS NULL` and verify history with `__START_AT` and `__END_AT`.

Map `warn` to `expect_all`, `drop` to `expect_all_or_drop`, and `fail` to `expect_all_or_fail`.
Omit a decorator when that action group is empty.
Give every dataset one focused file.

Statically parse every focused Python file and require exact equality with both authoring manifests before deployment.
Create `src/verify_pipeline_authoring.py`:

```text
import ast, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
catalog, bronze_schema = sys.argv[2:4]
expected_outputs = json.loads(sys.argv[4])
expected_rules = json.loads(sys.argv[5])
actions = {"expect_all": "warn", "expect_all_or_drop": "drop", "expect_all_or_fail": "fail"}
actual_outputs, actual_rules = [], []
for path in sorted(root.rglob("*.py")):
    relative = str(path.relative_to(root))
    tree = ast.parse(path.read_text(), filename=str(path))
    functions = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    for function in functions:
        calls = [item for item in function.decorator_list if isinstance(item, ast.Call) and isinstance(item.func, ast.Attribute)]
        datasets = [(item, "MATERIALIZED_VIEW") for item in calls if item.func.attr == "materialized_view"]
        datasets += [(item, "STREAMING_TABLE") for item in calls if item.func.attr == "table"]
        expectations = [item for item in calls if item.func.attr in actions]
        if not datasets:
            assert not expectations, f"expectation without dataset: {relative}:{function.name}"
            continue
        assert len(datasets) == 1
        dataset, dataset_type = datasets[0]
        values = [item.value for item in dataset.keywords if item.arg == "name"]
        assert len(values) == 1
        dataset_name = ast.literal_eval(values[0])
        assert isinstance(dataset_name, str) and dataset_name
        fqn = f"{catalog}.{dataset_name}" if "." in dataset_name else f"{catalog}.{bronze_schema}.{dataset_name}"
        actual_outputs.append({"file": relative, "name": dataset_name, "type": dataset_type, "fqn": fqn})
        for decorator in expectations:
            assert len(decorator.args) == 1 and not decorator.keywords
            action, rules = actions[decorator.func.attr], ast.literal_eval(decorator.args[0])
            assert isinstance(rules, dict) and rules
            for name, sql in rules.items():
                actual_rules.append({"file": relative, "dataset": dataset_name, "name": name, "sql": sql, "action": action})
    for call in [node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "create_streaming_table"]:
        values = [item.value for item in call.keywords if item.arg == "name"]
        assert len(values) == 1
        dataset_name = ast.literal_eval(values[0])
        fqn = f"{catalog}.{dataset_name}" if "." in dataset_name else f"{catalog}.{bronze_schema}.{dataset_name}"
        actual_outputs.append({"file": relative, "name": dataset_name, "type": "STREAMING_TABLE", "fqn": fqn})

def canonical(items):
    return sorted(items, key=lambda item: json.dumps(item, sort_keys=True))

def require_exact(expected, actual, label):
    assert canonical(expected) == canonical(actual), {"contract": label, "expected": canonical(expected), "actual": canonical(actual)}

require_exact(expected_outputs, actual_outputs, "datasets")
require_exact(expected_rules, actual_rules, "expectations")
for expected, omitted, label in [
    (expected_outputs, actual_outputs[:-1], "omitted dataset fixture"),
    (expected_rules, actual_rules[:-1], "omitted expectation fixture"),
]:
    try:
        require_exact(expected, omitted, label)
    except AssertionError:
        pass
    else:
        raise AssertionError(f"{label} passed")
print("authoring_manifests=passed omission_fixtures=passed")
```

Run the parser before deployment:

```bash
python3 src/verify_pipeline_authoring.py \
  "src/<pipeline_key>" \
  "$catalog" \
  "${schema_prefix}_bronze" \
  "$OUTPUT_MANIFEST_JSON" \
  "$EXPECTATION_MANIFEST_JSON"
```

Expected: `authoring_manifests=passed omission_fixtures=passed`.
Any omitted or extra dataset, object type, expectation rule, action, SQL expression, file, name, or FQN fails before deployment.

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
Keep every bronze and silver dataset schema-qualified as shown above.
Development mode may prefix the pipeline `target`, so an unqualified dataset can land in `dev_<user>_<target>` even when the bundle variable names the intended bronze schema.
Schema-qualified dataset names preserve the requested medallion layout while the target remains the pipeline default.
Default to serverless and keep each persisted dataset owned by one pipeline.

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
pipeline=$(databricks pipelines get "$pipeline_id" \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
jq -e '
  .spec.serverless == true
  and .spec.continuous == false
  and (.spec.channel | ascii_downcase) == "current"
' >/dev/null <<<"$pipeline"
```

Expected: deployment resolves one pipeline ID and the live pipeline is serverless, triggered, and on the current channel.

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
test "$persistent_bash_pid" = "$$"
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

Derive every runtime output and expected rule from the exact authoring manifests that passed before deployment.
Then verify object types, nonempty outputs, and numeric expectation counters from the exact update.

```bash
mapfile -t output_fqns < <(
  jq -r '.[].fqn' <<<"$OUTPUT_MANIFEST_JSON" | LC_ALL=C sort
)
mapfile -t expectation_dataset_names < <(
  jq -r '.[].dataset' <<<"$EXPECTATION_MANIFEST_JSON" \
    | LC_ALL=C sort -u
)
expectation_dataset_fqns=()
for expectation_dataset_name in "${expectation_dataset_names[@]}"
do
  expectation_dataset_fqns+=("$(
    jq -er --arg name "$expectation_dataset_name" '
      [.[] | select(.name == $name)]
      | select(length == 1)
      | .[0].fqn
    ' <<<"$OUTPUT_MANIFEST_JSON"
  )")
done
mapfile -t quality_rule_names < <(
  jq -r '.[].name' <<<"$EXPECTATION_MANIFEST_JSON" | LC_ALL=C sort
)
test "${#output_fqns[@]}" -eq "$(jq 'length' <<<"$OUTPUT_MANIFEST_JSON")"
test "${#quality_rule_names[@]}" -eq "$(jq 'length' <<<"$EXPECTATION_MANIFEST_JSON")"
dataset_count=0
nonempty_output_count=0
for output_fqn in "${output_fqns[@]}"
do
  table=$(
    databricks tables get "$output_fqn" \
      --profile "$DATABRICKS_CONFIG_PROFILE" -o json
  )
  expected_type=$(jq -er --arg fqn "$output_fqn" '
    [.[] | select(.fqn == $fqn)]
    | select(length == 1)
    | .[0].type
  ' <<<"$OUTPUT_MANIFEST_JSON")
  jq -e --arg expected_type "$expected_type" \
    '.table_type == $expected_type' >/dev/null <<<"$table"
  dataset_count=$((dataset_count + 1))
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
for dataset_fqn in "${expectation_dataset_fqns[@]}"
do
  statement=$(cat <<SQL
SELECT
  expectation.name,
  expectation.passed_records,
  expectation.failed_records
FROM event_log(TABLE($dataset_fqn))
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
printf 'update=%s\ndatasets=%s\nnonempty_outputs=%s\nexpectations=%s\n' \
  "$state" \
  "$dataset_count" \
  "$nonempty_output_count" \
  "$(wc -l <"$observed_rules" | tr -d ' ')"
```

Expected:

```text
update=COMPLETED
datasets=<configured-output-count>
nonempty_outputs=<configured-output-count>
expectations=<configured-rule-count>
```

For file ingestion, record output counts, run one additional update without adding files, and require unchanged counts.
Then add exactly one file and require only its valid rows to appear.
Query `_rescued_data` and representative payloads so schema drift or malformed values cannot pass silently.

For Auto CDC, verify current state and history separately.

```sql
SELECT count(*) AS current_rows
FROM <catalog>.<silver_schema>.<scd_table>
WHERE __END_AT IS NULL;

SELECT <key>, __START_AT, __END_AT
FROM <catalog>.<silver_schema>.<scd_table>
ORDER BY <key>, __START_AT;
```

Verify one insert, update, and delete against the source event contract.
Use selective refresh with fully qualified dataset names for focused recovery.
Do not use full refresh as routine recovery because it resets streaming state and can reprocess data.
Require explicit human approval after explaining the replay and data-loss impact of a full refresh.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| Authentication check fails before validation | The profile targets another account, workspace, or host | Correct the named values or reauthenticate the intended profile before continuing |
| Source precheck reports missing required columns | The human source mapping does not match the live table | Correct the mapping or approve revised dataset logic before authoring |
| Source precheck fails before inspection | A table FQN is malformed, a redundant field differs, or a file contract omits format, schema hints, or evolution mode | Correct the source specification before continuing |
| Quality rule precheck fails | A rule is incomplete, duplicated, or uses an action other than `warn`, `drop`, or `fail` | Correct the rule contract before authoring |
| Authoring manifest validation fails | A dataset, object type, expectation, action, expression, file, name, or FQN is omitted, extra, or changed | Reconcile the complete manifests and focused Python files before deployment |
| Source inspection or deployment returns permission denied | The deployment principal lacks source, schema, or warehouse privileges | Grant the minimum required read, write, and warehouse permissions |
| Pipeline source imports `dlt` | The project uses the legacy pipeline module | Replace it with `from pyspark import pipelines as dp` |
| A batch source is read as a stream | The dataset uses a streaming read for a batch input | Use a materialized view with `spark.read.table` |
| `CREATE_APPEND_ONCE_FLOW_FROM_BATCH_QUERY_NOT_ALLOWED` | A streaming-table file query omitted streaming semantics | Use Auto Loader with `spark.readStream` or `FROM STREAM read_files(...)` |
| File ingestion silently loses malformed fields | Bronze omitted `_rescued_data` or chose an implicit evolution policy | Set the evolution policy explicitly and verify rescued payloads before silver |
| Auto CDC reports an unresolved key or sequence column | The CDC contract does not match the source | Correct keys, operation mapping, and deterministic sequencing before rerunning |
| Bundle validation reports a missing library | The resource path does not match `src/<pipeline_key>/` | Align `root_path`, the glob, and the source directory |
| A materialized view appears under `dev_<user>_<schema>` | Development mode rewrote the default target for an unqualified dataset | Publish every layer with its explicit `<schema>.<dataset>` name and redeploy |
| Pipeline events say another pipeline owns the table | More than one pipeline publishes the same materialized-view FQN | Keep one owning pipeline or choose a new output FQN |
| `tables get` reports another object type | The implementation does not match the manifest-declared dataset type | Use the selected materialized-view or streaming-table API and redeploy |
| The row-count check returns zero | The source is empty or transformation logic removed every row | Inspect the selected source and rule actions before accepting the run |
| The expectation query returns no numeric counters | Rules did not attach, the update ID is wrong, or no rows flowed in that streaming update | Inspect an update that processed rows before concluding the rules are absent |
| Verification passes an idle pipeline while work is active | Polling uses top-level pipeline state or a different update | Poll `get-update` with both the resolved pipeline ID and returned update ID |

## Next

- **Do next:** [Metric Views](/docs/02-databricks-projects/metric-views/)
- **Manual fallback:** [Starter Journey: build the first pipeline](https://databricks-solutions.github.io/starter-journey/docs/07-build-first-pipeline/)
- **Back to section:** [Databricks Projects](/docs/02-databricks-projects/)
