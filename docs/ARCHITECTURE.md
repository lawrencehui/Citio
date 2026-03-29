# Citio -- Technical Architecture Document

Version: 0.1.0
Date: 2026-03-27
Status: Pre-release (functional prototype, not production-hardened)

---

## 1. Executive Summary

### What Citio Is

Citio is a self-hosted MCP (Model Context Protocol) server that bridges Slack with autonomous coding agents (Claude Code, OpenAI Codex). It receives natural-language requests from team members in Slack, spawns an AI coding agent to investigate or fix the issue, and posts results back -- including opening pull requests on GitHub.

The core premise: a technical founder going on holiday needs their team to fix bugs, investigate logs, and land code changes via Slack without bottlenecking on the CTO. Citio is the autonomous stand-in.

### Vision

Citio is not a Slack bot that calls an LLM API. It is an MCP server (control plane) that exposes tools to coding agents. The agents connect via MCP and use those tools to read code, write files, create branches, open PRs, and run commands. Credentials (GitHub PAT, AWS IAM, API keys) live in the MCP server and are never exposed to the agent process.

### Current State (v0.1.0)

What works:
- Slack integration via Assistant API and channel @mentions
- Claude Code agent spawning with `--mcp-config` and `--bare` flags
- Stream-JSON output parsing with live progress updates to Slack
- Workspace management (git clone, credential helper)
- Health check endpoint on port 3001
- Interactive installer (`citio init`) with AWS ECS deployment
- Docker container (non-root, linux/amd64)
- Credential redaction in Slack output
- DM restrictions (admin_users) and channel auth (authorized_users)

What does not work or is incomplete:
- MCP config is passed to Claude but has been observed to hang sometimes (see commit `2543821`)
- Codex integration is unstable (sandbox/bwrap issues on Fargate, token refresh fragile)
- No automated tests
- No session continuity across messages (each message spawns a fresh agent)
- `save_finding` writes to disk but there is no `recall_context` tool to read it back
- Installer has a hardcoded EFS ID in the OAuth credential upload path (`<EFS_ID>` at `src/cli/init.ts:749`)

### Git History (22 commits)

```
5cd8817 feat: stream-json output with live progress (tool usage, thinking)
25bb1c8 fix: add --bare flag to claude -p (prevents hang from plugin/hook loading)
0876f44 fix: remove hardcoded repo names from prompt
2543821 fix: remove MCP config (hanging), add AWS context to prompt
d24e255 feat: live progress streaming to Slack during agent work
3662df1 feat: channel replies (not threads), DM restricted to admin_users
ae9ea3d feat: Claude MCP mode with --mcp-config, Opus 4.6 default, GH_TOKEN
b494046 fix: remove broken auth check, trust EFS tokens + MCP server refresh
8beef66 fix: auth check uses --ephemeral to avoid sandbox false-negative
c10bab0 feat: auth check on container boot, device-auth prompt if needed
b641f2a docs: never kill all docker containers blindly
bdb479d refactor: replace one-shot codex exec with long-running codex mcp-server
197a349 fix: git clone auth in container via GH_TOKEN credential helper
487e0f2 feat: installer auto-fetches repos from GitHub PAT, multiselect picker
c632552 fix: Codex exec flag, git init workspace, skip-git-repo-check
20356f3 fix: codex CLI uses 'exec' not '-q' flag
6411f0d fix: installer auth -- local login then upload to EFS, no in-container auth
80d6979 docs: add deployment lessons to CLAUDE.md after ECS debugging
f388f84 fix: remove credential copy logic, fix 17 code quality issues
651f133 feat: Citio v0.1.0 -- autonomous CTO agent in Slack
```

---

## 2. Architecture

### 2.1 Current State (What Is Actually Implemented)

```
                         Slack Workspace
                              |
                    +---------+---------+
                    |                   |
             DM (Assistant API)   @mention (channel)
                    |                   |
                    v                   v
            +-------------------------------+
            |      SlackAdapter             |
            |   src/adapters/slack.ts       |
            |                               |
            |  - Assistant: threadStarted,  |
            |    userMessage, setStatus     |
            |  - app_mention event handler  |
            |  - Credential redaction       |
            |  - Progress streaming (5s)    |
            +-------------------------------+
                         |
                         | submit(prompt, callbacks)
                         v
            +-------------------------------+
            |      AgentRunner              |
            |   src/core/agent-runner.ts    |
            |                               |
            |  - FIFO queue (1 at a time)   |
            |  - Spawns: claude --bare -p   |
            |    --output-format stream-json |
            |    --mcp-config <path>        |
            |  - Parses stream events       |
            |  - Wall-clock timeout         |
            +-------------------------------+
                         |
                         | spawn child process
                         v
            +-------------------------------+
            |    Claude Code CLI            |
            |    (child process)            |
            |                               |
            |  --mcp-config points to:      |
            |  /tmp/citio/mcp-config.json
            +-------------------------------+
                         |
                         | MCP stdio transport
                         v
            +-------------------------------+
            |    Citio MCP Server       |
            |   src/core/mcp-entry.ts       |
            |                               |
            |  8 tools:                     |
            |  - investigate_codebase       |
            |  - read_file / write_file     |
            |  - create_branch / create_pr  |
            |  - run_command (allowlisted)  |
            |  - check_ci_status            |
            |  - save_finding               |
            +-------------------------------+
                    |           |
                    v           v
              /workspace    GitHub API
              (git repos)   (via gh CLI)
```

### 2.2 Target State (The Full MCP Vision from the Plan)

```
                         Slack Workspace
                              |
                    +---------+---------+
                    |                   |
             DM (Assistant API)   @mention (channel)
                    |                   |
                    v                   v
            +-------------------------------+
            |      SlackAdapter (thin)      |
            +-------------------------------+
                         |
                         v
            +-----------------------------------------------+
            |         Citio Core (MCP Server)           |
            |                                               |
            |  +------------------------------------------+ |
            |  |  MCP Tools:                              | |
            |  |  - investigate_codebase(query)           | |
            |  |  - read_file / write_file                | |
            |  |  - create_branch / create_pr             | |
            |  |  - run_command (allowlisted)             | |
            |  |  - check_ci_status                       | |
            |  |  - save_finding / recall_context          | |
            |  |  - post_update (Slack thread)            | |
            |  |  - query_logs (CloudWatch/service)       | |
            |  +------------------------------------------+ |
            |                                               |
            |  +------------------------------------------+ |
            |  |  Internal Services:                      | |
            |  |  - SessionManager (PID, timeouts,        | |
            |  |    worktree lifecycle, thread mapping)    | |
            |  |  - PolicyEngine (who can do what)        | |
            |  |  - AuditLog (all actions logged)         | |
            |  |  - OrgMemory (semantic search /memory)   | |
            |  +------------------------------------------+ |
            |                                               |
            |  Credentials: GH_TOKEN, AWS IAM, API keys    |
            |  ONLY accessible by Core, never by agents    |
            +-----------------------------------------------+
                         |
              Agent spawned as subprocess
              (Claude Code OR Codex OR pi-mono)
              Connects to Core via MCP
                         |
                         v
                 GitHub (PRs, CI)
                 AWS (logs, infra)
                 /memory (org knowledge)
```

### 2.3 Gap Analysis

| Component | Current State | Target State | Gap |
|-----------|--------------|--------------|-----|
| MCP Server | 8 tools implemented in `mcp-entry.ts` | 10+ tools including `post_update`, `query_logs`, `recall_context` | 3 tools missing |
| MCP Wiring | `--mcp-config` passed but observed to hang sometimes; was temporarily removed in commit `2543821`, re-added in `ae9ea3d` | Reliable MCP connection every time | Stability issue |
| SessionManager | None -- queue in AgentRunner processes one task at a time | PID tracking, wall-clock timeout, worktree lifecycle, thread-to-session mapping | Not implemented |
| PolicyEngine | `authorized_users` and `admin_users` lists in config | Fine-grained rules (who can trigger deploys, cost limits) | Only basic auth checks |
| AuditLog | Structured JSON to stdout | Queryable audit trail of all MCP tool invocations | stdout-only logging |
| Org Memory | `save_finding` writes markdown files to `/memory/` | Semantic search via `recall_context`, TTL-based compaction | Write-only, no recall |
| Providers | Claude Code works; Codex partially works | Claude Code, Codex, pi-mono all via MCP | Codex unstable, pi-mono not started |
| Session Continuity | Each message spawns a fresh agent | Thread replies maintain context within same session | Not implemented |
| Worktrees | `create_branch` MCP tool creates worktrees | Per-session worktrees with automatic cleanup | No session lifecycle |
| Concurrency | Queue with `running` flag, 1 at a time | `max_concurrent_sessions: 2` with proper session isolation | Single-threaded |
| Tests | `"test": "echo \"Error: no test specified\" && exit 1"` | Fixture-based tests for MCP tools, Slack adapter | Zero tests |

---

## 3. Core Components

### 3.1 Entry Point -- `src/index.ts`

The main process that orchestrates startup. Sequence:

1. Load config from `citio.yaml` or `CITIO_CONFIG_B64` env var (lines 14-27)
2. If provider is Codex, attempt OAuth token refresh via curl to `auth.openai.com` (lines 46-75)
3. Initialize `WorkspaceManager` -- clones repos (line 78-79)
4. Initialize `AgentRunner` -- writes MCP config (line 82-83)
5. Start HTTP health check server on port 3001 (lines 86-104)
6. Start `SlackAdapter` -- connects via Socket Mode (line 107-108)
7. Register SIGTERM/SIGINT handlers for graceful shutdown (lines 113-122)

Config loading supports two modes:
- File: reads from `CITIO_CONFIG` path (default `citio.yaml`)
- Base64 env var: `CITIO_CONFIG_B64` for ECS without volume mounts (line 18-19)

All config values support `${ENV_VAR}` interpolation via `resolveEnvVars()`.

### 3.2 Slack Adapter -- `src/adapters/slack.ts`

**File:** `src/adapters/slack.ts` (364 lines)

Two interaction modes:

**Assistant API (DMs):**
- Uses `@slack/bolt` `Assistant` class (line 42)
- `threadStarted`: greets user, sets suggested prompts (lines 43-81)
- `userMessage`: validates auth, sets thread title/status, submits to AgentRunner (lines 88-218)
- DM access controlled by `admin_users` list (lines 104-113) -- if populated, only those user IDs can DM the bot. Empty list means everyone can.

**Channel @mentions:**
- Listens for `app_mention` events (line 224)
- Strips the `<@BOT_ID>` mention from the text (line 226)
- Posts replies directly in the channel (not in a thread) per commit `3662df1` (lines 252-258)
- Access controlled by `authorized_users` list (lines 240-247) -- unauthorized users are silently ignored.

**Credential Redaction:**
- Seven regex patterns (lines 5-13) covering: Anthropic keys (`sk-ant-`), OpenAI keys (`sk-`), Slack tokens (`xoxb-`, `xapp-`), GitHub PATs (`ghp_`, `github_pat_`), AWS access keys (`AKIA`)
- All agent output is run through `redactCredentials()` before posting to Slack (lines 182, 191, 283)

**Response Streaming:**
- Posts a "Working on it..." message immediately (lines 157-167)
- Updates that message every 5 seconds with the latest agent output (lines 178-188)
- On completion, replaces the thinking message with the final output (lines 190-208)
- Output is truncated to 3,900 characters (Slack message limit is ~4,000) with `_(output truncated)_` suffix (lines 193-195)

**Prompt Construction:**
- `buildPrompt()` (lines 320-348) constructs the system prompt with:
  - Agent identity ("You are Citio, an autonomous CTO agent")
  - Available tools (aws, gh, git)
  - AWS IAM guidance (never use --profile)
  - Thread context (which channel the user is viewing)
  - User's message
  - Slack mrkdwn formatting rules (bold is `*bold*`, no `#` headers, etc.)

### 3.3 Agent Runner -- `src/core/agent-runner.ts`

**File:** `src/core/agent-runner.ts` (231 lines)

Manages a FIFO queue of tasks and spawns Claude Code processes one at a time.

**Queue mechanism:**
- Tasks are pushed to `this.queue` array (line 67)
- `processQueue()` checks `this.running` flag; only one task runs at a time (lines 71-84)
- After a task completes, `processQueue()` is called again to process the next (line 83)

**Agent spawning (lines 87-188):**
- Spawns `claude` CLI with these flags:
  - `--bare` -- prevents loading of plugins/hooks that can cause hangs (commit `25bb1c8`)
  - `-p <prompt>` -- single-prompt mode
  - `--output-format stream-json` -- structured output
  - `--dangerously-skip-permissions` -- no interactive permission prompts
  - `--model claude-opus-4-6` (overridable via `CLAUDE_MODEL` env var)
  - `--verbose` -- detailed output
  - `--mcp-config /tmp/citio/mcp-config.json` -- connects to Citio MCP server
- Working directory is `this.workspacePath` (default `/workspace`)

**MCP config generation (lines 26-51):**
- Writes `/tmp/citio/mcp-config.json` at construction time
- Points to `node /app/dist/core/mcp-entry.js` (container path)
- Passes environment: `CITIO_WORKSPACE`, `CITIO_MEMORY`, `HOME`, `PATH`, `GH_TOKEN`, `AWS_DEFAULT_REGION`

**Stream-JSON parsing (lines 191-223):**
- Handles four event types:
  - `result` -- final result text
  - `assistant` -- message with content blocks (text or tool_use)
  - `content_block_delta` -- streaming text deltas
  - `stream_event` -- nested event wrapper (recursively processed)
- Non-JSON lines are treated as raw text output (line 130)

**Timeout:**
- Wall-clock timeout from `config.engine.max_session_duration_minutes` (default 60 min) (lines 176-185)
- SIGTERM first, SIGKILL after 10 seconds if still running

### 3.4 MCP Server -- `src/core/mcp-entry.ts`

**File:** `src/core/mcp-entry.ts` (242 lines)

A standalone Node.js process that implements the MCP protocol via stdio transport. Claude Code connects to this as a child process via `--mcp-config`.

Uses `@modelcontextprotocol/sdk` (version ^1.28.0).

**Command Security:**

Allowlist (line 16-19):
```
git, npm, npx, tsc, bun, python, python3, node, make,
ls, cat, head, tail, grep, find, wc, sort, uniq,
diff, echo, test, gh, aws, supabase
```

Blocklist (line 22-24):
```
curl, wget, nc, ssh, scp, rsync, env, printenv, export
```

Shell metacharacter rejection (line 169): `;|&`$(){}` are all blocked.
Commands are executed with `execFileSync` (no shell) to prevent injection (line 180).

**Tools are documented in detail in Section 4.**

### 3.5 Workspace Manager -- `src/core/workspace.ts`

**File:** `src/core/workspace.ts` (203 lines)

Handles repository cloning and workspace initialization.

**Git credential configuration (lines 23-33):**
- Sets `git config --global credential.helper` to return `GH_TOKEN` as the password
- Fallback: injects token directly into clone URLs (line 51)

**Repository cloning (lines 46-107):**
- For each repo in `config.workspace.repos`:
  - If already cloned: `git pull --ff-only` (line 63)
  - If not: `git clone --depth 1 --branch <branch>` (line 88)
- Clone timeout: 5 minutes (300000ms)
- `GIT_TERMINAL_PROMPT=0` prevents interactive auth prompts (line 93)
- Clone failures are non-fatal -- other repos continue (line 104)

**Instruction file generation (lines 112-155):**
- Writes identical content to both `CLAUDE.md` (for Claude Code) and `AGENTS.md` (for Codex)
- Content includes: workspace rules, MCP tool documentation, suggested workflow, loaded skills

**Skill loading (lines 157-176):**
- Reads directories from `config.skills.directory` (default `/workspace/.citio/skills/`)
- Looks for `SKILL.md` file in each subdirectory
- Concatenates skill content into the instruction files

**Worktree support (lines 185-202):**
- `cleanupWorktree()` method exists but is not called anywhere in the current codebase
- The `create_branch` MCP tool creates worktrees but nothing cleans them up

### 3.6 Config Schema -- `src/config/schema.ts`

**File:** `src/config/schema.ts` (64 lines)

Zod schema defining the complete `citio.yaml` structure:

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `name` | string | `"citio"` | Instance name |
| `version` | number | `1` | Config version |
| `slack.bot_token` | string | required | Slack Bot Token (`xoxb-...`) |
| `slack.app_token` | string | required | Slack App Token for Socket Mode (`xapp-...`) |
| `slack.channel_id` | string | optional | Primary channel ID |
| `slack.authorized_users` | string[] | `[]` | User IDs allowed to @mention in channels (empty = all) |
| `slack.admin_users` | string[] | `[]` | User IDs allowed to DM the bot (empty = all) |
| `engine.default_provider` | `"codex"` or `"claude"` | `"codex"` | Which agent CLI to use |
| `engine.max_session_duration_minutes` | number | `60` | Wall-clock timeout per task |
| `engine.max_concurrent_sessions` | number | `2` | Max parallel agents (not enforced -- always 1) |
| `engine.providers.codex` | object | optional | Codex config (api_key) |
| `engine.providers.claude` | object | optional | Claude config (api_key) |
| `skills.installed` | string[] | `[]` | Names of installed skills |
| `skills.directory` | string | `"/workspace/.citio/skills/"` | Where skill SKILL.md files live |
| `workspace.repos` | array | required | Repos to clone `{url, branch}` |
| `workspace.rules` | string[] | `[]` | Agent behavior rules |
| `deploy.provider` | `"aws"` | `"aws"` | Cloud provider |
| `deploy.aws.region` | string | `"us-east-1"` | AWS region |
| `deploy.aws.ecr_repo` | string | `"citio"` | ECR repository name |
| `deploy.aws.ecs_cluster` | string | `"default"` | ECS cluster name |
| `deploy.aws.ecs_service` | string | `"citio"` | ECS service name |
| `deploy.aws.task_cpu` | number | `2048` | Fargate CPU units (2 vCPU) |
| `deploy.aws.task_memory` | number | `8192` | Fargate memory (8 GB) |
| `deploy.aws.ephemeral_storage_gb` | number | `100` | Ephemeral storage |

Note: `engine.max_concurrent_sessions` is defined in the schema but not enforced at runtime. The AgentRunner always runs one task at a time regardless of this setting.

### 3.7 Environment Variable Resolver -- `src/utils/env.ts`

**File:** `src/utils/env.ts` (14 lines)

Recursively walks a parsed YAML object and replaces `${VAR_NAME}` patterns with `process.env[VAR_NAME]`. Used to keep secrets out of the config file -- the YAML contains `${SLACK_BOT_TOKEN}` and the actual value comes from the environment or `.env` file.

### 3.8 Interactive Installer -- `src/cli/init.ts`

**File:** `src/cli/init.ts` (913 lines)

Exposed as the `citio` binary (via `package.json` `bin` field). Uses `@clack/prompts` for terminal UI.

**Flow:**

1. **Prerequisites check** (lines 47-74): Verifies `docker`, `aws`, and `git` are installed.

2. **Provider selection** (lines 78-91): Codex (OpenAI) or Claude Code (Anthropic).

3. **Auth method** (lines 96-155):
   - OAuth (recommended): checks for existing local credentials (`~/.codex/auth.json` or `~/.claude/`). If not found, runs `codex login --device-auth` or `claude login` interactively.
   - API key: prompts for the key directly.

4. **Slack setup** (lines 157-176): Collects Bot Token, App Token, Channel ID with guidance link.

5. **GitHub token** (lines 178-186): Collects fine-grained PAT with permissions guidance.

6. **Repository selection** (lines 188-239):
   - Fetches repos accessible by the GitHub PAT via REST API (line 195-199)
   - Presents a multiselect picker showing repo name, visibility, default branch, last updated date (lines 204-212)
   - Falls back to manual URL entry if API call fails (lines 228-239)

7. **Rules** (lines 241-250): Custom agent behavior rules, with sensible defaults.

8. **Skills** (lines 252-262): Multiselect from `SKILL_REGISTRY`:
   - `gstack` -- QA, shipping, investigation (git clone from github.com/garrytan/gstack.git)
   - `frontend-design` -- via `npx skills add`
   - `code-reviewer` -- via `npx skills add`
   - `antigravity-awesome-skills` -- via `npx antigravity-awesome-skills --claude`

9. **AWS config** (lines 264-301): Region selection, profile selection, EFS opt-in.

10. **Config file generation** (lines 320-383): Writes `citio.yaml` and `.env`.

11. **AWS deployment** (lines 442-865):
    - Gets account ID via STS
    - Creates ECR repository
    - Builds Docker image (`--platform linux/amd64`)
    - Pushes to ECR
    - Creates ECS cluster
    - Creates EFS filesystem (if enabled)
    - Creates IAM roles with CloudWatch Logs permissions
    - Registers ECS task definition (Fargate, 1024 CPU, 4096 MB)
    - Configures networking (default VPC, security group)
    - Creates or updates ECS service
    - If OAuth: uploads local credentials to EFS via a one-off Alpine container task
    - Waits up to 3 minutes for service stabilization
    - Shows logs and diagnostic info if unhealthy

---

## 4. MCP Tools

All 8 tools are defined in `src/core/mcp-entry.ts`.

### 4.1 investigate_codebase

**Lines:** 49-65
**Parameters:** `query` (string)
**Purpose:** Search the workspace for files matching a pattern.
**Implementation:** Runs `grep -rn --include='*.ts' --include='*.tsx' ...` across common source file extensions. Returns up to 20 matching file paths.
**Timeout:** 30 seconds.
**Limitation:** Only searches by grep pattern, not semantic search. Limited to specific file extensions.

### 4.2 read_file

**Lines:** 68-86
**Parameters:** `path` (string, relative to workspace root)
**Purpose:** Read file contents from the workspace.
**Security:** Path traversal check -- `fullPath` must start with `workspacePath` (line 76-77).
**Returns:** Full file content as text.

### 4.3 write_file

**Lines:** 89-108
**Parameters:** `path` (string), `content` (string)
**Purpose:** Create or overwrite a file in the workspace.
**Security:** Same path traversal check as read_file (line 97-98).
**Behavior:** Creates parent directories automatically (line 101).

### 4.4 create_branch

**Lines:** 111-126
**Parameters:** `repo` (string, repo directory name), `branch_name` (string)
**Purpose:** Create a git branch using `git worktree add`, giving the agent an isolated working copy.
**Worktree path:** `<workspace>/<repo>-wt-<branch_name>` (line 118)
**Timeout:** 30 seconds.

### 4.5 create_pr

**Lines:** 129-147
**Parameters:** `repo` (string), `title` (string), `body` (string), `branch` (string), `base` (string, default "main")
**Purpose:** Push a branch and create a GitHub pull request.
**Implementation:** `git push origin <branch>` then `gh pr create`.
**Timeout:** 60 seconds for push, 30 seconds for PR creation.
**Note:** Shell metacharacters in title/body are escaped by replacing `"` with `\"` but the command still uses `execSync` (shell) rather than `execFileSync`. This is a minor injection risk.

### 4.6 run_command

**Lines:** 150-189
**Parameters:** `command` (string), `cwd` (string, optional, relative to workspace)
**Purpose:** Run an allowlisted command in the workspace.
**Security layers:**
1. Command must not be in the blocklist (line 161)
2. Command must be in the allowlist (line 164)
3. Shell metacharacters are rejected: `;|&\`$(){}` (line 169)
4. Path traversal check on `cwd` (line 174)
5. Uses `execFileSync` (no shell) to prevent injection (line 180)
**Timeout:** 120 seconds. Max buffer: 10 MB.

### 4.7 check_ci_status

**Lines:** 192-207
**Parameters:** `repo` (string), `pr_number` (number)
**Purpose:** Check CI/CD status of a pull request.
**Implementation:** `gh pr checks <pr_number> --json name,status,conclusion`
**Timeout:** 30 seconds.

### 4.8 save_finding

**Lines:** 210-233
**Parameters:** `topic` (string), `content` (string)
**Purpose:** Save organizational knowledge for future reference.
**Implementation:** Appends a timestamped markdown entry to `/memory/<topic-slug>.md`.
**Storage:** `CITIO_MEMORY` env var (default `/memory`).
**Limitation:** Write-only. There is no corresponding `recall_context` tool to search or retrieve saved findings. The agent can only write knowledge, not read it back.

---

## 5. Authentication and Credential Management

### 5.1 Claude Code Authentication

**Primary method:** `ANTHROPIC_API_KEY` environment variable.

**OAuth method (subscription-based):**
- The installer checks for `~/.claude/` locally (src/cli/init.ts:122)
- If not found, runs `claude login` interactively (line 140)
- Local credentials are uploaded to EFS via a one-off Alpine container task (lines 710-779)
- The main container mounts EFS at `/home/citio` so Claude Code finds credentials at its expected path

**Keychain extraction:** Not implemented. The design doc mentions it but the code does not extract from macOS keychain. Users must either have `~/.claude/` files or use an API key.

### 5.2 Codex Authentication

**Primary method:** `OPENAI_API_KEY` environment variable.

**OAuth (device-auth) method:**
- Installer runs `codex login --device-auth` locally (src/cli/init.ts:138)
- Credentials stored at `~/.codex/auth.json`
- Uploaded to EFS same as Claude credentials
- On startup, `src/index.ts:46-75` attempts to refresh the OAuth token by calling `https://auth.openai.com/oauth/token` with the refresh token
- Client ID is hardcoded: `app_EMoamEEZ73f0CkXaXp7hrann` (line 58)

**Why it failed:** The Codex CLI's sandbox (`bwrap`) does not work on AWS Fargate because Fargate containers lack the kernel capabilities needed for user namespaces. The `--full-auto` flag was explored but the integration remained unstable (multiple fix commits: `c632552`, `20356f3`, `bdb479d`, `b494046`).

### 5.3 GitHub PAT

**Type:** Fine-grained Personal Access Token.

**Required permissions:** `contents:write`, `pull_requests:write` on target repos.

**How it flows:**
1. Installer collects it (src/cli/init.ts:183)
2. Written to `.env` as `GH_TOKEN` (line 370)
3. Passed to ECS task definition as environment variable (line 574)
4. WorkspaceManager sets it as git credential helper password (src/core/workspace.ts:27)
5. Also injected directly into clone URLs as fallback (src/core/workspace.ts:51)
6. Passed to MCP server environment (src/core/agent-runner.ts:43)
7. Used by `gh` CLI for PR creation and CI status checks

**Installer repo picker:** Uses the PAT to call `GET /user/repos` and presents a multiselect of accessible repos (src/cli/init.ts:195-222).

### 5.4 AWS IAM

**For ECS deployment:** The installer creates an IAM task execution role `citio-task-execution` (src/cli/init.ts:531-566) with:
- `AmazonECSTaskExecutionRolePolicy` managed policy
- Inline policy for CloudWatch Logs (`CreateLogGroup`, `CreateLogStream`, `PutLogEvents`, `DescribeLogStreams`)

**Task role vs profile:** The same role is used for both `executionRoleArn` and `taskRoleArn` (src/cli/init.ts:600-601). The agent prompt explicitly tells Claude to never use `--profile` because IAM task roles provide credentials automatically (src/adapters/slack.ts:324).

**Why profile doesn't work in containers:** There is no `~/.aws/credentials` file in the container. Fargate injects temporary credentials via the ECS metadata endpoint, which the AWS SDK and CLI pick up automatically. Using `--profile` would try to read a nonexistent credentials file and fail.

### 5.5 Credential Isolation Vision

The architectural goal: the MCP server (mcp-entry.ts) holds all credentials (GH_TOKEN, AWS creds, API keys). The agent process sees tool results but never the tokens themselves. The agent cannot run `env`, `printenv`, or `export` (all blocklisted in mcp-entry.ts:23).

**Current reality:** The agent is spawned with `{ ...process.env }` (src/core/agent-runner.ts:113), which passes ALL environment variables including `GH_TOKEN`, `SLACK_BOT_TOKEN`, and API keys to the Claude Code process. The credential isolation is partially achieved through the MCP blocklist but the agent process itself has access to the full environment. True isolation would require spawning the agent with a filtered environment.

---

## 6. Deployment Architecture

### 6.1 Docker Container

**File:** `Dockerfile` (45 lines)

```
Base:       node:22-slim
User:       citio (non-root, created via useradd)
Platform:   linux/amd64 (required for Fargate)

Installed globally:
  - @openai/codex
  - @anthropic-ai/claude-code

Installed via apt:
  - git, curl, jq, unzip, openssh-client, procps
  - aws-cli v2 (x86_64 zip install)
  - gh (GitHub CLI via apt repo)

Volumes:
  - /config    (citio.yaml mount point)
  - /workspace (git repos)
  - /memory    (org memory / findings)

Env defaults:
  - CITIO_CONFIG=/config/citio.yaml
  - CITIO_WORKSPACE=/workspace
  - CITIO_MEMORY=/memory
  - NODE_ENV=production

Health check:
  curl -f http://localhost:3001/healthz || exit 1
  Interval: 30s, Timeout: 5s, Start period: 30s, Retries: 3

Entrypoint: node dist/index.js
Port: 3001
```

### 6.2 AWS ECS Fargate

**Resources created by the installer:**

| Resource | Name/ID | Notes |
|----------|---------|-------|
| ECR Repository | `citio` | Stores Docker images |
| ECS Cluster | `citio` | Fargate cluster |
| ECS Service | `citio` | Desired count: 1 |
| ECS Task Definition | `citio` | Fargate, awsvpc networking |
| IAM Role | `citio-task-execution` | Execution + task role |
| Security Group | `citio-sg` | Default VPC, outbound only |
| EFS Filesystem | `citio-memory` | Optional, for credential/memory persistence |
| CloudWatch Log Group | `/ecs/citio` | Auto-created via `awslogs-create-group` |

**Task definition details (from installer):**
- CPU: 1024 (1 vCPU) -- note: schema default is 2048, installer uses 1024
- Memory: 4096 (4 GB) -- note: schema default is 8192, installer uses 4096
- Ephemeral storage: 100 GB
- Network: awsvpc with public IP (default VPC)
- Stop timeout: 60 seconds

**Actual production deployment (from CLAUDE.md):**
- Region: eu-west-2
- ECR: `<AWS_ACCOUNT_ID>.dkr.ecr.eu-west-2.amazonaws.com/citio`
- EFS: `<EFS_ID>` (mounted at `/home/citio`)
- Profile: `<AWS_PROFILE>`

### 6.3 EFS for Persistent State

EFS is mounted at `/home/citio` in the production deployment. This serves two purposes:

1. **Credential persistence:** Codex auth tokens (`~/.codex/auth.json`) survive container restarts
2. **Org memory:** Findings saved by `save_finding` persist at `/memory/` (if mapped)

The installer's credential upload flow:
1. Registers a one-off `citio-auth-setup` task definition with an Alpine container
2. Mounts EFS at `/efs`
3. Writes base64-decoded credentials to the appropriate path
4. Runs as a Fargate task, waits for completion
5. Restarts the main service to pick up credentials

**Known issue:** The EFS ID is hardcoded as a fallback in `src/cli/init.ts:749`: `<EFS_ID>`. This will fail for any deployment other than the original.

### 6.4 Zero-Console AWS Setup

The installer performs all AWS resource creation via CLI commands -- no console interaction needed. The flow uses the user's local AWS profile (collected during init) and creates resources via `aws` CLI calls with `execSync`. This includes VPC discovery, security group creation, IAM role creation, ECR/ECS setup, and EFS provisioning.

---

## 7. Slack Integration

### 7.1 Slack Assistant API

The Slack Assistant API provides a native AI-assistant experience in Slack DMs.

**Events handled:**
- `threadStarted` (src/adapters/slack.ts:43): Fires when a user opens a DM thread. Citio greets the user and sets suggested prompts.
- `userMessage` (src/adapters/slack.ts:88): Fires when the user sends a message. Citio processes it through the agent.
- `threadContextChanged` (src/adapters/slack.ts:84): Saves updated thread context.

**Suggested prompts** (lines 56-69):
- "Investigate a bug"
- "Review recent changes"
- "Check deployment status"
- "Summarize this channel" (only if context has a channel_id)

**Thread title and status:**
- Title is set to the first 50 chars of the user's message (line 118)
- Status shows "investigating..." with rotating loading messages (lines 119-128)
- These require `assistant:write` scope; failures are logged but non-fatal (lines 129-135)

### 7.2 Channel @mentions

**Event:** `app_mention` (src/adapters/slack.ts:224)

When a user types `@Citio <message>` in a channel:
1. The bot ID mention is stripped from the text (line 226)
2. Auth check against `authorized_users` list (lines 240-247)
3. A "Working on it..." message is posted directly in the channel (not as a thread reply) (lines 252-258)
4. The agent processes the request and updates the message with results

**Direct replies, not threads:** Per commit `3662df1`, channel responses are posted as top-level messages, not thread replies. The `thread_ts` is only used to identify the original mention for context, not for threading the response.

### 7.3 DM Restrictions

Two separate authorization mechanisms:

| Config Field | Controls | Behavior When Blocked |
|-------------|----------|----------------------|
| `admin_users` | Who can DM the bot | Explicit message: "DMs are restricted. Please @mention me in the team channel instead." |
| `authorized_users` | Who can @mention in channels | Silent ignore (no response) |

Both lists use Slack user IDs (e.g., `U01234ABCDE`). When the list is empty, all users are allowed.

### 7.4 Socket Mode

Citio uses Slack Socket Mode (src/adapters/slack.ts:35: `socketMode: true`). This means:
- No public URL or ingress needed
- Connection is outbound-only WebSocket
- Works behind firewalls and NAT
- Only requires the `app_token` (xapp-...) for the WebSocket connection
- Security group can deny all inbound traffic

### 7.5 Response Streaming

**Progress updates every 5 seconds:**
- Both DM and channel handlers use the same pattern
- A "thinking" message is posted immediately
- Every 5000ms, the message is updated via `chat.update` with the latest accumulated output (src/adapters/slack.ts:180-188, 272-279)
- The update shows the last 3,800 characters of output (to stay under Slack's limit)
- Updates are fire-and-forget (`.catch(() => {})`) to avoid blocking on Slack rate limits

**Final output:**
- Truncated to 3,900 characters if needed
- Appends `_(output truncated)_` when truncated
- Falls back to posting a new message if `chat.update` fails

### 7.6 Slack mrkdwn Formatting

The agent prompt (src/adapters/slack.ts:333-346) explicitly instructs the agent to use Slack mrkdwn syntax:
- Bold: `*bold*` (not `**bold**`)
- Italic: `_italic_`
- Code: backtick for inline, triple-backtick for blocks
- No `#` headers (Slack does not render them)
- No horizontal rules
- Links: `<url|text>` format
- Single newlines between sections

---

## 8. Configuration Reference

### Complete `citio.yaml` Schema

```yaml
# Instance name (used in logging)
name: citio                          # default: "citio"
version: 1                               # default: 1

slack:
  # Required: Slack Bot Token for API calls
  bot_token: ${SLACK_BOT_TOKEN}          # xoxb-... format

  # Required: Slack App Token for Socket Mode
  app_token: ${SLACK_APP_TOKEN}          # xapp-... format

  # Optional: Primary channel ID
  channel_id: C01234ABCDE

  # Who can @mention the bot in channels
  # Empty array = all channel members allowed
  authorized_users: []                   # Slack user IDs

  # Who can DM the bot directly
  # Empty array = all users allowed
  admin_users:
    - U01234ABCDE

engine:
  # Which coding agent to use: "codex" or "claude"
  default_provider: claude               # default: "codex"

  # Max wall-clock time per agent task (minutes)
  max_session_duration_minutes: 60       # default: 60

  # Max parallel sessions (NOT ENFORCED -- always 1)
  max_concurrent_sessions: 2             # default: 2

  providers:
    codex:
      api_key: ${OPENAI_API_KEY}         # optional
    claude:
      api_key: ${ANTHROPIC_API_KEY}      # optional

skills:
  # Names of installed skills
  installed: []                          # default: []

  # Directory where SKILL.md files are loaded from
  directory: /workspace/.citio/skills/  # default

workspace:
  # Repositories to clone on startup
  repos:
    - url: https://github.com/org/repo.git
      branch: main                       # default: "main"

  # Rules injected into CLAUDE.md / AGENTS.md
  rules:
    - "Always create PRs for code changes."

# Optional: Deployment configuration
deploy:
  provider: aws                          # only "aws" supported

  aws:
    region: us-east-1                    # default: "us-east-1"
    ecr_repo: citio                  # default: "citio"
    ecs_cluster: default                 # default: "default"
    ecs_service: citio               # default: "citio"
    task_cpu: 2048                       # default: 2048 (2 vCPU)
    task_memory: 8192                    # default: 8192 (8 GB)
    ephemeral_storage_gb: 100            # default: 100
```

### Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `SLACK_BOT_TOKEN` | Yes | Slack Bot Token |
| `SLACK_APP_TOKEN` | Yes | Slack App Token (Socket Mode) |
| `GH_TOKEN` | Yes | GitHub PAT for repo access and PR creation |
| `ANTHROPIC_API_KEY` | If provider=claude | Anthropic API key |
| `OPENAI_API_KEY` | If provider=codex | OpenAI API key |
| `CITIO_CONFIG` | No | Path to config file (default: `citio.yaml`) |
| `CITIO_CONFIG_B64` | No | Base64-encoded config (overrides file) |
| `CITIO_WORKSPACE` | No | Workspace path (default: `/workspace`) |
| `CITIO_MEMORY` | No | Memory storage path (default: `/memory`) |
| `CLAUDE_MODEL` | No | Claude model to use (default: `claude-opus-4-6`) |
| `AWS_DEFAULT_REGION` | No | AWS region for CLI commands |
| `HOME` | No | Home directory (default: `/home/citio`) |

---

## 9. Known Issues and Technical Debt

### 9.1 MCP Config Instability

The `--mcp-config` flag passed to Claude Code has been observed to cause hangs. Commit `2543821` removed it entirely and added AWS context directly to the prompt instead. Commit `ae9ea3d` re-added it with `--bare` to prevent plugin/hook loading. The current code (src/core/agent-runner.ts:91-99) passes both `--bare` and `--mcp-config`. This combination appears to work but may still hang under certain conditions.

**Impact:** If MCP hangs, the agent runs without tools and can only respond from its own knowledge, not from the actual codebase.

### 9.2 Codex Integration Unstable

Multiple issues with Codex on Fargate:
- `bwrap` (bubblewrap sandbox) requires kernel capabilities not available in Fargate containers
- Token refresh is fragile -- depends on hardcoded client ID (`app_EMoamEEZ73f0CkXaXp7hrann` in src/index.ts:58)
- The CLI flag changed from `-q` to `exec` (commit `20356f3`)
- Long-running MCP server approach was tried and abandoned (commit `bdb479d`)
- Auth check logic was removed as unreliable (commit `b494046`)

**Current state:** Codex is in the codebase but practically unused. The production config uses `default_provider: claude`.

### 9.3 No Automated Tests

`package.json` line 13: `"test": "echo \"Error: no test specified\" && exit 1"`

Zero tests exist. The plan called for fixture-based tests of MCP tool handlers and Slack adapter, but none were implemented.

### 9.4 No Session Continuity

Each Slack message spawns a completely fresh Claude Code process with no memory of previous messages in the thread. The plan described thread-based sessions with `slack_thread_ts -> provider_session_id` mapping, but this was never implemented.

**Impact:** Multi-turn conversations are not possible. Each message is independent.

### 9.5 Org Memory Is Write-Only

`save_finding` writes to `/memory/<topic>.md` but there is no `recall_context` tool. The plan described semantic search over `/memory/` files, but this was not implemented.

**Impact:** The agent can save knowledge but can never retrieve it. The `/memory/` directory grows but is never consulted.

### 9.6 Hardcoded Values in Installer

- EFS ID fallback: `<EFS_ID>` (src/cli/init.ts:749)
- Codex OAuth client ID: `app_EMoamEEZ73f0CkXaXp7hrann` (src/index.ts:58)
- IAM policy ARN with double colon: `arn:aws:iam::aws:policy/...` (src/cli/init.ts:548) -- this may be a typo (should be `arn:aws:iam::${accountId}:...` or the AWS-managed policy ARN)

### 9.7 Credential Isolation Is Incomplete

The agent process receives the full parent environment via `{ ...process.env }` (src/core/agent-runner.ts:113). While the MCP blocklist prevents `env`/`printenv`, the Claude Code process itself can access `GH_TOKEN` and other secrets in its environment. True isolation would require passing only safe environment variables to the child process.

### 9.8 Concurrency Not Implemented

`max_concurrent_sessions: 2` is in the config schema but AgentRunner processes exactly one task at a time. The queue serializes all requests.

### 9.9 Worktree Cleanup

`WorkspaceManager.cleanupWorktree()` exists (src/core/workspace.ts:185-202) but is never called. Worktrees created by the `create_branch` MCP tool accumulate on disk without cleanup.

### 9.10 create_pr Uses execSync (Shell)

The `create_pr` tool (src/core/mcp-entry.ts:138-141) uses `execSync` with shell interpolation for the `gh pr create` command. While title and body have `"` escaped, this is less secure than `execFileSync`. The `run_command` tool correctly uses `execFileSync`.

---

## 10. Roadmap

### v0.2: MCP Fully Wired + Org Memory + Proactive Monitoring

**MCP reliability:**
- Debug and fix `--mcp-config` hangs
- Ensure MCP connection is established before processing user prompts
- Add MCP connection health check to `/healthz`

**Org memory with recall:**
- Implement `recall_context` MCP tool -- semantic search over `/memory/` files
- Add memory compaction (TTL-based + agent-driven consolidation)
- Surface relevant findings automatically when new tasks are submitted

**Session continuity:**
- Implement `SessionManager` with thread-to-session mapping
- Use Claude Code `--resume` or context replay for multi-turn conversations
- Per-session git worktrees with automatic cleanup

**Proactive monitoring:**
- Watch CI failures and error logs
- Open fix PRs automatically when known patterns are detected
- `query_logs` MCP tool for CloudWatch/service log access

**Concurrency:**
- Enforce `max_concurrent_sessions` with proper session isolation
- Per-session worktrees (no shared workspace conflicts)

**Testing:**
- Fixture-based tests for all 8 MCP tool handlers
- Slack adapter integration tests with mock Bolt.js
- End-to-end test: message in -> agent runs -> PR created

### v0.3: Multi-Channel + Dashboard + Cloud Expansion

**Multi-channel:**
- Single container serves multiple Slack channels
- Channel-to-repo mapping in config
- Per-channel rules and authorized users

**Web dashboard:**
- Audit trail of all agent actions
- Session history and cost tracking
- Policy engine configuration UI

**Cloud providers:**
- GCP Cloud Run support in installer
- Azure Container Instances support
- Fly.io for lightweight deployments

### Open Source Release

**npm publish:**
- `npx citio init` for zero-install setup
- Published to npm registry

**Container images:**
- Pre-built images on GitHub Container Registry (`ghcr.io`)
- Multi-arch builds (amd64 + arm64)
- CI/CD via GitHub Actions on release tags

**Community:**
- Skill authoring guide
- `FROM citio:latest` extension pattern
- Community skill registry

---

## Appendix A: File Index

| File | Lines | Purpose |
|------|-------|---------|
| `src/index.ts` | 129 | Main entry point, startup orchestration |
| `src/adapters/slack.ts` | 364 | Slack Assistant API + channel @mention handler |
| `src/core/agent-runner.ts` | 231 | Task queue, Claude Code spawning, stream parsing |
| `src/core/mcp-entry.ts` | 242 | Standalone MCP server with 8 tools |
| `src/core/workspace.ts` | 203 | Git clone, credential helper, instruction files |
| `src/config/schema.ts` | 64 | Zod config schema |
| `src/utils/env.ts` | 14 | Environment variable interpolation |
| `src/cli/init.ts` | 913 | Interactive installer + AWS deployment |
| `Dockerfile` | 45 | Container image definition |
| `citio.yaml` | 38 | Example/dev configuration |
| `CLAUDE.md` | 143 | Project rules and development notes |
| `package.json` | 39 | Dependencies and scripts |

## Appendix B: Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@slack/bolt` | ^4.6.0 | Slack SDK (Socket Mode, events, Assistant API) |
| `@modelcontextprotocol/sdk` | ^1.28.0 | MCP server implementation |
| `@clack/prompts` | ^1.1.0 | Terminal UI for installer |
| `zod` | ^4.3.6 | Schema validation |
| `yaml` | ^2.8.3 | YAML parsing |
| `dotenv` | ^17.3.1 | .env file loading |
| `@aws-sdk/client-*` | ^3.1019.0 | AWS SDK (EC2, ECR, ECS, EFS, IAM, STS) |
| `typescript` | ^6.0.2 | Build toolchain |
| `tsx` | ^4.21.0 | Dev-time TypeScript execution |

## Appendix C: Actual Production Config

From `CLAUDE.md`:
```
Region: eu-west-2
ECR: <AWS_ACCOUNT_ID>.dkr.ecr.eu-west-2.amazonaws.com/citio
EFS: <EFS_ID> (mounted at /home/citio)
Profile: <AWS_PROFILE>
Repos: service-alpha, service-beta, service-gamma, service-delta (all your-org org)
```
