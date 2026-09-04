---
description: Deploy a Genie Agent by ID and verify its query against a SQL baseline.
---

# Genie Agents

## Mental Model

A Genie Agent is a reviewed `src/genie_agent.json` document deployed through the supported Genie create or update commands.
It is not a native bundle resource.
Author metric-view requests under `data_sources.metric_views`, then verify the persisted export under `data_sources.tables`.
Treat the create parent as requested input and the `get-space` parent as its canonical persisted form.
Persist the created space ID as ownership state and use that ID for every update.
Validate one deterministic question through the Conversation API against an independently executed baseline.

## Goal

Create or update one approved Genie Agent and prove its generated query is read-only, grounded only in configured sources, and equal to a deterministic baseline result.

## Prerequisites

- Obtain explicit approval of the parsed Genie configuration.
- Provide a writable workspace parent folder.
- Provide a SQL warehouse and governed source access.
- For an existing space, optionally provide its ID directly as authoritative human input.
- For normal CI/CD, optionally provide a target-owned persistent state path outside disposable implementation scratch.
- On first create, provide neither ownership input and persist the returned ID immediately.

## Skill

Invoke these verified skills in order:

1. [`databricks-core`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-core)
2. [`databricks-genie-agents`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-genie-agents)
3. [`databricks-dabs`](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-dabs)

## Inputs

| Input | Source | How to obtain |
|---|---|---|
| `DATABRICKS_ACCOUNT_ID`, `DATABRICKS_WORKSPACE_ID`, `DATABRICKS_HOST`, `DATABRICKS_CONFIG_PROFILE`, `PROJECT_PATH` | Human-provided | Named target and project |
| `GENIE_TITLE`, `GENIE_DESCRIPTION` | Human-provided | Exact title and purpose |
| `GENIE_REQUESTED_PARENT_PATH` | Human-provided | `/Workspace/Users/ivan.calvo@databricks.com/genie_agents` |
| `GENIE_PERSISTED_PARENT_PATH` | Human-provided | `/Users/ivan.calvo@databricks.com/genie_agents` |
| Source FQNs and column configurations | Human-provided | Permitted sources and metadata |
| Sample questions | Human-provided | Exact approved samples |
| Example questions | Human-provided | Exact approved examples |
| Justified text instructions | Human-provided | Each approved instruction |
| Example SQL | Human-provided | Validated read-only SQL |
| `GENIE_VALIDATION_QUESTION`, `GENIE_SPACE_ID`, `GENIE_STATE_FILE` | Human-provided | One query; ID optional on first create and authoritative when set; optional target-owned state |
| Warehouse, source metadata, stable IDs, `GENIE_BASELINE_SQL`, expected result | Agent-derived | Resolve and validate the complete design |
| Observed persistence contract | Agent-derived | `request_source_key=metric_views`, `persisted_source_key=tables`, persisted parent `/Users/ivan.calvo@databricks.com/genie_agents`, `create_id_field=space_id`, and `query_attachment_id_field=attachment_id` |

## Run

### 0. Design and obtain explicit approval

Present the title, description, requested parent path, expected persisted parent path, request source key `metric_views`, expected exported source key `tables`, warehouse, every source, every column configuration, every instruction, every sample question, every example SQL, and the entire parsed request JSON.
Obtain explicit human approval of that complete design.
General approval is insufficient.
Do not create the parent folder, create a space, or update a space before this approval.

Create `src/genie_agent.json` after approval:

```json
{
  "version": 2,
  "config": {
    "sample_questions": [{
      "id": "10000000000000000000000000000001",
      "question": ["<sample_question>"]
    }]
  },
  "data_sources": {
    "metric_views": [{
      "identifier": "<catalog>.<schema>.<metric_view>",
      "column_configs": [{
        "column_name": "<categorical_dimension>",
        "enable_entity_matching": true,
        "enable_format_assistance": true,
        "synonyms": ["<approved_synonym>"]
      }]
    }]
  },
  "instructions": {
    "example_question_sqls": [{
      "id": "20000000000000000000000000000001",
      "question": ["<representative_question>"],
      "sql": ["<validated_read_only_sql>"]
    }],
    "text_instructions": [{
      "id": "30000000000000000000000000000001",
      "content": ["<approved_global_instruction>"]
    }]
  }
}
```

Do not author request serialization with `tables`.

### 1. Verify auth and resolve the strict target

Start one shell session only after explicit approval:

```bash
set -euo pipefail
: "${DATABRICKS_ACCOUNT_ID:?}"
: "${DATABRICKS_WORKSPACE_ID:?}"
: "${DATABRICKS_HOST:?}"
: "${DATABRICKS_CONFIG_PROFILE:?}"
: "${PROJECT_PATH:?}"
: "${GENIE_TITLE:?}"
: "${GENIE_DESCRIPTION:?}"
: "${GENIE_REQUESTED_PARENT_PATH:?}"
: "${GENIE_PERSISTED_PARENT_PATH:?}"
: "${GENIE_VALIDATION_QUESTION:?}"
: "${GENIE_BASELINE_SQL:?}"

cd "$PROJECT_PATH"
databricks() {
  command databricks "$@" --profile "$DATABRICKS_CONFIG_PROFILE"
}
genie_title=$GENIE_TITLE
genie_description=$GENIE_DESCRIPTION
requested_parent_path=$GENIE_REQUESTED_PARENT_PATH
persisted_parent_path=$GENIE_PERSISTED_PARENT_PATH
direct_space_id=${GENIE_SPACE_ID:-}
genie_state_file=${GENIE_STATE_FILE:-}
validation_question=$GENIE_VALIDATION_QUESTION
baseline_sql=$GENIE_BASELINE_SQL
answer_file=$(mktemp)
baseline_file=$(mktemp)
sources_file=$(mktemp)
sql_gate=$(mktemp)
if test -n "$direct_space_id"
then
  jq -en --arg id "$direct_space_id" \
    '$id | select(test("^[0-9a-f]{32}$"))' >/dev/null
fi

auth=$(databricks auth describe -o json)
jq -e \
  --arg account "$DATABRICKS_ACCOUNT_ID" \
  --arg workspace "$DATABRICKS_WORKSPACE_ID" \
  --arg host "$DATABRICKS_HOST" '
    [
      .host // .details.host // .details.configuration.host.value,
      .account_id // .details.configuration.account_id.value,
      (.workspace_id // .details.configuration.workspace_id.value | tostring)
    ] == [$host, $account, $workspace]' >/dev/null <<<"$auth"
bundle=$(databricks bundle validate --strict --target dev \
  -o json)
warehouse_id=$(jq -er '
  .variables.warehouse_id.value
  | select(type == "string" and length > 0)' <<<"$bundle")
configured_sources=()
while IFS= read -r configured_source
do
  configured_sources+=("$configured_source")
done < <(jq -er '.data_sources.metric_views[].identifier' src/genie_agent.json)
test "${#configured_sources[@]}" -ge 1
printf '%s\n' "${configured_sources[@]}" >"$sources_file"
databricks workspace mkdirs "$requested_parent_path"
```

### 2. Resolve ownership and fail closed

```bash
state_space_id=
if test -n "$genie_state_file" && test -f "$genie_state_file"
then
  state_space_id=$(jq -er '
    .space_id
    | select(type == "string" and test("^[0-9a-f]{32}$"))' \
    "$genie_state_file")
  jq -e \
    --arg requested_parent "$requested_parent_path" \
    --arg persisted_parent "$persisted_parent_path" '
      .request_source_key == "metric_views"
      and .persisted_source_key == "tables"
      and .requested_parent_path == $requested_parent
      and .persisted_parent_path == $persisted_parent
      and .create_id_field == "space_id"
      and .query_attachment_id_field == "attachment_id"' \
    "$genie_state_file" >/dev/null
fi
if test -n "$direct_space_id" && test -n "$state_space_id"
then
  test "$direct_space_id" = "$state_space_id" || {
    printf 'GENIE_SPACE_ID disagrees with target-owned state\n' >&2
    exit 1
  }
fi
space_id=${direct_space_id:-$state_space_id}
if test -n "${space_id:-}"
then
  existing=$(databricks genie get-space "$space_id" \
    --include-serialized-space -o json)
  jq -e \
    --arg warehouse_id "$warehouse_id" \
    --arg title "$genie_title" \
    --arg persisted_parent "$persisted_parent_path" \
    --argjson configured \
      "$(printf '%s\n' "${configured_sources[@]}" | jq -R . | jq -s 'sort')" '
      .title == $title
      and .warehouse_id == $warehouse_id
      and .parent_path == $persisted_parent
      and (
        .serialized_space
        | fromjson
        | (.data_sources | keys) == ["tables"]
          and ([.data_sources.tables[].identifier] | sort) == $configured
      )' \
    >/dev/null <<<"$existing"
  deploy_action=update
else
  collisions=0
  page_token=
  page_count=0
  while :
  do
    page_count=$((page_count + 1))
    test "$page_count" -le 100
    list_args=(-o json)
    test -z "$page_token" || list_args+=(--page-token "$page_token")
    page=$(databricks genie list-spaces "${list_args[@]}")
    page_collisions=$(jq -er --arg title "$genie_title" '
      [(if type == "array" then . else (.spaces // []) end)[]
       | select(.title == $title)]
      | length' <<<"$page")
    collisions=$((collisions + page_collisions))
    next_page_token=$(jq -er '
      (if type == "array" then "" else (.next_page_token // "") end)
      | select(type == "string")' <<<"$page")
    test -n "$next_page_token" || break
    test "$next_page_token" != "$page_token"
    page_token=$next_page_token
  done
  test "$collisions" -eq 0
  deploy_action=create
fi
```

Title detects collisions, not ownership.

### 3. Create or update by ID

```bash
if test "$deploy_action" = create
then
  if test -z "$genie_state_file"
  then
    genie_state_file=.databricks/genie-agent-state.json
  fi
  printf 'First create must persist its returned ID in target-owned state: %s\n' \
    "$genie_state_file"
  serialized_space=$(jq -c '.' src/genie_agent.json)
  create_request=$(jq -n \
    --arg warehouse_id "$warehouse_id" \
    --arg title "$genie_title" \
    --arg description "$genie_description" \
    --arg parent_path "$requested_parent_path" \
    --arg serialized_space "$serialized_space" \
    '{warehouse_id:$warehouse_id,title:$title,description:$description,parent_path:$parent_path,serialized_space:$serialized_space}')
  mkdir -p "$(dirname "$genie_state_file")"
  pending_response="$genie_state_file.create-response.pending.json"
  test ! -e "$pending_response" || {
    printf 'reconcile pending create response first: %s\n' "$pending_response" >&2
    exit 1
  }
  : >"$pending_response"
  if ! databricks genie create-space --json "$create_request" \
    -o json >"$pending_response"
  then
    printf 'create outcome unresolved; inspect durable response: %s\n' \
      "$pending_response" >&2
    exit 1
  fi
  python3 - \
    "$pending_response" \
    "$genie_state_file" \
    "$requested_parent_path" \
    "$persisted_parent_path" <<'PY'
import json
import os
import sys

response = json.load(open(sys.argv[1]))
space_id = response["space_id"]
assert isinstance(space_id, str) and space_id
temporary = sys.argv[2] + ".tmp"
with open(temporary, "w") as handle:
    json.dump(
        {
            "space_id": space_id,
            "request_source_key": "metric_views",
            "persisted_source_key": "tables",
            "requested_parent_path": sys.argv[3],
            "persisted_parent_path": sys.argv[4],
            "create_id_field": "space_id",
            "query_attachment_id_field": "attachment_id",
        },
        handle,
        indent=2,
        sort_keys=True,
    )
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.replace(temporary, sys.argv[2])
PY
  space_id=$(jq -er '.space_id' "$genie_state_file")
  mv "$pending_response" "$genie_state_file.create-response.json"
  printf 'Persisted returned Genie space ID %s in target-owned state %s\n' \
    "$space_id" "$genie_state_file"
fi

if test "$deploy_action" = update
then
  serialized_space=$(jq -c '.' src/genie_agent.json)
  update_request=$(jq -n \
    --arg warehouse_id "$warehouse_id" \
    --arg title "$genie_title" \
    --arg description "$genie_description" \
    --arg serialized_space "$serialized_space" \
    '{warehouse_id:$warehouse_id,title:$title,description:$description,serialized_space:$serialized_space}')
  databricks genie update-space "$space_id" \
    --json "$update_request" -o json
fi
```

Do not define a native Genie bundle resource.

## Verify

### Verify canonical persistence

```bash
space=$(databricks genie get-space "$space_id" \
  --include-serialized-space -o json)
jq -e \
  --arg warehouse_id "$warehouse_id" \
  --arg title "$genie_title" \
  --arg persisted_parent "$persisted_parent_path" \
  --argjson configured "$(printf '%s\n' "${configured_sources[@]}" | jq -R . | jq -s 'sort')" '
    .warehouse_id == $warehouse_id
    and .title == $title
    and .parent_path == $persisted_parent
    and (
      .serialized_space
      | fromjson
      | .version == 2
        and (.data_sources | keys) == ["tables"]
        and ([.data_sources.tables[].identifier] | sort) == $configured
    )' >/dev/null <<<"$space"
```

### Complete one Conversation

```bash
start=$(databricks genie start-conversation "$space_id" "$validation_question" \
  --no-wait -o json)
conversation_id=$(jq -er '.conversation_id' <<<"$start")
message_id=$(jq -er '.message_id' <<<"$start")
while :
do
  message=$(databricks genie get-message \
    "$space_id" "$conversation_id" "$message_id" \
    -o json)
  status=$(jq -er '.status' <<<"$message")
  case "$status" in
    COMPLETED) break ;;
    SUBMITTED|FILTERING_CONTEXT|ASKING_AI|EXECUTING_QUERY) sleep 5 ;;
    FAILED|CANCELLED) jq '.' >&2 <<<"$message"; exit 1 ;;
    *) printf 'unknown Genie status: %s\n' "$status" >&2; exit 1 ;;
  esac
done
printf '%s\n' 'conversation=COMPLETED'

query_attachment=$(
  jq -ce '
    [.attachments[] | select(.query.query? | type == "string")]
    | select(length == 1)
    | .[0]' <<<"$message"
)
attachment_id=$(jq -er '.attachment_id' <<<"$query_attachment")
generated_sql=$(jq -er '.query.query' <<<"$query_attachment")
```

### Gate generated and baseline SQL

```bash
cat >"$sql_gate" <<'PY'
import re, sys

sql, sources_file, mode = sys.argv[1].strip(), sys.argv[2], sys.argv[3]
atom = r"(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_-]*)"
identifier = rf"{atom}(?:\.{atom})*"
atom_re = re.compile(atom)
unquote = lambda value: value[1:-1].replace("``", "`") if value.startswith("`") else value

masked = re.sub(
    r"'(?:''|[^'])*'|--[^\n]*|/\*.*?\*/",
    lambda match: "".join("\n" if char == "\n" else " " for char in match.group()),
    sql, flags=re.S,
)
statement = masked.rstrip()
if statement.endswith(";"):
    statement = statement[:-1].rstrip()
assert ";" not in statement, "multiple or embedded statements are forbidden"
first = re.match(r"\s*([A-Za-z]+)", statement)
assert first and first.group(1).upper() in {"SELECT", "WITH"}, "first token must be SELECT or WITH"
with_count = len(re.findall(r"(?i)\bWITH\b", statement))
assert with_count == (1 if first.group(1).upper() == "WITH" else 0), "nested WITH is forbidden"
assert not re.search(
    r"\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|"
    r"GRANT|REVOKE|CALL|COPY\s+INTO)\b",
    statement, re.I,
), "mutation or side-effecting SQL is forbidden"

def closing_parenthesis(text, opening):
    depth = 0
    for index, char in enumerate(text[opening:], opening):
        depth += (char == "(") - (char == ")")
        if depth == 0:
            return index
    raise AssertionError("unclosed CTE parenthesis")

def cte_aliases(text):
    result = set()
    with_match = re.match(r"\s*WITH\b", text, re.I)
    if not with_match:
        return result
    position = with_match.end()
    recursive = re.match(r"\s+RECURSIVE\b", text[position:], re.I)
    position += recursive.end() if recursive else 0
    while True:
        alias = re.match(rf"\s*({atom})", text[position:])
        assert alias, "invalid top-level CTE alias"
        name = unquote(alias.group(1)).lower()
        position += alias.end()
        columns = re.match(r"\s*\(", text[position:])
        if columns:
            opening = position + columns.end() - 1
            position = closing_parenthesis(text, opening) + 1
        body = re.match(r"\s+AS\s*\(", text[position:], re.I)
        assert body, "invalid top-level CTE body"
        opening = position + body.end() - 1
        position = closing_parenthesis(text, opening) + 1
        result.add(name)
        comma = re.match(r"\s*,", text[position:])
        if not comma: break
        position += comma.end()
    return result

assert not re.search(
    rf"(?i)\bFROM\s+{identifier}(?:\s+(?:AS\s+)?{atom})?\s*,",
    statement,
), "comma joins are forbidden"
targets = re.findall(rf"(?i)\b(?:FROM|JOIN)\s+((?:{identifier})(?![A-Za-z0-9_@.$])|\S+)", statement)
assert targets, "at least one FROM or JOIN target is required"
allowed = {line.strip().replace("`", "") for line in open(sources_file) if line.strip()}
assert allowed
aliases = cte_aliases(statement)
configured = set()
for target in targets:
    matches = atom_re.findall(target)
    parts = [unquote(part) for part in matches]
    assert parts and ".".join(matches) == target, target
    if len(parts) == 3:
        normalized = ".".join(parts)
        assert normalized in allowed, {"target": normalized, "allowed": sorted(allowed)}
        configured.add(normalized)
    elif len(parts) == 1:
        assert parts[0].lower() in aliases, {"target": parts[0], "cte_aliases": sorted(aliases)}
    else:
        raise AssertionError(f"target must be configured FQN or CTE alias: {target}")
assert configured, "query must read at least one configured FQN"
outputs = {"generated": "read_only_query=true\ngrounded_sources=true", "baseline": "baseline_read_only=true"}
assert mode in outputs, mode
print(outputs[mode])
PY
python3 "$sql_gate" "$generated_sql" "$sources_file" generated
python3 "$sql_gate" "$baseline_sql" "$sources_file" baseline
```

### Fetch and compare the exact result

```bash
databricks genie get-message-attachment-query-result \
  "$space_id" "$conversation_id" "$message_id" "$attachment_id" \
  -o json >"$answer_file"

run_sql() {
  local statement=$1 response statement_id state
  response=$(
    databricks api post /api/2.0/sql/statements \
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
        response=$(databricks api get "/api/2.0/sql/statements/$statement_id") || return
        ;;
      *) jq -c '.status.error // .status' >&2 <<<"$response"; return 1 ;;
    esac
  done
}
run_sql "$baseline_sql" >"$baseline_file"
jq -e '.status.state == "SUCCEEDED" and .result.data_array != null' \
  "$baseline_file" >/dev/null

canonical_filter='def normalize: if type == "string" and test("^-?[0-9]+([.][0-9]+)?$") then tonumber else . end;'
jq -S "$canonical_filter"'{columns:[.manifest.schema.columns[].name],rows:([.result.data_array[]|map(normalize)]|sort)}' \
  "$baseline_file" >"$baseline_file.canonical"
jq -S "$canonical_filter"'{columns:[.statement_response.manifest.schema.columns[].name],rows:([.statement_response.result.data_array[]|map(normalize)]|sort)}' \
  "$answer_file" >"$answer_file.canonical"
diff -u "$baseline_file.canonical" "$answer_file.canonical"
printf '%s\n' 'query_result_matches_baseline=true'
```

Expected:

```text
conversation=COMPLETED
read_only_query=true
grounded_sources=true
baseline_read_only=true
query_result_matches_baseline=true
```

Response prose is not verified.

## Where this fails

- Missing approval, parent, pagination, or canonicalization: stop.
- Rejected `metric_views` or `tables`, FQN drift, invalid ID, or private state: reconcile the target-owned contract.
- Wrong warehouse, permission, Conversation, or attachment count: correct target or question.
- Non-`SELECT` or non-`WITH` first token, mutation, multiple statements, comma join, nested subquery, or unconfigured source: reject the SQL.
- Result mismatch: reconcile SQL and data.

## Next

- **Do next:** [Databricks Jobs](https://github.com/databricks/databricks-agent-skills/tree/main/plugins/databricks/claude/skills/databricks-jobs)
- **Back to section:** [Databricks Projects](/docs/02-databricks-projects/)
