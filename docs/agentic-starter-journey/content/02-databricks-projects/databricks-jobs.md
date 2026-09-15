---
description: Design, deploy, break, diagnose, and verify a project-defined Lakeflow Job with explicit operational contracts.
---

# Databricks Jobs

## Mental Model

A Lakeflow Job owns an operational lifecycle rather than only a task list.
Put tasks in one job when they share ownership, permissions, parameters, retries, notifications, and execution policy.
Split jobs when those contracts differ.
Choose task types from the workload and verify business postconditions after the graph succeeds.

## Goal

Add one bundle-defined Lakeflow Job, deploy it, deliberately break one graph assumption, diagnose the deployment or run failure, repair it, and prove both graph state and workload outcomes.

## Prerequisites

- Complete the [Project repo](/docs/02-databricks-projects/project-repo/) outcome.
- Provide every notebook, Python file, wheel, SQL file, pipeline, nested job, and warehouse referenced by the graph.
- Configure a named workspace profile and pass `--profile` on every command.
- Provide job create and run permissions.
- Define task ownership, trigger, concurrency, retry, timeout, notification, and acceptance policies before authoring YAML.

## Skill

Invoke these verified skills in order:

1. [`databricks-core`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-core)
2. [`databricks-jobs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-jobs)
3. [`databricks-dabs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-dabs)

Read the selected task-type and trigger references before writing the resource.

## Inputs

| Input | Source | How to obtain |
|---|---|---|
| Account ID, workspace ID, host, profile | Human-provided | Name the exact live target and named CLI profile |
| Project path, target, job key, display name | Human-provided | Identify the existing bundle and stable resource identity |
| Tasks and edges | Human-provided | Define task keys, task types, dependencies, and `run_if` behavior |
| Execution policy | Human-provided | Choose manual, scheduled, periodic, file arrival, table update, or continuous |
| Operational policy | Human-provided | Define timeout, retry, queue, concurrency, notifications, and health rules |
| Compute policy | Human-provided | Default eligible notebook and Python tasks to serverless and justify classic compute |
| Parameters | Human-provided | Define job parameters once and reference them from tasks |
| Acceptance checks | Human-provided | Provide at least one data or side-effect postcondition, not only run success |
| Resource IDs and deployed graph | Agent-derived | Resolve from bundle summary and live Job metadata |

Encode the decision in one contract before authoring.

```json
{
  "job_key": "daily_orders",
  "display_name": "Daily orders",
  "execution": {"mode": "manual"},
  "operational": {
    "max_concurrent_runs": 1,
    "queue_enabled": true,
    "timeout_seconds": 3600
  },
  "tasks": [
    {
      "task_key": "refresh_pipeline",
      "task_type": "pipeline_task",
      "depends_on": [],
      "run_if": "ALL_SUCCESS",
      "spec": {"pipeline_key": "orders_pipeline", "full_refresh": false}
    }
  ],
  "acceptance_checks": [
    {
      "name": "silver_has_rows",
      "kind": "sql_count",
      "statement": "SELECT count(*) FROM <catalog>.<silver_schema>.orders",
      "minimum": 1
    }
  ]
}
```

## Run

### 1. Preflight authentication and local references

```bash
set -euo pipefail
: "${DATABRICKS_ACCOUNT_ID:?}"
: "${DATABRICKS_WORKSPACE_ID:?}"
: "${DATABRICKS_HOST:?}"
: "${DATABRICKS_CONFIG_PROFILE:?}"
: "${PROJECT_PATH:?}"

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

cd "$PROJECT_PATH"
test -f databricks.yml
```

Inspect every local path named by the contract.
Resolve referenced pipeline and job keys from the same bundle before deployment.

### 2. Apply task and compute rules

| Task type | Use when | Compute rule |
|---|---|---|
| `notebook_task` | The unit is a notebook | Omit cluster configuration for eligible serverless workloads |
| `spark_python_task` | The unit is a Python file | Omit cluster configuration for eligible serverless workloads |
| `python_wheel_task` | The unit is a tested package | Pin the built artifact and environment |
| `sql_task` | The unit is SQL, a dashboard, or an alert | Provide an explicit warehouse ID |
| `pipeline_task` | The unit is an SDP update | Compute belongs to the referenced pipeline |
| `run_job_task` | Another lifecycle must remain independent | Reference the other bundle job ID |
| `for_each_task` | One nested task repeats over bounded inputs | Bound concurrency and validate each input |

Default to serverless when the selected task supports it.
Do not add classic clusters without a stated runtime or library requirement.
For `pipeline_task`, verify serverless on the referenced pipeline because the Job does not define that compute.
Keep `full_refresh: false` unless a human explicitly approves the data and replay impact.

### 3. Write one native Job resource

```yaml
resources:
  jobs:
    <job_key>:
      name: <job_display_name>
      max_concurrent_runs: 1
      queue:
        enabled: true
      timeout_seconds: 3600
      tasks:
        - task_key: refresh_pipeline
          run_if: ALL_SUCCESS
          pipeline_task:
            pipeline_id: ${resources.pipelines.<pipeline_key>.id}
            full_refresh: false
```

Use `../src/...` for source paths referenced from `resources/*.yml`.
Declare job parameters once and reference them from tasks.
Add retries only for transient failures and avoid retrying deterministic data-quality failures.
Use notifications for final failure and duration warnings instead of notifying on every successful run.
Use `max_concurrent_runs: 1` when overlapping writes are unsafe.

Strict validation checks shape and warnings but may not reject a nonexistent `${resources.pipelines.<key>.id}` dependency.
Deployment is the graph-resolution test.

### 4. Validate, deploy, resolve, and run

```bash
databricks bundle validate --strict --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE"
databricks bundle deploy --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" --auto-approve
summary=$(databricks bundle summary --target dev \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
job_id=$(jq -er '.resources.jobs.<job_key>.id' <<<"$summary")
run=$(databricks jobs run-now "$job_id" --no-wait \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
run_id=$(jq -er '.run_id' <<<"$run")
```

Prefer `jobs run-now` when deterministic polling requires the numeric run ID.
CLI versions may print only a URL for `bundle run --no-wait -o json`.

Poll `databricks jobs get-run "$run_id"` until the run reaches a terminal state.
Inspect every task result, not only the parent state.
For a pipeline task, also poll the exact pipeline update and inspect its events when it fails.

### 5. Break, diagnose, and repair

Change one contract assumption that should fail safely.
A useful graph test is a misspelled bundle resource key.
Record whether strict validation, deployment, or execution catches it.
Capture the exact failure and resource ID.
Repair only the cause, redeploy, start a new run, and rerun every acceptance check.

## Verify

Verify the live graph against the contract.

```bash
job=$(databricks jobs get "$job_id" \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)
run=$(databricks jobs get-run "$run_id" \
  --profile "$DATABRICKS_CONFIG_PROFILE" -o json)

jq -e '
  .state.life_cycle_state == "TERMINATED"
  and .state.result_state == "SUCCESS"
  and all(.tasks[]; .state.result_state == "SUCCESS")
' >/dev/null <<<"$run"
```

Compare task keys, types, dependencies, `run_if`, parameters, trigger, queue, concurrency, retries, and timeouts with the contract.
For each `pipeline_task`, assert `full_refresh == false` and compare its pipeline ID with the resolved bundle resource.
Fetch that pipeline and assert `.spec.serverless == true` when serverless is required.

Run every acceptance check after graph success.
Use independent SQL for row counts, freshness, uniqueness, and quality reconciliation.
Job success alone does not prove the requested medallion schemas or data quality.

Expected: the deployed graph equals the contract, every task succeeds, pipeline tasks use the intended pipeline without full refresh, and every workload postcondition passes.

## Where this fails

| Symptom | Cause | Action |
|---|---|---|
| Strict validation passes but deployment reports `invalid dependency` | The referenced bundle resource key does not exist | Correct the key and redeploy |
| A pipeline task succeeded but output is in the wrong schema | Development mode rewrote an unqualified pipeline target | Verify the live pipeline outputs and fully qualify layer datasets |
| A pipeline task appears to have no serverless configuration | Compute belongs to the pipeline, not the Job | Fetch the pipeline and assert `spec.serverless=true` |
| `bundle run --no-wait -o json` has no parseable run ID | The CLI emitted only a Run URL | Use `jobs run-now` with the resolved Job ID |
| Parent run succeeds but an acceptance check fails | The graph ran but the workload outcome is wrong | Diagnose the task output and data contract |
| Concurrent runs corrupt or contend on outputs | Concurrency policy is too permissive | Set a safe maximum and enable queueing |
| Retries repeat a deterministic failure | Retry policy treats code or data defects as transient | Remove the retry and repair the cause |
| A pipeline task requests full refresh | The graph can reset streaming state | Set false and require explicit approval for exceptions |

## Next

Add schedules, event triggers, notifications, health rules, and permissions only when the project contract requires them.
Keep the job small enough that one ownership and operational policy remains true for every task.
