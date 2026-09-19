---
description: Deploy and verify one project-defined Lakeflow Job whose tasks, graph, trigger, and postconditions come from the project contract.
---

# Databricks Jobs

## Mental Model

A Lakeflow Job coordinates project-defined tasks under one operational lifecycle, including permissions, retries, parameters, and execution policy.
Choose each task type from the workload: notebook, Python, SQL, dbt, pipeline, JAR, nested job, or for-each.
Put tasks in one job when they share that lifecycle.
Put them in separate jobs when ownership, permissions, retries, or execution policy differ.

## Goal

Add one project-defined Lakeflow Job to the existing bundle, deploy it, and prove the deployed graph matches the contract and the declared postconditions hold.

## Prerequisites

- Complete the [Project repo](/docs/02-databricks-projects/project-repo/) outcome.
- Provide every source file, warehouse, cluster, or bundle resource the selected tasks reference.
- Configure workspace authentication for the intended account, workspace, and host.
- Provide job create and run permissions.

## Skill

Invoke these verified skills in order:

1. [`databricks-core`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-core)
2. [`databricks-jobs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-jobs)
3. [`databricks-dabs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-dabs)

Read `databricks-jobs` references for task types and triggers before authoring.
Do not invent a preferred graph.

## Inputs

| Input | Source | How to obtain |
|---|---|---|
| `DATABRICKS_ACCOUNT_ID` | Human-provided | Copy the intended Databricks account ID |
| `DATABRICKS_WORKSPACE_ID` | Human-provided | Copy the intended workspace ID |
| `DATABRICKS_HOST` | Human-provided | Copy the intended workspace URL |
| `DATABRICKS_CONFIG_PROFILE` | Human-provided | Name the Databricks CLI profile for the intended workspace |
| `PROJECT_PATH` | Human-provided | Use the local path to the completed project repository |
| `<job_key>` | Human-provided | Choose the stable bundle job resource key |
| `<job_display_name>` | Human-provided | Choose the displayed job name |
| `JOB_CONTRACT_JSON` | Human-provided | Encode job identity, tasks, edges, execution mode, compute, parameters, and acceptance checks in the required shape |
| `catalog` | Agent-derived | Read `.variables.catalog.value` from strict bundle validation when tasks need it |
| `warehouse_id` | Agent-derived | Read `.variables.warehouse_id.value` from strict bundle validation when a SQL task needs it |
| `job_id` | Agent-derived | Resolve `.resources.jobs[<job_key>].id` from the deployed bundle summary |
| Referenced resource IDs | Agent-derived | Resolve pipeline, job, warehouse, or query IDs named by the contract |

`JOB_CONTRACT_JSON` is the page contract.
Task count, task types, keys, dependencies, and trigger come from that object, not from this page.

Use this shape:

```json
{
  "job_key": "<job_key>",
  "display_name": "<job_display_name>",
  "parameters": [{"name": "<param_name>", "default": "<param_default>"}],
  "execution": {
    "mode": "manual"
  },
  "tasks": [
    {
      "task_key": "<task_key>",
      "task_type": "notebook_task",
      "depends_on": [],
      "run_if": "ALL_SUCCESS",
      "spec": {"notebook_path": "../src/<notebook_file>"}
    }
  ],
  "acceptance_checks": [
    {
      "name": "<check_name>",
      "kind": "sql_count",
      "statement": "SELECT count(*) FROM <output_fqn>",
      "minimum": 1
    }
  ]
}
```

Allowed `execution.mode` values: `manual`, `schedule`, `periodic`, `file_arrival`, `table_update`, `continuous`.
For `schedule`, add `quartz_cron_expression`, `timezone_id`, and `pause_status`.
For `periodic`, add `interval` and `unit`.
For `file_arrival`, add `url`.
For `table_update`, add `table_names`.
For `continuous`, add `pause_status`.
`manual` must omit schedule, trigger, and continuous blocks.

Allowed `task_type` values: `notebook_task`, `spark_python_task`, `python_wheel_task`, `sql_task`, `dbt_task`, `pipeline_task`, `spark_jar_task`, `run_job_task`, `for_each_task`.
Each `spec` object must contain only the fields that `databricks-jobs` documents for that type.
`depends_on` is an array of `{ "task_key": "<upstream_task_key>" }`.
`run_if` must be one of `ALL_SUCCESS`, `ALL_DONE`, `AT_LEAST_ONE_SUCCESS`, `NONE_FAILED`, `ALL_FAILED`, `AT_LEAST_ONE_FAILED`.

Allowed `acceptance_checks[].kind` values: `sql_count` and `command`.
`sql_count` requires `statement` and integer `minimum`.
`command` requires `argv` as a JSON array of strings and `expected_substring`.
The array must contain at least one check that asserts a workload postcondition, not only job state.

## Run

Start one persistent Bash session, then run every remaining Run and Verify block in that session.
This preserves strict options, variables, arrays, and functions and avoids reserved-name behavior from another shell.

```bash
/bin/bash --noprofile --norc
```

### 1. Resolve authentication and the bundle target

Set all human-provided environment variables, including `JOB_CONTRACT_JSON`, before running this block.
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
: "${JOB_CONTRACT_JSON:?}"
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
catalog=$(jq -r '.variables.catalog.value // empty' <<<"$bundle")
warehouse_id=$(jq -r '.variables.warehouse_id.value // empty' <<<"$bundle")
```

### 2. Validate the job contract

```bash
allowed_task_types='["notebook_task","spark_python_task","python_wheel_task","sql_task","dbt_task","pipeline_task","spark_jar_task","run_job_task","for_each_task"]'
allowed_run_if='["ALL_SUCCESS","ALL_DONE","AT_LEAST_ONE_SUCCESS","NONE_FAILED","ALL_FAILED","AT_LEAST_ONE_FAILED"]'
allowed_modes='["manual","schedule","periodic","file_arrival","table_update","continuous"]'
jq -en \
  --argjson contract "$JOB_CONTRACT_JSON" \
  --argjson types "$allowed_task_types" \
  --argjson run_if "$allowed_run_if" \
  --argjson modes "$allowed_modes" '
  ($contract.job_key | type == "string" and length > 0)
  and ($contract.display_name | type == "string" and length > 0)
  and ($contract.execution.mode | IN($modes[]))
  and ($contract.tasks | type == "array" and length > 0)
  and (($contract.tasks | map(.task_key) | length)
    == ($contract.tasks | map(.task_key) | unique | length))
  and ($contract.tasks | all(.;
    (.task_key | type == "string" and length > 0)
    and (.task_type | IN($types[]))
    and (.run_if | IN($run_if[]))
    and (.depends_on | type == "array")
    and (.spec | type == "object")))
  and ($contract.acceptance_checks | type == "array" and length > 0)
  and ($contract.acceptance_checks | all(.;
    (.name | type == "string" and length > 0)
    and ((.kind == "sql_count" and (.statement | type == "string") and (.minimum | type == "number"))
      or (.kind == "command" and (.argv | type == "array" and length > 0) and (.expected_substring | type == "string")))))
  and (
    if ($contract.parameters // null) == null then true
    else ($contract.parameters | type == "array"
      and all(.[]; (.name | type == "string" and length > 0) and (.default | type == "string")))
    end)
  and (
    if $contract.execution.mode == "manual" then true
    elif $contract.execution.mode == "schedule" then
      ($contract.execution.quartz_cron_expression | type == "string" and length > 0)
      and ($contract.execution.timezone_id | type == "string" and length > 0)
      and ($contract.execution.pause_status | type == "string" and length > 0)
    elif $contract.execution.mode == "periodic" then
      ($contract.execution.interval | type == "number")
      and ($contract.execution.unit | type == "string" and length > 0)
    elif $contract.execution.mode == "file_arrival" then
      ($contract.execution.url | type == "string" and length > 0)
    elif $contract.execution.mode == "table_update" then
      ($contract.execution.table_names | type == "array" and length > 0)
    elif $contract.execution.mode == "continuous" then
      ($contract.execution.pause_status | type == "string" and length > 0)
    else false
    end)
' >/dev/null
job_key=$(jq -er '.job_key' <<<"$JOB_CONTRACT_JSON")
jq -en \
  --argjson contract "$JOB_CONTRACT_JSON" '
  def valid_depends_on($keys):
    if (.depends_on | length) == 0 then true
    else all(.depends_on[]; .task_key as $up | ($keys | index($up) != null))
    end;
  ($contract.tasks | map(.task_key)) as $keys
  | $contract.tasks | all(valid_depends_on($keys))
' >/dev/null
printf 'job_contract=passed tasks=%s checks=%s mode=%s\n' \
  "$(jq '.tasks | length' <<<"$JOB_CONTRACT_JSON")" \
  "$(jq '.acceptance_checks | length' <<<"$JOB_CONTRACT_JSON")" \
  "$(jq -r '.execution.mode' <<<"$JOB_CONTRACT_JSON")"
```

Expected: `job_contract=passed` with the configured positive task and check counts.

Inspect every local path named in `spec` before authoring.
Stop when a referenced notebook, Python file, SQL file, wheel, JAR, or dbt project is missing.
Resolve bundle resource keys used by `pipeline_task` or `run_job_task` from the same bundle before deploy.

Use the already-invoked `databricks-core`, `databricks-jobs`, and `databricks-dabs` skills to implement the validated contract.

### 3. Write the native job resource

Create `resources/<job_key>.job.yml`.
Map `JOB_CONTRACT_JSON` onto one job resource.
Include only the blocks the selected mode and task types require.

```yaml
resources:
  jobs:
    <job_key>:
      name: <job_display_name>
      parameters:
        - name: <param_name>
          default: <param_default>
      tasks:
        - task_key: <task_key>
          depends_on:
            - task_key: <upstream_task_key>
          run_if: ALL_SUCCESS
          notebook_task:
            notebook_path: ../src/<notebook_file>
```

Replace `notebook_task` with the selected `task_type` object from `databricks-jobs`.
Examples of other `spec` objects, none of which is required:

```yaml
spark_python_task:
  python_file: ../src/<python_file>
sql_task:
  warehouse_id: ${var.warehouse_id}
  file:
    path: ../src/<sql_file>
pipeline_task:
  pipeline_id: ${resources.pipelines.<pipeline_key>.id}
  full_refresh: false
run_job_task:
  job_id: ${resources.jobs.<other_job_key>.id}
```

Keep `full_refresh` false on any `pipeline_task` unless a human explicitly approves a full rebuild after reviewing its impact and cost.
Pipeline-task compute belongs to the referenced pipeline, not to the Job task.
When the project requires serverless, verify `spec.serverless == true` on that pipeline after deployment.
For `manual`, omit `schedule`, `trigger`, and `continuous`.
For other modes, add only the matching execution block from `databricks-jobs` triggers and schedules.

Omit unused compute keys.
Notebook and Python tasks with no cluster configuration use serverless.
SQL tasks require `warehouse_id`.
Job clusters, existing clusters, and environments follow the skill when the contract names them.

Give every dataset, notebook, SQL file, or wheel the path the contract names.
Do not add extra tasks that the contract does not list.

### 4. Deploy and resolve the job ID

```bash
bundle=$(databricks bundle validate --strict --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
deployed_job_name=$(jq -er --arg key "$job_key" \
  '.resources.jobs[$key].name' <<<"$bundle")
databricks bundle deploy --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" --auto-approve
job_id=$(
  databricks bundle summary --target dev \
    --profile "$DATABRICKS_CONFIG_PROFILE" -o json \
  | jq -er --arg key "$job_key" '.resources.jobs[$key].id | tostring | select(length > 0)'
)
```

Expected: strict validation targets `dev` and the deployed job ID is nonempty.
Strict validation checks the bundle shape but may not resolve a misspelled resource key inside `${resources.pipelines.<key>.id}` or `${resources.jobs.<key>.id}`.
Treat deployment as the dependency-graph check and capture its exact `invalid dependency` error before correcting the key.

## Verify

```bash
test "$persistent_bash_pid" = "$$"
job_settings=$(databricks jobs get "$job_id" \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
jq -en \
  --argjson contract "$JOB_CONTRACT_JSON" \
  --arg deployed_job_name "$deployed_job_name" \
  --argjson settings "$job_settings" '
  ($settings.settings.name == $deployed_job_name)
  and (($settings.settings.tasks | map(.task_key) | sort)
    == ($contract.tasks | map(.task_key) | sort))
  and ($contract.tasks | length == ($settings.settings.tasks | length))
  and all($contract.tasks[];
    . as $expected
    | ($settings.settings.tasks[] | select(.task_key == $expected.task_key)) as $actual
    | ($actual[$expected.task_type] != null)
      and ($actual.run_if == $expected.run_if)
      and (
        ($expected.depends_on | map(.task_key) | sort)
        == (($actual.depends_on // []) | map(.task_key) | sort)
      ))
  and (
    if ($contract.parameters // []) | length == 0 then true
    else
      all($contract.parameters[];
        . as $expected
        | any(($settings.settings.parameters // [])[];
            .name == $expected.name and .default == $expected.default))
    end)
' >/dev/null
mode=$(jq -r '.execution.mode' <<<"$JOB_CONTRACT_JSON")
case "$mode" in
  manual)
    jq -e '
      (.settings | has("schedule") | not)
      and (.settings | has("trigger") | not)
      and (.settings | has("continuous") | not)' \
      >/dev/null <<<"$job_settings"
    ;;
  schedule)
    jq -e --argjson contract "$JOB_CONTRACT_JSON" '
      .settings.schedule.quartz_cron_expression
        == $contract.execution.quartz_cron_expression
      and .settings.schedule.timezone_id == $contract.execution.timezone_id
      and .settings.schedule.pause_status == $contract.execution.pause_status' \
      >/dev/null <<<"$job_settings"
    ;;
  continuous)
    jq -e --argjson contract "$JOB_CONTRACT_JSON" '
      .settings.continuous.pause_status == $contract.execution.pause_status' \
      >/dev/null <<<"$job_settings"
    ;;
  periodic)
    jq -e --argjson contract "$JOB_CONTRACT_JSON" '
      .settings.trigger.periodic.interval == $contract.execution.interval
      and .settings.trigger.periodic.unit == $contract.execution.unit' \
      >/dev/null <<<"$job_settings"
    ;;
  file_arrival)
    jq -e --argjson contract "$JOB_CONTRACT_JSON" '
      .settings.trigger.file_arrival.url == $contract.execution.url' \
      >/dev/null <<<"$job_settings"
    ;;
  table_update)
    jq -e --argjson contract "$JOB_CONTRACT_JSON" '
      (.settings.trigger.table_update.table_names | sort)
        == ($contract.execution.table_names | sort)' \
      >/dev/null <<<"$job_settings"
    ;;
esac
printf 'deployed_graph=passed mode=%s tasks=%s\n' \
  "$mode" "$(jq '.tasks | length' <<<"$JOB_CONTRACT_JSON")"
```

Expected: `deployed_graph=passed` with the configured mode and task count.
Missing tasks, extra tasks, drifted edges, parameters, or the wrong execution block fail here.
For each deployed pipeline task, fetch its referenced pipeline and verify the compute contract there.

```bash
deployed_pipeline_ids=()
while IFS= read -r deployed_pipeline_id
do
  test -z "$deployed_pipeline_id" || deployed_pipeline_ids+=("$deployed_pipeline_id")
done < <(
  jq -r '.settings.tasks[] | .pipeline_task.pipeline_id // empty' <<<"$job_settings" \
    | LC_ALL=C sort -u
)
for deployed_pipeline_id in "${deployed_pipeline_ids[@]}"
do
  pipeline=$(databricks pipelines get "$deployed_pipeline_id" \
    --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
  jq -e '.spec.serverless == true' >/dev/null <<<"$pipeline"
done
printf 'pipeline_tasks_serverless=%s\n' "${#deployed_pipeline_ids[@]}"
```

Expected: every pipeline referenced by this serverless project reports `spec.serverless=true`.

Define run helpers after the graph check.

```bash
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

assert_dependency_order() {
  local run_json=$1
  jq -en \
    --argjson contract "$JOB_CONTRACT_JSON" \
    --argjson run "$run_json" '
    def valid_order($task):
      if ($task.depends_on | length) == 0 then true
      else all($task.depends_on[];
          .task_key as $up
          | ($run.tasks[] | select(.task_key == $up).end_time) as $up_end
          | ($run.tasks[] | select(.task_key == $task.task_key).start_time) as $start
          | ($up_end | type == "number")
            and ($start | type == "number")
            and ($start >= $up_end))
      end;
    all($contract.tasks[]; valid_order(.))
    '
}

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

run_acceptance_checks() {
  local check_count check_index kind
  check_count=$(jq '.acceptance_checks | length' <<<"$JOB_CONTRACT_JSON")
  for ((check_index = 0; check_index < check_count; check_index++))
  do
    kind=$(jq -er --argjson index "$check_index" \
      '.acceptance_checks[$index].kind' <<<"$JOB_CONTRACT_JSON")
    case "$kind" in
      sql_count)
        test -n "$warehouse_id"
        statement=$(jq -er --argjson index "$check_index" \
          '.acceptance_checks[$index].statement' <<<"$JOB_CONTRACT_JSON")
        minimum=$(jq -er --argjson index "$check_index" \
          '.acceptance_checks[$index].minimum' <<<"$JOB_CONTRACT_JSON")
        run_sql "$statement" \
          | jq -e --argjson minimum "$minimum" '
              .result.data_array
              | select(length == 1)
              | .[0][0]
              | tonumber
              | select(. >= $minimum)' >/dev/null
        ;;
      command)
        expected=$(jq -er --argjson index "$check_index" \
          '.acceptance_checks[$index].expected_substring' <<<"$JOB_CONTRACT_JSON")
        argv=()
        while IFS= read -r argument
        do
          argv+=("$argument")
        done < <(jq -r --argjson index "$check_index" \
          '.acceptance_checks[$index].argv[]' <<<"$JOB_CONTRACT_JSON")
        output=$("${argv[@]}")
        grep -F -- "$expected" <<<"$output" >/dev/null
        ;;
      *) printf 'unsupported acceptance kind: %s\n' "$kind" >&2; return 1 ;;
    esac
  done
}

observe_continuous_health() {
  local deadline pause_status observed runs healthy=false
  pause_status=$(jq -r '.execution.pause_status' <<<"$JOB_CONTRACT_JSON")
  deadline=$((SECONDS + 180))
  while test "$SECONDS" -lt "$deadline"
  do
    observed=$(databricks jobs get "$job_id" \
      --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
    jq -e --argjson contract "$JOB_CONTRACT_JSON" '
      .settings.continuous != null
      and .settings.continuous.pause_status == $contract.execution.pause_status' \
      >/dev/null <<<"$observed" || return
    if test "$pause_status" = "PAUSED"
    then
      healthy=true
      break
    fi
    runs=$(databricks jobs list-runs --job-id "$job_id" \
      --profile "$DATABRICKS_CONFIG_PROFILE" --active-only -o json \
      | jq '.runs // []')
    if jq -e 'length > 0' <<<"$runs" >/dev/null
    then
      healthy=true
      break
    fi
    runs=$(databricks jobs list-runs --job-id "$job_id" \
      --profile "$DATABRICKS_CONFIG_PROFILE" --limit 1 -o json \
      | jq '.runs // []')
    if jq -e '
      length == 1
      and .[0].state.life_cycle_state == "TERMINATED"
      and .[0].state.result_state == "SUCCESS"' <<<"$runs" >/dev/null
    then
      healthy=true
      break
    fi
    sleep 10
  done
  test "$healthy" = true
}
```

For `manual`, `schedule`, `periodic`, `file_arrival`, and `table_update`, start one explicit test run.
Do not wait for the cron clock or an external event.

```bash
if test "$mode" != continuous
then
  run_id=$(databricks jobs run-now "$job_id" \
    --profile "$DATABRICKS_CONFIG_PROFILE" --no-wait -o json \
    | jq -er '.run_id | tostring')
  run=$(poll_job)
  jq -e --argjson contract "$JOB_CONTRACT_JSON" '
    (.tasks | map(.task_key) | sort) == ($contract.tasks | map(.task_key) | sort)
  ' >/dev/null <<<"$run"
  assert_dependency_order "$run" >/dev/null
  run_acceptance_checks
  printf 'job_run=SUCCESS tasks=%s dependency_order=passed checks=%s\n' \
    "$(jq '.tasks | length' <<<"$JOB_CONTRACT_JSON")" \
    "$(jq '.acceptance_checks | length' <<<"$JOB_CONTRACT_JSON")"
fi
```

For `continuous`, observe bounded health before acceptance checks.

```bash
if test "$mode" = continuous
then
  observe_continuous_health
  run_acceptance_checks
  printf 'job_continuous=observed checks=%s\n' \
    "$(jq '.acceptance_checks | length' <<<"$JOB_CONTRACT_JSON")"
fi
```

Expected for non-continuous jobs:

```text
deployed_graph=passed mode=<configured-mode> tasks=<configured-task-count>
job_run=SUCCESS tasks=<configured-task-count> dependency_order=passed checks=<configured-check-count>
```

Expected for continuous jobs:

```text
deployed_graph=passed mode=continuous tasks=<configured-task-count>
job_continuous=observed checks=<configured-check-count>
```

Job and task success without the acceptance checks is a failed verification.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| Authentication check fails before validation | The profile targets another account, workspace, or host | Correct the named values or reauthenticate the intended profile before continuing |
| Contract validation fails | A task type, run condition, mode, edge, parameter, or acceptance check is missing or invalid | Correct `JOB_CONTRACT_JSON` before authoring |
| A referenced source file is missing | The contract names a notebook, SQL file, Python file, wheel, JAR, or dbt project that is not in the repo | Add the file or correct the path |
| Deployment reports `invalid dependency` after strict validation passed | A `pipeline_task` or `run_job_task` names a key that is not in the same bundle | Correct the resource key, redeploy, and do not treat strict validation alone as graph resolution |
| A deployed pipeline task has `full_refresh: true` | The job would replace incremental processing with a full rebuild | Stop until a human reviews the rebuild impact and cost and explicitly approves it, or restore `full_refresh: false` and redeploy |
| A pipeline task has no serverless setting in the Job payload | Pipeline-task compute is configured on the referenced pipeline | Fetch that pipeline and verify its compute contract there |
| The deployed graph assertion fails | Task keys, task count, types, run conditions, edges, parameters, or execution mode drifted | Restore the contract graph and redeploy |
| `run-now` rejects the request | The command uses a resource key or an unsupported argument form instead of the resolved job ID | Pass the resolved numeric job ID with the shown syntax |
| The poll rejects a terminated run | The job or one of its tasks has a result other than `SUCCESS` | Inspect the exact run output and repair the failing task |
| A downstream task never runs | An upstream task failed or `depends_on` / `run_if` drifted | Repair the upstream task or restore the contract edges |
| The timestamp assertion fails | A downstream task began before an upstream task ended, or timestamps are absent | Inspect the exact run and restore the dependency |
| Continuous observation times out | The job never reached the declared continuous configuration or active health | Inspect pause status and recent run health |
| An acceptance check fails | The workload postcondition is false, the statement is wrong, or the warehouse cannot query it | Correct the output, permissions, or check and rerun |

## Next

- **Back to section:** [Databricks Projects](/docs/02-databricks-projects/)
