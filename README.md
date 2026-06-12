# GitHub Autofix Agent

An autonomous AI agent that reads GitHub bug reports, explores the codebase to find the root cause, writes a minimal fix on a new branch, and opens a pull request for human review. When the PR receives code review comments, a second agent loop addresses them and replies inline.

## The full autonomous pipeline

When combined with the [triage agent](https://github.com/asfar95/github-issue-triage-agent) and [code review bot](https://github.com/asfar95/ai-code-review-bot), this creates a fully autonomous engineering loop:

```
Issue opened
    │
    ▼
Triage Agent          classifies issue, adds "bug" label
    │
    ▼
Autofix Agent         reads code, writes fix, opens PR
    │
    ▼
Code Review Bot       reviews the PR, posts inline comments
    │
    ▼
Review-Fix Agent      reads review comments, applies fixes, replies inline
    │
    ▼
Human               merges (or requests further changes)
```

No manual intervention between steps — each agent triggers the next via GitHub webhooks.

## What makes this an AI Agent (not a script)

A script follows fixed rules. This agent gets a goal and figures out the steps itself:

```
get_issue_details          ← understand the bug
get_file_content(package.json) ← discover tech stack
list_repo_files            ← map the project structure
search_code                ← find the relevant file
get_file_content(src/...)  ← read the actual implementation
         │
    understand root cause
         │
create_branch              ← isolate the fix
get_file_content + sha     ← read file before writing
create_or_update_file      ← write the complete fixed file
create_pull_request        ← open for human review
post_issue_comment         ← link PR back to issue
```

The LLM decides the order, which files to read, and when to escalate — it reads the codebase the same way a new developer would on their first day.

## Screenshots

### Autofix agent — PR opened automatically from a bug issue
<img src="screenshots/autofix-pr.png" alt="Pull request opened by the autofix agent with problem, fix, and testing sections" width="800">

### Review-fix agent — inline replies after addressing review comments
<img src="screenshots/review-fix-comments.png" alt="Review comments with inline bot replies confirming each fix was applied" width="800">

### CLI output — agent discovery and fix iterations
<img src="screenshots/cli-output.png" alt="Terminal showing agent loop: issue read, codebase explored, branch created, fix committed, PR opened" width="800">

### Backlog scan — processing all open bug issues
<img src="screenshots/scan-output.png" alt="scan.js output showing open issues, skipping already-attempted ones, and processing the rest" width="800">

## Features

- **Discovery-first**: reads `package.json`, explores directory structure, and searches code before writing a single line — adapts to any codebase
- **Minimal fixes**: changes only what the issue describes, preserves all existing code style and patterns
- **Review-fix loop**: second agent reads PR review comments, triages each as actionable/not-applicable/already-fixed, applies fixes, and replies inline
- **Backlog scanner**: `scan.js` finds all open `bug` issues not yet attempted and processes them in one run
- **Human escalation**: escalates when fix spans more than 3 files, requires schema/API changes, or root cause is ambiguous
- **Idempotency**: both agents skip issues/PRs already handled — safe to re-deliver webhooks
- **Quota-aware retry**: distinguishes daily token exhaustion (fail fast) from per-minute rate limits (exponential backoff)
- **Webhook + CLI**: runs automatically via GitHub webhooks or triggered manually

## Architecture

```
src/
├── index.js          — webhook server (port 3003)
│                       issues.labeled "bug"       → autofix agent
│                       pull_request_review.submit → review-fix agent
├── agent.js          — autofix agent loop (discovery → fix → PR)
├── review-agent.js   — review-fix agent loop (read → triage → fix → reply)
├── cli.js            — manual fix trigger
├── review-fix.js     — manual review-fix trigger
├── scan.js           — backlog scanner (all open bug issues)
└── tools/
    └── github.js     — 13 GitHub tools + OpenAI function-calling definitions
```

**Stack:** Node.js · Groq API (llama-3.3-70b-versatile) · Octokit · Express

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/asfar95/github-autofix-agent.git
cd github-autofix-agent
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
GITHUB_TOKEN=ghp_...          # PAT — needs repo + issues + pull_requests scope
GITHUB_WEBHOOK_SECRET=...     # random string matching your GitHub webhook config
AI_API_KEY=gsk_...            # Groq API key — free at console.groq.com
AI_MODEL=llama-3.3-70b-versatile
PORT=3003
```

### 3. Fix a specific issue (CLI)

```bash
node src/cli.js asfar95/my-repo 42
```

### 4. Process all open bug issues (backlog scan)

```bash
# Preview what would be processed
node src/scan.js asfar95/my-repo --dry-run

# Run it
node src/scan.js asfar95/my-repo
```

### 5. Address review comments on a PR

```bash
node src/review-fix.js asfar95/my-repo 7
```

### 6. Run the webhook server

```bash
npm start
```

Expose with ngrok:

```bash
ngrok http 3003
```

Add the webhook to your GitHub repo (**Settings → Webhooks → Add webhook**):

| Field | Value |
|---|---|
| Payload URL | `https://<ngrok-url>/webhook` |
| Content type | `application/json` |
| Secret | same as `GITHUB_WEBHOOK_SECRET` |
| Events | Issues, Pull request reviews |

## Tools available to the agent

### Autofix agent

| Tool | What it does |
|---|---|
| `get_issue_details` | Reads issue title, body, labels |
| `list_repo_files` | Lists files/folders to map the project |
| `get_file_content` | Reads file content + SHA (required for updates) |
| `search_code` | Searches for a function/variable across the repo |
| `get_default_branch` | Gets `main` or `master` |
| `create_branch` | Creates `fix/issue-{n}-{slug}` branch |
| `create_or_update_file` | Writes the complete fixed file to the branch |
| `create_pull_request` | Opens PR with problem/fix/testing description |
| `post_issue_comment` | Links the PR back to the issue |
| `escalate_to_human` | Flags as too complex, applies `needs-human-fix` label |

### Review-fix agent (additional tools)

| Tool | What it does |
|---|---|
| `get_pull_request` | Gets PR details including head branch name |
| `get_pr_review_comments` | Gets all inline review comments with file + line |
| `reply_to_review_comment` | Replies to a comment confirming fix or explaining why skipped |

## Webhook events

| Event | Action | Trigger |
|---|---|---|
| `issues` | `labeled` | label name = `bug` → runs autofix agent |
| `pull_request_review` | `submitted` | any review → runs review-fix agent |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes | PAT with `repo`, `issues`, `pull_requests` scope |
| `GITHUB_WEBHOOK_SECRET` | No | Validates webhook signatures (recommended) |
| `AI_API_KEY` | Yes | Groq API key |
| `AI_MODEL` | No | Defaults to `llama-3.3-70b-versatile` |
| `PORT` | No | Defaults to `3003` |
