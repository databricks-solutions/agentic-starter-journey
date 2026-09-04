---
description: Install and verify the Databricks CLI, the cloud CLI, and both skill libraries before running any other page.
---

# Pre-requisites

## Mental Model

Every later page assumes three things work: the Databricks CLI is installed and authenticated, the cloud CLI for the target cloud is authenticated, and both skill libraries are visible to the agent harness.
Skipping this page fails mid-flight: Terraform stops mid-apply, and bundle deploys reject unauthenticated calls.

## Goal

Install anything missing, then confirm the three prerequisites every later page depends on.
Report what passed and what failed with the fix for each.

## Prerequisites

None.
This is the first page.
Auth surface: `account` plus cloud CLI for the target cloud.
This page is the bootstrap auth check.

## Skill

No product skill is invoked on this check page.
Install [ai-platform-kit](https://github.com/databricks-solutions/ai-platform-kit) and [databricks-agent-skills](https://github.com/databricks/databricks-agent-skills#installation) before continuing.

## Inputs

| Input | Source | How to obtain |
|---|---|---|
| Account host | Human | AWS: `https://accounts.cloud.databricks.com`. Azure: `https://accounts.azuredatabricks.net`. GCP: the accounts host for the cloud. Infra Setup starts here. There is no workspace URL yet. |
| Databricks account id | Human | Account console, top-right user menu. Live identity must match this id before any later page runs. |
| Named Databricks account profile | Human | Named Databricks CLI profile that can call account APIs (`databricks account workspaces list`). |
| Target cloud | Human | `aws`, `azure`, or `gcp`. Drives which cloud CLI check to run. |
| AWS account id and named profile | Human | Required for AWS. Use the 12-digit account id and the exact AWS CLI profile passed with `--profile`. |
| Azure expected subscription id and active CLI context | Human | Required for Azure. Name the expected subscription id, then select it in the active Azure CLI context with `az account set --subscription <azure-subscription-id>`. |
| GCP project id and named configuration | Human | Required for GCP. Name the expected project id and the exact gcloud configuration passed with `--configuration`. |
| Agent harness | You derive | `claude`, `codex`, `cursor`, `copilot`, `gemini`, `windsurf`, `opencode`, `kiro`, or `all`. Drives the ai-platform-kit `--agent` flag. |
| Skill directory | You derive | Directory this harness reads. Claude: `~/.claude/skills/`. Cursor: `~/.cursor/skills/`. Also check project `.claude/skills/` / `.cursor/skills/`. |

## Run

Refuse to continue if the human has not named `<databricks-account-id>`, `<account-profile>`, and the target cloud's expected identifier and auth context.
AWS requires `<aws-account-id>` and `<aws-profile>`.
Azure requires `<azure-subscription-id>` and an active Azure CLI context.
GCP requires `<gcp-project-id>` and `<gcp-configuration>`.
Ambiguous targets alone (workspace URL, bucket name, display name) are insufficient.

```bash
# 0. Live identity must match human-named account ids (hard stop on mismatch)
databricks auth profiles -o json \
  | jq -r --arg p "<account-profile>" '.profiles[] | select(.name==$p) | "\(.name)\tValid=\(.valid)\taccount_id=\(.account_id // "unknown")"'

LIVE_DB_ACCOUNT=$(databricks auth profiles -o json \
  | jq -er --arg p "<account-profile>" '
      [.profiles[] | select(.name == $p and .valid == true)]
      | select(length == 1)
      | .[0].account_id
      | select(type == "string" and length > 0)')
test "$LIVE_DB_ACCOUNT" = "<databricks-account-id>" \
  || { echo "BLOCKED: Databricks account id mismatch (live=$LIVE_DB_ACCOUNT expected=<databricks-account-id>)"; exit 1; }
databricks account workspaces list --profile <account-profile> -o json >/dev/null

# AWS
aws sts get-caller-identity --profile <aws-profile> --query Account --output text
test "$(aws sts get-caller-identity --profile <aws-profile> --query Account --output text)" = "<aws-account-id>" \
  || { echo "BLOCKED: AWS account id mismatch"; exit 1; }

# Azure (when target cloud is azure)
test "$(az account show --query id -o tsv)" = "<azure-subscription-id>" \
  || { echo "BLOCKED: Azure subscription id mismatch"; exit 1; }

# GCP (when target cloud is gcp)
test "$(gcloud config get-value project --configuration <gcp-configuration>)" = "<gcp-project-id>" \
  || { echo "BLOCKED: GCP project id mismatch"; exit 1; }

# 1. Databricks CLI installed and recent enough
databricks version

# 2. Named profiles; Valid=YES for the account-admin profile
databricks auth profiles
databricks auth describe --profile <account-profile>

# Prove account APIs work (do not require jq on auth describe)
databricks account workspaces list --profile <account-profile> -o json | jq 'length'

# 3. Install both skill libraries if missing
# ai-platform-kit (workspaces, catalogs, storage, networking)
bash <(curl -sL https://raw.githubusercontent.com/databricks-solutions/ai-platform-kit/main/install.sh) \
  --agent <harness> --scope global
# Examples: --agent cursor | --agent claude | --agent all

# databricks-agent-skills (pipelines, DABs, dashboards, agents)
databricks aitools install

# Confirm skills exist where THIS harness reads them
find ~/.claude/skills ~/.cursor/skills .claude/skills .cursor/skills \
  -name SKILL.md \( -path '*platform-provisioning*' -o -path '*unity-catalog-setup*' \) 2>/dev/null

# 4. Cloud CLI for the target cloud (run only the block for target cloud)
aws sts get-caller-identity --profile <aws-profile>   # AWS
az account show                                       # Azure: active context, note tenant + subscription
gcloud auth list --configuration <gcp-configuration> # GCP
terraform version                                        # >= 1.9.0, all clouds
```

Run all checks, then report the result as a table, not prose.
For every failure give the install command and where the value comes from.

On any auth preflight failure, print **BLOCKED: auth preflight failed**, then this remediation table, then stop.
Do not invoke skills, Terraform, or Crew.

| Check failed | Human must run |
|---|---|
| Databricks profile missing | `databricks auth login --host <account-host> --profile <account-profile>` |
| Databricks profile `Valid=NO` | Refresh OAuth or M2M credentials for `<account-profile>`; rerun `databricks auth login` or update the profile secret |
| Databricks account id mismatch | Confirm the account console id; fix `<account-profile>` or the human-provided `<databricks-account-id>` |
| AWS STS expired or invalid | `aws sso login --profile <aws-profile>` or refresh the named profile session |
| AWS account id mismatch | `aws sts get-caller-identity --profile <aws-profile>`; fix the profile or `<aws-account-id>` |
| Azure not logged in or wrong active subscription | `az login --tenant <tenant-id>` then `az account set --subscription <azure-subscription-id>` |
| GCP not logged in or wrong project | `gcloud auth login --configuration <gcp-configuration>` then `gcloud config set project <gcp-project-id> --configuration <gcp-configuration>` |

## Verify

```bash
databricks auth profiles
```

Expected: the account-admin profile row shows `Valid` = `YES` and the account host for that cloud.

```bash
databricks auth profiles -o json \
  | jq -er --arg p "<account-profile>" '
      [.profiles[] | select(.name == $p and .valid == true)]
      | select(length == 1)
      | .[0].account_id'
```

Expected: prints `<databricks-account-id>`.

```bash
aws sts get-caller-identity --profile <aws-profile> --query Account --output text         # AWS
az account show --query id -o tsv                                                       # Azure active context
gcloud config get-value project --configuration <gcp-configuration>                     # GCP
```

Expected: prints `<aws-account-id>`, `<azure-subscription-id>`, or `<gcp-project-id>` for the target cloud.
A mismatch with the human-named id is a hard failure; stop with the remediation table.

```bash
databricks account workspaces list --profile <account-profile> -o json | jq 'length'
```

Expected: a number (zero or more).
An auth error means the account profile is wrong.

Do not run `databricks clusters list` against an account-host profile.
That check belongs after a workspace profile exists.

```bash
find ~/.claude/skills ~/.cursor/skills .claude/skills .cursor/skills \
  -name SKILL.md -path '*platform-provisioning*' 2>/dev/null
find ~/.claude/skills ~/.cursor/skills .claude/skills .cursor/skills \
  -name SKILL.md \( -path '*databricks-pipelines*' -o -path '*pipelines*' \) 2>/dev/null
```

Expected: each prints at least one path.
A skill is installed when its `SKILL.md` exists.
Frontmatter `name` may be `databricks-platform-provisioning` while the directory is `platform-provisioning`.
Both forms are correct.

Example report format:

```text
CLI          v0.297.1        OK
Auth         profile Valid   OK
ai-platform-kit             not found   rerun install.sh --agent <harness> --scope global
databricks-agent-skills     OK
Terraform    v1.9.8          OK
AWS profile  not set         ask the user which named profile to use
```

## Where this fails

| Symptom | Cause | Fix |
|---|---|---|
| `BLOCKED: Databricks account id mismatch` | Named id does not match live profile or account API | Confirm account console id; rerun `databricks auth login --host <account-host> --profile <account-profile>` or fix M2M profile credentials |
| `BLOCKED: AWS account id mismatch` or `ExpiredToken` | Wrong AWS profile or expired STS session | `aws sso login --profile <aws-profile>`; confirm with `aws sts get-caller-identity --profile <aws-profile>` |
| `BLOCKED: Azure subscription id mismatch` | The active Azure CLI context targets the wrong subscription or tenant | `az login --tenant <tenant-id>` then `az account set --subscription <azure-subscription-id>` |
| `BLOCKED: GCP project id mismatch` | The named gcloud configuration targets the wrong project | `gcloud auth login --configuration <gcp-configuration>` then `gcloud config set project <gcp-project-id> --configuration <gcp-configuration>` |
| Account profile `Valid=NO` | Expired OAuth, stale M2M secret, wrong host, or missing account admin | `databricks auth login --host <account-host> --profile <account-profile>` or update the SP OAuth secret; confirm Account admin role |
| `databricks: command not found` | CLI not installed | Install per the Databricks CLI docs |
| `auth describe` prints "Unable to load OAuth Config" but account APIs work | Describe quirk on some M2M profiles | Trust `auth profiles` + `account workspaces list`, not describe alone |
| `databricks: unknown command "aitools"` | CLI below v1.0.0 | Upgrade the CLI, then rerun `databricks aitools install` |
| Skill find returns empty on Cursor | Searched only `~/.claude` | Search `~/.cursor/skills/` or reinstall with `--agent cursor --scope global` |
| Skills installed but the agent never invokes them | Project-scope install, agent started from a different directory | Reinstall ai-platform-kit with `--scope global`, or start the agent from the install directory |
| `terraform version` below 1.9.0 | Old Terraform | Install Terraform >= 1.9.0 |
| Cloud CLI not authenticated | No profile or login | `aws configure` / `az login` / `gcloud auth login` |

## Next

- **Do next:** [Workspaces](/docs/01-infra-setup/workspaces/)
