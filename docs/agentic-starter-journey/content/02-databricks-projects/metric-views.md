---
description: Deploy a governed metric view over project-selected sources and reconcile every semantic result with raw SQL.
---

# Metric Views

## Mental Model

A metric view stores governed dimensions and measures as YAML 1.1 over one source and an optional verified many-to-one join.
Select the no-join or joined branch from the requested definition, then deploy its DDL through an unscheduled bundle SQL job.

## Goal

Deploy one governed metric view and reconcile every semantic result with equivalent raw SQL.

## Prerequisites

- Complete [Spark Declarative Pipelines](/docs/02-databricks-projects/etl-pipelines/).
- Provide read access to every selected source.
- Provide create privileges on the target schema.
- Provide a SQL warehouse compatible with YAML 1.1 metric views.
- Install Databricks CLI v1.1.0 or newer.

## Skill

Invoke these verified skills in order:

1. [`databricks-core`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-core)
2. [`databricks-metric-views`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-metric-views)
3. [`databricks-dbsql`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-dbsql)
4. [`databricks-jobs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-jobs)
5. [`databricks-dabs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-dabs)

## Inputs

| Input | Source | How to obtain |
|---|---|---|
| Databricks target | Human-provided | Provide `DATABRICKS_ACCOUNT_ID`, `DATABRICKS_WORKSPACE_ID`, `DATABRICKS_HOST`, and the matching `DATABRICKS_CONFIG_PROFILE` |
| Existing bundle project path as `PROJECT_PATH` | Human-provided | Use the project completed on the Spark Declarative Pipelines page |
| Metric-view identity | Human-provided | Choose the job key and matching SQL filename, governed view name, and target schema |
| Fact source FQN | Human-provided | Provide the cleaned three-part source name |
| Dimension definitions | Human-provided | Provide names, display names, expressions, comments, and required columns |
| Measure definitions | Human-provided | Provide names, display names, aggregates, comments, and required columns |
| Reconciliation policy | Human-provided | Provide the dimension grain, which is the exact set of dimensions to group by. For every measure provide a comparison mode of exact for integer or count measures, or tolerance with a decimal bound for floating aggregates such as averages and ratios |
| Join definition | Human-provided | Set `METRIC_JOIN_MODE` to `none` or `joined`; for `joined`, provide the source FQN, alias, `left` type, fact key, and dimension key |
| Join quality | Human-provided | For `joined`, require nonnull keys, unique dimension keys, and zero unmatched fact rows |
| Derived verification | Agent-derived | Resolve catalog, warehouse, FQN, and required columns; check source and key quality; translate the selected definition into raw baseline SQL |

For `join_mode=none`, every join-specific input is not applicable and the DDL must not contain a `joins:` block.
For `join_mode=joined`, reject every unmatched fact row.

## Run

Run every shell block in Run and Verify in the same Bash shell so fail-closed options, resolved variables, and helpers persist.

### 0. Verify auth and resolve the active target

Require the named target and the selected branch before reading or deploying project files:

```bash
set -euo pipefail
: "${DATABRICKS_ACCOUNT_ID:?}"
: "${DATABRICKS_WORKSPACE_ID:?}"
: "${DATABRICKS_HOST:?}"
: "${DATABRICKS_CONFIG_PROFILE:?}"
: "${PROJECT_PATH:?}"
: "${METRIC_JOIN_MODE:?}"
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
metric_view_schema='<metric_view_schema>'
metric_view_name='<metric_view_name>'
metric_view_fqn="$catalog.$metric_view_schema.$metric_view_name"
fact_fqn='<fact_source_fqn>'
required_fact_columns=(
  "<fact_dimension_column>"
  "<date_column>"
  "<measure_input_column>"
)
join_mode=$METRIC_JOIN_MODE
case "$join_mode" in
  none)
    join_fqn=
    join_name=
    fact_join_key=
    join_key=
    required_join_columns=()
    ;;
  joined)
    join_fqn='<join_source_fqn>'
    join_name='<join_name>'
    fact_join_key='<fact_join_key>'
    join_key='<join_key>'
    required_fact_columns+=("<fact_join_key>")
    required_join_columns=("<join_key>" "<join_dimension_column>")
    ;;
  *)
    printf 'METRIC_JOIN_MODE must be none or joined\n' >&2
    exit 1
    ;;
esac
# Verification model.
# The metric view may have any number of dimensions and measures, not only three of each.
# These two arrays are the single source of truth for every Verify step below.
# Add one line per dimension and one line per measure the design actually has.
#
# Dimension entry: <name>|<raw_expr>.
# raw_expr rebuilds the dimension from the raw sources, using the join alias for joined columns.
dimensions=(
  "<dimension_one>|<raw_dimension_one_expression>"
  "<dimension_two>|<raw_dimension_two_expression>"
  "<dimension_three>|<raw_dimension_three_expression>"
)
# Measure entry: <name>|<comparison>|<tolerance>|<raw_expr>.
# comparison is exact for integer or count measures, or tolerance for floating aggregates such as averages.
# tolerance is the decimal bound for tolerance measures and empty for exact measures.
measures=(
  "<measure_one>|tolerance|<decimal_tolerance>|<raw_measure_one_expression>"
  "<measure_two>|exact||<raw_measure_two_expression>"
  "<measure_three>|tolerance|<decimal_tolerance>|<raw_measure_three_expression>"
)
# One display name per dimension and per measure, matching the deployed column set exactly.
# List every dimension and every measure, not only the first three.
expected_display_names_json='{
  "<dimension_one>": "<dimension_one_display_name>",
  "<dimension_two>": "<dimension_two_display_name>",
  "<dimension_three>": "<dimension_three_display_name>",
  "<measure_one>": "<measure_one_display_name>",
  "<measure_two>": "<measure_two_display_name>",
  "<measure_three>": "<measure_three_display_name>"
}'
# Raw baseline FROM clause for the selected branch.
case "$join_mode" in
  joined) raw_from="FROM $fact_fqn source LEFT JOIN $join_fqn $join_name ON source.$fact_join_key = $join_name.$join_key" ;;
  none)   raw_from="FROM $fact_fqn source" ;;
esac
# Build the SQL fragments used by every Verify step from the arrays above.
# Every dimension and every measure is covered, so a wider view cannot pass with unchecked columns.
dim_list=; metric_measure_list=; raw_dim_list=; raw_measure_list=
null_pred=; join_pred=; mismatch_pred=
for dimension in "${dimensions[@]}"
do
  name=${dimension%%|*}; expr=${dimension#*|}
  dim_list+="${dim_list:+, }$name"
  raw_dim_list+="${raw_dim_list:+, }$expr AS $name"
  null_pred+="${null_pred:+ OR }$name IS NULL"
  join_pred+="${join_pred:+ AND }m.$name <=> r.$name"
done
for measure in "${measures[@]}"
do
  IFS='|' read -r name mode tolerance expr <<<"$measure"
  metric_measure_list+=", MEASURE($name) AS $name"
  raw_measure_list+=", $expr AS $name"
  null_pred+=" OR $name IS NULL"
  if test "$mode" = exact
  then
    mismatch_pred+="${mismatch_pred:+ OR }NOT (m.$name <=> r.$name)"
  else
    mismatch_pred+="${mismatch_pred:+ OR }m.$name IS NULL OR r.$name IS NULL OR abs(m.$name - r.$name) > $tolerance"
  fi
done

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

Expected: auth matches every human-provided target, strict validation succeeds, and catalog and warehouse resolve from the active `dev` target.

### 1. Verify sources and optional join quality

Check required columns in every selected source.
For the joined branch, always reject null keys and duplicate dimension keys.
Reject every unmatched fact row.

```bash
assert_columns() {
  local source_fqn=$1
  shift
  local required=("$@") response required_file observed_file missing
  response=$(run_sql "DESCRIBE TABLE $source_fqn") || return
  required_file=$(mktemp)
  observed_file=$(mktemp)
  printf '%s\n' "${required[@]}" | LC_ALL=C sort -u >"$required_file"
  jq -r '
    .result.data_array[]?
    | .[0]
    | select(type == "string")
    | select(startswith("#") | not)' <<<"$response" \
    | LC_ALL=C sort -u >"$observed_file"
  missing=$(comm -23 "$required_file" "$observed_file")
  rm -f "$required_file" "$observed_file"
  test -z "$missing" || {
    printf 'missing columns in %s:\n%s\n' "$source_fqn" "$missing" >&2
    return 1
  }
}

assert_columns "$fact_fqn" "${required_fact_columns[@]}"
if test "$join_mode" = joined
then
  assert_columns "$join_fqn" "${required_join_columns[@]}"
  statement=$(cat <<SQL
WITH duplicate_join_keys AS (
  SELECT $join_key
  FROM $join_fqn
  GROUP BY $join_key
  HAVING count(*) > 1
),
unmatched_fact_rows AS (
  SELECT f.$fact_join_key
  FROM $fact_fqn f
  LEFT ANTI JOIN $join_fqn d
    ON f.$fact_join_key = d.$join_key
)
SELECT
  (SELECT count(*) FROM $fact_fqn WHERE $fact_join_key IS NULL) AS null_fact_keys,
  (SELECT count(*) FROM $join_fqn WHERE $join_key IS NULL) AS null_join_keys,
  (SELECT count(*) FROM duplicate_join_keys) AS duplicate_join_keys,
  (SELECT count(*) FROM unmatched_fact_rows) AS unmatched_fact_rows
SQL
)
  join_quality=$(run_sql "$statement")
  join_counts=$(jq -cer '
    .result.data_array
    | select(length == 1)
    | .[0]
    | map(tonumber)
    | select(length == 4)' <<<"$join_quality")
  jq -en --argjson counts "$join_counts" '
    $counts[0] == 0
    and $counts[1] == 0
    and $counts[2] == 0
    and $counts[3] == 0' >/dev/null
  jq -en '
    ([0, 0, 0, 0] | all(. == 0))
    and (([0, 0, 0, 1] | all(. == 0)) | not)' >/dev/null
  printf '%s\n' \
    'source_columns=passed join_quality=passed unmatched_rows=0'
else
  printf '%s\n' 'source_columns=passed join_quality=not_applicable'
fi
```

Expected for the joined branch: `source_columns=passed join_quality=passed unmatched_rows=0`.

Null keys and duplicate dimension keys always fail.
Every unmatched row fails.
The no-join branch prints `source_columns=passed join_quality=not_applicable`.

### 2. Add exactly one YAML 1.1 metric-view DDL

For `join_mode=none`, create `src/<metric_view_job_key>.metric_view.sql` with this shape:

```sql
CREATE SCHEMA IF NOT EXISTS IDENTIFIER({{catalog}} || '.<metric_view_schema>');
USE CATALOG IDENTIFIER({{catalog}});
USE SCHEMA <metric_view_schema>;

CREATE OR REPLACE VIEW <metric_view_name>
WITH METRICS
LANGUAGE YAML
AS $$
version: 1.1
source: <source_fqn>

dimensions:
  - name: <dimension_name>
    display_name: <dimension_display_name>
    expr: source.<dimension_column>
    comment: <dimension_comment>

measures:
  - name: <measure_name>
    display_name: <measure_display_name>
    expr: <measure_expression>
    comment: <measure_comment>
$$;
```

For `join_mode=joined`, create the same file with this shape:

```sql
CREATE SCHEMA IF NOT EXISTS IDENTIFIER({{catalog}} || '.<metric_view_schema>');
USE CATALOG IDENTIFIER({{catalog}});
USE SCHEMA <metric_view_schema>;

CREATE OR REPLACE VIEW <metric_view_name>
WITH METRICS
LANGUAGE YAML
AS $$
version: 1.1
source: <source_fqn>

joins:
  - name: <join_name>
    source: <join_source_fqn>
    'on': source.<source_join_key> = <join_name>.<dimension_join_key>

dimensions:
  - name: <dimension_name>
    display_name: <dimension_display_name>
    expr: <dimension_expression>
    comment: <dimension_comment>

measures:
  - name: <measure_name>
    display_name: <measure_display_name>
    expr: <measure_expression>
    comment: <measure_comment>
$$;
```

Select exactly one DDL shape from `join_mode`.
Both branches require YAML version 1.1 and display names.
Only the joined branch contains `joins:` and the quoted `'on'` key.
The service may serialize that quoted key with double quotes in persisted metadata.
The no-join branch requires no join input.

### 3. Add one unscheduled SQL job

Create `resources/<metric_view_job_key>.job.yml`:

```yaml
resources:
  jobs:
    <metric_view_job_key>:
      name: <metric_view_name>
      parameters:
        - name: catalog
          default: ${var.catalog}
      tasks:
        - task_key: create_metric_view
          sql_task:
            warehouse_id: ${var.warehouse_id}
            file:
              path: ../src/<metric_view_job_key>.metric_view.sql
```

Do not add a schedule or trigger.
The resource key is a job because metric views are not native bundle resources.

### 4. Deploy, run, and poll the job

Use the Databricks CLI v1.1.0 positional forms for job and run IDs:

```bash
databricks bundle validate --strict --target dev --profile "$DATABRICKS_CONFIG_PROFILE"
databricks bundle deploy --target dev --profile "$DATABRICKS_CONFIG_PROFILE" --auto-approve
job_id=$(databricks bundle summary --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json \
  | jq -er --arg key "<metric_view_job_key>" '.resources.jobs[$key].id | tostring')
run_id=$(databricks jobs run-now "$job_id" \
  --profile "$DATABRICKS_CONFIG_PROFILE" --no-wait -o json \
  | jq -er '.run_id | tostring')
while :
do
  run=$(databricks jobs get-run "$run_id" \
    --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
  lifecycle=$(jq -er '.state.life_cycle_state' <<<"$run")
  case "$lifecycle" in
    TERMINATED)
      jq -e '.state.result_state == "SUCCESS"' >/dev/null <<<"$run"
      break
      ;;
    PENDING|RUNNING|TERMINATING|BLOCKED|WAITING_FOR_RETRY|QUEUED) sleep 10 ;;
    *) jq '.state' >&2 <<<"$run"; exit 1 ;;
  esac
done
```

Expected: only terminal `SUCCESS` passes.

## Verify

### Verify metadata and semantic validity

Require the exact object type, display names, YAML version, and branch-specific join shape.
Then require positive semantic rows with no null dimensions or measures.

Create `src/verify_metric_yaml.py` with this standard-library parser:

```text
import json, sys
path, expected, mode, name, source, fact_key, join_key = sys.argv[1:]
def scalar(text):
    text = text.strip()
    return text[1:-1].replace(text[0] * 2, text[0]) if len(text) > 1 and text[0] == text[-1] and text[0] in "'\"" else text
def pair(text):
    quote = colon = None; cut, index = len(text), 0
    while index < len(text):
        char = text[index]
        if quote is not None:
            if quote == '"' and char == "\\": index += 2; continue
            if char == quote:
                if index + 1 < len(text) and text[index + 1] == quote: index += 2; continue
                quote = None
        elif char in "'\"": quote = char
        elif char == "#": cut = index; break
        elif char == ":" and colon is None: colon = index
        index += 1
    return None if colon is None else (text[:colon].strip(), text[colon + 1:cut].strip())
def parse(text):
    versions, joins, active, block, item, item_indent = [], [], False, None, None, None
    for raw in text.splitlines():
        indent = len(raw) - len(raw.lstrip(" "))
        if not raw.strip(): continue
        if block is not None:
            if indent > block: continue
            block = None
        body = raw[indent:]; parsed = pair(body)
        if not parsed: continue
        raw_key, value = parsed; key = scalar(raw_key)
        if value and value[0] in "|>" and set(value[1:]) <= set("+-0123456789"): block = indent
        if indent == 0:
            active, item, item_indent = key == "joins", None, None
            if key == "version": versions.append(scalar(value))
            if active: joins.append([])
        elif active and body.startswith("- "):
            joins[-1].append({}); item, item_indent = joins[-1][-1], indent
            raw_key, value = pair(body[2:].lstrip()) or ("", ""); key = scalar(raw_key)
            if key: item[key] = (raw_key, scalar(value))
        elif active and item is not None and indent == item_indent + 2:
            if key in item: raise AssertionError(f"duplicate join key: {key}")
            item[key] = (raw_key, scalar(value))
    return versions, joins
def valid(text, selected_mode):
    versions, joins = parse(text)
    if versions != ["1.1"]: return False
    if selected_mode == "none": return not joins
    if len(joins) != 1 or len(joins[0]) != 1: return False
    entry = joins[0][0]; wanted = f"source.{fact_key} = {name}.{join_key}"
    return entry.get("name", (None, None))[1] == name and entry.get("source", (None, None))[1] == source and entry.get("on", (None, None))[0] in {"'on'", '"on"'} and " ".join(entry.get("on", (None, ""))[1].split()) == wanted
single = f"version: 1.1\njoins:\n  - name: {name}\n    source: {source}\n    'on': source.{fact_key} = {name}.{join_key}"
double = single.replace("'on'", '"on"')
wrong = single.replace(f"source.{fact_key} = {name}.{join_key}", "source.wrong = wrong.key") + f"\nnote: >\n  'on': source.{fact_key} = {name}.{join_key}"
quoted = f'version: 1.1\nnote: "\'on\': source.{fact_key} = {name}.{join_key}"'
block = f"version: 1.1\nnote: |\n  'on': source.{fact_key} = {name}.{join_key}"
assert valid(single, "joined") and valid(double, "joined")
assert all(not valid(case, "joined") for case in [single.replace("    'on':", "    # 'on':"), quoted, block, wrong])
assert not valid("joins:\nversion: 1.1", "none")
description = json.load(open(path))
display = {column["name"]: column.get("metadata", {}).get("display_name") for column in description["columns"] if column.get("metadata", {}).get("display_name") is not None}
assert description["type"] == "METRIC_VIEW" and display == json.loads(expected) and valid(description["view_text"], mode)
```

The parser ignores comments, quoted scalar content, and indented literal or folded block-scalar bodies.
Its fixtures reject each false-positive shape before live metadata is evaluated.

```bash
metric_cte="metric AS (
  SELECT $dim_list$metric_measure_list, 1 AS row_present
  FROM $metric_view_fqn
  GROUP BY ALL
)"
metadata=$(
  run_sql "DESCRIBE TABLE EXTENDED $metric_view_fqn AS JSON"
)
description_file=$(mktemp)
jq -er '.result.data_array | select(length == 1) | .[0][0] | fromjson' \
  >"$description_file" <<<"$metadata"
python3 src/verify_metric_yaml.py "$description_file" \
  "$expected_display_names_json" "$join_mode" "$join_name" "$join_fqn" \
  "$fact_join_key" "$join_key"
rm -f "$description_file"

semantic_statement=$(cat <<SQL
WITH $metric_cte
SELECT
  count(*) AS metric_rows,
  count_if($null_pred) AS invalid_rows
FROM metric
SQL
)
run_sql "$semantic_statement" \
  | jq -e '
      .result.data_array
      | select(length == 1)
      | .[0]
      | map(tonumber)
      | select(.[0] > 0 and .[1] == 0)' >/dev/null
printf '%s\n' 'metadata=passed semantic_query=passed'
```

Expected: `metadata=passed semantic_query=passed`.

### Reconcile semantic and raw results

Build the raw baseline independently from the same dimension and measure lists:

```bash
raw_cte=$(cat <<SQL
raw AS (
  SELECT $raw_dim_list$raw_measure_list, 1 AS row_present
  $raw_from
  GROUP BY ALL
)
SQL
)

reconciliation_statement=$(cat <<SQL
WITH $metric_cte,
$raw_cte,
validity AS (
  SELECT
    (SELECT count(*) FROM metric WHERE $null_pred) AS metric_null_rows,
    (SELECT count(*) FROM raw WHERE $null_pred) AS raw_null_rows
),
mismatches AS (
  SELECT 1
  FROM metric m
  FULL OUTER JOIN raw r ON $join_pred
  WHERE m.row_present IS NULL
     OR r.row_present IS NULL
     OR $mismatch_pred
)
SELECT
  (SELECT count(*) FROM metric) AS metric_rows,
  (SELECT count(*) FROM raw) AS raw_rows,
  (SELECT metric_null_rows FROM validity) AS metric_null_rows,
  (SELECT raw_null_rows FROM validity) AS raw_null_rows,
  count(*) AS mismatch_rows
FROM mismatches
SQL
)
run_sql "$reconciliation_statement" \
  | jq -e '
      .result.data_array
      | select(length == 1)
      | .[0]
      | map(tonumber)
      | select(
          .[0] > 0
          and .[0] == .[1]
          and .[2] == 0
          and .[3] == 0
          and .[4] == 0
        )' >/dev/null
printf '%s\n' \
  'metric_rows>0 metric_rows=raw_rows metric_null_rows=0 raw_null_rows=0 mismatch_rows=0'
```

Expected: `metric_rows>0 metric_rows=raw_rows metric_null_rows=0 raw_null_rows=0 mismatch_rows=0`.

The raw baseline is built independently from the same dimension and measure lists.
The result proves positive equal row counts, no nulls, per measure comparisons and tolerances, and zero mismatches across every dimension and every measure.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| Auth validation fails | The target is missing or mismatched | Reauthenticate the named profile and repeat the precheck |
| Warehouse rejects DDL or queries | It is incompatible with YAML 1.1 metric views | Select a compatible warehouse and revalidate the target |
| Creation or metadata validation fails | YAML version, display names, quoted `on` key, join entry, or expression drifted | Restore the selected YAML shape and redeploy |
| DDL contains `{{catalog}}` | The catalog parameter is missing | Restore the parameter and target variable |
| Source-column validation fails | An expression references a missing column | Correct the definition or source |
| Join quality fails | Keys are null or duplicated | Repair keys before using the join |
| Unmatched rows fail | A fact has no dimension match | Repair the source relationship before deployment |
| Job is not successful | Its SQL task failed or was skipped | Repair the captured task error |
| Semantic or reconciliation validation fails | Results contain nulls, unequal rows, or measure mismatches | Align source, dimensions, measures, grain, comparisons, and tolerance |
| Verification passes but a dimension or measure is never checked | The dimensions or measures array omitted a column, so a wider view rolled up to the listed columns and the extra column went unverified | List every dimension and every measure in the arrays, then rerun |
| Creation fails with INVALID_EXTRACT_BASE_FIELD_TYPE | A join alias has the same name as a dimension, so a joined column reference resolves to the dimension | Rename the join so its alias differs from every dimension name |

## Next

- **Do next:** [Dashboards](/docs/02-databricks-projects/dashboards/)
- **Back to section:** [Databricks Projects](/docs/02-databricks-projects/)
