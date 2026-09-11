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
Validate one deterministic question through the Conversation API against an independent baseline.
A deterministic question returns one small, stable result set that fits in a single response chunk, so its rows equal the baseline on every run.
The safety gate accepts read-only queries, including CTEs, subqueries, and set operations, and grounds every base table to a configured source.
It rejects mutations, multiple statements, implicit comma joins, and unconfigured sources.

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
| `GENIE_APPROVED_REQUEST_SHA256` | Human-provided | Record the SHA-256 printed for the fully rendered and approved `src/genie_agent.json` |
| Source FQNs and column configurations | Human-provided | Permitted sources and metadata |
| Sample questions | Human-provided | Exact approved samples |
| Example questions | Human-provided | Exact approved examples |
| Justified text instructions | Human-provided | Each approved instruction |
| Example SQL | Human-provided | Validated read-only SQL |
| `GENIE_VALIDATION_QUESTION`, `GENIE_SPACE_ID`, `GENIE_STATE_FILE` | Human-provided | One deterministic question whose answer is a small, stable result set in a single response chunk; ID optional on first create and authoritative when set; optional target-owned state |
| Warehouse, source metadata, stable IDs, `GENIE_BASELINE_SQL`, expected result | Agent-derived | Resolve and validate the complete design |
| Requested and persisted parent paths | Agent-derived | Derive `/Workspace/Users/<current-user.userName>/genie_agents` for requests and `/Users/<current-user.userName>/genie_agents` for persisted metadata |
| Observed persistence contract | Agent-derived | `request_source_key=metric_views`, `persisted_source_key=tables`, `create_id_field=space_id`, and `query_attachment_id_field=attachment_id` |

## Run

### 0. Resolve the read-only target

Start one persistent Bash session before preparing the approval package.
This block reads authentication, current-user, and bundle state but mutates nothing.

```text
bash
set -euo pipefail
approval_session_pid=$$
for required in DATABRICKS_ACCOUNT_ID DATABRICKS_WORKSPACE_ID DATABRICKS_HOST DATABRICKS_CONFIG_PROFILE PROJECT_PATH GENIE_TITLE GENIE_DESCRIPTION
do
  test -n "${!required:-}" || { printf '%s is required\n' "$required" >&2; exit 1; }
done
cd "$PROJECT_PATH"
databricks() {
  command databricks "$@" --profile "$DATABRICKS_CONFIG_PROFILE"
}
auth=$(databricks auth describe -o json)
jq -e --arg a "$DATABRICKS_ACCOUNT_ID" --arg w "$DATABRICKS_WORKSPACE_ID" --arg h "$DATABRICKS_HOST" '
  [.host // .details.host // .details.configuration.host.value,
   .account_id // .details.configuration.account_id.value,
   (.workspace_id // .details.configuration.workspace_id.value | tostring)] == [$h, $a, $w]
' >/dev/null <<<"$auth"
principal=$(databricks current-user me -o json \
  | jq -er '.userName | select(type == "string" and length > 0 and (contains("/") | not))')
requested_parent_path="/Workspace/Users/$principal/genie_agents"
persisted_parent_path="/Users/$principal/genie_agents"
bundle=$(databricks bundle validate --strict --target dev -o json)
warehouse_id=$(jq -er '.variables.warehouse_id.value | select(type == "string" and length > 0)' <<<"$bundle")
printf 'principal=%s\nrequested_parent=%s\npersisted_parent=%s\nwarehouse_id=%s\n' \
  "$principal" "$requested_parent_path" "$persisted_parent_path" "$warehouse_id"
```

Expected: the exact target matches and the active principal, deterministic request path, canonical persisted path, and warehouse are printed before approval.

### 1. Design and obtain explicit approval

Create `src/genie_agent.json` as the complete proposed request:

```json
{
  "version": 2,
  "config": {"sample_questions": [{"id": "10000000000000000000000000000001", "question": ["<sample_question>"]}]},
  "data_sources": {"metric_views": [{"identifier": "<catalog>.<schema>.<metric_view>", "column_configs": [{"column_name": "<categorical_dimension>", "enable_entity_matching": true, "enable_format_assistance": true, "synonyms": ["<approved_synonym>"]}]}]},
  "instructions": {"example_question_sqls": [{"id": "20000000000000000000000000000001", "question": ["<representative_question>"], "sql": ["<validated_read_only_sql>"]}], "text_instructions": [{"id": "30000000000000000000000000000001", "content": ["<approved_global_instruction>"]}]}
}
```

Require the request source object to contain exactly `metric_views`.
Reject an extra `tables` key before checksum or approval:

```bash
request_source_filter='(.data_sources | keys) == ["metric_views"]'
jq -e "$request_source_filter" src/genie_agent.json >/dev/null
if jq -en '{"data_sources":{"metric_views":[],"tables":[]}} | '"$request_source_filter" >/dev/null
then
  printf '%s\n' 'extra source-key fixture passed' >&2
  exit 1
fi
```

Render the full file bytes, its entire parsed JSON, and its checksum for approval:

```bash
cat src/genie_agent.json
jq '.' src/genie_agent.json
shasum -a 256 src/genie_agent.json
```

Present the title, description, principal-derived requested parent path, expected persisted parent path, request source key `metric_views`, expected exported source key `tables`, warehouse, every source, every column configuration, every instruction, every sample question, every example SQL, and both complete renderings.
Obtain explicit human approval of that complete design and record the printed hash as `GENIE_APPROVED_REQUEST_SHA256`.
General approval is insufficient.
Do not modify the approved file after recording its hash.
Do not create the parent folder, create a space, or update a space before this approval.
Do not author request serialization with `tables`.

### 2. Continue after explicit approval

Continue in the same Bash session.
Every command before `workspace mkdirs` remains read-only or local validation:

```bash
test "$approval_session_pid" = "$$"
: "${GENIE_APPROVED_REQUEST_SHA256:?}"
: "${GENIE_VALIDATION_QUESTION:?}"
: "${GENIE_BASELINE_SQL:?}"
genie_title=$GENIE_TITLE
genie_description=$GENIE_DESCRIPTION
direct_space_id=${GENIE_SPACE_ID:-}
genie_state_file=${GENIE_STATE_FILE:-}
validation_question=$GENIE_VALIDATION_QUESTION
baseline_sql=$GENIE_BASELINE_SQL
answer_file=$(mktemp)
baseline_file=$(mktemp)
sources_file=$(mktemp)
if test -n "$direct_space_id"
then
  jq -en --arg id "$direct_space_id" \
    '$id | select(test("^[0-9a-f]{32}$"))' >/dev/null
fi
printf '%s  %s\n' "$GENIE_APPROVED_REQUEST_SHA256" src/genie_agent.json \
  | shasum -a 256 -c -
jq -e "$request_source_filter" src/genie_agent.json >/dev/null
configured_sources=()
while IFS= read -r configured_source
do
  configured_sources+=("$configured_source")
done < <(jq -er '.data_sources.metric_views[].identifier' src/genie_agent.json)
test "${#configured_sources[@]}" -ge 1
printf '%s\n' "${configured_sources[@]}" >"$sources_file"
expected_persisted_space=$(jq -ce '
  if (.data_sources | keys) == ["metric_views"]
  then . as $request
    | ($request | .data_sources = {"tables": $request.data_sources.metric_views})
  else error("request data_sources must contain only metric_views")
  end
' src/genie_agent.json)
databricks workspace mkdirs "$requested_parent_path"
```

### 3. Resolve ownership and fail closed

```bash
assert_space() {
  jq -e \
    --arg warehouse_id "$warehouse_id" \
    --arg title "$genie_title" \
    --arg description "$genie_description" \
    --arg persisted_parent "$persisted_parent_path" \
    --argjson expected "$expected_persisted_space" '
      .warehouse_id == $warehouse_id
      and .title == $title
      and .description == $description
      and .parent_path == $persisted_parent
      and (.serialized_space | fromjson) == $expected' \
    >/dev/null <<<"$1"
}
jq -en --argjson expected "$expected_persisted_space" '
  $expected == $expected
  and (($expected | .instructions = {}) != $expected)
' >/dev/null
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
  assert_space "$existing"
  space_etag=$(jq -er '
    .etag | select(type == "string" and length > 0)' <<<"$existing")
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

### 4. Create or update by ID

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
import json, os, sys
response_path, state_path, requested, persisted = sys.argv[1:]
response = json.load(open(response_path))
space_id = response["space_id"]
assert isinstance(space_id, str) and space_id
state = {
    "space_id": space_id,
    "request_source_key": "metric_views",
    "persisted_source_key": "tables",
    "requested_parent_path": requested,
    "persisted_parent_path": persisted,
    "create_id_field": "space_id",
    "query_attachment_id_field": "attachment_id",
}
temporary = state_path + ".tmp"
with open(temporary, "w") as handle:
    json.dump(state, handle, indent=2, sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.replace(temporary, state_path)
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
    --arg etag "$space_etag" \
    --arg serialized_space "$serialized_space" \
    '{warehouse_id:$warehouse_id,title:$title,description:$description,etag:$etag,serialized_space:$serialized_space}')
  databricks genie update-space "$space_id" \
    --json "$update_request" -o json
fi
```

Do not define a native Genie bundle resource.

## Verify

### Verify canonical persistence

Canonicalize only the request key `data_sources.metric_views` to the persisted key `data_sources.tables`.
Require the entire remaining parsed serialized configuration to equal the approved request, while preserving exact warehouse, title, description, and principal-derived parent checks.

```bash
space=$(databricks genie get-space "$space_id" \
  --include-serialized-space -o json)
assert_space "$space"
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
  message_status=$(jq -er '.status' <<<"$message")
  case "$message_status" in
    COMPLETED) break ;;
    SUBMITTED|FILTERING_CONTEXT|ASKING_AI|EXECUTING_QUERY) sleep 5 ;;
    FAILED|CANCELLED) jq '.' >&2 <<<"$message"; exit 1 ;;
    *) printf 'unknown Genie status: %s\n' "$message_status" >&2; exit 1 ;;
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

Create `src/verify_genie_sql.py`:

```text
import sys
sql, sources_file, mode = sys.argv[1].strip(), sys.argv[2], sys.argv[3]
WORD, NAME, SYMBOL = range(3)

def tokenize(text):
    result = []
    index = depth = 0
    while index < len(text):
        char, pair = text[index], text[index:index + 2]
        if pair == "--":
            index = text.find("\n", index + 2)
            index = len(text) if index < 0 else index + 1
        elif pair == "/*":
            index = text.find("*/", index + 2)
            assert index >= 0, "unclosed block comment"
            index += 2
        elif char in {"'", '"', "`"}:
            quote, value, index = char, "", index + 1
            while index < len(text):
                if text[index] == "\\": index += 2
                elif text[index:index + 2] == quote * 2: value, index = value + quote, index + 2
                elif text[index] == quote:
                    index += 1
                    break
                else: value, index = value + text[index], index + 1
            else: raise AssertionError("unclosed quote")
            if quote == "`": result.append((NAME, value, depth))
        elif char.isspace(): index += 1
        elif char == "(":
            result.append((SYMBOL, char, depth))
            depth, index = depth + 1, index + 1
        elif char == ")":
            depth -= 1
            assert depth >= 0, "unmatched closing parenthesis"
            result.append((SYMBOL, char, depth))
            index += 1
        elif char.isalpha() or char == "_":
            end = index + 1
            while end < len(text) and (text[end].isalnum() or text[end] in "_-"): end += 1
            result.append((WORD, text[index:end], depth))
            index = end
        else:
            result.append((SYMBOL, char, depth))
            index += 1
    assert depth == 0, "unclosed parenthesis"
    return result

tokens = tokenize(sql)
assert tokens, "query is empty"
semicolons = [index for index, token in enumerate(tokens) if token[1] == ";"]
assert not semicolons or semicolons == [len(tokens) - 1], "multiple or embedded statements are forbidden"
if semicolons: tokens.pop()
is_keyword = lambda token, word: token[0] == WORD and token[1].upper() == word
assert is_keyword(tokens[0], "SELECT") or is_keyword(tokens[0], "WITH"), "query must start with SELECT or WITH"
mutations = {"CREATE", "ALTER", "DROP", "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "GRANT", "REVOKE", "CALL", "COPY", "REFRESH", "USE", "SET", "RESET"}
assert not any(token[0] == WORD and token[1].upper() in mutations for token in tokens), "mutation or side-effecting SQL is forbidden"
cte_names = set()
for cte_index in range(len(tokens) - 2):
    head, joiner, opener = tokens[cte_index], tokens[cte_index + 1], tokens[cte_index + 2]
    if head[0] in {WORD, NAME} and is_keyword(joiner, "AS") and opener[0] == SYMBOL and opener[1] == "(":
        cte_names.add(head[1].lower())
terminators = {"WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "QUALIFY", "UNION", "EXCEPT", "INTERSECT", "MINUS", "WINDOW", "DISTRIBUTE", "SORT", "CLUSTER", "ON", "USING"}
relation_indexes = [index for index, token in enumerate(tokens) if is_keyword(token, "FROM") or is_keyword(token, "JOIN")]
assert relation_indexes, "at least one FROM or JOIN target is required"
for start in [index for index in relation_indexes if is_keyword(tokens[index], "FROM")]:
    scope = tokens[start][2]
    for token in tokens[start + 1 :]:
        if token[2] < scope or (token[2] == scope and token[0] == WORD and token[1].upper() in terminators): break
        assert token[2] != scope or token[1] != ",", "comma-separated relations are forbidden"
allowed = {line.strip().replace("`", "") for line in open(sources_file) if line.strip()}
assert allowed
def read_parts(position):
    parts = [tokens[position][1]]
    while position + 2 < len(tokens) and tokens[position + 1][1] == "." and tokens[position + 2][0] in {WORD, NAME}:
        parts.append(tokens[position + 2][1])
        position += 2
    return parts
configured = set()
for relation in relation_indexes:
    position = relation + 1
    assert position < len(tokens), "missing relation target"
    target = tokens[position]
    if target[0] == SYMBOL and target[1] == "(":
        continue
    if target[0] == WORD and target[1].upper() in {"LATERAL", "VALUES"}:
        continue
    if target[0] == WORD and target[1].upper() == "TABLE":
        position += 1
        assert position < len(tokens) and tokens[position][0] in {WORD, NAME}, "invalid TABLE target"
    assert tokens[position][0] in {WORD, NAME}, "invalid relation target"
    parts = read_parts(position)
    if len(parts) == 1:
        assert parts[0].lower() in cte_names, {"unqualified_relation": parts[0]}
    elif len(parts) == 3:
        normalized = ".".join(parts)
        assert normalized in allowed, {"target": normalized, "allowed": sorted(allowed)}
        configured.add(normalized)
    else:
        raise AssertionError({"target": ".".join(parts), "reason": "relation must be a configured FQN or CTE name"})
assert configured, "query must read at least one configured FQN"
outputs = {"generated": "read_only_query=true\ngrounded_sources=true", "baseline": "baseline_read_only=true"}
assert mode in outputs, mode
print(outputs[mode])
```

Run the same gate against both queries:

```bash
python3 src/verify_genie_sql.py "$generated_sql" "$sources_file" generated
python3 src/verify_genie_sql.py "$baseline_sql" "$sources_file" baseline
```

The lexer tracks quote, comment, and parenthesis state, allows read-only CTEs, subqueries, and set operations, rejects mutations, multiple statements, and implicit comma joins, and grounds every base relation to a configured FQN or a CTE name defined in the same query.

### Fetch and compare the exact result

Create `src/verify_complete_statement.jq`:

```text
.status.state == "SUCCEEDED" and (.result.data_array | type == "array")
and .manifest.truncated == false
and (.manifest.total_chunk_count | type == "number") and .manifest.total_chunk_count == 1
and (.manifest.chunks | type == "array") and (.manifest.chunks | length) == 1
and (.manifest.chunks[0].chunk_index | type == "number") and .manifest.chunks[0].chunk_index == 0
and (.manifest.chunks[0].row_count | type == "number") and .manifest.chunks[0].row_count == (.result.data_array | length)
and (.result.chunk_index | type == "number") and .result.chunk_index == 0
and (((.result | has("next_chunk_internal_link")) | not) or .result.next_chunk_internal_link == "")
and (((.result | has("next_chunk_external_link")) | not) or .result.next_chunk_external_link == "")
and (.manifest.total_row_count | type == "number")
and .manifest.total_row_count == (.result.data_array | length)
```

```bash
databricks genie get-message-attachment-query-result \
  "$space_id" "$conversation_id" "$message_id" "$attachment_id" \
  -o json >"$answer_file"

run_sql() {
  databricks api post /api/2.0/sql/statements \
    --json "$(jq -n \
      --arg warehouse_id "$warehouse_id" \
      --arg statement "$1" \
      '{warehouse_id:$warehouse_id,statement:$statement,wait_timeout:"50s",on_wait_timeout:"CANCEL"}')" \
    | jq -e 'select(.status.state == "SUCCEEDED")'
}
run_sql "$baseline_sql" >"$baseline_file"
jq -e -f src/verify_complete_statement.jq "$baseline_file" >/dev/null
answer_statement_file=$(mktemp)
jq -e '.statement_response' "$answer_file" >"$answer_statement_file"
jq -e -f src/verify_complete_statement.jq "$answer_statement_file" >/dev/null

complete_fixture=$(mktemp)
jq -n '{status:{state:"SUCCEEDED"},manifest:{truncated:false,total_chunk_count:1,total_row_count:1,chunks:[{chunk_index:0,row_count:1}]},result:{chunk_index:0,data_array:[["1"]]}}' >"$complete_fixture"
jq -e -f src/verify_complete_statement.jq "$complete_fixture" >/dev/null
for incomplete_fixture in \
  'del(.manifest.truncated)' \
  'del(.manifest.total_chunk_count)' \
  'del(.manifest.chunks)' \
  'del(.manifest.chunks[0].chunk_index)' \
  'del(.manifest.chunks[0].row_count)' \
  'del(.result.chunk_index)' \
  'del(.manifest.total_row_count)' \
  '.manifest.chunks[0].row_count = 2' \
  '.manifest.total_row_count = 2' \
  '.manifest.total_chunk_count = 2' \
  '.manifest.chunks += [{chunk_index:1,row_count:0}]' \
  '.result.next_chunk_internal_link = "/next"' \
  '.status.state = "RUNNING"'
do
  if jq "$incomplete_fixture" "$complete_fixture" \
    | jq -e -f src/verify_complete_statement.jq >/dev/null
  then
    printf 'incomplete result fixture passed: %s\n' "$incomplete_fixture" >&2
    exit 1
  fi
done

canonical_filter='def normalize: if type == "string" and test("^-?[0-9]+([.][0-9]+)?$") then tonumber else . end;'
jq -S "$canonical_filter"'{columns:[.manifest.schema.columns[].name],rows:([.result.data_array[]|map(normalize)]|sort),row_count:.manifest.total_row_count}' \
  "$baseline_file" >"$baseline_file.canonical"
jq -S "$canonical_filter"'{columns:[.manifest.schema.columns[].name],rows:([.result.data_array[]|map(normalize)]|sort),row_count:.manifest.total_row_count}' \
  "$answer_statement_file" >"$answer_file.canonical"
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
Every required completeness-field deletion, row-count mismatch, declared or manifest multi-chunk result, next-link, and noncompleted fixture must fail before exact comparison.

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| Approval, parent, pagination, or canonicalization fails | Mutation is not safe | Stop before mutation |
| Source keys, FQNs, ID, or state drift | The target-owned contract differs | Reconcile ownership |
| Warehouse, permission, Conversation, or attachment check fails | The target or question is wrong | Correct it |
| Generated query is rejected as unsafe | It mutates, runs multiple statements, uses an implicit comma join, or reads an unconfigured source | Keep the question read-only and grounded in configured sources, since CTEs, subqueries, and set operations are allowed |
| Result is truncated or multi-chunk | The validation question returns too large a result | Choose a deterministic question whose result fits one response chunk |
| SQL safety fails | The query mutates, runs multiple statements, uses implicit comma relations, or reads unconfigured sources | Reject it |
| Result differs | SQL or data drifted | Reconcile both |

## Next

- **Do next:** [Databricks Jobs](/docs/02-databricks-projects/databricks-jobs/)
- **Back to section:** [Databricks Projects](/docs/02-databricks-projects/)
