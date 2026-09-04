---
description: Deploy and verify unscheduled pipeline jobs with exact task graphs, dependency order, pipeline update correlation, and nonempty output.
---

# Databricks Jobs

## Mental Model

A Databricks job owns one operational lifecycle, including its trigger, permissions, retries, and task graph.
Use one single-task job when only the pipeline refresh shares that lifecycle.
Use one multi-task DAG when downstream validation must run only after the pipeline succeeds under the same lifecycle.
Use separate jobs when schedule, permissions, retries, or ownership differ.

## Goal

Deploy and run an unscheduled single-task pipeline job and an unscheduled two-task validation DAG, then prove task success, dependency order, pipeline freshness, and nonempty output.

## Prerequisites

- Complete [Spark Declarative Pipelines](/docs/02-databricks-projects/etl-pipelines/).
- Provide an existing bundle-managed pipeline resource key.
- Provide a nonempty pipeline output table and compatible SQL warehouse.
- Provide job create and run permissions.

## Skill

Invoke these verified skills in order:

1. [`databricks-core`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-core)
2. [`databricks-jobs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-jobs)
3. [`databricks-dabs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-dabs)

## Inputs

| Input | Source | How to obtain |
|---|---|---|
| `DATABRICKS_ACCOUNT_ID` | Human-provided | Copy the exact intended Databricks account ID |
| `DATABRICKS_WORKSPACE_ID` | Human-provided | Copy the exact intended workspace ID |
| `DATABRICKS_HOST` | Human-provided | Copy the exact intended workspace URL |
| `DATABRICKS_CONFIG_PROFILE` | Human-provided | Name the valid Databricks CLI profile for that exact workspace |
| `PROJECT_PATH` | Human-provided | Use the absolute local path to the completed project repository |
| `BUNDLE_TARGET` | Human-provided | Set exactly to `dev` |
| `<pipeline_key>` | Human-provided | Provide the existing bundle pipeline resource key |
| `<pipeline_output_fqn>` | Human-provided | Provide the exact nonempty three-part output table name embedded in the validation SQL |
| `<single_job_key>` | Human-provided | Choose the single-task bundle job resource key |
| `<single_job_display_name>` | Human-provided | Choose the single-task job display name |
| `<dag_job_key>` | Human-provided | Choose the two-task DAG bundle job resource key |
| `<dag_job_display_name>` | Human-provided | Choose the two-task DAG display name |
| `<validation_sql_filename>` | Human-provided | Choose the validation SQL filename under `src/` |
| `pipeline_id` | Agent-derived | Resolve `.resources.pipelines[<pipeline_key>].id` from the deployed bundle summary |
| `single_job_id` | Agent-derived | Resolve `.resources.jobs[<single_job_key>].id` from the deployed bundle summary |
| `dag_job_id` | Agent-derived | Resolve `.resources.jobs[<dag_job_key>].id` from the deployed bundle summary |
| `warehouse_id` | Agent-derived | Read the nonempty `warehouse_id` value from strict bundle validation |
| Baseline update ID | Agent-derived | Capture the newest pipeline update immediately before each job trigger |
| Pipeline task window | Agent-derived | Read the exact `refresh_pipeline` task start and end timestamps from each completed run |
| Correlated update ID | Agent-derived | Select the single completed `JOB_TASK` update inside each pipeline task window |

Both jobs use the fixed pipeline task key `refresh_pipeline`.
The DAG uses the fixed downstream task key `validate_output`.

## Run

### 1. Add the single-task pipeline job

Create one bundle resource file under `resources/`.

```yaml
resources:
  jobs:
    <single_job_key>:
      name: <single_job_display_name>
      tasks:
        - task_key: refresh_pipeline
          pipeline_task:
            pipeline_id: ${resources.pipelines.<pipeline_key>.id}
            full_refresh: false
```

This native job has exactly one task and no schedule, trigger, or continuous configuration.
Keep `full_refresh` false unless a human explicitly approves a full rebuild after reviewing its impact and cost.

### 2. Add the read-only validation query

Create `src/<validation_sql_filename>`.

```sql
SELECT assert_true(
  count(*) > 0,
  'The pipeline output must contain at least one row'
)
FROM <pipeline_output_fqn>;
```

The query reads the output and fails when it is empty.

### 3. Add the exact two-task DAG

Create a second bundle resource file under `resources/`.

```yaml
resources:
  jobs:
    <dag_job_key>:
      name: <dag_job_display_name>
      tasks:
        - task_key: refresh_pipeline
          pipeline_task:
            pipeline_id: ${resources.pipelines.<pipeline_key>.id}
            full_refresh: false
        - task_key: validate_output
          depends_on:
            - task_key: refresh_pipeline
          run_if: ALL_SUCCESS
          sql_task:
            warehouse_id: ${var.warehouse_id}
            file:
              path: ../src/<validation_sql_filename>
```

This native job has exactly two tasks, one explicit dependency, and no schedule, trigger, or continuous configuration.

### 4. Validate the exact target, deploy, and resolve IDs

Set every human-provided environment variable before running this block.
Set `PIPELINE_OUTPUT_FQN` to the exact FQN embedded in `src/<validation_sql_filename>`.

```bash
set -euo pipefail
: "${DATABRICKS_ACCOUNT_ID:?}"
: "${DATABRICKS_WORKSPACE_ID:?}"
: "${DATABRICKS_HOST:?}"
: "${DATABRICKS_CONFIG_PROFILE:?}"
: "${PROJECT_PATH:?}"
: "${BUNDLE_TARGET:?}"
: "${PIPELINE_OUTPUT_FQN:?}"
test "$BUNDLE_TARGET" = dev
case "$PROJECT_PATH" in
  /*) ;;
  *) printf 'PROJECT_PATH must be absolute\n' >&2; exit 1 ;;
esac
IFS=. read -r output_catalog output_schema output_table output_extra \
  <<<"$PIPELINE_OUTPUT_FQN"
test -n "$output_catalog"
test -n "$output_schema"
test -n "$output_table"
test -z "$output_extra" || {
  printf 'PIPELINE_OUTPUT_FQN must be a three-part name\n' >&2
  exit 1
}
cd "$PROJECT_PATH"
test "$(pwd -P)" = "$(cd "$PROJECT_PATH" && pwd -P)"
test -f "$PROJECT_PATH/databricks.yml"
validation_sql_file="$PROJECT_PATH/src/<validation_sql_filename>"
test -f "$validation_sql_file"
expected_validation_sql=$(mktemp)
cat >"$expected_validation_sql" <<SQL
SELECT assert_true(
  count(*) > 0,
  'The pipeline output must contain at least one row'
)
FROM $PIPELINE_OUTPUT_FQN;
SQL
diff -u "$expected_validation_sql" "$validation_sql_file"
rm -f "$expected_validation_sql"
databricks auth profiles -o json \
  | jq -e --arg profile "$DATABRICKS_CONFIG_PROFILE" '
      [.profiles[] | select(.name == $profile and .valid == true)]
      | length == 1' >/dev/null
auth=$(databricks auth describe \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
jq -e \
  --arg account "$DATABRICKS_ACCOUNT_ID" \
  --arg workspace "$DATABRICKS_WORKSPACE_ID" \
  --arg host "$DATABRICKS_HOST" '
    {
      host: (.host // .details.host // .details.configuration.host.value),
      account_id: (.account_id // .details.configuration.account_id.value),
      workspace_id: (
        .workspace_id
        // .details.configuration.workspace_id.value
        | tostring
      )
    }
    | select(
        .host == $host
        and .account_id == $account
        and .workspace_id == $workspace
      )' >/dev/null <<<"$auth"
bundle=$(databricks bundle validate --strict --target "$BUNDLE_TARGET" \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
warehouse_id=$(jq -er '
  .variables.warehouse_id.value
  | select(type == "string" and length > 0)' <<<"$bundle")
databricks bundle deploy --target "$BUNDLE_TARGET" \
  --profile "$DATABRICKS_CONFIG_PROFILE" --auto-approve
summary=$(databricks bundle summary --target "$BUNDLE_TARGET" \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
pipeline_id=$(jq -er --arg key "<pipeline_key>" \
  '.resources.pipelines[$key].id | select(type == "string" and length > 0)' \
  <<<"$summary")
single_job_id=$(jq -er --arg key "<single_job_key>" \
  '.resources.jobs[$key].id | tostring | select(length > 0)' <<<"$summary")
dag_job_id=$(jq -er --arg key "<dag_job_key>" \
  '.resources.jobs[$key].id | tostring | select(length > 0)' <<<"$summary")
```

Expected: strict validation targets `dev`, authentication matches the exact account, workspace, and host, and all three deployed resource IDs are nonempty.

### 5. Assert both deployed job graphs before triggering

```bash
single_settings=$(databricks jobs get "$single_job_id" \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
jq -e \
  --arg pipeline_id "$pipeline_id" '
    .settings as $settings
    | (($settings | has("schedule")) | not)
      and (($settings | has("trigger")) | not)
      and (($settings | has("continuous")) | not)
      and ($settings.tasks | length == 1)
      and ($settings.tasks[0].task_key == "refresh_pipeline")
      and ($settings.tasks[0].run_if == "ALL_SUCCESS")
      and ($settings.tasks[0].pipeline_task.pipeline_id == $pipeline_id)
      and ($settings.tasks[0].pipeline_task.full_refresh == false)' \
  >/dev/null <<<"$single_settings"

dag_settings=$(databricks jobs get "$dag_job_id" \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
jq -e \
  --arg pipeline_id "$pipeline_id" \
  --arg warehouse_id "$warehouse_id" '
    .settings as $settings
    | select(
        (($settings | has("schedule")) | not)
        and (($settings | has("trigger")) | not)
        and (($settings | has("continuous")) | not)
      )
    | $settings.tasks
    | select(length == 2)
    | sort_by(.task_key)
    | . as $tasks
    | ($tasks | map(.task_key)) == ["refresh_pipeline", "validate_output"]
      and ($tasks[] | select(.task_key == "refresh_pipeline")
           | .run_if == "ALL_SUCCESS"
             and .pipeline_task.pipeline_id == $pipeline_id
             and .pipeline_task.full_refresh == false)
      and ($tasks[] | select(.task_key == "validate_output")
           | .run_if == "ALL_SUCCESS"
             and .depends_on == [{"task_key":"refresh_pipeline"}]
             and .sql_task.warehouse_id == $warehouse_id
             and (.sql_task.file.path | endswith("/src/<validation_sql_filename>")))' \
  >/dev/null <<<"$dag_settings"
```

Expected: the exact one-task graph and exact two-task dependency graph pass before any trigger.

## Verify

Define fail-closed helpers for idle baseline capture, bounded pagination, exact job polling, update correlation, and output verification.

```bash
capture_idle_baseline() {
  local response update_id update state
  while :
  do
    response=$(databricks pipelines list-updates "$pipeline_id" \
      --max-results 1 --profile "$DATABRICKS_CONFIG_PROFILE" -o json) || return
    update_id=$(jq -er '
      .updates
      | select(length == 1)
      | .[0].update_id
      | select(type == "string" and length > 0)' <<<"$response") || return
    update=$(databricks pipelines get-update "$pipeline_id" "$update_id" \
      --profile "$DATABRICKS_CONFIG_PROFILE" -o json) || return
    state=$(jq -er '.update.state' <<<"$update") || return
    case "$state" in
      COMPLETED|FAILED|CANCELED) printf '%s\n' "$update_id"; return 0 ;;
      CREATED|INITIALIZING|QUEUED|RESETTING|RUNNING|SETTING_UP_TABLES|WAITING_FOR_RESOURCES|STOPPING) sleep 15 ;;
      *) printf 'unknown update state: %s\n' "$state" >&2; return 1 ;;
    esac
  done
}

collect_updates_through_baseline() {
  local baseline=$1 page_token= response pages=0 found=false
  : >"$updates_file"
  while test "$pages" -lt 20
  do
    if test -n "$page_token"
    then
      response=$(databricks pipelines list-updates "$pipeline_id" \
        --max-results 100 --page-token "$page_token" \
        --profile "$DATABRICKS_CONFIG_PROFILE" -o json) || return
    else
      response=$(databricks pipelines list-updates "$pipeline_id" \
        --max-results 100 \
        --profile "$DATABRICKS_CONFIG_PROFILE" -o json) || return
    fi
    jq -c '.updates[]' >>"$updates_file" <<<"$response"
    if jq -e --arg baseline "$baseline" \
      'any(.updates[]; .update_id == $baseline)' >/dev/null <<<"$response"
    then
      found=true
      break
    fi
    page_token=$(jq -r '.next_page_token // empty' <<<"$response")
    test -n "$page_token" || break
    pages=$((pages + 1))
  done
  test "$found" = true || {
    printf 'baseline not found within 2000 newest updates\n' >&2
    return 1
  }
}

poll_job() {
  local run lifecycle
  while :
  do
    run=$(databricks jobs get-run "$run_id" \
      --profile "$DATABRICKS_CONFIG_PROFILE" -o json) || return
    lifecycle=$(jq -er '.state.life_cycle_state' <<<"$run") || return
    case "$lifecycle" in
      TERMINATED)
        jq -e '
          .state.result_state == "SUCCESS"
          and (.tasks | length > 0)
          and all(.tasks[];
            .state.life_cycle_state == "TERMINATED"
            and .state.result_state == "SUCCESS")' >/dev/null <<<"$run" || return
        printf '%s\n' "$run"
        return 0
        ;;
      PENDING|RUNNING|TERMINATING|BLOCKED|WAITING_FOR_RETRY|QUEUED)
        sleep 10
        ;;
      *)
        jq '.state' >&2 <<<"$run"
        return 1
        ;;
    esac
  done
}

assert_exact_job_task_update() {
  local baseline=$1 run_json=$2 task_start task_end update_id update
  task_start=$(jq -er \
    --arg key "$pipeline_task_key" '
      [.tasks[] | select(.task_key == $key)]
      | select(length == 1)
      | .[0].start_time
      | select(type == "number" and . > 0)' <<<"$run_json") || return
  task_end=$(jq -er \
    --arg key "$pipeline_task_key" \
    --argjson start "$task_start" '
      [.tasks[] | select(.task_key == $key)]
      | select(length == 1)
      | .[0].end_time
      | select(type == "number" and . >= $start)' <<<"$run_json") || return
  update_id=$(jq -ser \
    --arg baseline "$baseline" \
    --argjson start "$task_start" \
    --argjson end "$task_end" '
      [.[] | select(
        .update_id != $baseline
        and .cause == "JOB_TASK"
        and .state == "COMPLETED"
        and .creation_time >= $start
        and .creation_time <= $end
      )]
      | select(length == 1)
      | .[0].update_id' "$updates_file") || return
  update=$(databricks pipelines get-update "$pipeline_id" "$update_id" \
    --profile "$DATABRICKS_CONFIG_PROFILE" -o json) || return
  jq -e '
    .update.state == "COMPLETED"
    and .update.cause == "JOB_TASK"' >/dev/null <<<"$update" || return
  printf '%s\n' "$update_id"
}

assert_output_nonempty() {
  local response
  response=$(
    databricks api post /api/2.0/sql/statements \
      --profile "$DATABRICKS_CONFIG_PROFILE" \
      --json "$(jq -n \
        --arg warehouse_id "$warehouse_id" \
        --arg statement "SELECT count(*) FROM $PIPELINE_OUTPUT_FQN" '
          {
            warehouse_id: $warehouse_id,
            statement: $statement,
            wait_timeout: "50s",
            on_wait_timeout: "CANCEL"
          }')"
  ) || return
  jq -e '
    .result.data_array
    | select(length == 1)
    | .[0][0]
    | tonumber
    | select(. > 0)' >/dev/null <<<"$response"
}
```

The idle baseline capture requires one prior update and waits until the newest update is terminal before triggering a job.
The collection reads newest-first pages without `--until-update-id`, whose CLI semantics return the baseline and older updates.
The paginated collection fails if it cannot reach that baseline within 20 pages of 100 updates.
This assumes fewer than 2000 updates occur between immediate baseline capture and run completion.

Run and fully verify the single-task job before capturing the DAG baseline.

```bash
single_baseline=$(capture_idle_baseline)
single_run_id=$(databricks jobs run-now "$single_job_id" \
  --profile "$DATABRICKS_CONFIG_PROFILE" --no-wait -o json \
  | jq -er '.run_id | tostring')
run_id=$single_run_id
run=$(poll_job)
pipeline_task_key=refresh_pipeline
updates_file=$(mktemp)
collect_updates_through_baseline "$single_baseline"
single_update_id=$(assert_exact_job_task_update "$single_baseline" "$run")
assert_output_nonempty
single_task=$(jq -ce '
  [.tasks[] | select(.task_key == "refresh_pipeline")]
  | select(length == 1)
  | .[0]' <<<"$run")
jq -en --argjson task "$single_task" '
  ($task.state.life_cycle_state == "TERMINATED")
  and ($task.state.result_state == "SUCCESS")
  and ($task.start_time | type == "number")
  and ($task.end_time | type == "number")
  and ($task.end_time >= $task.start_time)' >/dev/null
rm -f "$updates_file"
printf '%s\n' \
  'single_job=SUCCESS refresh_pipeline=SUCCESS correlated_updates=1'
```

Expected: the exact job and its only task are `TERMINATED` with result `SUCCESS`, exactly one completed job-task pipeline update falls within the task window, and the output row count is positive.

Only after that sequence passes, run and verify the DAG.

```bash
dag_baseline=$(capture_idle_baseline)
dag_run_id=$(databricks jobs run-now "$dag_job_id" \
  --profile "$DATABRICKS_CONFIG_PROFILE" --no-wait -o json \
  | jq -er '.run_id | tostring')
run_id=$dag_run_id
run=$(poll_job)
pipeline_task_key=refresh_pipeline
updates_file=$(mktemp)
collect_updates_through_baseline "$dag_baseline"
dag_update_id=$(assert_exact_job_task_update "$dag_baseline" "$run")
assert_output_nonempty
refresh_task=$(jq -ce '
  [.tasks[] | select(.task_key == "refresh_pipeline")]
  | select(length == 1)
  | .[0]' <<<"$run")
validate_task=$(jq -ce '
  [.tasks[] | select(.task_key == "validate_output")]
  | select(length == 1)
  | .[0]' <<<"$run")
jq -en \
  --argjson refresh "$refresh_task" \
  --argjson validate "$validate_task" '
    ($refresh.state.life_cycle_state == "TERMINATED")
    and ($refresh.state.result_state == "SUCCESS")
    and ($validate.state.life_cycle_state == "TERMINATED")
    and ($validate.state.result_state == "SUCCESS")
    and ($refresh.start_time | type == "number")
    and ($refresh.end_time | type == "number")
    and ($validate.start_time | type == "number")
    and ($validate.end_time | type == "number")
    and ($refresh.end_time >= $refresh.start_time)
    and ($validate.end_time >= $validate.start_time)
    and ($validate.start_time >= $refresh.end_time)' >/dev/null
rm -f "$updates_file"
printf '%s\n' \
  'dag_job=SUCCESS refresh_pipeline=SUCCESS validate_output=SUCCESS dependency_order=passed correlated_updates=1'
```

Expected output:

```text
single_job=SUCCESS refresh_pipeline=SUCCESS correlated_updates=1
dag_job=SUCCESS refresh_pipeline=SUCCESS validate_output=SUCCESS dependency_order=passed correlated_updates=1
```

The SQL assertion in the DAG and the independent row-count assertion after each job prove the output is nonempty.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| Bundle validation rejects the pipeline reference | `<pipeline_key>` does not identify a pipeline resource in the same bundle | Correct the resource key before deployment |
| A deployed job contains a schedule, trigger, or continuous configuration | The resource has unrequested automatic execution settings | Remove those settings and redeploy |
| A deployed pipeline task has `full_refresh: true` | The job would replace incremental processing with a full rebuild | Stop until a human reviews the rebuild impact and cost and explicitly approves it, or restore `full_refresh: false` and redeploy |
| Validation source check fails | `PIPELINE_OUTPUT_FQN` does not exactly match the FQN embedded in the validation SQL or the source file drifted | Correct the environment value or restore the exact read-only SQL before deployment |
| The deployed graph assertion fails | Task keys, task count, run condition, warehouse, or dependency drifted | Restore the exact resource graph and redeploy |
| `run-now` rejects the request | The command uses a resource key or an unsupported argument form instead of the resolved job ID | Pass the resolved numeric job ID with the shown syntax |
| The poll rejects a terminated run | The job or one of its tasks has a result other than `SUCCESS` | Inspect the exact run output and repair the failing task |
| The validation task never runs | The refresh task failed or the downstream dependency and `ALL_SUCCESS` condition drifted | Repair the refresh or restore the exact DAG |
| The timestamp assertion fails | The downstream task began before the refresh task ended or timestamps are absent | Inspect the exact run and restore the dependency |
| Idle baseline capture does not return | The pipeline has no prior update or its newest update remains active | Complete one pipeline update or wait for the active update to become terminal before triggering the job |
| Pagination exceeds its bound | More than 2000 updates occurred before collection reached the baseline | Repeat from a fresh baseline when update volume is lower |
| Pagination ends before the baseline | The API history does not contain the captured update | Stop and investigate pipeline history before accepting correlation |
| Correlation finds no update | No completed `JOB_TASK` update was created inside the exact pipeline task window | Inspect the pipeline task and update timestamps |
| Correlation finds multiple updates | More than one completed `JOB_TASK` update falls inside the exact task window | Stop and identify the update source before accepting the run |
| The output assertion has no positive count | The pipeline output is empty, the FQN is wrong, or the warehouse cannot query it | Correct the output or permissions and rerun the affected job |

## Next

- **Back to section:** [Databricks Projects](/docs/02-databricks-projects/)
