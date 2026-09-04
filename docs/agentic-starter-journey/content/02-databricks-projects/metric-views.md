---
description: Deploy a governed metric view over project-selected sources and reconcile every semantic result with raw SQL.
---

# Metric Views

## Mental Model

A metric view stores governed dimensions and measures as YAML 1.1 over one cleaned source, with an optional verified many-to-one join.
Use the no-join branch when every dimension and measure comes from one source.
Use the joined branch only when the requested semantic definition needs a second source and its join quality checks pass.
Deploy the DDL through an unscheduled bundle-managed SQL job because metric views are not a native bundle resource.

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
| Databricks account ID as `DATABRICKS_ACCOUNT_ID` | Human-provided | Use the account ID named for this deployment |
| Workspace ID as `DATABRICKS_WORKSPACE_ID` | Human-provided | Use the workspace ID named for this deployment |
| Workspace host as `DATABRICKS_HOST` | Human-provided | Use the named workspace URL |
| Workspace CLI profile as `DATABRICKS_CONFIG_PROFILE` | Human-provided | Use the named profile for the target workspace |
| Existing bundle project path as `PROJECT_PATH` | Human-provided | Use the project completed on the Spark Declarative Pipelines page |
| Metric-view job key | Human-provided | Choose the bundle resource key and matching SQL filename |
| Metric-view name | Human-provided | Choose the governed view name |
| Metric-view target schema | Human-provided | Choose the schema created in the active target catalog |
| Fact source FQN | Human-provided | Provide the cleaned three-part source name |
| Dimension definitions | Human-provided | Provide each dimension name, display name, source expression, comment, and required source column |
| Measure definitions | Human-provided | Provide each measure name, display name, aggregate expression, comment, and required source column |
| Validation grain | Human-provided | Provide the complete dimension set used by both semantic and raw `GROUP BY ALL` queries |
| Decimal tolerance | Human-provided | Provide the maximum accepted absolute difference for each decimal measure |
| Exact-measure comparison policy | Human-provided | Identify measures that must use null-safe exact equality |
| Join mode as `METRIC_JOIN_MODE` | Human-provided | Set exactly `none` or `joined` |
| Join source FQN | Human-provided | Required for `joined`; not applicable for `none` |
| Join alias | Human-provided | Required for `joined`; not applicable for `none` |
| Join type | Human-provided | Set `left` for `joined`; not applicable for `none` |
| Fact join key | Human-provided | Required for `joined`; not applicable for `none` |
| Dimension join key | Human-provided | Required for `joined`; not applicable for `none` |
| Join-key non-null policy | Human-provided | Set `reject` for both key sides in `joined`; not applicable for `none` |
| Dimension-key uniqueness policy | Human-provided | Set `reject` for duplicate dimension keys in `joined`; not applicable for `none` |
| `UNMATCHED_ROW_POLICY` | Human-provided | Use `reject` by default for `joined`; set `accept` only when this row explicitly records acceptance of unmatched fact rows and that their joined dimensions become null; not applicable for `none` |
| Required source columns | Agent-derived | Derive from all selected dimension, measure, and join expressions |
| Source and key quality | Agent-derived | Run the column, null-key, uniqueness, and unmatched-row checks before writing DDL |
| Target catalog | Agent-derived | Read `.variables.catalog.value` from strict bundle validation |
| SQL warehouse ID | Agent-derived | Read `.variables.warehouse_id.value` from strict bundle validation |
| Metric-view FQN | Agent-derived | Combine the active catalog, target schema, and metric-view name |
| Raw baseline SQL | Agent-derived | Translate the dimensions, measures, grain, and selected join branch into independent raw SQL |

For `join_mode=none`, every join-specific input is not applicable and the DDL must not contain a `joins:` block.
For `join_mode=joined`, refuse `UNMATCHED_ROW_POLICY=accept` unless the human-provided input explicitly records both acceptance and the null-dimension consequence.

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
    fact_join_key=
    join_key=
    unmatched_row_policy=not_applicable
    required_join_columns=()
    ;;
  joined)
    join_fqn='<join_source_fqn>'
    fact_join_key='<fact_join_key>'
    join_key='<join_key>'
    unmatched_row_policy=${UNMATCHED_ROW_POLICY:-reject}
    case "$unmatched_row_policy" in
      reject) ;;
      accept)
        test "${UNMATCHED_ROW_POLICY+x}" = x || {
          printf 'accept requires an explicit human-provided input\n' >&2
          exit 1
        }
        ;;
      *)
        printf 'UNMATCHED_ROW_POLICY must be reject or accept\n' >&2
        exit 1
        ;;
    esac
    required_fact_columns+=("<fact_join_key>")
    required_join_columns=("<join_key>" "<join_dimension_column>")
    ;;
  *)
    printf 'METRIC_JOIN_MODE must be none or joined\n' >&2
    exit 1
    ;;
esac
expected_display_names_json='{
  "<dimension_one>": "<dimension_one_display_name>",
  "<dimension_two>": "<dimension_two_display_name>",
  "<dimension_three>": "<dimension_three_display_name>",
  "<measure_one>": "<measure_one_display_name>",
  "<measure_two>": "<measure_two_display_name>",
  "<measure_three>": "<measure_three_display_name>"
}'

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
Reject unmatched rows by default and allow them only under the explicit human-approved policy.

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
    and $counts[2] == 0' >/dev/null
  unmatched_rows=$(jq -er '.[3] | select(. >= 0)' <<<"$join_counts")
  case "$unmatched_row_policy" in
    reject)
      test "$unmatched_rows" -eq 0
      printf '%s\n' \
        'source_columns=passed join_quality=passed unmatched_rows=0 unmatched_policy=reject'
      ;;
    accept)
      printf \
        'source_columns=passed join_quality=passed unmatched_rows=%s unmatched_policy=accepted\n' \
        "$unmatched_rows"
      ;;
  esac
else
  printf '%s\n' 'source_columns=passed join_quality=not_applicable'
fi
```

Expected with the default policy: `source_columns=passed join_quality=passed unmatched_rows=0 unmatched_policy=reject`.
Expected only with explicit human acceptance: `source_columns=passed join_quality=passed unmatched_rows=<observed-nonnegative-count> unmatched_policy=accepted`.

Null keys and duplicate dimension keys always fail.
Unmatched rows fail by default and pass only when the input explicitly sets `UNMATCHED_ROW_POLICY=accept`.
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

```bash
root_joins_pattern='(?m)^joins:[ \t]*$'
join_on_pattern="(?m)^    ['\"]on['\"]: source[.]<fact_join_key> = <join_name>[.]<join_key>[ \t]*$"
metadata=$(
  run_sql "DESCRIBE TABLE EXTENDED $metric_view_fqn AS JSON"
)
jq -e \
  --argjson expected "$expected_display_names_json" \
  --arg join_mode "$join_mode" \
  --arg root_joins_pattern "$root_joins_pattern" \
  --arg join_on_pattern "$join_on_pattern" '
    .result.data_array
    | select(length == 1)
    | .[0][0]
    | fromjson
    | . as $description
    | ([
        $description.columns[]
        | select(.metadata.display_name != null)
        | {key: .name, value: .metadata.display_name}
      ] | from_entries) as $actual
    | select(
        $description.type == "METRIC_VIEW"
        and $actual == $expected
        and ($description.view_text | test("(?m)^version: 1[.]1[ \t]*$"))
        and (
          if $join_mode == "joined"
          then (
            ($description.view_text | test($root_joins_pattern))
            and ($description.view_text | test($join_on_pattern))
          )
          else ($description.view_text | test($root_joins_pattern) | not)
          end
        )
      )' >/dev/null <<<"$metadata"

semantic_statement=$(cat <<SQL
WITH metric AS (
  SELECT
    <dimension_one>,
    <dimension_two>,
    <dimension_three>,
    MEASURE(<measure_one>) AS <measure_one>,
    MEASURE(<measure_two>) AS <measure_two>,
    MEASURE(<measure_three>) AS <measure_three>
  FROM $metric_view_fqn
  GROUP BY ALL
)
SELECT
  count(*) AS metric_rows,
  count_if(
    <dimension_one> IS NULL
    OR <dimension_two> IS NULL
    OR <dimension_three> IS NULL
    OR <measure_one> IS NULL
    OR <measure_two> IS NULL
    OR <measure_three> IS NULL
  ) AS invalid_rows
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

Build the raw baseline independently for the selected branch:

```bash
if test "$join_mode" = joined
then
  raw_cte=$(cat <<SQL
raw AS (
  SELECT
    <joined_raw_dimension_one_expression> AS <dimension_one>,
    <joined_raw_dimension_two_expression> AS <dimension_two>,
    <joined_raw_dimension_three_expression> AS <dimension_three>,
    <raw_measure_one_expression> AS <measure_one>,
    <raw_measure_two_expression> AS <measure_two>,
    <raw_measure_three_expression> AS <measure_three>,
    1 AS row_present
  FROM $fact_fqn source
  LEFT JOIN $join_fqn <join_name>
    ON source.<fact_join_key> = <join_name>.<join_key>
  GROUP BY ALL
)
SQL
)
else
  raw_cte=$(cat <<SQL
raw AS (
  SELECT
    <no_join_raw_dimension_one_expression> AS <dimension_one>,
    <no_join_raw_dimension_two_expression> AS <dimension_two>,
    <no_join_raw_dimension_three_expression> AS <dimension_three>,
    <raw_measure_one_expression> AS <measure_one>,
    <raw_measure_two_expression> AS <measure_two>,
    <raw_measure_three_expression> AS <measure_three>,
    1 AS row_present
  FROM $fact_fqn source
  GROUP BY ALL
)
SQL
)
fi

reconciliation_statement=$(cat <<SQL
WITH metric AS (
  SELECT
    <dimension_one>,
    <dimension_two>,
    <dimension_three>,
    MEASURE(<measure_one>) AS <measure_one>,
    MEASURE(<measure_two>) AS <measure_two>,
    MEASURE(<measure_three>) AS <measure_three>,
    1 AS row_present
  FROM $metric_view_fqn
  GROUP BY ALL
),
$raw_cte,
validity AS (
  SELECT
    (SELECT count(*) FROM metric WHERE
      <dimension_one> IS NULL
      OR <dimension_two> IS NULL
      OR <dimension_three> IS NULL
      OR <measure_one> IS NULL
      OR <measure_two> IS NULL
      OR <measure_three> IS NULL) AS metric_null_rows,
    (SELECT count(*) FROM raw WHERE
      <dimension_one> IS NULL
      OR <dimension_two> IS NULL
      OR <dimension_three> IS NULL
      OR <measure_one> IS NULL
      OR <measure_two> IS NULL
      OR <measure_three> IS NULL) AS raw_null_rows
),
mismatches AS (
  SELECT 1
  FROM metric m
  FULL OUTER JOIN raw r
    ON m.<dimension_one> <=> r.<dimension_one>
   AND m.<dimension_two> <=> r.<dimension_two>
   AND m.<dimension_three> <=> r.<dimension_three>
  WHERE m.row_present IS NULL
     OR r.row_present IS NULL
     OR m.<measure_one> IS NULL
     OR r.<measure_one> IS NULL
     OR abs(m.<measure_one> - r.<measure_one>) > <decimal_tolerance>
     OR NOT (m.<measure_two> <=> r.<measure_two>)
     OR m.<measure_three> IS NULL
     OR r.<measure_three> IS NULL
     OR abs(m.<measure_three> - r.<measure_three>) > <decimal_tolerance>
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

Both raw SQL branches are independently executable.
One result row proves positive semantic rows, equal row counts, zero null dimensions or measures on both sides, configured null-safe exact comparisons and decimal tolerances, and zero mismatches.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| Auth or active-target validation fails | A required target value is missing or the profile reaches another workspace | Reauthenticate the named profile against the named host and repeat the full precheck |
| Warehouse rejects metric-view DDL or semantic queries | The selected warehouse is incompatible with YAML 1.1 metric views | Select a compatible warehouse, update the active bundle target, and repeat validation |
| Metric-view creation rejects the YAML | The version, dimension, measure, or join definition is invalid | Align the selected DDL branch with the verified YAML 1.1 shape |
| Metadata reports a drifted join expression | The persisted quoted `on` key or join expression changed | Restore the authored quoted key and the verified key mapping |
| DDL contains unresolved `{{catalog}}` | The job parameter or bundle catalog variable is missing | Restore the `catalog` parameter and active-target variable |
| Source-column assertion fails | A selected expression references a missing or renamed column | Correct the input definition or upstream source before deployment |
| Join quality fails on null or duplicate keys | The dimension relationship is not many-to-one | Repair the source keys before using the joined branch |
| Unmatched rows fail under the default policy | Fact rows have no dimension match | Repair the sources or obtain explicit human acceptance with its null-dimension consequence |
| Semantic validity reports nulls | A dimension, measure, or accepted unmatched join produced null output | Correct the semantic definition or reject unmatched rows before downstream use |
| Job reaches a terminal non-success state | The SQL task failed, was skipped, or encountered an internal error | Inspect the captured run and repair its task error before retrying |
| Metadata assertion fails | The object type, display names, YAML version, or branch-specific join shape drifted | Compare the deployed description with the selected DDL and redeploy |
| Reconciliation reports unequal rows or mismatches | The semantic and raw dimensions, measures, join, grain, exact comparison, or tolerance differ | Stop downstream work and align both definitions |
| Reconciliation reports null rows | Either side emitted a null dimension or measure | Repair the source or definition because nulls fail closed even when keys compare null-safely |

## Next

- **Do next:** [Dashboards](/docs/02-databricks-projects/dashboards/)
- **Back to section:** [Databricks Projects](/docs/02-databricks-projects/)
